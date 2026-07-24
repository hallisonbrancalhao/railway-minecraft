# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-contained Minecraft server image with a Bun + React control panel: live console, command
sender, and a file browser over `/data`. Built for Railway.

**The control app is the container entrypoint and supervises Minecraft itself.** `src/index.ts`
runs as PID 1, spawns `java` via `Bun.spawn` with piped stdio, and owns the process lifecycle.
There is no upstream Minecraft image, no supervisor shell script, no named pipe, and no log-file
tailing — commands go to the child's stdin and log lines come off its stdout.

## Commands

```bash
bun install

bun run dev:css     # terminal 1 — Tailwind watcher (required, see below)
bun dev             # terminal 2 — bun --hot src/index.ts

bun run lint        # biome check .        — green, keep it that way
bun run format      # biome check --write .
bun run typecheck   # tsc --noEmit
bun run build       # build:css + bundle src/index.html -> dist/
bun start           # NODE_ENV=production bun src/index.ts
```

**There are no tests.** `lint`, `typecheck` and `build` are the only gates, and all three are
green — CI (`.github/workflows/ci.yml`) runs them plus a full `docker build`, which is what
actually verifies the pinned jar's SHA1.

`typescript` is pinned to `5.9.2` on purpose: newer versions removed `baseUrl`, which
`tsconfig.json` still uses for the `@/*` alias, so an unpinned `bunx tsc` fails with `TS5102`.

`biome.json` excludes three things deliberately — `dist`, the vendored `src/components/ui`, and
**all CSS** (Biome's CSS parser cannot parse Tailwind's `@apply`). `useExhaustiveDependencies`
is off because auto-fixing `useEffect` deps in `frontend.tsx` would change runtime behaviour.

### Two things that block a local run

1. **`src/tailwind.css` is a generated artifact** (minified, committed). `src/index.html` links it
   via `<link>`, and Bun's bundler does **not** produce it — only `bunx tailwindcss` does. After
   touching any class name or `src/index.css`, run `dev:css` or `build:css`.
2. **`RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_SERVICE_ID` are required** (`src/env.ts`,
   `@t3-oss/env-core`); the process throws at boot without them. `/data` must also exist. Without
   `java` on PATH the UI still runs — the console just reports the server as not running.

## Architecture

### Minecraft supervision — `src/mc-process.ts`

Owns the child process and is the single source of log lines. Key invariants:

- **One in-memory broadcaster**, not a file tail. `subscribeToLogs(fn, { backlogLines })` replays a
  ring buffer (`BACKLOG_LINES = 1000`) then streams live lines, and returns an unsubscribe
  function. Every consumer — WebSocket and SSE — goes through it. Callers must unsubscribe on
  close or the Set leaks.
- **stdout and stderr are decoded with a carry buffer** so a line split across chunks is not
  emitted twice. Both streams feed the same broadcaster.
- **Supervisor messages are prefixed `[control]`** and injected into the same stream, so start /
  crash / restart notices appear in the web console alongside real server output.
- **`EULA` gates startup.** If it is not truthy, `startServer()` sets state `blocked`, emits an
  explanatory line, and never spawns. It deliberately does not accept the EULA on the operator's
  behalf.
- **`server.properties` is seeded on first boot only**; after that it belongs to the operator, who
  edits it through the file browser. `eula.txt` is written on every start when `EULA` is truthy.
- **Shutdown is a handshake, not a kill**: write `stop` to stdin, await exit, SIGKILL only after
  `STOP_GRACE_MS` (90s). `src/index.ts` wires this to SIGTERM/SIGINT. Getting this wrong corrupts
  worlds.
- **Crash restarts use exponential backoff** and are suppressed once `stopServer()` has run.
- Readiness is detected by matching `Done (Ns)!` in the log stream, exposed via `getServerState()`.

### HTTP — `src/index.ts` (`Bun.serve` with `routes`)

| Route | Purpose |
| --- | --- |
| `/api/auth/redirect` \| `/callback` \| `/me` \| `/logout` | Railway OAuth (PKCE) |
| `/api/files` (GET/DELETE), `/api/files/content`, `/api/files/upload` | file browser rooted at `/data` |
| `/api/console` (POST) | one command line to the child's stdin |
| `/api/console/ws` | WebSocket log stream — **what the UI uses** |
| `/api/console/logs` | SSE equivalent, currently unused by the frontend |
| `/api/server/status` | `minecraftstatuspinger` ping (8s cache) + `getServerState()` |
| `/` | `import index from "./index.html"` |

**Auth is Railway-account-based, not a password.** Dynamic OAuth client registration against
`backboard.railway.com/oauth/register` (persisted to `/data/.railway-oauth-client.json`, falling
back to `RAILWAY_CLIENT_ID`/`SECRET` if registration fails) → PKCE authorize → token in the
`railway_oauth_access_token` HttpOnly cookie. **Authorization** = querying
`service(id: RAILWAY_SERVICE_ID)` on Railway's GraphQL API with that token. Cached 15s per token;
long-lived WS/SSE streams re-validate on a 30s interval and close with `1008` when access is
revoked.

