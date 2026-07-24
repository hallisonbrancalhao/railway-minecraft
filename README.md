# Minecraft Control UI — Railway template

A self-contained Minecraft server with a web control panel: live console, command sender,
and a file browser rooted at `/data`. One service, one container, no sidecars.

<!-- Replace TEMPLATE_CODE after publishing the template (see "Publishing as a Railway template"). -->
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE)

Pinned to **Minecraft 26.2** (vanilla, Java 25). The server jar is downloaded at build time and
verified against Mojang's SHA1 — no upstream Minecraft image is involved.

The Bun control app **is** the container entrypoint. It spawns the Minecraft server as a child
process and owns its stdin/stdout directly: no supervisor script, no named pipe, no log-file
tailing. Commands go to the child's stdin; log lines come off its stdout.

## Publishing as a Railway template

Railway template configuration lives in the **template composer**, not in this repo.
`railway.json` here only carries build and deploy settings — the schema has no field for
variables, volumes, or networking. Everything below must be set in the composer UI
(Railway docs: [Create a template](https://docs.railway.com/templates/create)):

1. **Source** — this GitHub repo. The `Dockerfile` is detected automatically.
2. **Variables** — add `EULA`, required, with a description pointing at
   <https://aka.ms/MinecraftEULA>. Do **not** add `RAILWAY_PUBLIC_DOMAIN` or
   `RAILWAY_SERVICE_ID`; Railway injects those itself.
3. **Volume** — attach one, mount path `/data`. Without it every deploy wipes the world.
4. **Networking → HTTP** — enable a public domain for the control panel. This is not optional:
   `RAILWAY_PUBLIC_DOMAIN` is only populated when the service has a domain, and `src/env.ts`
   requires it, so the app refuses to boot without one.
5. **Networking → TCP Proxy** — expose port `25565` so players can connect. Railway then fills
   `RAILWAY_TCP_PROXY_DOMAIN` / `RAILWAY_TCP_PROXY_PORT`, which the panel displays as the join
   address.

### Why the deploy settings in `railway.json` matter

| Setting | Reason |
| --- | --- |
| `numReplicas: 1` | Two replicas would run two JVMs against one volume and corrupt the world. |
| `overlapSeconds: 0` | Railway's zero-downtime deploy otherwise starts the new container before stopping the old one — again two servers writing `/data`. |
| `drainingSeconds: 120` | Covers the supervisor's 90s stop handshake. With the default the platform would SIGKILL mid-save. |
| `restartPolicyType: ON_FAILURE` | The app already restarts a crashed server itself, with backoff. |

## Access control

There is no password. Users sign in with **Railway OAuth**, and are authorized only if their
token can see this service (`RAILWAY_SERVICE_ID`) via Railway's GraphQL API. Long-lived console
streams re-check every 30s and disconnect when access is revoked.

## Environment

Required:

| Variable | Notes |
| --- | --- |
| `EULA` | Must be `true`. The server refuses to start otherwise — <https://aka.ms/MinecraftEULA> |
| `RAILWAY_PUBLIC_DOMAIN` | Injected by Railway; only set when the service has an HTTP domain |
| `RAILWAY_SERVICE_ID` | Injected by Railway; access to this service is what authorizes a user |

Minecraft process:

| Variable | Default | Notes |
| --- | --- | --- |
| `MC_VERSION` | `26.2` | Set by the Dockerfile from the pinned build. Reported by the status API; it does **not** change which jar runs. |
| `MC_JAR_PATH` | `/opt/minecraft/server.jar` | |
| `MC_MEMORY` | `2G` | Used for `-Xms`/`-Xmx` |
| `JVM_OPTS` | — | Replaces the default flags entirely (`-Xms`/`-Xmx`/`-XX:+UseG1GC`). An unrecognised flag stops the JVM from starting at all. |
| `MC_SERVER_HOST` | `127.0.0.1` | Target of the status ping |
| `MC_SERVER_PORT` / `SERVER_PORT` | `25565` | Also seeds `server-port` in a first-boot `server.properties` |

Control panel:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | — | Injected by Railway and **takes precedence**. Railway ignores the Dockerfile's `EXPOSE` and routes public traffic here. |
| `CONTROL_PORT` / `APP_PORT` | `3000` | Local override, used when `PORT` is absent |
| `RAILWAY_TCP_PROXY_DOMAIN`, `RAILWAY_TCP_PROXY_PORT` | — | Shown as the public join address |
| `RAILWAY_CLIENT_ID`, `RAILWAY_CLIENT_SECRET` | — | Fallback only, used when dynamic OAuth client registration fails |

`RCON_HOST`, `RCON_PORT` and `RCON_PASSWORD` are declared in `src/env.ts` but nothing reads them.

## Development

```bash
bun install

bun run dev:css     # terminal 1 — Tailwind watcher
bun dev             # terminal 2
```

`src/tailwind.css` is a generated artifact that `src/index.html` links directly. Bun's bundler
does not produce it — without `dev:css` or `build:css` the UI renders unstyled. It is committed
so a fresh clone works, and CI fails if it drifts from `src/index.css`.

Local runs need `RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_SERVICE_ID` set, plus a readable `/data`.
Without `java` on PATH the panel still works — the console just reports the server as not running.

```bash
bun run lint        # biome
bun run typecheck   # tsc --noEmit
bun run build       # build:css + bundle the frontend into dist/
bun start
```

There are no tests. `dist/` is not used by the container — `bun build --compile` embeds the
frontend into the binary.

## Changing the Minecraft version

The jar is pinned at build time and verified against its SHA1. Four things must agree, and all
of them come from Mojang's metadata:

1. `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` → `latest.release`
2. the matching entry in `versions[]` → its `url`
3. that version JSON → `downloads.server.url`, `downloads.server.sha1`
4. that same JSON → **`javaVersion.majorVersion`**, which must match the
   `eclipse-temurin:<N>-jre` tag in the `Dockerfile`

Update the `MC_VERSION`, `MC_SERVER_URL` and `MC_SERVER_SHA1` build args together. 26.2 requires
Java 25; Java 21 will not run it. Note that Minecraft left the `1.x.y` scheme after `1.21.11` and
now uses `YY.N` — never guess a version string from memory.

**World data cannot be downgraded.** Pinning to a version older than the one that last wrote
`/data` will fail to load the world. Check the running version in the panel first, and back up
the volume.

## Container

Three stages, no upstream Minecraft image:

1. `oven/bun` — compiles the control app into a single binary (frontend embedded)
2. `debian:bookworm-slim` — downloads the pinned `server.jar` and verifies its SHA1
3. `eclipse-temurin:25-jre` — runtime; the binary is the `ENTRYPOINT`

On SIGTERM the app writes `stop` to the server's stdin and waits for a clean save (90s) before
exiting, so shutdowns do not corrupt the world. A crashed server is restarted with exponential
backoff, and the backoff only resets once the server has actually finished booting.

Minecraft's output is also mirrored to the container's stdout, so `railway logs` works alongside
the web console.

The container runs as root so it can write to the mounted volume regardless of how the platform
owns it.

## Notes

- File preview is limited to small text files.
- `/data/.railway-oauth-client.json` holds the OAuth client secret and is blocked from every
  file-browser route.
- `docker/start.sh` is left over from a previous itzg-based image and is no longer referenced.

## License

See `LICENSE`. In short: free to use/modify/contribute (including commercially), but you **may
not** redistribute it as part of a competing Minecraft server template/starter/boilerplate.
