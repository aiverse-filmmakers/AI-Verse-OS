# Phase 3A.42: ordered, fail-closed prospective Codex message preview

**CI-tested code head:** `1fec558e70591491f1ccf6f65031d2d0dcb61854`.

This phase tightens `codex_app_server_event_admission_preview.py`, the
isolated, non-production synthetic v2 source-shape checker from 3A.39.

- The only candidate message order is prospective `turn/started`,
  text-only `userMessage` `item/completed`, final-answer
  `agentMessage` `item/completed`, then `turn/completed`.
- An assistant message before its user prompt, repeated prompt,
  duplicate item, or timestamp earlier than the preceding completed
  item causes terminal rejection. These were gaps in the prior
  structure-only candidate checker.
- The notification envelope now rejects unsupported top-level fields,
  JSON-RPC request IDs, non-v2 jsonrpc, non-integer/unsafe optional
  `emittedAtMs`, and caller-supplied `authenticated` or `consentVerified`
  claims. The optional emission time is only a shape check, **not a
  trusted timestamp or authority**.
- Unknown, multimodal, tool, delta, historical and incomplete events
  remain rejected. No event text is stored, hashed, logged, returned
  or serialized by this candidate.
- Even a successfully completed synthetic fixture returns
  `authentic_host_origin=False`, `recording_consent_issued=False`,
  `archive_write_admitted=False` and `memory_retrieval_admitted=False`.

The negative cases are in
`test_codex_app_server_event_admission_preview.py`.

**Evidence:** [Pinned real Codex offline workflow](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42889871712)
and [Repository QC](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42889871485)
both **PASS** on the exact code SHA above.

The upstream Codex protocol is allowed to evolve. The current moving
`main` supports other event kinds and notification envelopes; this
fixture deliberately handles only the separate, older pinned
schema/known subset and must not be interpreted as complete visible
conversation capture. Real original-event process attribution, consent,
writer and installed native-host identity are not implemented.

This document is a later docs-only commit. Both main PRs remain draft
and unmerged.