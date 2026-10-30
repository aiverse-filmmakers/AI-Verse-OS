# Canvas Native Owner Grant Lifecycle v1 (draft)

**28 October 2026. Stacked draft PR #111, based on readonly OS PR #110. NOT deployed.**

## Scope and authority

`scripts/canvas-grant-owner-lifecycle.mjs` adds a **native-only** grant
issue/revoke/revoke-all mechanism on the same canonical OS private file
read by `scripts/canvas-actor-grant.mjs`. There is deliberately **no**
HTTP route, browser method, AI tool, login endpoint, credential issuer,
headless "yes" flag, auto-installation, or OS setup hook.

Calling code MUST already be a trusted native OS owner host. It must
inject two separately owned host functions:

- `approveNativeOwnerChange(change)`: a real *authenticated human*
  approval, whose receipt must bind the supplied exact request digest,
  method, readable target/permission summary, owner ID, live session ID,
  and an expiration not beyond five minutes.
- `verifyCanonicalBotRun(runFacts)`: live independent canonical
  Gateway run and session verification, required before **and after**
  bot grant approval.

The lifecycle does **not implement either authenticator itself**.
Their absence is a hard denial. A test double is used only inside
disposable CI; no private owner identity is claimed.

## Atomic native operation

`createCanvasGrantOwnerLifecycle({osRoot,approveNativeOwnerChange,
verifyCanonicalBotRun})` verifies a real OS v2 root and existing
`.aiverse/os` directory owned by the current Unix user. Windows is
unconditionally denied because real Windows ACL owner verification
has not yet been implemented. It never creates OS directory layout.

- `list()`: host-only sanitized, read-only status, generation,
  grant IDs, scopes/methods/expiry. Never return through HTTP/agent RPC.
- `apply({operation:"issue",expectedGeneration,requestId,reason,grant})`:
  strict known schema, exact method allowlist, max 24-hour lease,
  valid active OS workspace; bot grant requires live run/session.
  Bots cannot receive `revert` or `delete`; deletion is unsupported
  for humans too pending genuine destructive action approvals.
- `apply({operation:"revoke",expectedGeneration,requestId,reason,grantId})`:
  removes exactly one existing grant; permitted even when the owning
  workspace was paused so owner can revoke safely.
- `apply({operation:"revoke-all",expectedGeneration,requestId,reason})`:
  empties all grants only with a distinct owner-approved digest.

Any mutation requires a current generation CAS, an exact native
approval receipt for that operation and a fresh effect-edge validation.
File operations use an exclusive owner lock, private temporary file,
fsync, atomic rename, parent directory fsync and post-commit
schema/binding verification. Existing invalid or foreign grant files
fail closed without overwrite. An abandoned lock intentionally blocks
future changes until manually inspected/recovered by the owner.

Atomicity is for the **single grant file**, not for a cross-process
Data or Gateway effect. It is not a durable signed audit log. The
returned native receipt has request fingerprint, generation
transition, owner ID, operation, grant ID/count. An independent
append-only/tamper-evident owner audit design remains a separate
release gate. Native approval must display the target scope,
actor, exact method list, expiry and reason.

## Tests and evidence

`tests/canvas-grant-owner-lifecycle.test.mjs` validates missing
approval, wrong fingerprint, explicit readable permission diff,
real issuance through the readonly verifier, scoped revoke,
revoke-all, generation stale/replay, duplicate ambiguous grant,
expired/oversized lease, bot live run, bot canceled during consent,
workspace paused during consent, invalid existing file, symlinked
owner directory, manual lock collision, and safe Windows rejection.

`.github/workflows/canvas-owner-grant-lifecycle.yml` runs Node 22
on Linux/macOS/Windows with the original readonly verifier tests.
Windows success means the issuance path denied correctly, **not**
that Windows ACL issuance was implemented.

Dashboard has a disposable integration proof
`scripts/mc2/ci-canvas-native-owner-lifecycle-proof.mjs`
that checks the real canonical GatewayStore + native OS verifier
against a synthetic CI owner approval. It is not production
human-session proof.

## Production blockers

Real native Mac owner login/session authentication, approval UI,
real audit receipt store/verification, OS install/distribution
approval, Windows ACLs, owner-selected Data provisioning/restore,
human destructive approval receipts and private owner dogfood
remain unimplemented or unaccepted. The grant issuer must not
be exposed to browser, model or HTTP requests, nor merged or
installed automatically. The existing reader PR #110 remains
read-only; PR #111 is stacked and separate.

Official Dashboard formal acceptance remains 15/100 until a
reviewed gate is genuinely approved. Engineering estimates are
separate from formal acceptance.
