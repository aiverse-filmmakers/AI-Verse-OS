#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Backward-compatible entrypoint. OS capabilities now live canonically under
# system/capabilities/ and both Claude and Codex adapters are generated peers.
exec node "$ROOT/scripts/sync-runtime-adapters.mjs" --root "$ROOT" "$@"
