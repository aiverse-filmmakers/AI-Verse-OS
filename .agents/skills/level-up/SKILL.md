---
name: level-up
description: Use after AI-Verse OS has basic context or whenever the operator wants to improve leverage, remove recurring manual work, repair a weak workflow, or convert a repeated process into a capability. Uses the Three Ms in order and ends with one shipped or clearly scoped improvement.
---

# Level Up

Use the Three Ms to turn one real constraint into one concrete improvement.

Read `references/3ms-framework.md` before running this skill. Read the latest relevant `/audit` report when one exists.

## Principle

One run should focus on one improvement. A repair to an existing workflow can be more valuable than adding another skill.

## Phase 1 - Mindset

Look at current priorities, repeated manual tasks, time sinks, audit findings, repeated context reconstruction, fragile workflows, and important work the operator avoids because it is too slow.

Ask enough questions to choose one high-value target. Use the question: "To what extent can AI be leveraged here?"

## Phase 2 - Method

Run EAD:

1. Eliminate unnecessary steps.
2. Automate repeatable machine-friendly steps.
3. Delegate steps that should remain human.

Map the trigger, inputs, transformations, decisions, and output destination.

Choose the lowest workable autonomy level:

- L0 manual
- L1 suggested
- L2 drafted
- L3 supervised
- L4 autonomous

Define a measurable outcome such as time saved, more output, lower errors, faster response, higher conversion, lower cost, or fewer manual handoffs.

Append a decision to `decisions/log.md` when the operator commits to a meaningful implementation.

## Phase 3 - Machine

Break the solution into small blocks. For every block identify input, action, output, deterministic vs AI-driven logic, validation, and failure behavior.

Prefer deterministic code or rules when enough. Validate each block before chaining it.

The correct artifact may be a repaired skill, new skill, script, template, SOP, route, connection, schedule, or removal of an unnecessary process. Do not default to creating another skill.

## When a target should become a skill

A new skill is justified when the process is repeatable, has a recognizable trigger, requires consistent ordered work or reasoning, has clear inputs and outputs, benefits from guardrails, and can be verified.

If it is only knowledge, store it as a reference. If deterministic logic is enough, prefer a script.

## Rollout

Use staged autonomy for real-world actions: manual test, draft with review, supervised execution, then monitored autonomy.

## Completion

Report target, constraint, what changed, artifact created or repaired, autonomy level, verification, metric to watch, and the next audit check.

If implementation was completed, run or recommend `/audit` again rather than assuming success.
