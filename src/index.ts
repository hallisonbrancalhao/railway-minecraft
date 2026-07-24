import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import mc from "minecraftstatuspinger";
import { z } from "zod";
import { env } from "./env";
import index from "./index.html";
import {
	getServerState,
	sendConsoleCommand,
	startServer,
	stopServer,
	subscribeToLogs,
} from "./mc-process";

const MAX_PREVIEW_BYTES = 200_000;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const FILES_ROOT = path.resolve("/data");
const DEFAULT_BACKLOG_LINES = 500;
const WS_AUTH_REVALIDATE_MS = 30_000;
const MC_STATUS_CACHE_MS = 8000;
const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const RAILWAY_OAUTH_ME_ENDPOINT = "https://backboard.railway.com/oauth/me";
const RAILWAY_OAUTH_SCOPE = "openid profile email project:viewer";
const RAILWAY_OAUTH_CLIENT_CACHE_PATH = path.join(
	FILES_ROOT,
	".railway-oauth-client.json",
);
const RAILWAY_AUTH_COOKIE_NAME = "railway_oauth_access_token";
const SERVICE_AUTH_CACHE_MS = 15_000;
const PKCE_SESSION_TTL_MS = 5 * 60 * 1000;

const json = (data: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(data), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init.headers,
		},
	});

const jsonPretty = (data: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(data, null, 2), {
		...init,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...init.headers,
		},
	});

const redirectWithHeaders = (
	location: URL | string,
	headers: HeadersInit = {},
	status = 302,
) =>
	new Response(null, {
		status,
		headers: {
			Location: typeof location === "string" ? location : location.toString(),
			...headers,
		},
	});

type ServiceAuthorizationResult = {
	ok: boolean;
	service: { id: string; name: string | null } | null;
	status?: number;
	error?: string;
	details?: unknown;
	/**
	 * True when we never got an answer from Railway (DNS/TLS/connection). Request
	 * paths still fail closed, but long-lived streams treat it as "ask again next
	 * tick" instead of signing the user out over a network blip.
	 */
	transportError?: boolean;
};

type RailwayUserProfile = {
	sub: string | null;
	name: string | null;
	email: string | null;
	picture: string | null;
};

const persistedRailwayOAuthClientSchema = z.object({
	clientId: z.string().min(1),
	clientSecret: z.string().optional(),
	registrationAccessToken: z.string().optional(),
	registrationClientUri: z.string().optional(),
	redirectUri: z.string().min(1),
	registeredAt: z.string().min(1),
});

const dynamicRegistrationResponseSchema = z.object({
	client_id: z.string().min(1),
	client_secret: z.string().optional(),
	registration_access_token: z.string().optional(),
	registration_client_uri: z.string().optional(),
});

const oauthMeResponseSchema = z.object({
	sub: z.string().optional().nullable(),
	name: z.string().optional().nullable(),
	email: z.string().optional().nullable(),
	picture: z.string().optional().nullable(),
});

const serviceAuthorizationResponseSchema = z.object({
	data: z
		.object({
			service: z
				.object({
					id: z.string().min(1),
					name: z.string().optional().nullable(),
				})
				.nullable(),
		})
		.optional(),
	errors: z.array(z.unknown()).optional(),
});

const mcStatusPayloadSchema = z.object({
	description: z.unknown().optional(),
	motd: z.unknown().optional(),
	version: z
		.union([z.string(), z.object({ name: z.string().optional() })])
		.optional()
		.nullable(),
	players: z
		.object({
			online: z.coerce.number().optional(),
			max: z.coerce.number().optional(),
			sample: z
				.array(z.union([z.string(), z.object({ name: z.string().optional() })]))
				.optional(),
		})
		.optional()
		.nullable(),
});

const serviceAuthCache = new Map<
	string,
	{ result: ServiceAuthorizationResult; expiresAt: number }
>();

const readCookie = (req: Request, name: string) => {
	const cookieHeader = req.headers.get("cookie");
	if (!cookieHeader) return null;
	const cookies = cookieHeader.split(";");
	for (const part of cookies) {
		const [rawName, ...rawValue] = part.trim().split("=");
		if (rawName !== name) continue;
		return decodeURIComponent(rawValue.join("="));
	}
	return null;
};

