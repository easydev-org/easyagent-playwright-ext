# syntax=docker/dockerfile:1
# The extension drives a REMOTE browser over CDP, so no Chromium is bundled or
# downloaded (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).
#
# The SDK (@easydev-org/easybus-sdk) is published to the PUBLIC npm registry and
# ships compiled JS + .d.ts, so this build needs no credential and the runtime
# image needs no transpiler.
#
# PORTABILITY: no internal artifact mirror, no proxy, no regional package mirror,
# no *.svc.cluster.local. Builds identically on a CI runner and a laptop.
FROM node:26-alpine AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build
# The lockfile is regenerated when the SDK moves, so it is copied via a wildcard:
# COPY of a missing file would fail the build.
COPY package.json package-lock.json* .npmrc tsconfig.json ./
# The SDK is a vendored tarball (it is not published to a registry), so the build needs it
# before `npm install` — the dependency is a file: path, not a version range.
COPY vendor vendor
COPY scripts scripts
COPY manifest.yaml manifest.yaml
COPY src src
RUN npm install --no-audit && npm run build

FROM alpine:3.24
RUN apk add --no-cache ca-certificates nodejs
WORKDIR /app
# playwright-core is external (a real package resolved at runtime); everything
# else is inlined into dist/main.js.
COPY --from=build /build/node_modules/playwright-core node_modules/playwright-core
COPY --from=build /build/dist/main.js dist/main.js
COPY --from=build /build/package.json package.json
EXPOSE 8080
CMD ["node", "dist/main.js"]
