#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
warn=0

ok() { printf 'OK   %s\n' "$1"; }
err() { printf 'FAIL %s\n' "$1" >&2; fail=1; }
warning() { printf 'WARN %s\n' "$1" >&2; warn=$((warn+1)); }

required_files=(
  "AI-VERSE.yaml"
  "AGENTS.md"
  "CLAUDE.md"
  "system/architecture/README.md"
  "system/architecture/source-of-truth.md"
  "system/architecture/knowledge-lifecycle.md"
  "system/architecture/routing.md"
  "system/architecture/domain-adaptation.md"
  "system/schemas/workspace.schema.yaml"
  "workspaces/_template/WORKSPACE.yaml"
  "skills/registry.yaml"
  "operator/README.md"
  "knowledge/README.md"
  "workspaces/README.md"
  "connections/README.md"
  "agents/README.md"
  "automations/README.md"
  "apps/README.md"
  "runtime/README.md"
  "scripts/sync-runtime-adapters.mjs"
)

for path in "${required_files[@]}"; do
  if [[ -f "$path" ]]; then
    ok "$path"
  else
    err "missing required file: $path"
  fi
done

for key in schema_version architecture paths ownership source_of_truth routing knowledge_lifecycle domain_adaptation privacy; do
  if grep -q "^${key}:" AI-VERSE.yaml 2>/dev/null; then
    ok "AI-VERSE.yaml contains ${key}"
  else
    err "AI-VERSE.yaml missing top-level key: ${key}"
  fi
done

for key in schema_version id name type status purpose; do
  if grep -Eq "^[[:space:]]*${key}:" workspaces/_template/WORKSPACE.yaml 2>/dev/null; then
    ok "workspace template contains ${key}"
  else
    err "workspace template missing field: ${key}"
  fi
done

if grep -Fq 'canonical_materialization: system/capabilities/' skills/registry.yaml; then
  ok "system/capabilities is the canonical capability source"
else
  err "skills/registry.yaml must name system/capabilities/ as canonical_materialization"
fi

if [[ -d system/capabilities && -d .claude/skills && -d .agents/skills ]]; then
  for source in system/capabilities/*; do
    [[ -d "$source" ]] || continue
    skill="$(basename "$source")"
    for runtime in .claude/skills .agents/skills; do
      target="$runtime/$skill"
      if [[ ! -d "$target" ]]; then
        err "runtime adapter missing OS capability: $runtime/$skill"
        continue
      fi
      if diff -qr "$source" "$target" >/dev/null 2>&1; then
        ok "OS capability adapter synchronized: $runtime/$skill"
      else
        err "OS capability adapter drift: $runtime/$skill (run scripts/sync-codex-skills.sh $skill and review any reported conflict)"
      fi
    done
  done
else
  err "canonical capability or runtime adapter directories are missing"
fi

# Public-template privacy warning. This is advisory because a private installation
# may deliberately version user-owned state.
if command -v git >/dev/null 2>&1; then
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      operator/README.md|operator/*/README.md|operator/*/*.example.md|knowledge/README.md|workspaces/README.md|workspaces/_template/*|workspaces/_template/**|connections/README.md|connections/registry.example.yaml|agents/README.md|agents/registry.example.yaml|automations/README.md|automations/*/README.md)
        ;;
      *)
        warning "user-owned state is tracked: $path"
        ;;
    esac
  done < <(git ls-files 'operator/**' 'knowledge/**' 'workspaces/**' 'connections/registry.yaml' 'agents/registry.yaml' 'automations/jobs/**' 'automations/triggers/**' 'automations/policies/**' 2>/dev/null || true)
fi

printf '\nArchitecture check: '
if [[ "$fail" -eq 0 ]]; then
  printf 'PASS'
else
  printf 'FAIL'
fi
printf ' (%s warning(s))\n' "$warn"

exit "$fail"
