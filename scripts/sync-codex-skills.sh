#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Backward-compatible entrypoint. OS capabilities now live canonically under
# system/capabilities/ and both Claude and Codex adapters are generated peers.
# Run through the OS launcher: the OS's own Node (private copy first), never whatever node is on PATH.
exec "$ROOT/scripts/ai-verse" node "$ROOT/scripts/sync-runtime-adapters.mjs" --root "$ROOT" "$@"
