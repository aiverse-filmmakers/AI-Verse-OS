---
name: audit
description: Use after onboarding, after meaningful AI-Verse OS changes, before increasing automation autonomy, or during regular reviews. Performs an evidence-based architecture v2 and Four Cs audit covering source authority, workspace isolation, routing, privacy, compatibility, freshness, capabilities, and real cadence.
---

# Audit

Measure verified operational reliability, not folder counts.

## Read

Read:

- `AI-VERSE.yaml`
- `AGENTS.md`
- `system/architecture/README.md`
- `system/architecture/source-of-truth.md`
- `references/4cs-framework.md`
- `connections/registry.yaml` when it exists, otherwise note legacy registry state
- `rubric.md`
- `compatibility.md`
- `history.md`

Run `bash scripts/check-architecture.sh` when the script is available. Treat its result as evidence, not as the entire audit.

Do not modify the inspected system merely to improve its score. The default write is the audit report.

## Step 1 - define scope

Record:

- target installation/workspace
- date/time
- runtime
- active workspace, if any
- whether live connections can be tested
- important inspection limitations

## Step 2 - inspect architecture integrity

Check:

### Ownership

- system-owned files are not being personalized with user facts
- user-owned state is not casually overwritten by system updates
- public-template privacy rules are intact unless deliberately changed

### Authority

- current facts have identifiable canonical sources
- there are no unexplained editable duplicates
- indexes/apps/summaries are not being treated as sole truth

### Workspace isolation

- substantial scopes have clear workspace boundaries when isolation is useful
- workspace-specific context is not polluting unrelated scopes
- manifests identify source routes, privacy, and approvals where relevant

### Domain neutrality

- profession/domain specialization occurs locally or through optional overlays
- the universal root has not fragmented into one mini-OS per function/domain
- domain-specific shared structure is justified by real reuse

### Runtime hygiene

- derived state is rebuildable
- irreplaceable knowledge is not trapped in `runtime/` or an app cache

## Step 3 - inspect the Four Cs

### Context

Check operator and active-workspace current state, memory separation, priorities, decisions, freshness cues, and routing to deeper sources.

### Connections

A registry entry is not evidence of working access. For important connections determine whether there is evidence of actual access, known mechanism, appropriate permissions, scope, source freshness, and safe authentication handling.

### Capabilities

Inspect shared and workspace-local skills, scripts, agents, templates, and reusable workflows. Look for triggers, inputs, outputs, decision rules, guardrails, verification, failure behavior, and evidence of use.

### Cadence

Look for real schedules/event triggers, permissions, approval rules, retries, deduplication, monitoring, failure handling, and evidence of execution. A filename is not runtime evidence.

## Step 4 - routing probes

From a fresh-session perspective test a small set such as:

1. Where are operator-wide current priorities?
2. How is the active workspace identified and loaded?
3. Which source is authoritative for a workspace-specific fact?
4. Where is live-source access registered and what proves it works?
5. Where should a new specialized piece of knowledge be stored first?
6. How would a local skill be promoted to shared capability?
7. Which file defines architecture when adapters disagree?

Record expected source, route followed, resolution, freshness, and authority.

## Step 5 - compatibility

Compare `.claude/skills/` and `.agents/skills/` using `compatibility.md` and the architecture check.

Distinguish missing packages, meaningful logic drift, expected runtime metadata differences, and broken dependencies.

## Step 6 - classify findings

Use:

- confirmed defect
- verification gap
- stale/conflicting source
- isolation/authority defect
- intentional runtime difference
- optional improvement

Use stable IDs when useful.

## Step 7 - score evidence

Apply `rubric.md`.

A large number of skills or folders must not compensate for broken authority, missing context, unsafe connection assumptions, or nonexistent execution evidence.

## Step 8 - save report

Save private point-in-time audit evidence under:

`runtime/reports/YYYY-MM-DD-HHMM-audit.md`

Create the folder when needed. Use `templates/report.md`.

If a finding changes durable current state or leads to a settled decision, promote that small result to the appropriate operator/workspace context or decision source rather than treating the entire audit report as canonical truth.

## Step 9 - recommend the next improvement

Recommend at most three improvements ordered by dependency and expected value. Highlight one best next action for `/level-up`.

A valid improvement may be deletion, migration, routing repair, verification, connection work, context cleanup, a script, a skill, an automation, or a policy. Do not default to adding complexity.

## Rules

- Evidence beats presence.
- Unknown is not the same as broken.
- Do not claim live verification you did not perform.
- Do not expose secrets in reports.
- Preserve workspace privacy boundaries.
- Do not silently change the target while auditing it.
