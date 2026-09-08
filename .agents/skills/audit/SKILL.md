---
name: audit
description: Use after onboarding, after meaningful AI-Verse OS changes, before increasing automation autonomy, or during regular reviews. Performs an evidence-based Four Cs audit, checks routing and freshness, records a dated report, and identifies the smallest high-value improvement.
---

# Audit

Measure verified operational reliability, not folder counts.

Read:

- `references/4cs-framework.md`
- `AGENTS.md`
- `CLAUDE.md`
- `connections.md`
- `rubric.md`
- `compatibility.md`
- `history.md`

Do not modify the inspected system merely to improve its score. The default write is the audit report itself.

## Step 1 - define the audit scope

Audit the repository or project in which the skill is being run unless the user specifies a different target.

Record:

- target
- date/time
- runtime being used
- relevant operating manuals
- whether live connections can actually be tested
- important limitations of the inspection

## Step 2 - inspect the Four Cs

### Context

Check whether important current information exists, is discoverable, and has an identifiable canonical source.

Look for:

- operator and business context
- priorities
- active project routes
- voice or brand guidance when relevant
- decisions
- source authority
- stale or conflicting context

### Connections

Use `connections.md` as a registry, not as proof.

For important connections determine whether there is evidence of:

- actual access
- known mechanism
- appropriate permissions
- source freshness
- documented integration knowledge when needed

If a connection cannot be tested, mark it unverified.

### Capabilities

Inspect installed skills, scripts, SOPs, and reusable workflows.

Do not award reliability merely because a skill folder exists. Look for:

- clear triggers
- known inputs and outputs
- guardrails
- verification
- references
- evidence of successful use when available

### Cadence

Look for real schedules, event triggers, recurring runs, monitoring, approval rules, and failure handling.

A file named "daily" is not evidence that anything runs daily.

## Step 3 - routing probes

Run a small set of retrieval probes from a fresh-session perspective.

Examples:

1. Where would the AI find the operator's current priorities?
2. Where is the source of truth for connections?
3. How would it discover a relevant project or lesson reference?
4. Which file explains the Three Ms?
5. Which skill should be used to add a new source?

For each probe record:

- expected source
- route followed
- whether the route resolves
- whether the retrieved source appears current

## Step 4 - compatibility check

Compare `.claude/skills/` and `.agents/skills/`.

Distinguish:

- missing copies
- expected runtime-specific metadata differences
- meaningful logic drift
- package assets missing from one runtime

Do not treat every textual difference as a defect.

## Step 5 - classify findings

Every finding should be one of:

- **confirmed defect**
- **verification gap**
- **stale or conflicting source**
- **intentional runtime difference**
- **optional improvement**

Give stable finding IDs when possible so later audits can track whether an issue is new, still open, resolved, reopened, not rechecked, or no longer applicable.

## Step 6 - score using evidence

Apply `rubric.md`.

Missing or unverified foundational layers should cap the score. A large number of skills must not compensate for broken context or nonexistent connections.

The score is a summary of verified operational reliability, not a measure of the operator's intelligence, business quality, or overall usefulness of AI.

## Step 7 - save the report

Create `audits/` when needed and save a unique report such as:

`audits/YYYY-MM-DD-HHMM-audit.md`

Use `templates/report.md` as the structure.

Audit reports are gitignored because they may contain private project details.

If prior audit reports exist, compare the relevant findings and distinguish actual fixes from changes in evidence coverage.

## Step 8 - choose the next improvement

Recommend no more than three improvements, ordered by expected value and dependency.

Highlight one best next action for `/level-up`.

A valid improvement may be a repair, route fix, connection, script, verification step, or deletion. Do not assume the answer is another skill.

## Rules

- Evidence beats presence.
- Unknown is not the same as broken.
- Do not claim live verification you did not perform.
- Preserve previous audit reports.
- Do not expose secrets in reports.
- Keep current truth separate from point-in-time audit evidence.
- Do not silently change the target while auditing it.
