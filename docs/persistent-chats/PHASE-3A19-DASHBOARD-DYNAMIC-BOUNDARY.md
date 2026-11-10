# 3A.19: Real Dashboard host-session behavior, pinned CI

Status: **verified read-only integration evidence**, not recording authorization. All Persistent Chats capture admission paths remain hard-blocked.

## Pinned existing implementation

- Source repository: [AI-Verse-Dashboard](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard)
- Exact commit: `91aad66592ab43dfe2acaeff314ade93c63a7cef`
- Native launcher and paired-browser boundary: `apps/gateway/src/local-app-session.ts`, Git blob `299c9c46371f64deaf8899d6672970e015f3b975`
- Existing native-session tests: `test/local-app-session.test.ts`, Git blob `51e7b649a998a094676e408e266d053ecadd7da9`
- Dashboard package lock: Git blob `5f58ee26fb50da632219b6bcbe26d055c70df43a`

A newly added OS [GitHub Actions test workflow](../../.github/workflows/persistent-chats-dashboard-native-session.yml) obtains only the exact published Dashboard commit, asserts the three Git blobs, installs its locked dependencies with lifecycle scripts disabled, compiles its TypeScript, then runs two **existing real executable** Dashboard suites:

1. `dist/test/local-app-session.test.js`: pairing, origin and cookie checks, single-use codes, workspace switching and re-pairing, registered OS root and generation checks, socket/stream invalidation, pending workspace requests, logout, stale requests, race conditions and attempt budgets.
2. `dist/test/gateway-auth.test.js`: bearer authentication, default-deny and localhost Gateway boundary.

Only synthetic local workspaces, fake browser sessions and localhost test gateways are used. GitHub Actions has `contents: read` and no production credentials. The external Dashboard checkout is **never modified, pushed or merged**.

**CI evidence:** [Pinned native Dashboard #1](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42688171362) **passed 16/16 actual runtime tests, zero skipped**, against exact OS head `fee8f23c487ec54cfa7e96ecb2dcc289bc2514ab`. This is distinct from the nine synthetic plus source-blob tests in 3A.18, which also passed.

## Security scope

OWASP's [Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) says authentication is not permission to use every protected service and asks for default-deny checks on every request. A successful Dashboard cookie pairing is therefore **not consent to record**, archive or transmit Codex conversations.

The existing Dashboard method allowlist has no approved Codex recording or archive method. Do not infer a native consent issuer from the browser cookie, public TypeScript source, OS workspace ID, a GitHub CI test or a synthetic owner preview. No real host-issued per-event evidence has yet been produced.

Remaining work before any capture:
1. Implement and independently review a *narrow host-owned prospective recording consent action*, callable only after verified native OS authorization, with stop/revocation and no historical transcript access.
2. Prove the host ties every event to its own live Codex child process, OS root generation, exact physical workspace, user consent generation and stream/turn identity at event time. Reject stale, ambiguous or mixed-source events.
3. Validate complete visible-message capture and special cases without claiming original provider transcript byte coordinates the App Server does not supply.
4. Authorize storage/Memory reads only after production privacy, integrity, recovery and scope tests plus explicit local user acceptance.

Keep the branch draft and unmerged. The completion of this phase does not change any production admission flag.
