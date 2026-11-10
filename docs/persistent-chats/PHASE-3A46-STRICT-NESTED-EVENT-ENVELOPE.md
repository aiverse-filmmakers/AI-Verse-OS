# Phase 3A.46: nested Codex v2 event guard and emission ordering

**Exact OS tested code head:**
`2cf9f18b1f3f5b1e05fd4ba851f80d99972ca138`.

The existing `ProspectiveEventPreview` was a **zero-storage synthetic
shape checker**, not a production event admission mechanism. Phase 3A.46
closes gaps in that checker:

- Every supported `turn/started`, `item/completed` and
  `turn/completed` notification requires an exact set of expected
  parameter fields. Unrecognized nested `consentVerified`,
  `authenticated`, `scope`, `signed` or `recordingAuthorized`
  assertions can no longer be ignored inside plausible event objects.
- Text-only user and final-answer agent items require exact item keys.
  Extra authentication, source-identity or capture fields are rejected.
- Optional `emittedAtMs` is bounded and nondecreasing in a candidate
  sequence. Missing values remain compatible with the older pinned
  schema, but **emission time is never treated as a trusted timestamp**.
- Violations close the candidate permanently. Accepted synthetic
  observations still have all host-authentication, consent, complete UI
  coverage, archive and Memory permissions **false**. No message text
  is stored, logged, hashed, returned or serialized.

This intentionally narrow checker is **not a complete view of live Codex
App Server conversations**. The modern protocol supports additional
message and tool shapes. Unknown events fail closed, not silently
converted into a message archive.

**GitHub evidence:** [Pinned real Codex runtime and tests](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42897725210),
[Repository QC](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42897724903),
both **PASS** on exact source code head above.

Codex reference: [Official current App Server notification envelope](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ServerNotificationEnvelope.ts).
The project's actual test schema remains pinned to its earlier
immutable upstream commit, not moving `main`. Current sources are
research context only.

No production recording or writer is connected, and both primary PRs
remain draft/unmerged.