const buildAuthCookie = (token: string, maxAgeSeconds: number) =>
	`${RAILWAY_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

const clearAuthCookie = () =>
	`${RAILWAY_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const authorizeTokenForService = async (
	accessToken: string,
): Promise<ServiceAuthorizationResult> => {
	const cached = serviceAuthCache.get(accessToken);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.result;
	}

	const query = `
		query ServiceAuthorization($serviceId: String!) {
			service(id: $serviceId) {
				id
				name
			}
		}
	`;

	let response: Response;
	try {
		response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({
				query,
				variables: { serviceId: env.RAILWAY_SERVICE_ID },
			}),
		});
	} catch (error) {
		// Never let a network failure reject: this runs from interval callbacks in
		// a process that is PID 1, and an unhandled rejection would kill the
		// container without the graceful Minecraft shutdown.
		return {
			ok: false,
			service: null,
			error: "Railway GraphQL request failed.",
			details: formatUnknownError(error),
			transportError: true,
		};
	}

	const raw = await response.text();
	let payload: Record<string, unknown> | null = null;
	try {
		payload = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// Keep raw response in details for debugging.
	}

	if (!response.ok) {
		const result: ServiceAuthorizationResult = {
			ok: false,
			service: null,
			status: response.status,
			error: "Railway GraphQL service authorization failed.",
			details: payload ?? raw,
		};
		serviceAuthCache.set(accessToken, {
			result,
			expiresAt: Date.now() + Math.min(5000, SERVICE_AUTH_CACHE_MS),
		});
		return result;
	}

	const parsed = serviceAuthorizationResponseSchema.safeParse(payload ?? {});
	const gqlErrors = parsed.success ? (parsed.data.errors ?? null) : null;
	if (gqlErrors || !parsed.success) {
		const result: ServiceAuthorizationResult = {
			ok: false,
			service: null,
			status: 200,
			error: parsed.success
				? "Railway GraphQL returned errors."
				: "Railway GraphQL payload validation failed.",
			details: parsed.success ? gqlErrors : parsed.error.flatten(),
		};
		serviceAuthCache.set(accessToken, {
			result,
			expiresAt: Date.now() + Math.min(5000, SERVICE_AUTH_CACHE_MS),
		});
		return result;
	}
	const service = parsed.data.data?.service
		? {
				id: parsed.data.data.service.id,
				name: parsed.data.data.service.name ?? null,
			}
		: null;

	const result: ServiceAuthorizationResult = {
		ok: Boolean(service),
		service,
		status: 200,
		error: service ? undefined : "Service not accessible for this token.",
		details: payload ?? raw,
	};
	serviceAuthCache.set(accessToken, {
		result,
		expiresAt: Date.now() + SERVICE_AUTH_CACHE_MS,
	});
	return result;
};

const fetchRailwayUserProfile = async (
	accessToken: string,
): Promise<RailwayUserProfile | null> => {
	try {
		const response = await fetch(RAILWAY_OAUTH_ME_ENDPOINT, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
			},
		});

		const raw = await response.text();
		if (!response.ok) return null;

		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return null;
		}
		const parsed = oauthMeResponseSchema.safeParse(payload);
		if (!parsed.success) return null;
		return {
			sub: parsed.data.sub ?? null,
			name: parsed.data.name ?? null,
			email: parsed.data.email ?? null,
			picture: parsed.data.picture ?? null,
		};
	} catch {
		return null;
	}
};

const requireAuth = async (req: Request) => {
	const accessToken = readCookie(req, RAILWAY_AUTH_COOKIE_NAME);
	if (!accessToken) return false;

	const auth = await authorizeTokenForService(accessToken);
	return auth.ok;
};

const getValidatedAccessToken = async (req: Request) => {
	const accessToken = readCookie(req, RAILWAY_AUTH_COOKIE_NAME);
	if (!accessToken) return null;
	const auth = await authorizeTokenForService(accessToken);
	return auth.ok ? accessToken : null;
};

const normalizeConsoleCommand = (command: string) =>
	command.replace(/\r?\n/g, " ").trim();

const getBacklogLines = (value: string | null) => {
	if (!value) return DEFAULT_BACKLOG_LINES;
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) return DEFAULT_BACKLOG_LINES;
	return Math.max(0, parsed);
};

const getMCServerPort = () => {
	const port = Number.parseInt(
		env.MC_SERVER_PORT ?? env.SERVER_PORT ?? "25565",
		10,
	);
	return Number.isNaN(port) ? 25565 : port;
};

const getControlPort = () => {
	// PORT first: Railway ignores the Dockerfile's EXPOSE and sends public traffic
	// to the PORT it injects, so binding anywhere else answers nobody (502).
	//
	// But adding a TCP proxy for Minecraft makes Railway set PORT to *that*
	// target (25565). Binding it would steal the port from the server we
	// supervise — the panel wins the race (Bun.serve runs before startServer)
	// and Minecraft then crash-loops on "address already in use". So a PORT that
	// collides with the game port is not ours, and we fall through.
	const minecraftPort = getMCServerPort();
	for (const candidate of [env.PORT, env.CONTROL_PORT, env.APP_PORT]) {
		const parsed = Number.parseInt(candidate ?? "", 10);
		if (Number.isNaN(parsed) || parsed === minecraftPort) continue;
		return parsed;
	}
	return 3000;
};

type ConsoleLogSocketData = {
	backlogLines: number;
	accessToken: string;
	unsubscribe: (() => void) | null;
	authTimer: ReturnType<typeof setInterval> | null;
};

