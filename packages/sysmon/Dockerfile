# syntax=docker/dockerfile:1.7
# Sysmon: read-only host utilization for heartbeat and D74 ranking.
#
# Build context is the repository root: every toolkit image is built from the
# workspace so `@konteks/remote-common` resolves through the workspace symlink
# and the shared `@konteks/*` contracts resolve from the Konteks registry
# (`scripts/pin-registry-deps.mjs` rewrites the development `file:` links).
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
 && npx tsc --build packages/sysmon \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
RUN groupadd --gid 10020 sysmon && useradd --uid 10020 --gid sysmon --create-home sysmon
USER sysmon
WORKDIR /app
COPY --from=builder --chown=sysmon:sysmon /src/package.json ./
COPY --from=builder --chown=sysmon:sysmon /src/node_modules ./node_modules
COPY --from=builder --chown=sysmon:sysmon /src/packages/common/package.json ./packages/common/
COPY --from=builder --chown=sysmon:sysmon /src/packages/common/dist ./packages/common/dist
COPY --from=builder --chown=sysmon:sysmon /src/packages/sysmon/package.json ./packages/sysmon/
COPY --from=builder --chown=sysmon:sysmon /src/packages/sysmon/dist ./packages/sysmon/dist
ENV NODE_ENV=production SYSMON_PORT=41830 SYSMON_DATA_ROOT=/data
EXPOSE 41830
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:41830/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/sysmon/dist/main.js"]
