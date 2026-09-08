---
name: workspace
description: Use when a new substantial project, role, client, case, practice, product, research area, team, study, personal area, or other scope should be isolated in AI-Verse OS, or when an existing workspace needs to evolve. Creates the minimum universal workspace structure without assuming a profession.
---

# Workspace

Create or evolve one isolated AI-Verse OS workspace using the universal workspace contract.

## Read first

Read:

- `AGENTS.md`
- `AI-VERSE.yaml`
- `system/architecture/domain-adaptation.md`
- `system/schemas/workspace.schema.yaml`
- `workspaces/_template/WORKSPACE.yaml`

Do not hardcode a profession or force the work into a closed taxonomy.

## Step 1 - determine whether a workspace is justified

A workspace is appropriate when the scope has enough independent state, sources, decisions, knowledge, outputs, privacy, or lifecycle to benefit from isolation.

Do not create a workspace for every tiny task, file, or tool.

Before creating one, look for an existing workspace that already owns the scope. Prefer evolving the existing workspace over creating a near-duplicate.

## Step 2 - establish identity and boundaries

Determine from available context:

- human-readable name
- unique slug/id
- free-form `type`
- optional free-form `domains`
- purpose
- owner(s), if relevant
- success criteria, if known
- privacy/approval constraints
- authoritative source routes
- required connections

Reuse known information. Ask only when a missing answer materially affects boundaries, safety, or routing.

`type` is extensible. Examples such as `project`, `case`, `client`, `practice`, `research`, `team`, or `personal` are suggestions, not an enum.

## Step 3 - scaffold the minimum useful structure

Create:

```text
workspaces/<id>/
├── WORKSPACE.yaml
└── context/
    └── CURRENT.md
```

Add other standard layers only when useful:

```text
memory/
inbox/
knowledge/
assets/
decisions/
outputs/
automations/
skills/
```

Use `workspaces/_template/` as the contract, but do not produce empty-folder theater.

## Step 4 - adapt to the domain locally

If the workspace has specialized terminology, entities, standards, records, schemas, quality gates, or procedures, create that structure inside the workspace first.

Examples of valid local evolution include:

- a glossary or ontology
- source hierarchy
- domain-specific knowledge categories
- file naming conventions
- local schemas
- local policies
- local skills
- local automations

Do not create a profession-specific root folder merely because this workspace uses that profession.

## Step 5 - route sources instead of duplicating them

For authoritative material already stored elsewhere:

- record a safe route in `WORKSPACE.yaml`
- add or reuse a scoped connection in `connections/registry.yaml` when appropriate
- copy material only when a local canonical or approved snapshot is genuinely useful

Never store secrets in the manifest.

## Step 6 - initialize current context

`context/CURRENT.md` should be compact and useful immediately. Include only supported information such as:

- objective/current outcome
- current state
- next useful actions
- pending decisions
- constraints/approvals
- pointers to authoritative sources

Do not populate it with invented domain facts.

## Step 7 - promotion discipline

Keep workspace-specific knowledge and skills local at first.

Promote knowledge to root `knowledge/` when it is genuinely reusable beyond this workspace.

Promote a local skill to the shared capability layer only when it is portable, guarded, verifiable, and no longer depends on hidden workspace-specific assumptions.

## Existing folders and legacy projects

If the user already has a project/case/client folder outside `workspaces/`, do not bulk-move it automatically.

Prefer creating a workspace manifest that routes to the existing authoritative location. Migrate only when the user explicitly wants consolidation and the move can be verified safely.

## Verification

Before finishing, verify:

- the workspace ID is unique
- `WORKSPACE.yaml` contains the required schema fields
- the current-context path exists
- declared source routes resolve or are marked unverified
- privacy/approval boundaries are not weaker than known requirements
- no secrets were written
- no unrelated workspace was modified
- no new profession-specific root structure was introduced

## Output

Report briefly:

```text
Workspace: <name> (<id>)
Type: <free-form type>
Purpose: <purpose>
Created/updated: <paths>
Authoritative sources: <routes or none yet>
Connections: <verified / unverified / none>
Next useful action: <one action>
```
