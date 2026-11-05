# AI-Verse connection for Codex desktop

This local extension connects the Codex message lifecycle to the existing AI-Verse OS. It does not replace Memory, Brain, Data, Skills, or the model.

## Message flow

1. Resolve the operator or one workspace and retrieve bounded current context, preferences, and relevant Memory.
2. Give Codex a short preflight and the exact command for reviewing this turn.
3. Observe user/tool evidence as bounded salted hashes, without retaining source bodies in adapter diagnostics.
4. Review within the original turn and submit an empty receipt if nothing deserves retention. Automatic Stop continuations are off by default; opting in can request one additional review.
5. Route eligible candidates to existing owners: historical Memory, operator profile, operational current context, or Brain/Skills proposals. Keep strategy and Data with their owners.
6. Report the actual owner receipt. An unavailable owner produces an explicit proposal in the existing OS inbox.

The model performs the review. Evidence checks establish that quoted words were observed; they do not prove the proposed conclusion. The canonical owner remains the final admission gate.

## Desktop activation

The six project handlers are installed in `.codex/hooks.json`: UserPromptSubmit, SessionStart, PostToolUse, Stop, Interrupt, SessionEnd. In **Codex Settings → Hooks**, review and trust these project handlers. Registration alone does not activate them.

After trust, use this OS project in a fresh local Codex conversation. A production check must observe genuine hook callbacks, scoped context delivery, a review receipt, and fresh-session recall. Bundled engine fixture tests are evidence of the implementation, not proof that the desktop conversation has activated it.

The trusted command includes the bridge source digest. Any code change requires regenerating the definition and renewed review. The installer never writes hook trust records.

## Controls

Run commands with the same installed Python executable shown in `.codex/hooks.json`:

```text
bridge.py status
bridge.py set --enabled false
bridge.py set --enabled true
bridge.py set --review-mode all
bridge.py set --review-mode meaningful
bridge.py set --review-mode off
lifecycle.py install
lifecycle.py remove
```

`all` reviews normal messages, including no-learning receipts. `meaningful` reduces fallback reviews. `off` retains context loading without review continuations. Removing hooks preserves canonical state and other project handlers.

## Boundaries

- Local desktop/project runtime only; local command hooks do not run in cloud orchestration.
- Additional reviews consume Codex usage and can add visible output and latency. Prefer submitting a receipt within the original turn.
- No continuous idle thinking, model weight training, autonomous permission expansion, external API key, or scheduled heartbeat is introduced.
- Scope ambiguity refuses learning rather than expanding retrieval. Profile writes require direct user evidence. Skill activation follows the existing owner mode.
- Interrupt records cancellation promptly and stops subsequent writes when observed. A committed owner write cannot be undone by cancellation.
- Runtime receipts are disposable diagnostics. Durable truth remains in canonical owners.

Read `INSTRUCTIONS.md` and `REVIEW-SCHEMA.md` for the execution contract. QC evidence lives in `runtime/reports/codex-learning/`.

## Portable member package and setup

`install.py package --output ARCHIVE.zip` exports only generic code/instructions and a SHA-256 file manifest. It excludes local config, registry, runtime logs, personal state and trust. From the extracted package, Distribution invokes `install.py install --root MEMBER_OS --metadata ADMITTED_PROJECT_JSON --json` using its provisioned Python. Explicit runtime/provider overrides are supported when metadata is unavailable; dependency checks fail with setup guidance rather than copying another member's paths.

The installer generates local commands, preserves other hooks and local modifications, writes an ownership receipt, and supports idempotent reinstall/relocation plus owned-hook removal. `install.py setup`, `doctor` and `descriptor` expose resumable setup and member guidance in `SETUP.md`. The actual member Distribution release must admit this package; exporting a ZIP does not publish or update that release.

Windows has a native locking branch and command generation; native Windows/Linux release validation is still required. Mac fixture installation/relocation checks do not certify other platforms.

## Learning maintenance

`maintenance.py --root OS --scope operator report` produces content-free review coverage and typed owner counters. Unlabelled correctness is explicitly unknown. Optional operator feedback records evaluation labels by real Memory ID and canonical evidence reference; it never mutates historical truth.

A native desktop schedule is configured separately and must be disclosed to the operator. Local file review requires the computer and app running. Review scope stays explicit, unchanged states remain quiet, and Memory/Brain/Skills gates control any proposed write. A schedule is not an immediate invisible post-message reviewer.

## Claude Code

The same bridge serves Claude Code as a second adapter (`--harness claude`). `install.py claude-install`, `claude-doctor` and `claude-remove` manage only `.claude/settings.local.json` and `claude-adapter.json`; Codex files are never touched. Claude events carry no turn id, so the bridge derives one per prompt. Because Claude Code blocks JSON typed into shell commands, Claude saves each review or goal as a short note file in `runtime/codex-learning/claude-input/` and passes it with `--input-file`; the bridge accepts only a file directly inside that folder (no symlinks), keeps the 2,000,000 byte limit and deletes the note after reading it, even when the request is refused. Codex normally keeps JSON on stdin and may also use `--input-file`. Both apps share the same features: profile corrections, the authenticated quote in provenance, key preferences first, the compact fallback and `query --kind profile`. See `SETUP.md`.

