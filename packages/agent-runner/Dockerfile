# syntax=docker/dockerfile:1.7
# Agent runner: one image parameterised by agent family (`--build-arg
# AGENT_FAMILY=<claude-code|codex|opencode|pi>`). The bridge and its official
# tooling are VENDORED at the CP0-pinned version into /opt/konteks/bridges at
# build time; nothing is resolved from a package registry at runtime and the
# image digest pins the bridge. The runner holds no instance key, no Core
# token, and no Docker socket; its only writable path is the private
# credential volume.
FROM node:22-bookworm-slim AS builder
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages
ARG KONTEKS_CONTRACTS_VERSION
RUN --mount=type=secret,id=npm_token,required=true \
    KONTEKS_CONTRACTS_VERSION="$KONTEKS_CONTRACTS_VERSION" node scripts/pin-registry-deps.mjs \
 && printf '@konteks:registry=https://gitea.sev-2.com/api/packages/konteks/npm/\n//gitea.sev-2.com/api/packages/konteks/npm/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" > .npmrc \
 && npm ci --ignore-scripts \
 && rm -f .npmrc \
 && npx tsc --build packages/agent-runner \
 && npm prune --omit=dev --ignore-scripts

# Vendor the pinned bridge family. Versions are the release manifest's
# `agentBridges[].version`; the release pipeline passes them explicitly so the
# Dockerfile and the signed manifest cannot drift.
FROM node:22-bookworm-slim AS bridges
ARG AGENT_FAMILY
ARG BRIDGE_PACKAGE
ARG BRIDGE_VERSION
ARG TOOLING_PACKAGE
ARG TOOLING_VERSION
RUN test -n "$AGENT_FAMILY" && test -n "$BRIDGE_PACKAGE" && test -n "$BRIDGE_VERSION"
RUN mkdir -p /opt/konteks/bridges \
 && npm install --global --prefix /opt/konteks/bridges --ignore-scripts --no-audit --no-fund "${BRIDGE_PACKAGE}@${BRIDGE_VERSION}" \
 && if [ -n "$TOOLING_PACKAGE" ]; then npm install --global --prefix /opt/konteks/bridges --ignore-scripts --no-audit --no-fund "${TOOLING_PACKAGE}@${TOOLING_VERSION}"; fi \
 && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ARG AGENT_FAMILY
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10030 runner && useradd --uid 10030 --gid runner --create-home runner \
 && mkdir -p /credentials /workspace && chown runner:runner /credentials /workspace && chmod 700 /credentials
COPY --from=bridges --chown=root:root /opt/konteks/bridges /opt/konteks/bridges
USER runner
WORKDIR /app
COPY --from=builder --chown=runner:runner /src/package.json ./
COPY --from=builder --chown=runner:runner /src/node_modules ./node_modules
COPY --from=builder --chown=runner:runner /src/packages/common/package.json ./packages/common/
COPY --from=builder --chown=runner:runner /src/packages/common/dist ./packages/common/dist
COPY --from=builder --chown=runner:runner /src/packages/release/package.json ./packages/release/
COPY --from=builder --chown=runner:runner /src/packages/release/dist ./packages/release/dist
COPY --from=builder --chown=runner:runner /src/packages/agent-runner/package.json ./packages/agent-runner/
COPY --from=builder --chown=runner:runner /src/packages/agent-runner/dist ./packages/agent-runner/dist
ENV NODE_ENV=production \
    RUNNER_AGENT_ID=${AGENT_FAMILY} \
    RUNNER_PORT=41840 \
    RUNNER_CREDENTIAL_DIR=/credentials \
    RUNNER_WORKSPACE_DIR=/workspace \
    RUNNER_BRIDGE_PREFIX=/opt/konteks/bridges
VOLUME ["/credentials"]
EXPOSE 41840
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:41840/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/agent-runner/dist/main.js"]
