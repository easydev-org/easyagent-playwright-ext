# syntax=docker/dockerfile:1
#
# TWO PROCESSES, ONE IMAGE: a Go shell that speaks easybus, and a Node sidecar that drives the
# browser. They run in the same pod and talk over localhost.
#
# WHY ONE IMAGE AND NOT TWO. They are one extension with one version: a deploy that pairs shell 0.7
# with sidecar 0.6 is a deploy nobody tested, and two images means two tags to keep in step. It also
# keeps the sidecar unreachable from outside — it binds 127.0.0.1 and has no authentication, which is
# only safe because nothing else can route to it.
#
# WHAT IS NOT HERE: Chromium. This drives a REMOTE browser over CDP, so the image stays small.
#
# PORTABILITY: no internal artifact mirror, no proxy, no *.svc.cluster.local. Builds identically on a
# CI runner and a laptop.
FROM node:26-alpine AS ts
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build
COPY package.json package-lock.json* tsconfig.json ./
# NO npm TOKEN NEEDED ANY MORE. The easybus SDK used to come from GitHub Packages, which
# authenticates even for a read; that dependency moved to Go, so this build reads nothing private.
RUN npm install --no-audit --no-fund
COPY scripts scripts
COPY src src
RUN npm run build

FROM golang:1.26-alpine AS goshell
WORKDIR /src
# The module needs the published easybus SDK. GOPROXY is whatever the build environment provides —
# nothing here names a private registry.
COPY go.mod ./
RUN go mod download 2>/dev/null || true
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/playwright-goshell ./cmd/playwright-goshell

FROM alpine:3.24
RUN apk add --no-cache ca-certificates nodejs
WORKDIR /app

COPY --from=goshell /out/playwright-goshell /app/playwright-goshell
# The manifest is READ AT STARTUP by the shell, not embedded, because the sidecar's tool list comes
# from the same file at build time — two copies is how the sandbox extension ended up with two
# manifests that had to be kept in step by hand.
COPY manifest.yaml /app/manifest.yaml

# playwright-core is a real package resolved at runtime; everything else is inlined into main.js.
COPY --from=ts /build/node_modules/playwright-core /app/node_modules/playwright-core
COPY --from=ts /build/dist/main.js /app/dist/main.js
COPY --from=ts /build/package.json /app/package.json

# The supervisor is a shell loop rather than supervisord: two processes, one restart policy, and a
# dependency (the sidecar's health is part of the shell's readiness, so starting order barely matters).
COPY --chmod=755 run.sh /app/run.sh

ENV MANIFEST_PATH=/app/manifest.yaml \
    SIDECAR_URL=http://127.0.0.1:9222 \
    SIDECAR_PORT=9222 \
    PORT=8080

# 8080 is the shell (probes + panel data). 9222 is the sidecar and is NEVER published — it is bound to
# loopback in the sidecar and has no auth, so exposure would be a remote browser with no credential.
EXPOSE 8080
ENTRYPOINT ["/app/run.sh"]
