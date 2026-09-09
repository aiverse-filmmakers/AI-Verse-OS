# AI-Verse OS v2 Audit Rubric

Score verified evidence, not visual complexity.

Total: 100 points.

## Architecture integrity - 20 points

- 5: system-owned and user-owned state have clear boundaries
- 5: source authority is explicit and duplicate editable truth is controlled
- 4: workspaces isolate substantial scopes without cross-contamination
- 3: derived runtime/app/index state is not the only copy of important truth
- 3: universal core remains domain-neutral and specialization is scoped deliberately

## Context - 20 points

- 5: operator current context is discoverable when relevant
- 5: active workspace current context is compact, current, and routeable
- 4: memory/history is separated from current state
- 3: decisions and important source pointers are discoverable
- 3: freshness/recency is visible where current state matters

## Connections - 20 points

- 4: important sources are represented in the canonical registry or deliberate legacy route
- 6: important named connections have evidence of actual access when live data is required
- 4: mechanism, scope, and permissions are understood
- 3: freshness is known for current-state sources
- 3: secrets are not stored in repository connection metadata

## Capabilities - 25 points

- 5: important recurring work has at least one usable capability
- 5: triggers, scope, inputs, outputs, and ordered execution are clear
- 5: decision rules, guardrails, and failure behavior are explicit
- 5: verification/QC exists for consequential workflows
- 3: deterministic helpers are used where appropriate
- 2: there is evidence of real successful use when evidence is available

## Cadence - 15 points

- 4: at least one useful recurring/event-driven workflow is configured when cadence is relevant
- 4: approval/permissions match consequence and scope
- 3: retry, deduplication, monitoring, or exception handling is considered
- 4: there is evidence of actual execution over time

## Evidence rules

- Presence alone earns only presence-related points.
- A configured connection name, schedule filename, agent, or skill folder is not proof of operation.
- If a live test cannot be performed, mark it unverified rather than awarding full operational credit.
- An intentional runtime adapter difference is not automatically a defect.
- A resolved finding requires fresh evidence.

## Score caps

- Broken or ambiguous source authority for essential current state: maximum 55.
- Essential context missing or unrouteable: maximum 55.
- No important live connection can be verified when the system depends on live data: maximum 70.
- Installed capabilities have no usable execution path or verification: maximum 75.
- Workspace isolation leaks sensitive or materially conflicting context: maximum 60 until repaired.
- Cadence may remain low without capping an early-stage installation when automation is not yet relevant.

## Interpretation

- 90-100: strongly verified operating system
- 75-89: useful and mostly reliable, with identifiable gaps
- 60-74: functioning foundation, important gaps remain
- 40-59: partial or weakly verified operation
- below 40: mostly unverified or missing foundations

The score summarizes evidence. The findings remain more important than the number.
