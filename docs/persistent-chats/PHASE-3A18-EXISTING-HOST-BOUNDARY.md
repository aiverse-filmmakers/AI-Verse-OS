# Persistent Chats, 3A.18: Existing host authority boundary audit

Status: read-only contract tests and disconnected synthetic OS fixture only. **No real capture, host consent issuer, storage admission, or Memory discovery.** Draft PR #124 remains unmerged.

## Existing sources verified 2026-11-09

- [Dashboard trusted local application session](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/blob/91aad66592ab43dfe2acaeff314ade93c63a7cef/apps/gateway/src/local-app-session.ts), pinned repository commit `91aad66592ab43dfe2acaeff314ade93c63a7cef`, file Git blob `299c9c46371f64deaf8899d6672970e015f3b975`. A trusted local launcher owns pairing and workspace rotation. The local browser session uses a single-use pairing code, HttpOnly cookie, owner-root and generation checks, per-workspace device/inode identity, and aborts active work on logout, expiry or host rotation. The pairing-cookie session **does not** authorize Codex recording. The current browser method allowlist has no capture or archive permission.
- [OS canonical workspace detector](../../scripts/workspace-infrastructure.mjs), existing read-only `workspace-id-slot-v1` identity check. An active `WORKSPACE.yaml` in the exact physical workspace slot is additional synthetic test evidence only. Physical directory identity does not authenticate a logged-in operator.
- [Synthetic preview authorization model](../../system/extensions/packages/ai-verse-codex-learning/codex_app_server_preview_authorization.py), 3A.15, still independently disconnected from real Dashboard/Gateway. Its consent and process identity are fixture-owned, not authentic host-issued credentials or consent.

Research guidance: [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) recommends default-deny and request-by-request checks. [NIST SP 800-63B session management](https://pages.nist.gov/800-63-4/sp800-63b.html) addresses session binding and expiration. Neither external document provides a concrete AI-Verse native consent API.

## 3A.18 implementation

- `system/extensions/tests/codex-learning/fixture_os_dashboard_boundary.py` verifies a pinned Dashboard source blob as an external **source compatibility alarm**, and runs the actual OS read-only workspace detector on disposable 0700 POSIX test directories. The verdict always says **not capture authority**, even if the pinned source or workspace identity checks pass.
- `test_codex_app_server_host_boundary.py` rejects wrong or paused manifests, nested workspaces, symlink or replacement paths, unsafe permissions, fake browser/capture claims and source drift. It proves the existing synthetic-preview lease cannot survive an alpha -> beta -> alpha workspace selection change. Neither test stores chat messages.
- Repository QC downloads only the exact pinned Dashboard TypeScript source into a disposable runner folder and executes nine tests. No Dashboard checkout mutates, no Gateway endpoint or user host is contacted, and no credentials are requested. A missing external source makes that exact CI step fail, not quietly skip. Four Repo Acceptance can execute the self-contained seven workspace tests and skip the two external-source tests if its own workflow does not supply that pinned source. A passing test remains a structural compatibility result, not real authentication.

Cloud-independent validation against the exact pinned sources: 9/9 tests passed in an isolated Python + Node environment.

## Missing implementation before any real capture

1. A trusted **native host** must issue a non-forgeable, short-lived session binding for the selected OS system/workspace and approved Codex child process, with independent generation/revocation authority. The existing Dashboard browser cookie or caller-supplied JSON cannot fill this role.
2. A separately reviewed opt-in consent path for recording, not a preexisting Dashboard pairing consent. Consent must be actively rechecked on every received event and revoked on workspace switching, expiry, stop, restart and disconnect.
3. A verified original wire-source handoff from an OS-owned Codex process, followed by completeness validation for rendered messages, private sessions and unsupported event paths.
4. Only then a separately reviewed production v2 writer and an authorized Memory reader, with secure storage, recovery and scope controls. Current read/write production gates stay blocked.

Do not add a general-purpose issuer to unblock recording. Do not assume authentication just because the Dashboard session is paired. Do not merge or enable real capture based on this fixture.
