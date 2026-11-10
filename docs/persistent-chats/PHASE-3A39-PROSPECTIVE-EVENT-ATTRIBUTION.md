# Phase 3A.39: synthetic prospective v2 original-event attribution, no capture

**Status: CI-tested, zero-storage structural preview only.** This milestone
does NOT authenticate the real Codex subprocess or operator, grant recording
consent, prove complete UI coverage, install hooks, import history, open user
conversations, enable archive writes or retrieve Memory.

## Implementation

- `codex_app_server_event_admission_preview.py` introduces
  `SyntheticOwner` and `ProspectiveEventPreview`, both disconnected
  from installed OS, Codex process launch, Gateway, archives and Memory.
  The synthetic owner retains a transient **in-memory object identity**,
  workspace label, physical-path *claim*, child PID *claim* and generation.
  These are tests of lifecycle structure and **are forgeable if passed in
  from a caller**. They must not be adopted as authenticated provenance.
- An observation must match that exact in-memory source object and current
  synthetic binding. Workspace switch, process replacement, revoked
  source, stale generation or incorrect process identity fail closed.
- The candidate handles a fresh `turn/started`, exactly one
  `item/completed` text-only `userMessage`, exactly one final-answer
  `agentMessage`, then `turn/completed`. It validates strict
  thread/turn/item IDs, duplicate item IDs, bounded event count, bounded
  timestamp and text UTF-8 size.
- Delta streams, history/resume, tools, reasoning, multimodal content,
  commentary, partial answers, unsupported event kinds, cross-turn
  items and incomplete or overlapping sequences are rejected.
- Text is evaluated transiently for shape and size but **never stored,
  hashed, logged, returned or serialized** by the module. Its verdict
  carries only event count and fixed false authorizations.
- `recording_permitted`, `persist` and `retrieve_memory` are
  unconditionally false. A well-shaped complete synthetic turn remains
  only a candidate, never complete UI coverage or a write grant.
- `test_codex_app_server_event_admission_preview.py` exercises the
  complete synthetic cycle and negative cases. It runs in the
  repository QC and the pinned real Codex offline CI workflow **before**
  that workflow downloads or starts the real binary.

The actual app-server v2 notification shape is pinned elsewhere in this
repo to the immutable upstream schema source commit, rather than trusting
a moving main branch. This phase does not change that pin or expand
production admission.

## Verified GitHub results (exact tested code head)

Code head: `95b9232996d77cd513bffb8ba4e71a83451f75f5`.

- [Pinned real Codex offline workflow, including 3A.39 negative tests](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42886073804): **PASS**
- [Repository QC, including 3A.39 negative tests](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42886073703): **PASS**
- [Trusted Dashboard session boundary](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42886073878): **PASS**
- [Four Repo Acceptance](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42886073665) and other OS workflows may still be running. Do not claim global green until finished.

## Remaining hard gates

An actual native host must derive and authenticate the original Codex
process handle, protocol pipe, physical workspace and per-event current
session, without trusting serialized source IDs or synthetic fixtures.
A genuine signed native-host device-owner authentication result is
needed, followed by a *separate*, affirmative prospective-only
recording consent, validated at every original event. Text visibility
and UI completeness still need independent coverage and privacy review.
Until there is a reviewed, owner-scoped archive writer with retention,
deletion and Memory consent policy, no production content storage may
be enabled.

Dashboard [draft PR #105](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/pull/105)
and OS [draft PR #124](https://github.com/aiverse-filmmakers/AI-Verse-OS/pull/124)
remain unmerged. This report is a later documentation-only commit.
