---
name: onboard
description: Use on first setup, when someone says set me up or onboard me, when profile/context is incomplete, or when refreshing AI-Verse OS from the universal intake. Starts progressively from real work by default and keeps the existing seven-question intake available when a deeper intake is explicitly wanted.
---

# Onboard

Establish a useful AI-Verse OS without forcing a questionnaire before first value.

The default product behavior is progressive:

```text
user arrives
-> "What would you like help with?"
-> begin useful work
-> learn missing context only when it becomes relevant
```

The seven-question intake remains available for a deliberate full/deep intake. It is not a prerequisite for ordinary work.

## Read first

Read:

- `AGENTS.md`
- `AI-VERSE.yaml`
- `ai-verse-os-intake.md`
- `system/architecture/domain-adaptation.md`
- `system/architecture/direction-ownership.md`
- `workspaces/_template/WORKSPACE.yaml`

The core files remain generic. Do **not** personalize `AGENTS.md`, `CLAUDE.md`, or `AI-VERSE.yaml` with operator-specific facts.

## Step 0 - preserve state and resolve direction ownership

Before durable writes:

- inspect existing v2 operator/workspace files when they matter
- inspect legacy `context/`, `decisions/`, `connections.md`, and operator-specific reference files if they contain real data
- inspect any already-filled answers in `ai-verse-os-intake.md`
- never delete or bulk-move existing user state during onboarding
- if old and new sources conflict, mark the ambiguity and preserve provenance
- run `node scripts/direction-owner.mjs status --scope operator`
- before any operator goal/priority/success-definition write, run `node scripts/direction-owner.mjs assert-strategic-write --scope operator`

Re-running onboarding must be safe and must reuse known answers rather than asking them again.

If the operator scope is Brain-owned, OS onboarding must **not** create, refresh, or silently recover an editable OS strategic store. Read `.aiverse/direction/views/operator.md` when present and treat legacy OS goals/priorities as frozen provenance. Brain unavailability does not change this rule.

## Step 1 - start from real work

If the user already supplied a real request, treat that request as the first onboarding evidence and begin the useful work.

Do **not** stop the task merely because Q1-Q7 are incomplete.

If the user has not supplied a real task yet, ask only:

> What would you like help with?

From the request, infer only what is well-supported, such as:

- relevant role or responsibility
- current scope/project/client
- communication preference demonstrated or stated
- source/tool involved
- privacy/approval boundary
- repeated workflow evidence

Persist supported facts only in their canonical owner when doing so is appropriate. Do not invent missing profile details.

## Step 2 - ask only when blocked

Before asking an onboarding question, determine whether the missing answer actually blocks:

- safety
- scope/privacy
- permission
- external access
- a consequential action
- correct canonical routing
- a strategic write whose owner cannot be resolved

If none of those are blocked, continue the work and leave the unrelated intake field unanswered.

Do not ask the user to choose internal architecture such as Memory vs Data vs Skill vs Workspace.

Do not ask a question merely to make the profile look complete.

## Step 3 - preserve progressive state

`ai-verse-os-intake.md` remains the resumable intake record for OS-owned answers.

- reuse any usable existing answer
- save an OS-owned answer when it is explicitly supplied or safely inferred from strong evidence
- leave unknown fields as placeholders
- after restart, inspect the file and canonical operator/workspace state before asking anything
- if direction is Brain-owned, do not persist Q2 strategic content into the OS intake; route strategic answers to Brain instead

A partially completed intake is valid during normal use.

## Optional full/deep intake

Run the existing seven-question intake only when the user explicitly asks for full onboarding, a complete profile/intake, or equivalent deliberate setup.

Use the exact intent of the intake:

1. Who is the operator and which roles/responsibilities matter?
2. Which outcomes or priorities matter most over the next 90 days?
3. How should the AI work and communicate, including optional real writing samples?
4. Which active areas of work should stay isolated from one another?
5. Where does important information or evidence live?
6. Which tools, systems, people, or channels does the work pass through?
7. Which repeated/high-friction/high-value task should improve first, and what boundaries must be respected?

Do not add an eighth primary question. Ask one missing applicable question at a time and save each answer immediately so the full intake can resume after interruption.

When `direction_owner = brain`, Q2 belongs to Brain onboarding and is not written by OS. OS may use a Brain-generated reference view for operational relevance.

## Step 4 - create or refresh only useful operator state

Using only supported facts, create or refresh as relevant:

- `operator/profile/identity.md`
- `operator/profile/preferences.md`
- `operator/profile/voice.md` only when real writing samples or explicit voice guidance exist
- `operator/context/CURRENT.md`
- `operator/profile/goals.md` **only when** `assert-strategic-write --scope operator` succeeds

Do not create empty profile files merely to claim onboarding completion.

When OS owns direction, `CURRENT.md` may contain editable current priorities. When Brain owns direction, current priorities must be a generated/reference pointer to `.aiverse/direction/views/operator.md` or Brain refs; keep editable OS content to current facts, active workspaces, pending decisions, constraints and operational state.

## Step 5 - add connections only when relevant

If a relevant source/system needs routing and `connections/registry.yaml` does not exist, initialize it from `connections/registry.example.yaml`.

For each relevant entry distinguish:

- planned
- configured
- verified
- degraded/unavailable

Naming a tool does not prove access. Never store secrets. Missing credentials or new external authorization are approval/authorization boundaries, not profile questions to bypass.

Do not pre-populate unrelated connections.

## Step 6 - establish workspaces only when earned by real work

When current evidence shows a substantial scope that deserves isolation, follow the `/workspace` capability.

Create/evolve a workspace only when the boundary is reasonably clear. A single trivial task, tool, or file is not automatically a workspace.

Do not force the user to answer Q4 before useful work can begin.

## Step 7 - treat improvement evidence safely

A repeated/high-friction/high-value workflow may become an improvement candidate, but ordinary onboarding does not itself authorize a new Automation, permanent Bot, credential, Connection, permission expansion, destructive change, or strategic handover.

Do not create a new recurring Automation or permanent Bot unless the user has already explicitly requested that responsibility.

## Verification

Before a progressive onboarding write or full-intake completion, verify:

- known facts were reused rather than re-asked
- unanswered intake fields did not block unrelated useful work
- direction ownership was resolved before strategic writes
- Brain-owned direction did not create editable parallel OS goals
- Brain unavailability was never treated as ownership transfer
- operator facts remain outside system-owned files
- workspace boundaries remain isolated
- connection entries do not overclaim access
- no secrets were written
- existing user state was preserved
- `AGENTS.md`, `CLAUDE.md`, and `AI-VERSE.yaml` remain generic system files

## User-facing handoff

For normal progressive use, keep it natural and brief. Do not announce subsystem choices.

When no additional information is needed, continue the task.

If a first-run handoff is useful:

```text
You're ready to work. I'll learn missing details as they become relevant.
```

For an explicitly requested full intake, a compact completion summary is still appropriate.
