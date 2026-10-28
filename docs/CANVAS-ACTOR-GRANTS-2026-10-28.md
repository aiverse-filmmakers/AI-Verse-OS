# Canvas actor-grant verification: owner-controlled draft contract

**28 October 2026 · Draft PR #110 · Not installed or production-authorized**

## Authority and non-authority

OS owns workspace identity, local permission floors and operator-controlled
host configuration. The pinned existing `scripts/action-permission.mjs`
decides whether an *action class* can execute, but never issues actor
identities or agent leases. Canonical Gateway owns run/session status; Data
owns Canvas documents. A Gateway bearer, Dashboard cookie, running model,
OS permission `allow` result, or the words `local-operator` are **not**
independent grants.

`scripts/canvas-actor-grant.mjs` adds only a **readonly verifier** for a
pre-existing file controlled by the OS owner:

`<OS_ROOT>/.aiverse/os/canvas-actor-grants.json`

It does not create the file, issue/renew grants, authenticate a human,
open Gateway storage, expose an HTTP route, grant Data permissions, install
the app or approve destructive actions. Native OS installation must
explicitly control owner identity, file placement, lifecycle, ACLs and
removal. A forged or missing file fails closed. Do **not** install or
manually populate this on a real machine before independent review.

## Required bounded document

A version-1 OS-owned document has exactly:

- `format: "ai-verse-os/canvas-actor-grants-v1"`
- `schema_version: 1`
- `generation`: bounded identity epoch (changed when grants are rotated)
- `grants`: at most 128 entries, unique grant IDs

Each entry contains `grant_id`, `actor_kind` (`human` or `bot`),
`actor_id`, `scope` (operator or a single workspace ID), `system_id`,
`principal`, `lease_epoch`, ISO UTC `expires_at` and a bounded list of
**exact** `aiverse.canvas.*` method names. Bot entries also require
`run_id` and `session_id`, bound to the canonical Gateway run/session.
No wildcard methods, arbitrary principals, forward-dated lease over 24
hours, duplicate versions, unknown fields or malformed entries.

The verifier checks exact scope, method, actor type, caller identity,
OS system, session/run and current timestamp. It refuses multiple
matching grants rather than choosing one. It rereads the authoritative
file per call; removing the grant revokes the next authorization.
Generation and lease epoch form a bounded revocation signal passed to
the Gateway run verifier.

It opens the owner-private regular file with `O_NOFOLLOW` where
available, denies symlinked parents and rejects group/world file
permissions and foreign ownership on Unix. Real OS root and current
workspace activation are checked using the existing
`evaluateActionPermission` owner, not a new YAML parser.

**Platform caveat:** Windows POSIX-mode checks are not equivalent to
Windows ACL verification. Actual Windows owner grant admission requires
a separately reviewed ACL mechanism before release. This draft does
not claim it implemented that Windows security property.

## Real host integration

Dashboard's independent host adapter is responsible for supplying an
authentic **native operator session** or separately verified **live
Gateway run/session**. Neither may be inferred from an HTTP request.
The OS verifier can then decide whether a preinstalled grant covers
that exact session and Canvas method. OS action permission and Data
scoped actor provenance remain separate checks at every effect edge.

Bot admission through the Gateway run verifier uses a read
(`aiverse.canvas.get`) grant as an initial minimum. A subsequent
write uses a fresh **method-specific** OS grant, scope, OS policy,
Gateway run and Data optimistic version check. Agents cannot delete
or revert without reviewed human approval receipts, which this
contract deliberately does not create.

## Verification and next blockers

`tests/canvas-actor-grant.test.mjs` covers legitimate scoped
human and bot grants, wrong actor/run/session/workspace/method,
grant removal and generation rotation, expired/oversized leases,
ambiguous/malformed files, symlinks, UNIX file permissions,
foreign roots and paused-workspace revocation. A dedicated
GitHub Actions matrix runs Node 22 across Linux/macOS/Windows.
The current workflow must be checked before stating a green
latest-head release.

No production operator identity authenticator, lifecycle grant
issuer/revoker with audit receipts, human-approval receipt issuer,
Windows ACL owner guarantee, native Data scope provisioning,
real installed model-to-Canvas tool execution or private Mac
acceptance is bundled here. These require separate owner
qualification. The draft must not be merged or installed by default.
