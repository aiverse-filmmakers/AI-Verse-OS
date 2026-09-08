# AI-Verse OS Expansion Policy

AI-Verse OS should grow from real usage, not from guessing every profession, industry, or future feature in advance.

The universal core stays small. Domain structure should emerge inside workspaces and be promoted only when repeated use proves it belongs at a broader scope.

## Stable top-level layers

Do not create new top-level folders casually. The intended v2 layers are:

| Path | Scope |
|---|---|
| `system/` | AI-Verse OS architecture, schemas, templates, health, policy |
| `operator/` | User-owned operator profile, current context, memory, inbox, decisions |
| `knowledge/` | Reusable knowledge that applies across multiple workspaces |
| `workspaces/` | Isolated units of substantial work |
| `connections/` | Registries and integration knowledge for external systems/sources |
| `skills/` | Runtime-neutral capability registry |
| `agents/` | Orchestration definitions and routing |
| `automations/` | Jobs, triggers, and policies implementing cadence |
| `apps/` | Persistent interfaces and tools built on the OS |
| `runtime/` | Disposable derived state |
| `archives/` | Historical material no longer treated as current truth |

Existing `references/`, `context/`, `decisions/`, and `connections.md` remain as v1 compatibility surfaces. Do not use them as a reason to create duplicate v2 truth.

## Workspace-first rule

When a new domain, client, case, project, research area, practice, product, team, study, or other substantial scope appears, start with a workspace rather than a new root folder.

Use:

```text
workspaces/<workspace-id>/
```

A workspace can define its own vocabulary, knowledge categories, assets, local skills, automations, and privacy constraints without changing the universal core.

## Promotion rules

### Promote workspace knowledge to `knowledge/` when

- it has been validated beyond one narrow task,
- more than one workspace genuinely benefits from it, or
- the operator explicitly wants it as shared reusable knowledge.

Do not promote merely because the information sounds important.

### Promote a local capability to the shared skill layer when

- the trigger is reusable,
- inputs and outputs are clear,
- the method is stable,
- domain assumptions are explicit or parameterized,
- guardrails exist,
- verification exists,
- and the capability can operate without hidden workspace-specific facts.

### Promote repeated execution into automation when

- the manual or supervised workflow is already reliable,
- the trigger or schedule is well defined,
- failure behavior is known,
- permissions are appropriate,
- and external effects have suitable approval or rollback controls.

### Build an app when

- a persistent interface materially improves use,
- the underlying source-of-truth remains elsewhere,
- and the app does not become a second hidden database of canonical facts.

## Domain packs

AI-Verse OS may eventually support optional domain packs, but they must remain optional overlays rather than assumptions in the core.

A domain pack may contain:

- vocabulary or ontology references
- recommended workspace templates
- domain-specific quality gates
- optional skills
- optional agents
- connection adapters
- regulatory or approval guidance

Installing one must not change the meaning of universal folders or make other professions second-class users.

## New top-level folder test

Before adding another top-level folder, answer all of these:

1. Is this truly a new architectural concern rather than a workspace/domain detail?
2. Does it apply across unrelated professions and work types?
3. Would placing it inside an existing layer create ambiguity or conflicting authority?
4. Is its ownership and lifecycle different enough to justify a new root?
5. Can the change be represented in `AI-VERSE.yaml` with a clear source-of-truth rule?

If the answer is not clearly yes, keep it inside an existing layer.

## Anti-patterns

- One mini-OS per function, each with duplicate context and instructions.
- Profession-specific root folders baked into the public template.
- Multiple editable copies of the same fact.
- Giant agent prompts that duplicate knowledge and skills.
- Loading every memory file into every session.
- Treating an embedding/vector index as canonical truth.
- Turning every lesson or note into a skill.
- Creating automation before the underlying workflow is reliable.
- Storing user secrets or sensitive records in tracked template files.
- Letting generated apps or dashboards become the only place important state exists.
