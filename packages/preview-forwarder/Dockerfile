# syntax=docker/dockerfile:1.7
# Preview forwarder: loopback-only bridge from the Validation Runtime's local
# preview port onto the governed `preview` relay channel. Compose runs it in
# the Validation Runtime's network namespace so "loopback" is the preview
# origin itself; it listens for no viewer and maps nothing until the operator
# enables preview AND a grant exists.
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
 && npx tsc --build packages/preview-forwarder \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
RUN groupadd --gid 10040 forwarder && useradd --uid 10040 --gid forwarder --create-home forwarder
USER forwarder
WORKDIR /app
COPY --from=builder --chown=forwarder:forwarder /src/package.json ./
COPY --from=builder --chown=forwarder:forwarder /src/node_modules ./node_modules
COPY --from=builder --chown=forwarder:forwarder /src/packages/common/package.json ./packages/common/
COPY --from=builder --chown=forwarder:forwarder /src/packages/common/dist ./packages/common/dist
COPY --from=builder --chown=forwarder:forwarder /src/packages/preview-forwarder/package.json ./packages/preview-forwarder/
COPY --from=builder --chown=forwarder:forwarder /src/packages/preview-forwarder/dist ./packages/preview-forwarder/dist
ENV NODE_ENV=production PREVIEW_FORWARDER_STATUS_PORT=41860
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:41860/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/preview-forwarder/dist/main.js"]
