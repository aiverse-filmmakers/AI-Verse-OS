---
name: onboard
description: Use on first setup, when someone says set me up or onboard me, or when refreshing an AI-Verse OS installation from the universal seven-question intake. Builds domain-neutral operator state, a safe connection registry, and the minimum useful workspace routes without assuming a profession.
---

# Onboard

Establish a useful AI-Verse OS without turning onboarding into a profession-specific questionnaire or a long consulting exercise.

## Read first

Read:

- `AGENTS.md`
- `AI-VERSE.yaml`
- `ai-verse-os-intake.md`
- `system/architecture/domain-adaptation.md`
- `workspaces/_template/WORKSPACE.yaml`

The core files remain generic. Do **not** personalize `AGENTS.md`, `CLAUDE.md`, or `AI-VERSE.yaml` with operator-specific facts.

## Step 0 - preserve existing state

Before writing:

- inspect v2 operator/workspace files when they exist
- inspect legacy `context/`, `decisions/`, `connections.md`, and operator-specific reference files if they contain real data
- never delete or bulk-move existing user state during onboarding
- if old and new sources conflict, mark the ambiguity and preserve provenance

Re-running onboarding must be safe.

## Step 1 - inspect the seven-question intake

Use `ai-verse-os-intake.md` as the source-of-truth intake.

- If all seven answers are usable, scaffold from them.
- If some are filled, ask only for the missing primary questions unless the user wants a partial setup.
- If none are filled, interview one question at a time.
- Save each answer to the intake immediately so onboarding can resume after interruption.

Do not treat placeholders as answers.

## Step 2 - ask at most seven primary questions

Use the exact intent of the intake:

1. Who is the operator and which roles/responsibilities matter?
2. Which outcomes or priorities matter most over the next 90 days?
3. How should the AI work and communicate, including optional real writing samples?
4. Which active areas of work should stay isolated from one another?
5. Where does important information or evidence live?
6. Which tools, systems, people, or channels does the work pass through?
7. Which repeated/high-friction/high-value task should improve first, and what boundaries must be respected?

Do not add an eighth primary question. Follow-up clarification is allowed only when a response cannot be routed safely or meaningfully.

## Step 3 - create operator state

Using only supported facts, create or refresh as relevant:

- `operator/profile/identity.md`
- `operator/profile/preferences.md`
- `operator/profile/goals.md`
- `operator/profile/voice.md` only when real writing samples or explicit voice guidance exist
- `operator/context/CURRENT.md`

Keep `CURRENT.md` compact. It should point to active workspaces rather than absorb all workspace detail.

The public template gitignores these files by default. Do not weaken that privacy protection during onboarding.

## Step 4 - create the connection registry

If `connections/registry.yaml` does not exist, initialize it from `connections/registry.example.yaml`.

Use Q5 and Q6 to create safe entries for relevant sources and systems.

For each entry distinguish:

- planned
- configured
- verified
- degraded/unavailable

Naming a tool does not prove access. Never store secrets. Record only safe authentication metadata such as `environment`, `credential manager`, `interactive`, `none`, or another non-secret description.

## Step 5 - establish workspaces

Use Q4 and current priorities to identify substantial scopes that deserve isolation.

Create a workspace only when the boundary is reasonably clear. A tool, folder, or single task is not automatically a workspace.

For each clearly justified workspace:

- create a unique `workspaces/<id>/WORKSPACE.yaml`
- create `context/CURRENT.md`
- use free-form `type` and `domains`
- record source routes and privacy/approval constraints
- add optional layers only when immediately useful

Follow the `/workspace` skill's rules. Do not pre-create profession-specific global folders.

If Q4 reveals many possible scopes but priorities do not make the active ones clear, record candidates in operator current context and defer unnecessary scaffolding.

## Step 6 - capture the first improvement candidate

Treat Q7 as an improvement candidate for `/level-up`, not an instruction to automate immediately.

Record the constraint in the narrowest relevant current context. Preserve stated approval, privacy, or high-stakes boundaries.

Do not create a new skill or automation during onboarding unless the user explicitly requests implementation and the workflow is sufficiently understood.

## Step 7 - verify

Before finishing verify:

- all seven primary questions are answered or clearly unknown
- operator facts are stored outside system-owned files
- current context is compact and routes to active workspaces
- workspaces use the universal manifest rather than profession-specific root structure
- connection entries do not overclaim access
- no secrets were written
- existing user state was preserved
- `AGENTS.md`, `CLAUDE.md`, and `AI-VERSE.yaml` remain generic system files

## Closing handoff

Keep it compact:

```text
Onboarding complete.
Operator context: <created/updated paths>
Active workspaces: <list or none yet>
Connections: <verified/configured/planned summary>
First improvement candidate: <constraint>

Next: use the system for real work, then run /audit. Use /workspace when another substantial scope needs isolation and /level-up when the first repeated constraint is ready to improve.
```
