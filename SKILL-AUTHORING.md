# AI-Verse OS Skill Authoring Guide

AI-Verse skills should be portable capabilities that perform repeatable work reliably. The shared skill layer must remain useful across professions; domain-specific assumptions should be explicit, parameterized, or kept inside the workspace that needs them.

## First decide what the material really is

Not everything should become a skill.

| Material | Best home |
|---|---|
| Current state | operator/workspace `context/` |
| Historical events and learnings | operator/workspace `memory/` |
| Durable reusable information | workspace `knowledge/` first, root `knowledge/` when broadly reusable |
| A settled choice and reasoning | scoped `decisions/` |
| A repeatable human procedure | knowledge/SOP material |
| A reusable artifact shape | template |
| Deterministic file/API/data work | script |
| Repeatable AI-guided work with judgment, guardrails, and verification | skill |
| Coordination across multiple capabilities | agent |
| Reliable scheduled/event-driven execution | automation |
| Persistent human interface | app |

A workflow can produce several artifacts. Keep execution logic in the skill and deeper domain knowledge in references/knowledge so either can evolve without duplicating the other.

## Current skill packaging

The current materialized authoring source is:

```text
.claude/skills/<skill-name>/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── references/
├── assets/
└── scripts/
```

`skills/registry.yaml` is the runtime-neutral capability registry. Codex-compatible packages are synchronized to `.agents/skills/` with:

```bash
bash scripts/sync-codex-skills.sh <skill-name>
```

The capability contract should not depend on Claude-specific behavior unless the skill explicitly declares that limitation.

## Required anatomy

### 1. Trigger

Define recognizable intent that should activate the skill. Do not rely only on a slash command.

### 2. Outcome

State the concrete result that should exist when the skill finishes.

### 3. Scope

Declare whether the skill is:

- universal/shared
- domain-aware but portable
- workspace-local
- runtime-specific

If a shared skill assumes one profession's terminology or workflow, either parameterize it or move it to a narrower scope.

### 4. Inputs

List required context, files, connected data, user decisions, assets, constraints, and permissions.

Reuse known operator/workspace context instead of asking the user to repeat it.

### 5. Execution

Write the real ordered workflow. Separate deterministic operations from AI judgment. Make handoffs explicit when another capability consumes the output.

### 6. Decision rules

Explain how the AI chooses between valid paths. Avoid hidden intuition that only the original author understands.

### 7. Locks and guardrails

State what may not be invented, changed, disclosed, overwritten, published, or acted upon without approval.

For regulated, safety-critical, financial, legal, medical, security-sensitive, or otherwise high-stakes work, include stricter evidence, verification, permissions, and human-approval rules.

### 8. Outputs

Define what is produced, where it belongs, and whether it is current context, memory, knowledge, a decision, an artifact, or disposable runtime output.

### 9. Verification

Verify the failure modes that would make the result unreliable or unsafe. A skill is incomplete if it cannot say how success is checked.

### 10. Failure behavior

Explain what happens when inputs are missing, a connection fails, the evidence is ambiguous, or the requested action exceeds allowed autonomy.

## Domain adaptation

A shared capability may operate in many domains by loading domain knowledge from the active workspace.

Prefer this pattern:

```text
shared skill method
      +
workspace context
      +
workspace knowledge
      +
workspace policies
      +
approved connections
      =
scoped execution
```

Do not duplicate a separate version of a generic skill for every profession merely to change terminology.

A domain-specific skill is appropriate when the reasoning itself materially differs and cannot be represented safely as parameters, references, or policies.

## Keep changing knowledge outside stable skill logic

Fast-changing model behavior, regulations, vendor APIs, platform quirks, or domain reference material should live in references/knowledge loaded by the skill as needed.

The stable skill should contain the method and guardrails.

## Beginner and expert rule

A skill should perform as much reliable reasoning as possible instead of forcing the user to learn internal terminology. Ask a question only when the answer materially changes execution, safety, or output quality.

At the same time, do not hide consequential assumptions from expert users. Surface important uncertainty, provenance, and approval points.

## Promotion test

Before promoting a workspace-local capability to the shared layer, verify:

1. The trigger makes sense outside the original workspace.
2. Required inputs are explicit.
3. Workspace-specific facts have been removed from the method.
4. Domain assumptions are parameterized or documented.
5. Ordered steps are reproducible.
6. Guardrails and autonomy boundaries are explicit.
7. Outputs have a canonical destination.
8. Verification is meaningful.
9. Failure behavior is defined.
10. At least one fresh-session run can execute without relying on undocumented context.

If those conditions are not met, keep improving it locally instead of expanding the global skill library.
