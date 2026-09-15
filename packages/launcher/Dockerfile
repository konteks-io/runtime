# syntax=docker/dockerfile:1.7
# The launcher is a NATIVE signed artifact (.pkg/.msi/.deb built by the
# release pipeline with Node SEA). This image exists for CI: it builds the
# launcher and runs its self-checks; it is never part of the customer bundle.
FROM node:22-bookworm-slim AS builder
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY compose ./compose
ARG KONTEKS_CONTRACTS_VERSION
RUN --mount=type=secret,id=npm_token,required=true \
    KONTEKS_CONTRACTS_VERSION="$KONTEKS_CONTRACTS_VERSION" node scripts/pin-registry-deps.mjs \
 && printf '@konteks:registry=https://gitea.sev-2.com/api/packages/konteks/npm/\n//gitea.sev-2.com/api/packages/konteks/npm/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" > .npmrc \
 && npm ci --ignore-scripts \
 && rm -f .npmrc \
 && npx tsc --build packages/launcher \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
RUN groupadd --gid 10050 launcher && useradd --uid 10050 --gid launcher --create-home launcher
USER launcher
WORKDIR /app
COPY --from=builder --chown=launcher:launcher /src ./
ENTRYPOINT ["node", "packages/launcher/dist/cli.js"]
CMD ["--help"]