`/data/.railway-oauth-client.json` is filtered out of `/api/files` listings — keep it hidden if you
touch that handler.

**Every path goes through `resolveSafePath()`**, which resolves against `FILES_ROOT` and rejects
anything escaping it; uploads additionally run `normalizeUploadRelativePath()`. Never bypass these
when adding a filesystem route.

The status ping falls back to `env.MC_VERSION` when it fails, since the jar is pinned at build time
and the version is known even while the server is still booting.

### Frontend — `src/frontend.tsx` (~1600 lines, `LoginPage` + `App`)

- `src/components/ui/*` is shadcn/ui (`components.json`, alias `@/*` → `./src/*`).
- The console is **`ghostty-web`, not a PTY**. `await init()` (WASM) must complete before
  `new Terminal()`. Keystrokes echo into a client-side buffer; Enter POSTs the line to
  `/api/console`. Output is one-way over the WebSocket.
- **The WS contract is one log line per message, and the client sends no query params.** Preserve
  that shape when touching the broadcaster or the frontend needs changes too.
- The WS reconnects with exponential backoff + jitter (capped at 8s).
- Only `BUN_PUBLIC_*` env vars reach the client bundle (`bunfig.toml`, `--env` in `build`).
- File-row selection is styled via `data-selected`, matched by `.dash-row[data-selected="true"]`
  in `src/index.css`. Renaming that attribute silently kills the highlight, and any change needs
  `build:css` to regenerate `src/tailwind.css`.

### Deployment — `Dockerfile`

Three stages, no upstream Minecraft image:

1. `oven/bun` — Tailwind CSS, then `bun build ./src/index.ts --compile` into one binary with the
   frontend embedded
2. `debian:bookworm-slim` — downloads the pinned `server.jar` and verifies its SHA1
3. `eclipse-temurin:25-jre` — runtime; the binary is the `ENTRYPOINT`

The jar lives at `/opt/minecraft/server.jar`, deliberately outside `/data` (the mounted volume and
the file browser root). The container runs as root so it can write to the volume whatever the
platform's ownership. `dist/` is not used by the image.

**Changing the Minecraft version touches four things that must agree:** `MC_VERSION`,
`MC_SERVER_URL`, `MC_SERVER_SHA1` (all `ARG`s at the top of the Dockerfile) and the
`eclipse-temurin:<N>-jre` tag. All four derive from Mojang's manifest —
`piston-meta.mojang.com/mc/game/version_manifest_v2.json` → `latest.release` → the version JSON →
`downloads.server.{url,sha1}` and `javaVersion.majorVersion`. **26.2 requires Java 25; Java 21 will
not run it.** Never guess a version string or a JRE major from memory: Minecraft left the `1.x.y`
scheme after `1.21.11` and now uses `YY.N` (`26.1`, `26.2`, snapshots `26.3-snapshot-5`).

**World data cannot be downgraded.** Pinning below the version that last wrote `/data` breaks the
world. Railway service env vars also override Dockerfile `ENV`.

### Railway packaging — `railway.json`

**Railway ignores `EXPOSE`.** It injects `PORT` and routes public HTTP traffic there, so
`getControlPort()` reads `PORT` first and `Bun.serve` binds `0.0.0.0`. Binding anything else
gives every template user a 502 plus a failing health check. Do not "simplify" this back to
`CONTROL_PORT`.

`railway.json` carries build/deploy settings only — the schema has exactly four top-level keys
(`$schema`, `build`, `deploy`, `environments`) with `additionalProperties: false`, and **no field
for variables, volumes, or TCP proxy**. Those are configured in Railway's template composer UI;
there is no in-repo file for them. (`.railway/railway.ts` IaC exists but is experimental,
CLI-applied rather than deploy-time, and mutually exclusive with `railway.json` — don't add it.)

Three deploy values are world-safety, not tuning: `numReplicas: 1` and `overlapSeconds: 0` stop
two JVMs from ever sharing the volume, and `drainingSeconds: 120` covers the 90s stop handshake.

Enum values must be UPPERCASE (`DOCKERFILE`, `ON_FAILURE`); the docs' lowercase examples fail
schema validation in editors.

## Leftovers

`docker/start.sh` is from the previous itzg-based image and is no longer referenced by the
Dockerfile or anything else. It can be deleted — this repo is not under version control, so that
was left as the operator's call.

## Style

TypeScript strict is on, plus `noUncheckedIndexedAccess` and `noImplicitOverride`. Route handlers
follow a consistent shape: `ensureAuth` → `try` → `json({...})` / `json({ error }, { status })`;
errors are never thrown out of a handler. Zod schemas validate every external payload (Railway
GraphQL, OAuth, Minecraft ping) — keep that pattern for new external calls.
