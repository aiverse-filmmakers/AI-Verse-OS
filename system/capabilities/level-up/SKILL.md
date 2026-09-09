---
name: level-up
description: Use when the operator wants to remove a recurring constraint, improve leverage, repair a weak workflow, strengthen a workspace, or convert repeated work into a more reliable capability. Uses the Three Ms and ships one scoped improvement without assuming a profession.
---

# Level Up

Use the Three Ms to turn one real constraint into one concrete improvement at the correct scope.

Read `references/3ms-framework.md`, `AI-VERSE.yaml`, relevant current context, and the latest relevant audit evidence when available.

## Step 1 - scope the improvement

Determine whether the constraint is:

- operator-wide
- workspace-specific
- shared across several workspaces
- system/architecture-related

Prefer solving it locally before promoting complexity globally.

## Phase 1 - Mindset: find the highest-value constraint

Look at:

- current operator priorities
- active workspace objectives
- repeated manual work
- recent audit findings
- repeated context reconstruction
- fragile partially automated workflows
- useful work being avoided because it is too slow, expensive, inconsistent, or difficult

Ask only enough to identify one target.

## Phase 2 - Method: redesign the work

### EAD

1. **Eliminate:** can a step disappear?
2. **Automate:** which steps are repetitive and sufficiently reliable?
3. **Delegate:** which steps should remain human or move to another person/system?

### Map the process

Capture:

- trigger
- authoritative inputs
- transformations
- decision points
- approvals/permissions
- outputs
- failure paths

### Choose autonomy

Use the lowest workable level:

- L0 manual
- L1 suggested
- L2 drafted
- L3 supervised execution
- L4 monitored autonomous execution

High-stakes or external actions may require a lower autonomy level even when technically automatable.

### Define success

Choose useful measures appropriate to the actual domain, such as time saved, error reduction, quality, throughput, latency, reliability, cost, fewer handoffs, better coverage, or another evidence-based outcome.

### Record meaningful decisions

Write a settled implementation choice to the narrowest decision log:

- operator-wide -> `operator/decisions/`
- workspace -> workspace `decisions/`

Do not duplicate it in the legacy root log.

## Phase 3 - Machine: build the smallest reliable version

For each block define:

- input/source
- action
- output
- deterministic vs AI-driven
- validation
- permissions
- failure behavior

Prefer deterministic code/rules when sufficient. Validate each block before chaining it.

## Choose the correct artifact and scope

The improvement may be:

- deletion of unnecessary work
- better current context or routing
- connection verification
- knowledge/SOP
- template
- script
- workspace-local skill
- shared skill
- agent
- automation
- app
- policy/approval rule

Do not default to a shared skill.

### Local-first promotion

If the method depends on one workspace's terminology, sources, policies, or hidden assumptions, keep it local.

Promote to shared capability only after portability and verification are demonstrated.

## Rollout

For workflows with external or consequential effects, use staged autonomy:

1. manual baseline
2. AI draft/suggestion
3. supervised execution
4. monitored autonomy

Increase autonomy from evidence, not enthusiasm.

## Verification

Verify the actual failure modes of the improvement. If the target is domain-regulated or high-consequence, increase evidence and human review accordingly.

## Completion

```text
Scope:
Target:
Constraint:
What changed:
Artifact/location:
Autonomy level:
Verification:
Metric/evidence to watch:
Promotion status: local / shared
Next audit check:
```

After a meaningful implementation, use `/audit` to verify rather than assuming the change worked.