type StatusSnapshot = {
	host: string;
	port: number;
	publicAddress: string | null;
	motd: string | null;
	version: string | null;
	latency: number | null;
	players: {
		online: number;
		max: number;
		sample: string[];
	};
};

const createBaseStatusSnapshot = (): StatusSnapshot => ({
	host: env.MC_SERVER_HOST,
	port: getMCServerPort(),
	publicAddress:
		env.RAILWAY_TCP_PROXY_DOMAIN && env.RAILWAY_TCP_PROXY_PORT
			? `${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}`
			: null,
	motd: null,
	// The jar is pinned at build time, so the version is known even when the
	// server is still booting and the status ping has nothing to say yet.
	version: env.MC_VERSION,
	latency: null,
	players: { online: 0, max: 0, sample: [] },
});

let statusCache: {
	data: StatusSnapshot;
	fetchedAt: number;
} | null = null;
let statusInFlight: Promise<StatusSnapshot> | null = null;

const normalizeMotd = (motd: unknown) => {
	if (!motd) return null;
	if (typeof motd === "string") return motd;
	if (typeof motd === "object" && motd && "clean" in motd) {
		const clean = (motd as { clean?: string | string[] }).clean;
		if (Array.isArray(clean)) return clean.join(" ").trim();
		if (typeof clean === "string") return clean.trim();
	}
	if (typeof motd === "object" && motd && "raw" in motd) {
		const raw = (motd as { raw?: string | string[] }).raw;
		if (Array.isArray(raw)) return raw.join(" ").trim();
		if (typeof raw === "string") return raw.trim();
	}
	return null;
};

const parseStatusPayload = (statusRaw: string) => {
	try {
		return JSON.parse(statusRaw) as Record<string, unknown>;
	} catch {
		return null;
	}
};

const getStatusPayload = (payload: {
	status: Record<string, unknown> | null;
	statusRaw: string;
}) => payload.status ?? parseStatusPayload(payload.statusRaw);

const fetchServerStatus = async () => {
	const now = Date.now();
	if (statusCache && now - statusCache.fetchedAt < MC_STATUS_CACHE_MS) {
		return statusCache.data;
	}
	if (statusInFlight) return statusInFlight;

	statusInFlight = (async () => {
		const baseSnapshot = createBaseStatusSnapshot();

		try {
			const res = await mc.lookup({
				host: env.MC_SERVER_HOST,
				port: getMCServerPort(),
				timeout: 2500,
				ping: true,
				SRVLookup: true,
				JSONParse: true,
				throwOnParseError: false,
			});
			const statusPayload = getStatusPayload(res);
			if (!statusPayload) {
				throw new Error("Server status unavailable");
			}
			const parsedStatusPayload =
				mcStatusPayloadSchema.safeParse(statusPayload);
			if (!parsedStatusPayload.success) {
				throw new Error("Server status payload invalid");
			}
			const typedPayload = parsedStatusPayload.data;
			const version =
				typeof typedPayload.version === "string"
					? typedPayload.version
					: (typedPayload.version?.name ?? null);
			const sample =
				typedPayload.players?.sample
					?.map((player) => (typeof player === "string" ? player : player.name))
					.filter((value): value is string => Boolean(value)) ?? [];
			const online = typedPayload.players?.online ?? 0;
			const max = typedPayload.players?.max ?? 0;

			const snapshot: StatusSnapshot = {
				...baseSnapshot,
				motd: normalizeMotd(typedPayload.description ?? typedPayload.motd),
				version,
				latency: typeof res.latency === "number" ? res.latency : null,
				players: {
					online,
					max,
					sample,
				},
			};

			statusCache = { data: snapshot, fetchedAt: Date.now() };
			statusInFlight = null;
			return snapshot;
		} catch {
			// The ping fails while the server is still booting or is down. The
			// pinned build version already carries the useful part of the answer.
			const snapshot = { ...baseSnapshot };

			statusCache = { data: snapshot, fetchedAt: Date.now() };
			statusInFlight = null;
			return snapshot;
		}
	})();

	try {
		return await statusInFlight;
	} finally {
		statusInFlight = null;
	}
};

const normalizeRelativePath = (value: string | null) => {
	const raw = value ?? "/";
	const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
	return withLeadingSlash.replace(/\/+/g, "/");
};

const resolveSafePath = (value: string | null) => {
	const relative = normalizeRelativePath(value);
	const resolved = path.resolve(FILES_ROOT, `.${relative}`);
	const rootWithSep = FILES_ROOT.endsWith(path.sep)
		? FILES_ROOT
		: `${FILES_ROOT}${path.sep}`;

	if (resolved !== FILES_ROOT && !resolved.startsWith(rootWithSep)) {
		throw new Error("Invalid path.");
	}

	// The persisted OAuth client holds a client_secret. Filtering it out of the
	// directory listing is not enough — without this every other file route
	// (content, delete, upload) could still reach it by exact path.
	if (resolved === RAILWAY_OAUTH_CLIENT_CACHE_PATH) {
		throw new Error("Invalid path.");
	}

	return { relative, resolved };
};

