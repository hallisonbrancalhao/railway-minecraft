import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";
import { env } from "./env";

const DATA_DIR = path.resolve("/data");
const BACKLOG_LINES = 1000;
const STOP_GRACE_MS = 90_000;
const RESTART_BASE_MS = 2_000;
const RESTART_MAX_MS = 60_000;

export type ServerState =
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "crashed"
	| "blocked";

type LogSubscriber = (line: string) => void;

type McSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const subscribers = new Set<LogSubscriber>();
const backlog: string[] = [];

let proc: McSubprocess | null = null;
let state: ServerState = "stopped";
let ready = false;
let shuttingDown = false;
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

const isTruthy = (value: string | undefined) =>
	Boolean(value) &&
	["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");

const emit = (line: string) => {
	// Also this container's stdout, so `railway logs` / `docker logs` still show
	// the server. Capturing the child's output must not blind the platform.
	console.log(line);
	backlog.push(line);
	if (backlog.length > BACKLOG_LINES) backlog.shift();
	for (const subscriber of subscribers) {
		try {
			subscriber(line);
		} catch {
			// A failing subscriber must never stall the log fan-out.
		}
	}
};

/** Lines produced by the supervisor itself, so they show up in the web console. */
const emitSupervisor = (message: string) => emit(`[control] ${message}`);

export const subscribeToLogs = (
	subscriber: LogSubscriber,
	options: { backlogLines?: number } = {},
) => {
	const wanted = Math.max(0, options.backlogLines ?? BACKLOG_LINES);
	const start = Math.max(0, backlog.length - wanted);
	for (const line of backlog.slice(start)) subscriber(line);
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
};

const markReadyFromLog = (line: string) => {
	if (ready) return;
	if (!/\bDone \([\d.]+s\)!/.test(line)) return;
	ready = true;
	state = "running";
	// Only a server that actually finished booting counts as a healthy start.
	// Resetting on spawn instead would flatten the backoff into a hot restart
	// loop for anything that dies during startup (bad JVM flag, corrupt world).
	restartAttempts = 0;
};

const consumeStream = async (stream: ReadableStream<Uint8Array>) => {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let carry = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		carry += decoder.decode(value, { stream: true });
		const lines = carry.split(/\r?\n/);
		carry = lines.pop() ?? "";
		for (const line of lines) {
			markReadyFromLog(line);
			emit(line);
		}
	}
	if (carry.length > 0) emit(carry);
};

const getServerPort = () => {
	const parsed = Number.parseInt(
		env.MC_SERVER_PORT ?? env.SERVER_PORT ?? "25565",
		10,
	);
	return Number.isNaN(parsed) ? 25565 : parsed;
};

/**
 * Mojang requires an explicit EULA acceptance. We only ever write the file when
 * the operator opted in via the EULA env var — never on their behalf by default.
 */
const ensureEula = async () => {
	if (!isTruthy(env.EULA)) return false;
	await Bun.write(path.join(DATA_DIR, "eula.txt"), "eula=true\n");
	return true;
};

/**
 * Seed server.properties on first boot only. After that the file belongs to the
 * operator, who edits it through the file browser.
 */
const ensureServerProperties = async () => {
	const target = path.join(DATA_DIR, "server.properties");
	if (await Bun.file(target).exists()) return;
	await Bun.write(
		target,
		[
			`server-port=${getServerPort()}`,
			"motd=A Minecraft Server on Railway",
			"enable-rcon=false",
			"",
		].join("\n"),
	);
};

const buildJavaArgs = () => {
	const custom = env.JVM_OPTS?.trim();
	const memory = env.MC_MEMORY.trim();
	const tuning = custom
		? custom.split(/\s+/).filter(Boolean)
		: [`-Xms${memory}`, `-Xmx${memory}`, "-XX:+UseG1GC"];
	return [...tuning, "-jar", env.MC_JAR_PATH, "nogui"];
};

const scheduleRestart = () => {
	if (shuttingDown || restartTimer) return;
	restartAttempts += 1;
	const backoff = Math.min(
		RESTART_MAX_MS,
		RESTART_BASE_MS * 2 ** Math.min(5, restartAttempts - 1),
	);
	emitSupervisor(
		`restarting in ${Math.round(backoff / 1000)}s (attempt ${restartAttempts})`,
	);
	restartTimer = setTimeout(() => {
		restartTimer = null;
		void startServer();
	}, backoff);
};

const handleExit = (
	exitCode: number | null,
	signalCode: number | string | null,
) => {
	proc = null;
	ready = false;
	const how = signalCode ? `signal ${signalCode}` : `exit code ${exitCode}`;
	if (shuttingDown) {
		state = "stopped";
		emitSupervisor(`minecraft stopped (${how})`);
		return;
	}
	state = exitCode === 0 ? "stopped" : "crashed";
	emitSupervisor(`minecraft exited (${how})`);
	scheduleRestart();
};

/**
 * Never rejects. This runs as a floating promise inside a process that is PID 1,
 * so a failure here (full volume, read-only mount, missing java) must surface in
 * the web console as a log line instead of killing the container.
 */
export const startServer = async () => {
	if (proc || shuttingDown) return;
	state = "starting";
	ready = false;

	try {
		await mkdir(DATA_DIR, { recursive: true });

		if (!(await ensureEula())) {
			state = "blocked";
			emitSupervisor(
				"refusing to start: set EULA=true to accept the Minecraft EULA (https://aka.ms/MinecraftEULA)",
			);
			return;
		}

		await ensureServerProperties();
		const args = buildJavaArgs();
		emitSupervisor(
			`starting minecraft ${env.MC_VERSION}: java ${args.join(" ")}`,
		);

		proc = Bun.spawn(["java", ...args], {
			cwd: DATA_DIR,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			onExit: (_subprocess, exitCode, signalCode) =>
				handleExit(exitCode, signalCode),
		});

		void consumeStream(proc.stdout).catch(() => {});
		void consumeStream(proc.stderr).catch(() => {});
	} catch (error) {
		proc = null;
		state = "crashed";
		emitSupervisor(
			`failed to start: ${error instanceof Error ? error.message : String(error)}`,
		);
		scheduleRestart();
	}
};

export const sendConsoleCommand = (command: string) => {
	if (!proc) throw new Error(`Minecraft is not running (state: ${state}).`);
	proc.stdin.write(`${command}\n`);
	proc.stdin.flush();
};

export const stopServer = async (graceMs = STOP_GRACE_MS) => {
	shuttingDown = true;
	if (restartTimer) clearTimeout(restartTimer);
	restartTimer = null;
	const running = proc;
	if (!running) return;

	state = "stopping";
	emitSupervisor("sending 'stop' and waiting for a clean save…");
	try {
		running.stdin.write("stop\n");
		running.stdin.flush();
	} catch {
		running.kill("SIGTERM");
	}

	const killTimer = setTimeout(() => {
		emitSupervisor(
			`server did not stop within ${Math.round(graceMs / 1000)}s; killing`,
		);
		running.kill("SIGKILL");
	}, graceMs);
	await running.exited;
	clearTimeout(killTimer);
};

export const getServerState = () => ({
	state,
	ready,
	pid: proc?.pid ?? null,
	version: env.MC_VERSION,
	restartAttempts,
});
