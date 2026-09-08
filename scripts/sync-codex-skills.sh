#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/.claude/skills"
TARGET="$ROOT/.agents/skills"

if [[ ! -d "$SOURCE" ]]; then
  echo "Missing source directory: $SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET"

sync_one() {
  local skill="$1"
  local src="$SOURCE/$skill"
  local dst="$TARGET/$skill"

  if [[ ! -d "$src" ]]; then
    echo "Unknown skill: $skill" >&2
    exit 1
  fi

  rm -rf "$dst"
  mkdir -p "$dst"
  cp -R "$src"/. "$dst"/

  # Keep the skill content portable. Runtime-specific menu metadata can live
  # inside each package's agents/openai.yaml when present.
  echo "Synced $skill"
}

if [[ $# -gt 0 ]]; then
  for skill in "$@"; do
    sync_one "$skill"
  done
else
  for path in "$SOURCE"/*; do
    [[ -d "$path" ]] || continue
    sync_one "$(basename "$path")"
  done
fi

echo "Codex skill copies are up to date."