const normalizeUploadRelativePath = (value: string) => {
	const segments = value
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".");
	if (
		segments.length === 0 ||
		segments.some(
			(segment) =>
				segment === ".." || segment.includes("\0") || segment === "/",
		)
	) {
		throw new Error("Invalid upload path.");
	}
	return segments.join("/");
};

const ensureAuth = async (req: Request) => {
	if (!(await requireAuth(req))) {
		return json({ error: "Unauthorized." }, { status: 401 });
	}
	return null;
};

const formatUnknownError = (error: unknown) => {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		};
	}
	if (typeof error === "string") return { message: error };
	try {
		return { value: JSON.stringify(error) };
	} catch {
		return { value: String(error) };
	}
};

type RailwayOAuthClient = {
	clientId: string;
	clientSecret: string | null;
	registrationAccessToken: string | null;
	registrationClientUri: string | null;
	redirectUri: string;
	registeredAt: string;
};

type OAuthPkceSession = {
	codeVerifier: string;
	expiresAt: number;
};

const oauthPkceSessions = new Map<string, OAuthPkceSession>();

/** Railway rate-limits POST /oauth/register; back off instead of hammering it. */
const RAILWAY_OAUTH_REGISTER_COOLDOWN_MS = 60_000;
let railwayOAuthRegistrationError: Error | null = null;
let railwayOAuthRegistrationBlockedUntil = 0;

const isRateLimited = (error: unknown) =>
	error instanceof Error && error.message.includes("(429)");

let railwayOAuthClientCache: RailwayOAuthClient | null = null;
let railwayOAuthClientInFlight: Promise<RailwayOAuthClient> | null = null;

const toBase64Url = (input: Uint8Array) =>
	Buffer.from(input)
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/g, "");

const buildRailwayRedirectUri = () =>
	`https://${env.RAILWAY_PUBLIC_DOMAIN}/api/auth/callback`;

const createCodeVerifier = () => toBase64Url(randomBytes(64));

const createCodeChallenge = (codeVerifier: string) =>
	toBase64Url(createHash("sha256").update(codeVerifier).digest());

const prunePkceSessions = () => {
	const now = Date.now();
	for (const [state, session] of oauthPkceSessions.entries()) {
		if (session.expiresAt <= now) oauthPkceSessions.delete(state);
	}
};

const parseRailwayOAuthClient = (value: unknown): RailwayOAuthClient | null => {
	const parsed = persistedRailwayOAuthClientSchema.safeParse(value);
	if (!parsed.success) return null;
	return {
		clientId: parsed.data.clientId,
		clientSecret: parsed.data.clientSecret ?? null,
		registrationAccessToken: parsed.data.registrationAccessToken ?? null,
		registrationClientUri: parsed.data.registrationClientUri ?? null,
		redirectUri: parsed.data.redirectUri,
		registeredAt: parsed.data.registeredAt,
	};
};

const readPersistedRailwayOAuthClient = async () => {
	try {
		const file = Bun.file(RAILWAY_OAUTH_CLIENT_CACHE_PATH);
		if (!(await file.exists())) return null;
		const parsed = JSON.parse(await file.text()) as unknown;
		return parseRailwayOAuthClient(parsed);
	} catch {
		return null;
	}
};

const persistRailwayOAuthClient = async (client: RailwayOAuthClient) => {
	await mkdir(FILES_ROOT, { recursive: true });
	await Bun.write(
		RAILWAY_OAUTH_CLIENT_CACHE_PATH,
		`${JSON.stringify(client, null, 2)}\n`,
	);
};

const registerRailwayOAuthClient = async (): Promise<RailwayOAuthClient> => {
	const redirectUri = buildRailwayRedirectUri();
	const response = await fetch("https://backboard.railway.com/oauth/register", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_name: "Railway Minecraft Template",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "client_secret_post",
			scope: RAILWAY_OAUTH_SCOPE,
		}),
	});

	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`Railway OAuth registration failed (${response.status}): ${responseText}`,
		);
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(responseText) as Record<string, unknown>;
	} catch {
		throw new Error("Railway OAuth registration returned invalid JSON.");
	}
	const parsed = dynamicRegistrationResponseSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(
			`Railway OAuth registration response validation failed: ${parsed.error.issues
				.map((issue) => issue.path.join("."))
				.join(", ")}`,
		);
	}

	const client: RailwayOAuthClient = {
		clientId: parsed.data.client_id,
		clientSecret: parsed.data.client_secret ?? null,
		registrationAccessToken: parsed.data.registration_access_token ?? null,
		registrationClientUri: parsed.data.registration_client_uri ?? null,
		redirectUri,
		registeredAt: new Date().toISOString(),
	};
	await persistRailwayOAuthClient(client);
	return client;
};

