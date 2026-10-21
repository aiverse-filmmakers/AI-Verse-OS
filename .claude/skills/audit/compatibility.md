# Runtime Compatibility

AI-Verse OS treats capabilities as runtime-neutral. OS built-in sources live under `system/capabilities/`; `.claude/skills/` and `.agents/skills/` are generated peer adapters. Member and publisher packages retain their separate canonical owners and configured library locations.

`skills/registry.yaml` describes the shared capability layer.

## What should normally match

For each shared skill compare:

- `SKILL.md` method and safety logic
- supporting references
- templates/assets
- deterministic scripts
- required package structure

## Intentional differences

Runtime-specific invocation metadata, menu labels, adapter configuration, or instructions explicitly required by one runtime may differ when documented.

## Defects

Treat these as meaningful problems:

- a shared capability exists in one supported adapter and is missing in another without explanation
- execution or safety logic materially differs
- required assets/references/scripts are missing
- one adapter points to invalid paths
- canonical materialization changed without refreshing the compatible copy

Use `bash scripts/sync-codex-skills.sh` to refresh Codex packages when appropriate, then verify the runtime-specific metadata still works.
