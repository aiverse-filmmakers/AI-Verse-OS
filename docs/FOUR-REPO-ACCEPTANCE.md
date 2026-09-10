# Four-Repo Acceptance Matrix

This document defines the final cross-repository acceptance gate for AI-Verse OS, AI-Verse Memory, AI-Verse Brain, and AI-Verse Skills.

The canonical executable gate is `.github/workflows/four-repo-acceptance.yml` in AI-Verse OS. OS is the host for this test because it owns the canonical filesystem contract and source-of-truth boundary. Memory, Brain, and Skills are cloned from their current `main` branches at the start of every run, and their exact commit SHAs are printed in the job output.

The gate is deliberately integration-first. It does not treat four independent green unit-test suites as proof that the products compose.

| Row | Contract proved | Acceptance condition |
| --- | --- | --- |
| 1 | Memory native installation, workspace/source isolation, and canonical freshness | Memory installs into a real OS checkout without tracked OS mutation, operator recall works, workspace `alpha` cannot see `beta`, and a changed canonical `CURRENT.md` is visible to recall without a manual rebuild. |
| 2 | Skills immutable generation and real readiness | A current Skills profile installs as an immutable generation, `pin` and readiness report the same generation, generation metadata/index exist, and an unprobed authenticated connector such as Google Workspace cannot be reported `ready`. |
| 3 | OS scoped capability discovery and generation selection | OS discovers the live Skills provider as healthy, selects a real capability by qualified ID, and binds the selection to the provider generation and package digest. |
| 4 | Single strategic owner plus real Brain host retrieval | Brain is explicitly registered and initialized, OS-owned direction is explicitly handed to Brain, OS then refuses strategic writes, and Brain consumes current OS context, Memory history, Skills capabilities, and configured connections through an explicitly selected JSON subprocess host adapter. |
| 5 | OS + Brain permission intersection | OS denial blocks a Brain-allowed action, Brain denial blocks an OS-allowed action, and one dispatch occurs only when both layers permit it. |
| 6 | Skills receipt + Brain verification | A receipt is bound to the exact live Skills capability, generation, package digest, action fingerprint, scope, class, and operation; Brain translates it conservatively and closes a V2 objective only with fresh OS verification evidence. |
| 7 | Adapter ownership safety | Running OS adapter synchronization leaves Memory-owned Claude/Codex adapters byte-for-byte unchanged and creates no tracked OS drift. |
| 8 | Final source-of-truth cleanliness | Memory extension registry, durable Brain direction ownership, Brain/Memory state, and Skills generation remain available while the OS tracked tree returns clean after removing the single intentional host-owned Brain registration edit. |

## Invariants

The acceptance workflow must preserve these boundaries:

- `AI-VERSE.yaml` remains host-owned. The test explicitly adds Brain `supported: true` and `enabled: true`; Brain does not self-register by editing the manifest.
- Memory uses the local extension registry and canonical OS operator/workspace paths rather than creating a competing truth store.
- Skills remains an external immutable capability provider. OS reads its provider contract; OS does not own or rewrite Skills generations.
- Brain owns strategic intent only after an explicit direction handover. Brain unavailability must not imply that OS silently becomes a second editable strategic store.
- Models do not receive direct authority to mutate policy, permissions, or canonical lifecycle state.
- An execution trace is not proof of effect. Verified completion requires action/generation identity plus verification evidence.
- Extension/runtime/generated state may be untracked or ignored by OS Git, but normal integration may not modify tracked OS system truth.

## Why the external repositories are not pinned

This final gate intentionally clones the current `main` branches of Memory, Brain, and Skills. Earlier producer/consumer contract tests may pin known compatible commits for contract stability; this matrix has a different purpose: it is the continuously moving compatibility gate for the released four-repository system.

Each run records the exact four SHAs it exercised so a failure or successful release candidate can be reproduced later.
