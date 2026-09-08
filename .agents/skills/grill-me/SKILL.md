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

Recommended filename: `brainstorms/YYYY-MM-DD-topic-slug.md`.

Include topic, purpose, status, questions and verbatim answers, confirmed facts, tentative ideas, unresolved questions, and a resume point if interrupted. Save every answer immediately.

## Interview behavior

Ask one useful question at a time. Start broad, then narrow based on the answer. Avoid a rigid questionnaire when the user's answers reveal a more useful direction.

Useful areas include outcome, current workflow, why choices are made, what stays consistent, what varies, failure cases, quality standards, tools, terminology, examples, handoffs, and assumptions the AI must never make.

## Separate fact from exploration

- **Confirmed:** current truth, rule, preference, or settled decision.
- **Tentative:** brainstorming, future plans, guesses, experiments, unresolved choices.
- **Historical:** previously true information that should not override current context.

Do not promote tentative ideas into canonical context as confirmed truth.

## Promote confirmed knowledge

When requested, route confirmed information into the smallest appropriate canonical source:

- personal/working preferences -> `context/about-me.md`
- business facts -> `context/about-business.md`
- priorities -> `context/priorities.md`
- durable workflow knowledge -> `references/` or an SOP
- repeated executable process -> candidate AI-Verse skill
- meaningful decision -> `decisions/log.md`
- live external source -> `connections.md` plus an appropriate route

## Lesson-to-skill mode

When interviewing about an AI-Verse lesson, extract:

1. desired outcome
2. required inputs or reference assets
3. ordered execution steps
4. decisions the AI must make
5. locked rules
6. expected deliverables
7. verification and QC checks
8. model-specific details that belong in references rather than timeless skill logic

At completion, state whether the material is best stored as reference knowledge, an SOP, a template, an executable skill, or a combination.

Stop when further questions no longer materially improve the system.
