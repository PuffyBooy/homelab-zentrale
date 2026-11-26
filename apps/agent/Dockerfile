# syntax=docker/dockerfile:1.7
# Homelab-Zentrale agent. Multi-arch (linux/amd64, linux/arm64). Build context is the repo root:
#   docker build -f apps/agent/Dockerfile -t homelab-zentrale/agent:local .
#   docker buildx build --platform linux/amd64,linux/arm64 -f apps/agent/Dockerfile .
# Run it with deploy/docker-compose.agent.yml (rights and mounts are explained there).

# Docker CLI + Compose plugin for compose.* actions. The official image ships static,
# multi-arch (amd64/arm64) binaries, so no apt repository or GPG key is needed.
# Pinned by digest; update tag and digest together.
FROM docker:29-cli@sha256:4e60c31615e83523afbb59773b25d055c0da9edcd5f80a4c6a6eebad49de1a25 AS dockercli

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo

# Build stage: install only what the agent needs, build, copy the production deps.
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter @hz/agent...
RUN pnpm --filter @hz/agent... build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --filter @hz/agent --prod deploy --legacy /out
# node-pty (web console): the package ships prebuilt pty.node for every platform. Its
# install script (prebuild check, node-gyp fallback) is not run: pnpm only runs build
# scripts listed in onlyBuiltDependencies, so no compiler is needed. This stage runs on
# the target platform, so keep only the prebuild for this arch (linux-x64 / linux-arm64)
# and drop the C++ sources and the Windows conpty binaries.
RUN set -eu; \
  d="$(readlink -f /out/node_modules/@homebridge/node-pty-prebuilt-multiarch)"; \
  keep="linux-$(node -p process.arch)"; \
  test -f "$d/prebuilds/$keep/pty.node"; \
  find "$d/prebuilds" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} +; \
  rm -rf "$d/src" "$d/third_party" "$d/scripts" "$d/binding.gyp" "$d/build"

FROM node:22-bookworm-slim AS runtime
# util-linux: nsenter (host commands in the namespaces of host PID 1)
# iproute2:   ss (listening ports)
# iputils-ping: check.ping
# git, openssh-client, ca-certificates: deploy.run (git fetch over https or ssh with a
#   deploy key; GitHub's host keys are bundled in assets/github_known_hosts)
# tar, zstd:  game.backup (world folder as .tar.zst; tar is in the base image, zstd is not)
# smartmontools: smartctl for SMART reads (M13, only with HZ_AGENT_SMART=1)
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux iproute2 iputils-ping \
     git openssh-client ca-certificates tar zstd smartmontools \
  && rm -rf /var/lib/apt/lists/*
# The runtime never needs npm, corepack or yarn; removing them drops their dependency CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose \
  /usr/local/libexec/docker/cli-plugins/docker-compose
ENV NODE_ENV=production \
    HZ_AGENT_DATA=/data \
    HZ_AGENT_HOST_EXEC=nsenter \
    HZ_AGENT_HOST_PROC=/host/proc \
    HZ_AGENT_HOST_ROOT=/host/proc/1/root
WORKDIR /app
COPY --from=build /out /app
# Fail the build if the native pty module does not load on this arch/libc.
RUN node -e "require('/app/node_modules/@homebridge/node-pty-prebuilt-multiarch')"
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]
# Least privilege by default: as `node` the agent can still report metrics.
# Docker socket, nsenter and host files need root; deploy/docker-compose.agent.yml
# sets `user: "0:0"` explicitly together with a minimal capability set.
USER node
# No port: the agent only dials out to the core (docs/NETWORK.md).
HEALTHCHECK NONE
CMD ["node", "dist/index.js"]
