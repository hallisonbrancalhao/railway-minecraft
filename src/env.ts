import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		// Minecraft server process (supervised by this app — see src/mc-process.ts).
		MC_VERSION: z.string().default("26.2"),
		MC_JAR_PATH: z.string().default("/opt/minecraft/server.jar"),
		MC_MEMORY: z.string().default("2G"),
		JVM_OPTS: z.string().optional(),
		EULA: z.string().optional(),
		MC_SERVER_HOST: z.string().default("127.0.0.1"),
		MC_SERVER_PORT: z.string().optional(),
		SERVER_PORT: z.string().optional(),
		RAILWAY_TCP_PROXY_DOMAIN: z.string().default(""),
		RAILWAY_TCP_PROXY_PORT: z.string().default(""),
		RAILWAY_PUBLIC_DOMAIN: z.string(),
		RAILWAY_SERVICE_ID: z.string(),
		// Railway injects PORT and routes public HTTP traffic to it; the Dockerfile's
		// EXPOSE is ignored by the platform. PORT must therefore win over CONTROL_PORT.
		PORT: z.string().optional(),
		CONTROL_PORT: z.string().optional(),
		APP_PORT: z.string().optional(),
		RCON_HOST: z.string().optional(),
		RCON_PORT: z.string().optional(),
		RCON_PASSWORD: z.string().optional(),
		RAILWAY_CLIENT_ID: z.string().optional(),
		RAILWAY_CLIENT_SECRET: z.string().optional(),
		RAILWAY_OAUTH_REGISTRATION_ACCESS_TOKEN: z.string().optional(),
		RAILWAY_OAUTH_REGISTRATION_CLIENT_URI: z.string().optional(),
	},
	runtimeEnv: Bun.env,
	emptyStringAsUndefined: true,
});
