# Unified Workspace Architecture

AI-Verse OS uses a **Unified Workspace Architecture (UWA)**: one universal operating system, one explicit authority model, and many isolated workspaces that can adapt to any domain.

## Why this model exists

A folder tree can look organized while still being architecturally weak. Common failure modes are:

- duplicating context across multiple mini operating systems
- mixing system code with user knowledge
- loading unrelated domains into every session
- treating every new profession as a reason for a new root folder
- allowing memory, indexes, dashboards, and source files to disagree with no authority rule

UWA organizes by ownership, scope, lifecycle, and authority instead.

## Layers

```text
SYSTEM
  architecture / schemas / templates / health / capabilities

USER
  operator
  shared knowledge
  workspaces
  connections
  agents
  automations
  apps

DERIVED
  runtime
```

## One universal workspace primitive

A workspace is an isolated unit of meaningful work. The architecture intentionally does not define a closed list of workspace types.

A workspace may represent a project, role, practice, client, case, product, research area, team, study, personal area, or a type no template author anticipated.

Each workspace uses the same contract, then evolves local structure as the work reveals what is actually needed.

## Separation of concerns

- Context answers: **what matters now?**
- Memory answers: **what happened?**
- Knowledge answers: **what should remain reusable?**
- Decisions answer: **what was settled and why?**
- Skills answer: **how does AI perform repeatable work?**
- Agents answer: **how are capabilities coordinated?**
- Connections answer: **where can current external truth be reached?**
- Automations answer: **when should reliable work run?**
- Apps answer: **how can humans interact with the system persistently?**
- Runtime answers: **what can be regenerated?**

Keeping those meanings distinct is more important than having many folders.

OS-built-in capability methodology lives under `system/capabilities/`. Runtime trees such as `.claude/skills/` and `.agents/skills/` are generated peers, not competing editable sources. See `adapter-synchronization.md`.

## Domain neutrality

The architecture does not mean domain ignorance. It means domain knowledge is learned at the right scope rather than assumed globally.

A healthcare practice, software project, film production, laboratory, classroom, legal matter, sales team, household, or entirely different context can all use the same workspace contract while maintaining different local terminology, knowledge, policies, connections, and quality gates.

See `domain-adaptation.md`.

## Design constraints

1. One fact should have one canonical editable home.
2. Current context must stay smaller and more current than long-term memory.
3. Workspace-specific material should not pollute unrelated workspaces.
4. Shared knowledge should be promoted deliberately.
5. Agents should orchestrate capabilities rather than duplicate them.
6. Apps and indexes are derived interfaces, not hidden truth stores.
7. User-owned state must survive system upgrades.
8. Generated adapters must never silently overwrite unknown or locally modified files.
9. New top-level structure must earn its existence through cross-domain architectural need.

## Related documents

- `source-of-truth.md`
- `knowledge-lifecycle.md`
- `routing.md`
- `domain-adaptation.md`
- `ownership.md`
- `adapter-synchronization.md`
- `../schemas/workspace.schema.yaml`
- `../../AI-VERSE.yaml`

## Next capability integration contract

[Capability Provider Contract v1](../contracts/capability-provider-v1/README.md) specifies ownership, identity, readiness, generation safety, and extension compatibility for the next implementation stage. The built-in source migration to `system/capabilities/` is now implemented; external provider discovery and later integration stages remain separate work.
