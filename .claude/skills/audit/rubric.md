# AI-Verse OS Audit Rubric

Score verified evidence across the Four Cs. The goal is diagnostic usefulness, not score inflation.

Total: 100 points.

## Context - 30 points

- 8: operator/business context exists and is discoverable
- 6: current priorities or active work are identifiable
- 5: source authority is clear when information could conflict
- 5: operating manuals route to important context correctly
- 3: important context has freshness or recency cues when needed
- 3: archived/tentative material is separated from current truth

## Connections - 25 points

- 5: `connections.md` covers important domains
- 8: important named connections have evidence of actual access
- 4: mechanisms and permissions are understood
- 4: freshness is known for important sources
- 4: reusable integration knowledge is documented when the connection is non-trivial

## Capabilities - 30 points

- 6: important recurring work has at least one usable capability
- 6: skill triggers, inputs, outputs, and execution steps are clear
- 6: verification or QC exists for meaningful workflows
- 4: deterministic helpers are used where appropriate
- 4: package/reference dependencies are discoverable
- 4: there is evidence of successful real use when such evidence is available

## Cadence - 15 points

- 5: at least one useful recurring or event-driven workflow is actually configured, when cadence is relevant
- 4: approval, monitoring, or exception handling matches the risk
- 3: duplicate-run and failure behavior is considered
- 3: there is evidence of actual execution over time

## Evidence rules

- Presence alone earns only presence-related points.
- A configured key, connection name, schedule filename, or skill folder is not proof of operation.
- If a live test cannot be performed, mark the item unverified rather than awarding full credit.
- Intentional differences between Claude Code and Codex are not defects.
- A resolved finding requires fresh evidence.

## Score caps

Use caps to prevent superficial strength in one layer from hiding a broken foundation.

- If essential Context is missing or unrouteable: maximum 55.
- If no important Connection can be verified and the system depends on live data: maximum 70.
- If installed Capabilities have no usable execution path or verification: maximum 75.
- Cadence can remain low without capping an early-stage system, provided the report clearly states that automation has not yet matured to that layer.

## Interpretation

- 90-100: strongly verified operating system
- 75-89: useful and mostly reliable, with identifiable gaps
- 60-74: functioning foundation, important gaps remain
- 40-59: partial structure with limited verified operation
- below 40: mostly unverified or missing foundations

The interpretation should never replace the actual findings.
