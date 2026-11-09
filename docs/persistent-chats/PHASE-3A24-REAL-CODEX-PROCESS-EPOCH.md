# 3A.24: Two real pinned Codex subprocesses with parent-owned pipe epochs

**Status:** CI-only provenance *boundary proof*. Real user recording, consent issuance, archive admission and Memory discovery remain unconditionally **blocked**. Draft OS PR #124 is not merged.

## Sources and precise claims

- [Official Codex App Server `rust-v0.167.0` generated protocol](https://github.com/openai/codex/tree/rust-v0.167.0/codex-rs/app-server-protocol/schema/json/v2) and [app-server source](https://github.com/openai/codex/tree/rust-v0.167.0/codex-rs/app-server): the parent drives a local JSONL stdio process using `initialize`, `initialized`, then request/response IDs. Thread IDs do not authenticate native OS ownership.
- [Python subprocess Popen](https://docs.python.org/3/library/subprocess.html#subprocess.Popen) gives the creating parent concrete process, stdin and stdout objects. The parent must keep this ownership instead of accepting a PID or thread ID from a potentially forged event. [Python `select`](https://docs.python.org/3/library/select.html) permits bounded waits on the direct pipe.
- [Linux process cwd symlink](https://man7.org/linux/man-pages/man5/proc_pid_cwd.5.html) permits the CI parent to verify the running child's physical cwd identity with `/proc/<pid>/cwd`. It is an environment check, **not** human consent, and Linux-only.
- [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) requires independent authorization and default deny.

## Implementation

The existing fully isolated `test_codex_real_app_server_ci.py`, not an installed extension, now defines a `DisposableRealChildEpoch` and immutable `DisposableRealChildLease`. A lease binds the exact `Popen` object, parent pipe file descriptor and device/inode, PID, generation counter, and physical owner-only workspace inode.

An owned `config/read` runs only while the lease is valid. `read_matching` checks ownership:
- before reading buffered output;
- after a bounded, interruptible `select` wait;
- after every stdout `os.read`;
- before accepting the matched RPC reply.

Checks refuse a replaced process, exited child, reopened or replaced pipe, physical cwd mismatch, foreign workspace, or expired generation. They never inspect or persist personal history. An old child must have **terminated** before another child is bound.

The real release-smoke suite already verified the SHA-256 of the immutable `rust-v0.167.0` release archive, generated schemas, no-token startup, two separate empty ephemeral threads in the same initial Codex process, and clean teardown. Phase 3A.24 adds two **separately spawned actual Codex app-server processes**:

1. Spawn process A in private `/scratch/workspace-alpha`, initialize/initialized, and obtain a bounded `config/read` via its own stdout.
2. Issue a second read-only RPC, revoke A's parent epoch **before reading the pending reply**, and prove that the reply is rejected without consuming stale bytes. Terminate and reap the entire process group.
3. Spawn process B in private `/scratch/workspace-beta`, bind a new epoch and demonstrate that A's lease remains rejected. Initialize/initialized and read B's sterile configuration under the new pipe binding, then revoke and tear down.

Both run in the existing Docker CI: no network, no API token, read-only container, temporary private home, pinned binary and container-image digests, sandboxed process/resource budget, discarded stderr, no `turn/start`, no chats, no real model inference.

The separate `test_codex_app_server_process_epoch.py` adds **six Linux synthetic subprocess tests**: valid direct-pipe reply; pending reply rejection after revoke; no new binding while old process remains live; new workspace/new child epoch; forged/foreign process and wrong cwd refusal; symlink/unprivate directory refusal; and exit invalidation. These six independently passed in a cloud test, with no private user files.

GitHub Repository QC and pinned offline Codex runtime CI both run the tests. All previously passing OS functionality and production blocks are unchanged.

## Limits before real capture

This proves a **real parent-owned pinned binary can be isolated by process epoch in CI**. It does not prove the real deployed AI-Verse OS launches Codex from the authorized native Dashboard session. It does not bind any real user prompt or rendered-message frame to that session, issue a legitimate recording grant, authorize a production writer, or prove all visible conversation elements are captured. Source output cannot authorize itself.

The next phase must connect a **trusted native host** to an independently reviewed, explicit prospective recording consent action and then attach authenticated per-event scope/process evidence. Do not invent a generic issuer merely to pass CI. A local acceptance and security review remain necessary before production.

No rollout, install, merge, remote transcript access, live archive, or Memory reader is introduced here.
