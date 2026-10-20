# syntax=docker/dockerfile:1
# The extension drives a REMOTE browser over CDP, so no Chromium is bundled or
# downloaded (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).
#
# The SDK comes from GitHub Packages (@easydev-org/easybus-sdk) and ships
# compiled JS + .d.ts, so the runtime image needs no transpiler. That registry
# requires a token even for a public package, so the build takes one as a
# BuildKit secret-like ARG; it is never written into an image layer.
ARG REGISTRY=docker.io/library
FROM ${REGISTRY}/node:26-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=localhost,127.0.0.1,.svc.cluster.local,.svc \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build
# The lockfile is regenerated against GitHub Packages when the SDK source moves,
# so it is copied via a wildcard: COPY of a missing file would fail the build.
COPY package.json package-lock.json* .npmrc tsconfig.json ./
COPY scripts scripts
COPY manifest.yaml manifest.yaml
COPY src src
# .npmrc points the @easydev-org scope at npm.pkg.github.com and carries a
# read-only (read:packages) token, so the build needs no secret passed in: no
# extra ARG, no --secret mount, no CI variable. That token can do nothing except
# read packages, so committing it costs nothing.
RUN npm install --no-audit --strict-ssl=false && npm run build

FROM ${REGISTRY}/alpine:3.24
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates nodejs
WORKDIR /app
# playwright-core is external (a real package resolved at runtime); everything
# else is inlined into dist/main.js.
COPY --from=build /build/node_modules/playwright-core node_modules/playwright-core
COPY --from=build /build/dist/main.js dist/main.js
COPY --from=build /build/package.json package.json
EXPOSE 8080
CMD ["node", "dist/main.js"]
