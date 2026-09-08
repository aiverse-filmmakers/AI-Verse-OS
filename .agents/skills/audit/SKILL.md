---
name: audit
description: Use after onboarding, after meaningful AI-Verse OS changes, before increasing automation autonomy, or during regular reviews. Performs an evidence-based Four Cs audit, checks routing and freshness, records a dated report, and identifies the smallest high-value improvement.
---

# Audit

Measure verified operational reliability, not folder counts.

Read `references/4cs-framework.md`, `AGENTS.md`, `CLAUDE.md`, `connections.md`, `rubric.md`, `compatibility.md`, and `history.md`.

Do not modify the inspected system merely to improve its score. The default write is the audit report itself.

## Scope

Record the target, runtime, relevant operating manuals, live checks actually performed, and inspection limitations.

## Four Cs

### Context
Check that current operator/business information, priorities, projects, voice/brand guidance, decisions, authority, and freshness are discoverable from canonical routes.

### Connections
Treat `connections.md` as a registry, not proof. Verify actual access, mechanism, permissions, freshness, and reusable integration knowledge where possible. Mark unavailable tests as unverified.

### Capabilities
Inspect skills, scripts, SOPs, templates, and workflows for clear triggers, inputs, outputs, guardrails, verification, references, and evidence of successful use where available.

### Cadence
Look for real schedules, event triggers, recurring runs, monitoring, approval rules, exception handling, and execution evidence. A filename containing "daily" is not proof of cadence.

## Routing probes

Test a small set of fresh-session lookups, such as current priorities, connection source of truth, project or lesson routes, the Three Ms reference, and the skill used to add a new source.

Record expected source, route followed, whether it resolves, and freshness.

## Compatibility

Compare `.claude/skills/` and `.agents/skills/`. Distinguish missing packages, meaningful logic drift, missing assets, and intentional runtime-specific differences.

## Findings

Classify findings as:

- confirmed defect
- verification gap
- stale or conflicting source
- intentional runtime difference
- optional improvement

Use stable IDs where useful so future audits can track new, still-open, resolved, reopened, not-rechecked, and no-longer-applicable findings.

## Score and report

Apply `rubric.md`. Missing or unverified foundations should cap the score.

Save `audits/YYYY-MM-DD-HHMM-audit.md` using `templates/report.md`. Preserve earlier reports and compare relevant findings.

Recommend no more than three improvements, ordered by value and dependency, with one best next `/level-up` target.

## Rules

- Evidence beats presence.
- Unknown is not the same as broken.
- Do not claim live verification you did not perform.
- Preserve prior reports.
- Never expose secrets in reports.
- Keep audit evidence separate from current canonical truth.
