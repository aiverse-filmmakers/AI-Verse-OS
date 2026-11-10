# Phase 3A.43: production capture denial release regression

**Scope:** read-only, fail-closed source and callable-gate acceptance
for the current OS and Dashboard code. This is an automated guard against
accidental enablement, not a security proof for all future modules.

## OS acceptance

`test_codex_app_server_release_capture_denial.py` reads the committed
Python modules' AST and requires each named global capture admission
flag to have exactly one top-level literal `False` assignment:

- Codex hook observer: host events and at-time scope issuer disabled
- App Server candidate: owned transport not admitted
- Synthetic trust policy: host and consent issuers disabled
- Received-wire v2 envelope: recording disabled
- Pinned schema gate: real-host runtime, OS consent, per-event scope and
  complete UI coverage unattested

It also **calls** each named production archive/capture admission
function with forged signer, user authentication, source and consent
claims, and verifies an unconditional `blocked` result. In-memory
mutation tests flip each gate to `True` and must cause the source
acceptance to fail. The synthetic prospective preview's `persist`
and `retrieve_memory` remain false.

No actual private text, filesystem archive, provider token, Gateway,
Memory service or production writer is involved.

## Dashboard acceptance

The counterpart
`scripts/mc2/ci-no-capture-release-contract.mjs` runs in Dashboard
CI on Windows, macOS and Linux. It confirms the actual Node/browser
source contract has literal `false` capture/origin/consent/import
fields, that paired browser RPC methods exclude capture/consent/archive
authority, and that no Swift/ObjC CI fixture is referenced by
application/package imports or production npm scripts.

It also restricts the current fixture XPC protocol to three
denied-only methods and verifies five deliberate source mutations
are rejected. These tests do **not** connect a signed production
XPC service to the installed Dashboard.

## Verified CI

- [OS pinned real Codex runtime](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42889871712): PASS
- [OS Repository QC](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42889871485): PASS
- [Dashboard CI cross-platform](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/actions/runs/42889628377): PASS on Dashboard source SHA `b0aa02e7c2802e1c783d8bd3f9ddaea1cc97dd04`, all three OS runners

OS tested source SHA `1fec558e70591491f1ccf6f65031d2d0dcb61854`.
A later doc-only commit is not implied to share identical CI results.

**Critical limitation:** An AST/source audit is defense in depth,
not runtime authority. Real recording still requires the actual
installed and developer-signed native host, correctly authenticated
operator, original Codex child identity, separate prospective consent
and per-original-event authorization. Nothing here permits storage,
history import, private Memory retrieval or a recording API.