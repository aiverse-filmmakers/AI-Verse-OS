# Claude Code Adapter for AI-Verse OS

This file is a runtime adapter, not a second operating manual.

Before substantial work in this repository:

1. Read `AGENTS.md` for the canonical runtime contract.
2. Read `AI-VERSE.yaml` for the machine-readable architecture and source-of-truth map.
3. Treat **System Capabilities** and the **Skills Library** as separate ownership layers:
   - System Capabilities are built into AI-Verse OS and canonically live under `system/capabilities/`.
   - Skills Library packages are owned by the separate `AI-Verse-Skills` provider and are discovered through the OS capability resolver.
4. Use `.claude/skills/` only as Claude's runtime adapter surface for OS-owned System Capabilities. The folder name `skills` is a Claude/runtime convention; it does not make those capabilities part of the AI-Verse-Skills library.
5. Use `skills/registry.yaml` to understand the runtime-neutral registry for OS System Capabilities. Use the capability resolver for task-skill discovery across OS, AI-Verse-Skills, local, and workspace providers.

Do not store operator-specific facts, domain assumptions, workspace state, or duplicated standing guidance in this file. Those belong in the canonical locations defined by `AI-VERSE.yaml`.
