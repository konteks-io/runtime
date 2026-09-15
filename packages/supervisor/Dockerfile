# syntax=docker/dockerfile:1.7
# Supervisor: the privileged appliance process that owns the instance key,
# lease, journal, outbox, control protocol, relay client, and channel mux.
# It is the only container with the restricted data root mounted; nothing
# else can read it. Non-root, no Docker socket, no host credential directory.
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
 && npx tsc --build packages/supervisor \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10010 supervisor && useradd --uid 10010 --gid supervisor --create-home supervisor \
 && mkdir -p /data && chown supervisor:supervisor /data && chmod 700 /data
USER supervisor
WORKDIR /app
COPY --from=builder --chown=supervisor:supervisor /src/package.json ./
COPY --from=builder --chown=supervisor:supervisor /src/node_modules ./node_modules
COPY --from=builder --chown=supervisor:supervisor /src/packages ./packages
ENV NODE_ENV=production SUPERVISOR_DATA_DIR=/data SUPERVISOR_CONTROL_PORT=41800 SUPERVISOR_INTERNAL_PORT=41820
VOLUME ["/data"]
EXPOSE 41800 41820
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:41820/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/supervisor/dist/main.js"]
