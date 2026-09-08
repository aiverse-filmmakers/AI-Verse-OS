---
name: grill-me
description: Use when the operator wants AI-Verse OS to understand a topic, project, plan, preference, workflow, business area, lesson, or decision more deeply. Conducts a focused one-question-at-a-time interview, checkpoints every answer, and promotes confirmed facts into canonical context when requested.
---

# Grill Me

Capture knowledge that is still only in the operator's head without mixing brainstorming, tentative ideas, and confirmed facts together.

## Trigger examples

- "grill me about this project"
- "help the OS understand how I work"
- "ask me questions about this lesson"
- "I want to dump everything I know about this workflow"
- "interview me so this becomes usable context"

Use `/onboard` for first-time setup. Use `/grill-me` for depth after onboarding.

## Storage

Create a dated Markdown capture under `brainstorms/`.

Recommended filename:

`brainstorms/YYYY-MM-DD-topic-slug.md`

Include:

- topic
- purpose of the interview
- status: in-progress or complete
- questions and verbatim answers
- extracted confirmed facts
- tentative ideas
- unresolved questions
- resume point if interrupted

Write each answer immediately after it is given. Do not wait until the end to save the entire interview.

## Interview behavior

Ask one useful question at a time.

Start broad enough to understand the topic, then narrow based on the answer. Avoid a rigid questionnaire when the user's answers reveal a more useful direction.

Useful question categories include:

- what outcome matters
- how the operator currently does the work
- why they make certain choices
- what always stays consistent
- what varies
- failure cases
- quality standards
- tools and sources
- terminology
- examples and counterexamples
- handoff requirements
- what the AI must never assume

Do not repeat questions the operator has already answered.

## Separating fact from exploration

Classify captured information carefully.

**Confirmed context:** the operator states it as current truth, a rule, a preference, or a settled decision.

**Tentative:** brainstorming, possible future plans, guesses, experiments, or unresolved choices.

**Historical:** previously true information that may explain a decision but should not overwrite current context.

Do not promote tentative ideas into canonical context as if they are confirmed.

## Promoting knowledge into AI-Verse OS

When the user explicitly wants the interview to update the system, route confirmed information into the smallest appropriate canonical source.

Examples:

- personal or working preferences -> `context/about-me.md`
- business facts -> `context/about-business.md`
- priorities -> `context/priorities.md`
- durable workflow knowledge -> `references/` or an SOP
- repeated executable process -> candidate AI-Verse skill
- meaningful settled decision -> `decisions/log.md`
- live external source -> `connections.md` plus a route or integration reference

Link back to the brainstorm capture when provenance would be useful.

## Lesson-to-skill mode

When the interview is about an AI-Verse lesson, also determine whether the lesson should become a skill.

Extract:

1. the learner's desired outcome
2. required inputs or reference assets
3. ordered execution steps
4. decisions the AI must make
5. rules that must remain locked
6. expected deliverables
7. verification and quality-control checks
8. model-specific details that belong in references rather than timeless skill logic

At the end, state whether the material is best stored as:

- reference knowledge
- an SOP
- a reusable template
- an executable skill
- a combination of those

## Completion

When the useful information has been captured, summarize:

- what was learned
- which facts are confirmed
- which ideas remain tentative
- what was added or should be added to canonical context
- whether a new skill or workflow is justified

Do not manufacture a fixed number of questions. Stop when additional questions are no longer materially improving the system.
