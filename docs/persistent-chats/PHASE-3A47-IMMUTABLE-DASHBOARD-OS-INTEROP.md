# Phase 3A.47: immutable Dashboard native-owner and OS event-denial compatibility

**Status:** browser/GitHub-only cross-repository CI check. This does
NOT establish a trusted operational authentication bridge between apps.

The existing
`persistent-chats-dashboard-native-session.yml` workflow already
tested a pinned older Dashboard session implementation and exercised
actual localhost pairing/revocation code. That job remains intact.

The new **separate** job
`pinned-current-native-owner-no-capture` now:

1. Clones the Dashboard repository **read-only** at exact, previously
   Apple-CI-verified code commit
   `faab75af2e792f0d5e23d3e4ff88e4041742b841`.
2. Checks exact Git blob hashes for the native subprocess owner,
   per-event physical scope fence, actual XPC owner, native XPC
   packaging test, current Dashboard localhost session source and
   cross-platform no-capture release contract. Any source drift
   fails the test.
3. Executes Dashboard's actual Node no-capture release contract
   without launching a Gateway, enabling app-server hooks or
   installing an XPC service.
4. Independently runs OS's strict prospective-event and
   release-entrypoint refusal tests using the OS branch under review.
5. Never copies private conversation content, transmits credentials,
   issues an authentication token, creates an archive or opens Memory.

**Verified:** [OS immutable Dashboard source / OS event boundary workflow](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42897724683)
PASS on exact OS tested source SHA
`2cf9f18b1f3f5b1e05fd4ba851f80d99972ca138`.
Both jobs in this workflow passed:
the pre-existing pinned Dashboard localhost pairing tests and
the **new** current native-owner source interop check.

The pinned Dashboard code head previously passed [Apple native owner/XPC](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/actions/runs/42897113015)
and [Dashboard CI](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/actions/runs/42897112925).
Doc-only follow-up commits were not retested as code heads.

**Boundaries:** A Git blob pin is a source-drift alarm, not proof of
runtime channel authenticity or per-event attestation. The native
child currently used for this proof is `/bin/sleep`, not Codex.
Cross-repo compatibility only means both tested sources enforce
their current hard-denial policies. Native production release identity,
real device-owner approval, consent, event source coverage,
storage and Memory remain blocked until separate local acceptance.

Both primary PRs remain draft and unmerged.
