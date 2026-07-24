# syntax=docker/dockerfile:1

# Pinned vanilla server build. All three values come from Mojang's own metadata:
#   https://piston-meta.mojang.com/mc/game/version_manifest_v2.json  -> latest.release
#   -> the matching versions[] entry url -> downloads.server.{url,sha1}
# To move to another version, update all three together.
ARG MC_VERSION=26.2
ARG MC_SERVER_URL=https://piston-data.mojang.com/v1/objects/823e2250d24b3ddac457a60c92a6a941943fcd6a/server.jar
ARG MC_SERVER_SHA1=823e2250d24b3ddac457a60c92a6a941943fcd6a

# --- Stage 1: compile the Bun control app into a single binary ----------------
FROM oven/bun:latest AS builder

WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY bunfig.toml tsconfig.json postcss.config.cjs tailwind.config.ts components.json ./

# Tailwind is a separate build step: src/tailwind.css is a generated artifact that
# index.html links directly, and Bun's bundler does not produce it.
RUN bunx tailwindcss -c tailwind.config.ts -i src/index.css -o src/tailwind.css --minify
RUN bun build ./src/index.ts --compile --outfile=server

# --- Stage 2: fetch and verify the pinned server jar --------------------------
FROM debian:bookworm-slim AS mcjar

ARG MC_SERVER_URL
ARG MC_SERVER_SHA1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/minecraft
RUN curl -fsSL -o server.jar "${MC_SERVER_URL}" \
 && echo "${MC_SERVER_SHA1}  server.jar" | sha1sum -c -

# --- Stage 3: runtime ---------------------------------------------------------
# Minecraft 26.2 declares javaVersion.majorVersion = 25 in Mojang's manifest, so
# the JRE major here must track the pinned MC_VERSION. Java 21 will NOT run it.
FROM eclipse-temurin:25-jre

ARG MC_VERSION

ENV MC_VERSION=${MC_VERSION} \
    MC_JAR_PATH=/opt/minecraft/server.jar \
    MC_MEMORY=2G \
    CONTROL_PORT=3000

WORKDIR /app
COPY --from=builder /build/server ./server
COPY --from=mcjar /opt/minecraft/server.jar /opt/minecraft/server.jar

# The jar lives outside /data on purpose: /data is the mounted volume and the
# file browser's root, so keeping the jar out of it keeps both clean.
EXPOSE 3000 25565

# The control app is PID 1: it spawns java, owns its stdin/stdout, and performs
# the graceful "stop" handshake on SIGTERM. There is no shell entrypoint.
ENTRYPOINT ["/app/server"]
