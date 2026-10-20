#!/usr/bin/env bash
set -euo pipefail
image="${1:?runtime image reference required}"
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,exec,mode=1777 --env HOME=/tmp/home \
  --entrypoint /bin/sh "$image" -ec '
    mkdir -p "$HOME"
    node --version
    npm --version
    git --version
    jq --version
    curl --version
    claude --version
    codex --version
    opencode --version
    pi --version
  '
node "$(dirname "$0")/test-runtime-path.mjs" "$image"
