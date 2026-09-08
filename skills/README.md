# Capability Layer

`skills/` is the runtime-neutral registry and architecture layer for AI-Verse capabilities.

The current working packages remain materialized in `.claude/skills/` and synchronized to `.agents/skills/` for Codex compatibility. This preserves the existing tested packages, including large bundled assets, while separating the logical capability model from any one runtime.

New shared skills should be written so their method is portable even when a runtime adapter is needed.

Workspace-specific skills should remain inside that workspace until reuse and stability justify promotion.

See `SKILL-AUTHORING.md` and `registry.yaml`.
