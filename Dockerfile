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
COPY scripts scripts
COPY manifest.yaml manifest.yaml
COPY src src

# The SDK is installed from GitHub Packages, which authenticates even for a read.
#
# The token arrives as a BUILDKIT SECRET, not a build-arg: a build-arg is recorded in the image
# metadata (`docker history`) and in the provenance attestation, so it would be published with
# the image. A secret is mounted for this RUN only, and `--mount=type=secret` keeps it out of the
# layer cache as well.
#
# It is read from a file inside that mount and handed to npm through the environment, which is
# what .npmrc's `_authToken=${NODE_AUTH_TOKEN}` expects — the token never appears in a committed
# file. An earlier attempt committed a read:packages token; GitHub's secret scanning revoked it
# and every later install failed.
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" npm install --no-audit && npm run build

FROM alpine:3.24
RUN apk add --no-cache ca-certificates nodejs
WORKDIR /app
# playwright-core is external (a real package resolved at runtime); everything
# else is inlined into dist/main.js.
COPY --from=build /build/node_modules/playwright-core node_modules/playwright-core
COPY --from=build /build/dist/main.js dist/main.js
COPY --from=build /build/package.json package.json
# The browser panel. Copied verbatim — it is a static HTML document and one ES module, with no build
# step, so there is nothing to compile and nothing that can drift from the source.
#
# PLAYWRIGHT_UI_DIR is what TURNS IT ON: without it the server keeps exactly the surface it had before.
# A deployment that does not want a panel pays nothing, and one that does gets it by mounting this.
COPY ui ui
ENV PLAYWRIGHT_UI_DIR=/app/ui
EXPOSE 8080
CMD ["node", "dist/main.js"]