## Tidying and routing

- `reflect.py` is the tidy engine (plan, apply, done, undo, status, list). It keeps a content light work list under `runtime/codex-learning/reflect/`, one lock shared by Codex and Claude Code, and a lease so only one pass runs at a time. It changes things only through the existing owners and adds new records instead of deleting.
- Each turn has its own destinations (the folder the chat runs in plus projects the operator named in his own words, including aliases from `WORKSPACE.yaml`). Nothing carries over to the next turn.
- Configuration: `reflection_enabled` (default true), `reflect_min_entries` (5), `reflect_max_age_hours` (6), `maintainer_feedback` (default false, kept on reinstall).
- Ordinary web chat apps (chatgpt.com, claude.ai) have no local helpers and are not covered.

## Portable chat archive batch checkpoint (slice 1B draft)

`ChatArchive.append_batch(events)` is the recommended interface for a
synthetic complete session catch-up. Events must be the full ordered visible
source sequence starting at 1. Under one writer lock it parses and validates
the canonical archive exactly once, then compares the complete existing prefix
with current source records before writing **only** the new suffix. A
`BatchReceipt` reports the verified committed sequence and final source
record position/hash. The receipt is not a persisted cursor or proof of source
authorization; the canonical private JSONL is always rechecked after restart.
A changed/truncated old record or conflict anywhere in the supplied batch
refuses writes. Crash recovery uses the committed JSONL prefix, and an
unterminated archive tail is repaired only when there is a validated suffix
to append.

The wire format remains `ai-verse.chat-archive/v1`, including exact field
names, content checksums, original source byte offsets, one header, newline
terminated messages, and the existing private scope directory layout.
Single-event `append()` remains for compatibility. No new sidecar, consumer
index, configuration switch, installation or host capture is introduced.

## Portable visible-chat capture (slice 1C draft, disabled)

This is experimental source archiving, not the existing learning review. No new
hooks are installed by this draft. The Claude Code bridge may call
`claude_capture.py` on its existing lifecycle events only if
`capture_enabled` is set. The default is `false`. A second configuration
flag, `capture_coverage_verified`, also defaults to `false`; an independent
code-level host-admission gate remains **false** until a separately reviewed,
version-specific pilot proves actual Claude Code coverage. Changing user
configuration alone cannot override that gate.

The capture reader uses only the callback's explicitly supplied `session_id`,
`cwd` and `transcript_path`, never a home-directory search. It requires a
matching source record session, verified physical transcript and directory
identities, the current OS-bound session and workspace, the OS context owner,
and its canonical `chat.archive.append` action-permission decision. An
unfinished JSONL line remains pending, with no durable source cursor ahead of
the private archive. Under the archive's writer lock, a single batch validates
the complete canonical prefix once, rejects changed or missing old rows, and
commits only the new suffix with a durable fsync. Restart/replay always derives
the verified checkpoint from existing private JSONL, not a saved sidecar.
Source evidence is transient and raw tools/reasoning
are excluded by the fixture filter. Only one physically bound scope may be
captured; ambiguous or mixed-scope turn histories are refused.

**Historical privacy, draft fail-closed gate:** The present `cwd`, current
workspace or current-turn permission cannot grant access to older events in
an existing/resumed transcript. Before creating or writing an archive, every
newline-terminated source record, including excluded tool/sidechain rows,
must match an OS-owned `capture_scope_provenance` ledger with the original
session ID, exact source path, immutable byte offset/end, raw record SHA-256
and **scope attested when the record was first observed**. One missing,
changed or differently scoped historical record blocks the entire snapshot
with zero archive writes. Unfinished final lines stay provisional.

No production at-record provenance issuer exists in slice 1C; the code NEVER
creates an attestation by rereading old text or applying today's scope.
An independent code-level `_HISTORY_PROVENANCE_ISSUER_ADMITTED = False`
gate also prevents a retroactively fabricated session-state ledger from
authorizing any source. It stays closed independently of the Claude host
coverage gate. Thus existing or resumed transcripts remain refused even if
capture flags were changed. Synthetic tests mock both gates and create a
fixture-only ledger solely to exercise the verification contract. A future
real issuer must be independently reviewed for at-time authenticity and
historical scope binding before either gate may be admitted.

**Unverified boundaries:** The 1A parser is a synthetic fixture contract, not
proof of the host's visible UI, event ordering, prompt formatting or tool
exclusions. The custom `capture_opt_out` flag is a fail-closed input but has
not been verified as a native Claude Code private-session control. Credential
recognition is heuristic and cannot establish that arbitrary visible text is
secret-free. The new per-record historical-scope check blocks unproven
history but does not itself issue or cryptographically authenticate the
underlying OS provenance. No local or real host pilot, verified host version,
reviewed consent/secret policy, cross-tool read,
or member distribution approval has occurred. Filesystem identity checks
reduce replacement races but do not constitute isolation against a privileged
local adversary. Keep capture OFF for all members and installations.
