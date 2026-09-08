---
name: level-up
description: Use after AI-Verse OS has basic context or whenever the operator wants to improve leverage, remove recurring manual work, repair a weak workflow, or convert a repeated process into a capability. Uses the Three Ms in order and ends with one shipped or clearly scoped improvement.
---

# Level Up

Use the Three Ms to turn one real constraint into one concrete improvement.

Read `references/3ms-framework.md` before running this skill. Read the latest relevant `/audit` report when one exists.

## Principle

One run should focus on one improvement. Do not end with a giant backlog of vague automation ideas.

A repair to an existing workflow can be more valuable than adding another skill.

## Phase 1 - Mindset: find the opportunity

Look at:

- the operator's current priorities
- repeated manual tasks
- the biggest current time sink
- recent audit findings
- work that repeatedly requires copy-pasting context
- workflows that are already partially automated but still fragile
- important work the operator is not doing because it is too slow or expensive

Ask enough questions to identify the highest-value candidate.

Useful prompts include:

- What are you doing repeatedly that should feel easier by now?
- If demand doubled tomorrow, what would break first?
- What useful work are you avoiding because it takes too long?
- Where are you repeatedly rebuilding the same prompt or explanation?
- To what extent can AI be leveraged here?

Select one target and state why it matters.

## Phase 2 - Method: decide what should change

### Run EAD

For the target process:

1. **Eliminate:** can any step disappear entirely?
2. **Automate:** which steps are repetitive or machine-friendly?
3. **Delegate:** which steps should remain human or be handled by another person?

### Map the process

Capture:

- trigger
- input sources
- transformations
- decision points
- output destination

### Choose autonomy

Assign the lowest workable level to each important step:

- L0 manual
- L1 suggested
- L2 drafted
- L3 supervised
- L4 autonomous

### Define success

Choose at least one useful outcome such as:

- time saved
- more outputs shipped
- lower error rate
- faster response
- higher conversion
- lower cost
- less context switching
- fewer manual handoffs

### Record the decision

If the operator commits to a meaningful implementation, append a concise entry to `decisions/log.md` including the reason and constraints.

## Phase 3 - Machine: build the smallest reliable version

Break the solution into blocks.

For every block identify:

- input
- action
- output
- deterministic vs AI-driven
- validation
- failure behavior

Prefer deterministic code or rules when they are enough.

Build or specify the smallest useful version first. Validate each step before chaining it.

## Decide the correct artifact

The improvement may be:

- a repaired existing skill
- a new skill
- a script
- a template
- an SOP
- a better route to context
- a new connection
- a scheduled automation
- removal of an unnecessary process

Do not default to creating a new skill.

## When the target should become a skill

A new skill is justified when the process:

- will be repeated
- has a recognizable trigger
- requires consistent reasoning or ordered steps
- has clear inputs and outputs
- benefits from guardrails
- can be verified

If it is only knowledge, store it as a reference. If it is a deterministic helper, prefer a script. If it is a proven process humans also need to understand, an SOP may be appropriate.

## Rollout

For workflows with real-world actions, recommend staged autonomy:

1. manual test
2. AI draft with review
3. supervised execution
4. monitored autonomy

Use higher autonomy only when evidence supports it.

## Completion

End with a compact implementation summary:

```text
Target:
Constraint:
What changed:
Artifact created or repaired:
Autonomy level:
Verification:
Metric to watch:
Next audit check:
```

If implementation was completed, suggest running `/audit` again to verify the improvement rather than assuming it worked.
