#!/bin/sh
# Runs the two halves of one extension, and stops BOTH when either dies.
#
# WHY NOT `a & b` AND HOPE. A container whose shell process exits while the sidecar keeps running
# looks healthy to the kubelet as long as something stays in the foreground — and then a rolling
# update waits forever for a pod that will never stop. Whichever process ends first takes the other
# down and the container exits, which is the one behaviour a restart policy can act on.
#
# THE ORDER IS DELIBERATE. The sidecar starts first because the shell's readiness probe asks it a
# question; starting the shell first would only make it report not-ready for a moment.
set -u

SIDECAR_PORT="${SIDECAR_PORT:-9222}"

node /app/dist/main.js &
SIDECAR_PID=$!

/app/playwright-goshell &
SHELL_PID=$!

# FIRST TO EXIT WINS. busybox sh has no `wait -n`, so this polls — and then `wait`s on the specific pid,
# which yields ITS exit status. Checking with `kill -0` first and waiting afterwards would race a
# process that had already been reaped.
while :; do
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    wait "$SIDECAR_PID"; CODE=$?
    echo "run.sh: sidecar exited ($CODE), stopping the shell" >&2
    kill "$SHELL_PID" 2>/dev/null || true
    exit "$CODE"
  fi
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    wait "$SHELL_PID"; CODE=$?
    echo "run.sh: shell exited ($CODE), stopping the sidecar" >&2
    kill "$SIDECAR_PID" 2>/dev/null || true
    exit "$CODE"
  fi
  sleep 0.2
done
