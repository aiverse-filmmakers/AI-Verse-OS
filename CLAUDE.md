# Claude Code Adapter for AI-Verse OS

This file is a runtime adapter, not a second operating manual.

Before substantial work in this repository:

1. Read `AGENTS.md` for the canonical runtime contract.
2. Read `AI-VERSE.yaml` for the machine-readable architecture and source-of-truth map.
3. Use `.claude/skills/` for the currently materialized Claude skill packages.
4. Use `skills/registry.yaml` to understand the runtime-neutral capability registry.

Do not store operator-specific facts, domain assumptions, workspace state, or duplicated standing guidance in this file. Those belong in the canonical locations defined by `AI-VERSE.yaml`.
