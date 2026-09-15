# syntax=docker/dockerfile:1.7
# Browser tool: headless Chromium/Playwright exposed as an MCP server to
# qa-role agents. The Playwright base image is pinned by digest in the signed
# release manifest; the tool has no provider route (network isolation) and
# runs as the image's non-root user.
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
 && npx tsc --build packages/browser-tool \
 && npm prune --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime
USER pwuser
WORKDIR /app
COPY --from=builder --chown=pwuser:pwuser /src/package.json ./
COPY --from=builder --chown=pwuser:pwuser /src/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /src/packages/common/package.json ./packages/common/
COPY --from=builder --chown=pwuser:pwuser /src/packages/common/dist ./packages/common/dist
COPY --from=builder --chown=pwuser:pwuser /src/packages/browser-tool/package.json ./packages/browser-tool/
COPY --from=builder --chown=pwuser:pwuser /src/packages/browser-tool/dist ./packages/browser-tool/dist
ENV NODE_ENV=production BROWSER_TOOL_PORT=41850
EXPOSE 41850
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:41850/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/browser-tool/dist/main.js"]