const getRailwayOAuthClient = async () => {
	const redirectUri = buildRailwayRedirectUri();

	if (railwayOAuthClientCache?.redirectUri === redirectUri) {
		return railwayOAuthClientCache;
	}
	if (railwayOAuthClientInFlight) return railwayOAuthClientInFlight;

	railwayOAuthClientInFlight = (async () => {
		const persisted = await readPersistedRailwayOAuthClient();
		if (persisted?.redirectUri === redirectUri) {
			railwayOAuthClientCache = persisted;
			return persisted;
		}

		// Retrying on every sign-in click is precisely what keeps Railway's rate
		// limit saturated, so a failed registration is remembered for a cooldown
		// and replayed without touching the network.
		if (
			railwayOAuthRegistrationError &&
			railwayOAuthRegistrationBlockedUntil > Date.now() &&
			!env.RAILWAY_CLIENT_ID
		) {
			throw railwayOAuthRegistrationError;
		}

		try {
			const dynamicClient = await registerRailwayOAuthClient();
			railwayOAuthRegistrationError = null;
			railwayOAuthClientCache = dynamicClient;
			return dynamicClient;
		} catch (error) {
			railwayOAuthRegistrationError =
				error instanceof Error ? error : new Error(String(error));
			railwayOAuthRegistrationBlockedUntil =
				Date.now() + RAILWAY_OAUTH_REGISTER_COOLDOWN_MS;
			if (!env.RAILWAY_CLIENT_ID) throw railwayOAuthRegistrationError;
			const fromEnv: RailwayOAuthClient = {
				clientId: env.RAILWAY_CLIENT_ID,
				clientSecret: env.RAILWAY_CLIENT_SECRET ?? null,
				registrationAccessToken:
					env.RAILWAY_OAUTH_REGISTRATION_ACCESS_TOKEN ?? null,
				registrationClientUri:
					env.RAILWAY_OAUTH_REGISTRATION_CLIENT_URI ?? null,
				redirectUri,
				registeredAt: new Date().toISOString(),
			};
			console.warn(
				"Failed to dynamically register Railway OAuth client; using env credentials instead.",
			);
			console.error(
				"Dynamic registration error details:",
				formatUnknownError(error),
			);
			railwayOAuthClientCache = fromEnv;
			return fromEnv;
		}
	})();

	try {
		return await railwayOAuthClientInFlight;
	} finally {
		railwayOAuthClientInFlight = null;
	}
};

