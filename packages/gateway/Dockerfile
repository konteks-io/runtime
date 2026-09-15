# syntax=docker/dockerfile:1.7
# Egress gateway: the only provider path for gateway-keyed agents. Keys live
# in process memory only; the config volume carries the verified allowlist and
# instance ID, nothing secret. Non-root, read-only root filesystem, no socket.
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
 && npx tsc --build packages/gateway \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10011 gateway && useradd --uid 10011 --gid gateway --create-home gateway
USER gateway
WORKDIR /app
COPY --from=builder --chown=gateway:gateway /src/package.json ./
COPY --from=builder --chown=gateway:gateway /src/node_modules ./node_modules
COPY --from=builder --chown=gateway:gateway /src/packages/common/package.json ./packages/common/
COPY --from=builder --chown=gateway:gateway /src/packages/common/dist ./packages/common/dist
COPY --from=builder --chown=gateway:gateway /src/packages/gateway/package.json ./packages/gateway/
COPY --from=builder --chown=gateway:gateway /src/packages/gateway/dist ./packages/gateway/dist
ENV NODE_ENV=production GATEWAY_PROXY_PORT=41810 GATEWAY_ADMIN_PORT=41811
EXPOSE 41810 41811
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:41811/health').then(r=>r.json()).then(j=>process.exit(j.healthy?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/gateway/dist/main.js"]
