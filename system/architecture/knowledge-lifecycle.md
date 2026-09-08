# Knowledge Lifecycle

AI-Verse OS treats information differently depending on its maturity and purpose.

## 1. Inbox

Incoming material is unclassified. Examples include uploaded files, notes, transcripts, exports, recordings, scraped pages, messages, research dumps, and observations.

Receipt is not validation. Inbox material should not automatically override current context or curated knowledge.

## 2. Classify

Determine whether the useful part belongs to:

- current context
- memory/history
- durable knowledge
- a decision
- a source route/connection
- a candidate skill or automation
- archive/discard

A single source may contribute to several categories, but do not duplicate entire documents unnecessarily.

## 3. Context

Context is a compact representation of what matters now.

Good context contains active state, priorities, pending decisions, constraints, and pointers to deeper sources.

Context should not become a full historical transcript.

## 4. Memory

Memory records events, learnings, and historical state that may matter later but should not be loaded into every session.

Memory can be searched when needed. It does not automatically outrank current context.

## 5. Knowledge

Knowledge is curated reusable information: terminology, models, procedures, standards, conclusions, reference facts, patterns, or domain understanding.

Keep it workspace-local while its usefulness is narrow. Promote it to root `knowledge/` when genuinely reusable across workspaces.

## 6. Decisions

A decision stores what was settled, why, constraints, evidence, alternatives, owner, and what would cause reconsideration.

A changed decision should supersede an older one, not erase it.

## 7. Capability

When knowledge describes repeatable execution, decide whether it should become a skill, script, template, agent, or automation.

Do not turn every note into executable logic.

## 8. Archive

Archive obsolete or superseded material that still has historical value. Archived content should be discoverable but must not silently override active truth.

## Promotion test

Before promoting information to a stronger layer, ask:

- Is it verified enough for that layer?
- Will future work benefit from it?
- Is there already a canonical source?
- Is the scope operator-wide, shared, or workspace-specific?
- Could promotion expose sensitive information?

The goal is not maximum retention. The goal is reliable retrieval of the right information at the right scope.