const server = Bun.serve<ConsoleLogSocketData>({
	port: getControlPort(),
	// Must be 0.0.0.0, not localhost: Railway's edge proxy reaches the container
	// from outside its loopback.
	hostname: "0.0.0.0",
	maxRequestBodySize: MAX_UPLOAD_BYTES,
	// Without this, an uncaught throw in any handler makes Bun serve its default
	// error page — which embeds the compiled source around the throw site. That
	// must never reach a browser on a public deployment.
	error(error: Error) {
		console.error("Unhandled request error:", formatUnknownError(error));
		return json({ error: "Internal server error." }, { status: 500 });
	},
	routes: {
		"/api/auth/redirect": {
			GET: async (req: Request) => {
				try {
					const client = await getRailwayOAuthClient();
					const codeVerifier = createCodeVerifier();
					const codeChallenge = createCodeChallenge(codeVerifier);
					const state = randomBytes(32).toString("hex");
					oauthPkceSessions.set(state, {
						codeVerifier,
						expiresAt: Date.now() + PKCE_SESSION_TTL_MS,
					});
					prunePkceSessions();

					const url = new URL("https://backboard.railway.com/oauth/auth");
					url.searchParams.append("response_type", "code");
					url.searchParams.append("client_id", client.clientId);
					url.searchParams.append("redirect_uri", client.redirectUri);
					url.searchParams.append("scope", RAILWAY_OAUTH_SCOPE);
					url.searchParams.append("code_challenge", codeChallenge);
					url.searchParams.append("code_challenge_method", "S256");
					url.searchParams.append("state", state);

					return Response.redirect(url, 302);
				} catch (error) {
					// Getting an OAuth client can fail (Railway rate-limits dynamic
					// registration). Send the operator back to a readable message
					// instead of letting the error escape into Bun's error page.
					console.error("OAuth redirect failed:", formatUnknownError(error));
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set(
						"auth_error",
						isRateLimited(error)
							? "Railway is rate limiting OAuth app registration. Wait a few minutes and try again, or set RAILWAY_CLIENT_ID and RAILWAY_CLIENT_SECRET."
							: "Could not start sign-in. Check the server logs for details.",
					);
					return Response.redirect(redirectTo, 302);
				}
			},
		},
		"/api/auth/callback": {
			GET: async (req: Request) => {
				const url = new URL(req.url);
				const wantsJson = url.searchParams.get("json") === "1";
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				if (!code) {
					if (wantsJson) {
						return jsonPretty(
							{ error: "Missing OAuth authorization code." },
							{ status: 400 },
						);
					}
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set("auth_error", "Missing sign-in code.");
					return Response.redirect(redirectTo, 302);
				}
				if (!state) {
					if (wantsJson) {
						return jsonPretty(
							{ error: "Missing OAuth state." },
							{ status: 400 },
						);
					}
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set("auth_error", "Missing sign-in state.");
					return Response.redirect(redirectTo, 302);
				}

				prunePkceSessions();
				const pkceSession = oauthPkceSessions.get(state);
				oauthPkceSessions.delete(state);
				if (!pkceSession || pkceSession.expiresAt <= Date.now()) {
					if (wantsJson) {
						return jsonPretty(
							{ error: "OAuth session expired. Start the login flow again." },
							{ status: 400 },
						);
					}
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set(
						"auth_error",
						"Sign-in session expired. Please try again.",
					);
					return Response.redirect(redirectTo, 302);
				}

				const client = await getRailwayOAuthClient();
				const tokenPayload = new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: client.redirectUri,
					client_id: client.clientId,
					code_verifier: pkceSession.codeVerifier,
				});
				if (client.clientSecret) {
					tokenPayload.set("client_secret", client.clientSecret);
				}

				const response = await fetch(
					"https://backboard.railway.com/oauth/token",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							Accept: "application/json",
						},
						body: tokenPayload.toString(),
					},
				);

				const text = await response.text();
				let data: unknown = text;
				try {
					data = JSON.parse(text) as unknown;
				} catch {
					// Non-JSON response.
				}

				if (!response.ok) {
					if (wantsJson) {
						return jsonPretty(
							{
								error: "Railway OAuth token exchange failed.",
								status: response.status,
								data,
							},
							{ status: 400 },
						);
					}
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set(
						"auth_error",
						"Sign-in failed. Please try again.",
					);
					return Response.redirect(redirectTo, 302);
				}

				const tokenResponse =
					data && typeof data === "object"
						? (data as Record<string, unknown>)
						: null;
				const accessToken =
					tokenResponse && typeof tokenResponse.access_token === "string"
						? tokenResponse.access_token
						: null;
				const expiresInSeconds =
					tokenResponse && typeof tokenResponse.expires_in === "number"
						? Math.max(60, Math.floor(tokenResponse.expires_in))
						: 3600;

				if (!accessToken) {
					if (wantsJson) {
						return jsonPretty(
							{ error: "OAuth token response is missing access_token.", data },
							{ status: 400 },
						);
					}
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set(
						"auth_error",
						"Sign-in completed but no token was returned.",
					);
					return Response.redirect(redirectTo, 302);
				}

				const authorization = await authorizeTokenForService(accessToken);
				if (!authorization.ok) {
					if (wantsJson) {
						return jsonPretty(
							{
								error:
									"OAuth token does not have access to configured Railway service.",
								serviceId: env.RAILWAY_SERVICE_ID,
								authorization,
							},
							{
								status: 403,
								headers: { "Set-Cookie": clearAuthCookie() },
							},
						);
					}
					const redirectTo = new URL("/", req.url);
					redirectTo.searchParams.set(
						"auth_error",
						"No access to this service. Ask an admin for access.",
					);
					return redirectWithHeaders(redirectTo, {
						"Set-Cookie": clearAuthCookie(),
					});
				}

				if (wantsJson) {
					return jsonPretty(
						{
							data,
							authorizedService: authorization.service,
						},
						{
							headers: {
								"Set-Cookie": buildAuthCookie(accessToken, expiresInSeconds),
							},
						},
					);
				}

				return redirectWithHeaders(new URL("/", req.url), {
					"Set-Cookie": buildAuthCookie(accessToken, expiresInSeconds),
				});
			},
		},
		"/api/auth/me": {
			GET: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;
				const accessToken = readCookie(req, RAILWAY_AUTH_COOKIE_NAME);
				const profile = accessToken
					? await fetchRailwayUserProfile(accessToken)
					: null;
				const fallbackNameFromEmail = profile?.email?.includes("@")
					? profile.email.split("@")[0]
					: null;
				const fallbackNameFromSub =
					profile?.sub && profile.sub.length > 0
						? `user-${profile.sub.slice(0, 6)}`
						: null;
				const displayName =
					profile?.name ??
					fallbackNameFromEmail ??
					fallbackNameFromSub ??
					"Railway user";
				return json({
					ok: true,
					user: {
						name: displayName,
						email: profile?.email ?? null,
						picture: profile?.picture ?? null,
						sub: profile?.sub ?? null,
					},
				});
			},
		},
		"/api/auth/logout": {
			POST: async (req: Request) => {
				const accessToken = await getValidatedAccessToken(req);
				if (!accessToken) {
					return json(
						{ error: "Unauthorized." },
						{
							status: 401,
							headers: {
								"Set-Cookie": clearAuthCookie(),
							},
						},
					);
				}

				return json(
					{ ok: true },
					{
						headers: {
							"Set-Cookie": clearAuthCookie(),
						},
					},
				);
			},
		},
		"/api/files": {
			GET: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;

				try {
					const { searchParams } = new URL(req.url);
					const { relative, resolved } = resolveSafePath(
						searchParams.get("path"),
					);
					const info = await stat(resolved);
					if (!info.isDirectory()) {
						return json({ error: "Path is not a folder." }, { status: 400 });
					}

					const entries = await readdir(resolved, { withFileTypes: true });
					const hiddenPaths = new Set([RAILWAY_OAUTH_CLIENT_CACHE_PATH]);
					const items = await Promise.all(
						entries
							.filter(
								(entry) => !hiddenPaths.has(path.join(resolved, entry.name)),
							)
							.map(async (entry) => {
								const fullPath = path.join(resolved, entry.name);
								const info = await stat(fullPath);
								return {
									name: entry.name,
									path: path.posix.join(relative, entry.name),
									type: entry.isDirectory() ? "dir" : "file",
									size: info.size,
									mtime: info.mtime.toISOString(),
								};
							}),
					);

					items.sort((a, b) => {
						if (a.type !== b.type) {
							return a.type === "dir" ? -1 : 1;
						}
						return a.name.localeCompare(b.name);
					});

					return json({ path: relative, entries: items });
				} catch (error) {
					return json(
						{ error: error instanceof Error ? error.message : "List failed." },
						{ status: 400 },
					);
				}
			},
			DELETE: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;

				try {
					const { searchParams } = new URL(req.url);
					const { relative, resolved } = resolveSafePath(
						searchParams.get("path"),
					);
					if (resolved === FILES_ROOT) {
						return json({ error: "Refusing to delete root." }, { status: 400 });
					}

					const targetInfo = await stat(resolved);
					if (targetInfo.isDirectory()) {
						await rm(resolved, { recursive: true, force: true });
					} else {
						await rm(resolved, { force: true });
					}

					return json({ ok: true, path: relative });
				} catch (error) {
					return json(
						{
							error: error instanceof Error ? error.message : "Delete failed.",
						},
						{ status: 400 },
					);
				}
			},
		},
		"/api/files/content": {
			GET: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;

				try {
					const { searchParams } = new URL(req.url);
					const { relative, resolved } = resolveSafePath(
						searchParams.get("path"),
					);
					const info = await stat(resolved);

					if (!info.isFile()) {
						return json({ error: "Path is not a file." }, { status: 400 });
					}

					if (info.size > MAX_PREVIEW_BYTES) {
						return json(
							{ error: "File too large to preview." },
							{ status: 413 },
						);
					}

					const file = Bun.file(resolved);
					const sample = new Uint8Array(
						await file.slice(0, 1024).arrayBuffer(),
					);

					if (sample.includes(0)) {
						return json(
							{ error: "Binary file preview is not supported." },
							{ status: 415 },
						);
					}

					const content = await file.text();
					return json({ path: relative, content });
				} catch (error) {
					return json(
						{
							error: error instanceof Error ? error.message : "Preview failed.",
						},
						{ status: 400 },
					);
				}
			},
		},
		"/api/files/upload": {
			POST: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;

				try {
					const { searchParams } = new URL(req.url);
					const { relative } = resolveSafePath(searchParams.get("path"));
					const fileNameHeader = req.headers.get("x-file-name");
					const relativePathHeader = req.headers.get("x-relative-path");
					const uploadPath = relativePathHeader
						? normalizeUploadRelativePath(relativePathHeader)
						: path.basename(fileNameHeader || "upload.bin");
					const destinationRelative = path.posix.join(relative, uploadPath);
					const { resolved: destination } =
						resolveSafePath(destinationRelative);

					if (!req.body) {
						return json({ error: "Missing upload body." }, { status: 400 });
					}

					const bytes = new Uint8Array(await req.arrayBuffer());
					await mkdir(path.dirname(destination), { recursive: true });
					await Bun.write(destination, bytes);

					return json({ ok: true, path: destinationRelative });
				} catch (error) {
					return json(
						{
							error: error instanceof Error ? error.message : "Upload failed.",
						},
						{ status: 400 },
					);
				}
			},
		},
		"/api/console": {
			POST: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;

				try {
					const body = (await req.json()) as { command?: string };
					const command = normalizeConsoleCommand(body.command ?? "");

					if (!command) {
						return json({ error: "Command is required." }, { status: 400 });
					}

					sendConsoleCommand(command);
					return json({ ok: true });
				} catch (error) {
					return json(
						{
							error:
								error instanceof Error
									? error.message
									: "Console command failed.",
						},
						{ status: 400 },
					);
				}
			},
		},
		"/api/server/status": {
			GET: async (req: Request) => {
				const authError = await ensureAuth(req);
				if (authError) return authError;
				try {
					const data = await fetchServerStatus();
					const cached =
						statusCache &&
						Date.now() - statusCache.fetchedAt < MC_STATUS_CACHE_MS + 250;
					return json({
						ok: true,
						data,
						process: getServerState(),
						cached,
						fetchedAt: statusCache?.fetchedAt ?? Date.now(),
					});
				} catch (error) {
					if (statusCache) {
						return json({
							ok: true,
							data: statusCache.data,
							cached: true,
							stale: true,
							error:
								error instanceof Error ? error.message : "Status ping failed.",
							fetchedAt: statusCache.fetchedAt,
						});
					}
					return json({
						ok: true,
						data: createBaseStatusSnapshot(),
						cached: false,
						stale: true,
						error:
							error instanceof Error ? error.message : "Status ping failed.",
						fetchedAt: Date.now(),
					});
				}
			},
		},
		"/api/console/ws": {
			GET: async (req: Request) => {
				const accessToken = await getValidatedAccessToken(req);
				if (!accessToken) {
					return json({ error: "Unauthorized." }, { status: 401 });
				}

				const { searchParams } = new URL(req.url);
				const upgraded = server.upgrade(req, {
					data: {
						backlogLines: getBacklogLines(searchParams.get("tail")),
						accessToken,
						unsubscribe: null,
						authTimer: null,
					} satisfies ConsoleLogSocketData,
				});

				if (upgraded) return;
				return new Response("Upgrade failed.", { status: 400 });
			},
		},
		"/api/console/logs": {
			GET: async (req: Request) => {
				const accessToken = await getValidatedAccessToken(req);
				if (!accessToken) {
					return json({ error: "Unauthorized." }, { status: 401 });
				}

				const { searchParams } = new URL(req.url);
				const backlogLines = getBacklogLines(searchParams.get("tail"));

				let unsubscribe: (() => void) | null = null;
				let authTimer: ReturnType<typeof setInterval> | null = null;
				let closed = false;

				const teardown = () => {
					closed = true;
					unsubscribe?.();
					unsubscribe = null;
					if (authTimer) clearInterval(authTimer);
					authTimer = null;
				};

				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						controller.enqueue(encoder.encode(": connected\n\n"));

						unsubscribe = subscribeToLogs(
							(line) => {
								try {
									controller.enqueue(encoder.encode(`data: ${line}\n\n`));
								} catch {
									// Client went away mid-enqueue; stop feeding it.
									teardown();
								}
							},
							{ backlogLines },
						);

						authTimer = setInterval(() => {
							void authorizeTokenForService(accessToken)
								.then((auth) => {
									// A blip reaching Railway must not sign the user out;
									// the next tick asks again.
									if (auth.ok || auth.transportError) return;
									if (closed) return;
									teardown();
									try {
										controller.close();
									} catch {
										// The client already cancelled the stream.
									}
								})
								.catch(() => {
									// Nothing here may reject: this process is PID 1.
								});
						}, WS_AUTH_REVALIDATE_MS);
					},
					cancel: teardown,
				});

				return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				});
			},
		},
		"/": index,
	},
	websocket: {
		open(ws: ServerWebSocket<ConsoleLogSocketData>) {
			const data = ws.data;
			if (!data.accessToken) {
				ws.close(1008, "Unauthorized");
				return;
			}

			data.unsubscribe = subscribeToLogs(
				(line) => {
					try {
						ws.send(line);
					} catch {
						// Socket is already closing; close() handles the unsubscribe.
					}
				},
				{ backlogLines: data.backlogLines },
			);

			data.authTimer = setInterval(() => {
				void authorizeTokenForService(data.accessToken)
					.then((auth) => {
						if (auth.ok || auth.transportError) return;
						ws.close(1008, "Unauthorized");
					})
					.catch(() => {
						// Nothing here may reject: this process is PID 1.
					});
			}, WS_AUTH_REVALIDATE_MS);
		},
		message() {
			// No incoming websocket messages are handled for this route.
		},
		close(ws: ServerWebSocket<ConsoleLogSocketData>) {
			const data = ws.data;
			data.unsubscribe?.();
			data.unsubscribe = null;
			if (data.authTimer) clearInterval(data.authTimer);
			data.authTimer = null;
		},
	},
});

let shuttingDown = false;

/**
 * This process is PID 1 in the container, so it owns the shutdown handshake:
 * tell Minecraft to save and quit before the runtime pulls the rug.
 */
const shutdown = async (signal: NodeJS.Signals) => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`${signal} received — stopping Minecraft…`);
	await stopServer();
	server.stop(true);
	process.exit(0);
};

// Last line of defence. Bun exits on an unhandled rejection, and because this
// process is PID 1 that would SIGKILL Minecraft without the stop handshake —
// staying up with a loud log is strictly better than losing the world's save.
process.on("unhandledRejection", (reason) => {
	console.error("Unhandled rejection:", formatUnknownError(reason));
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`🚀 Control UI running at ${server.url}`);
void startServer();
