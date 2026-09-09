---
name: grill-me
description: Use when the operator wants AI-Verse OS to understand a topic, workspace, plan, preference, workflow, domain, lesson, or decision more deeply. Conducts a focused one-question-at-a-time interview, checkpoints answers, separates confirmed facts from exploration, and promotes useful information to the correct scoped source.
---

# Grill Me

Capture knowledge that is still only in the operator's head without mixing brainstorming, historical context, tentative ideas, and confirmed truth.

## Step 1 - choose scope

Determine whether the interview belongs to:

- the operator across workspaces
- one existing workspace
- a candidate new workspace
- shared reusable knowledge

If one workspace clearly owns the topic, use it. Do not dump specialized detail into operator-wide context.

If a new substantial scope emerges, finish enough discovery to understand the boundary and then use `/workspace` rather than inventing ad hoc root structure.

## Step 2 - store the raw interview safely

Use the narrowest inbox:

- operator-wide: `operator/inbox/interviews/YYYY-MM-DD-topic.md`
- workspace-specific: `workspaces/<id>/inbox/interviews/YYYY-MM-DD-topic.md`

Create the parent folders when needed. These user-owned captures are gitignored by default.

Include:

- scope
- topic
- purpose
- status
- questions and verbatim answers
- extracted confirmed facts
- tentative ideas
- historical information
- unresolved questions
- resume point if interrupted

Write each answer as it is given.

## Step 3 - interview one useful question at a time

Adapt questions to the actual domain rather than using one industry's vocabulary.

Useful dimensions include:

- desired outcome
- current process
- important entities and terminology
- authoritative sources
- quality standards
- invariant rules
- what varies
- decision criteria
- failure cases
- privacy or approval boundaries
- tools and connections
- examples and counterexamples
- handoffs
- what the AI must never assume

Do not repeat information already available in canonical context.

Stop when additional questioning is no longer materially improving the system.

## Step 4 - classify what was learned

**Confirmed current context:** presently true and relevant now.

**Durable knowledge:** reusable understanding, procedure, vocabulary, standard, or reference material.

**Decision:** a settled choice with reasoning.

**Historical/memory:** what happened and may matter later.

**Tentative:** brainstorming, guesses, future possibilities, or unresolved choices.

**Source route:** information that should remain in another authoritative system.

Do not promote tentative material as fact.

## Step 5 - promote to the narrowest canonical home

Examples:

- operator identity/preferences -> `operator/profile/`
- operator-wide current priorities -> `operator/context/CURRENT.md`
- operator history/learnings -> `operator/memory/`
- workspace current state -> workspace `context/CURRENT.md`
- workspace durable knowledge -> workspace `knowledge/`
- workspace history -> workspace `memory/`
- scoped settled choice -> scoped `decisions/`
- cross-workspace reusable knowledge -> root `knowledge/`
- live external source -> `connections/registry.yaml` plus workspace/source route
- repeated AI-guided execution -> candidate local or shared skill
- repeated deterministic execution -> candidate script
- reliable scheduled/event execution -> candidate automation

Promote only information the user has confirmed or evidence supports.

## Workflow-to-capability mode

When the interview is about a repeatable workflow, extract:

1. trigger
2. desired outcome
3. required inputs/sources
4. ordered steps
5. decision points
6. invariant locks/guardrails
7. permissions and approvals
8. expected outputs
9. verification
10. failure behavior

Then classify it as knowledge/SOP, template, script, skill, agent, automation, or a combination.

Keep workspace-specific capabilities local until they are proven portable.

## Completion

Summarize:

- what was learned
- what is confirmed
- what remains tentative
- which canonical sources were updated or should be updated
- whether a workspace/capability/automation is justified
- the one most useful unresolved question, if any
