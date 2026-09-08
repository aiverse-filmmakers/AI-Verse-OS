# Claude Code and Codex Compatibility

AI-Verse OS keeps canonical skill packages in `.claude/skills/` and compatible copies in `.agents/skills/`.

## What should normally match

For each skill, compare:

- `SKILL.md` execution logic
- supporting references
- templates
- assets required at runtime
- scripts used by the skill

## Differences that may be intentional

Runtime-specific metadata such as `agents/openai.yaml`, invocation syntax, menu labels, or instructions that explicitly refer to one runtime may differ.

Do not report an intentional adaptation as logic drift.

## Defects

Treat these as meaningful problems:

- a skill exists in one runtime and is missing in the other without explanation
- the execution logic has materially different steps or safety rules
- a required asset is missing from one copy
- one runtime points to a path that does not exist
- a supporting reference changed in the canonical package but the copy was not refreshed

## Verification

Use `bash scripts/sync-codex-skills.sh` to regenerate Codex copies from canonical Claude skill packages when appropriate.

After synchronization, verify that runtime-specific metadata still works as intended.
