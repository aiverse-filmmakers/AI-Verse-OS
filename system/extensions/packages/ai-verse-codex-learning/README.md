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

**Shared reader/writer capacity contract:** Each canonical archive contains
at most 40,000 committed messages and 64,000,000 total UTF-8 JSONL bytes.
Both `append()` and `append_batch()` reject a write that would breach
either limit before modifying committed data or repairing a torn tail;
`read()` rejects any existing file outside the bounds. The native Memory
portable-chat reader uses the same per-file limits, retaining its separate
40,000-message aggregate discovery budget. Oversized legacy files are
not silently truncated, imported, or declared compatible.
Single-event `append()` remains for compatibility. No new sidecar, consumer
index, configuration switch, installation or host capture is introduced.


## Portable Codex hook observation (slice 3A.1 draft, disabled)

This slice introduces **only** a pure, synthetic-tested, prospective
`codex_capture.py` hook-field observer. The documented Codex hook JSON
provides `UserPromptSubmit.prompt` and
`Stop.last_assistant_message`. Those are *individual host-supplied fields*,
**not a full rendered conversation**. Codex can also supply a
`transcript_path`, but its private file format is expressly not a stable
hook API, so this adapter never opens that path or guesses its location.

The observer accepts a candidate `SessionStart(source="startup")`
boundary, then ordered matching user-prompt/assistant-stop pairs. It
preserves each string exactly in transient observations, with field-specific
hashes and stable IDs. It refuses resume, fork, compact, clear, changed
replays, overlapping turns, uncertain Stop continuations, scope/path/session
changes, interrupt and invalid sizes. `PostToolUse`, reasoning,
subagents, model events and arbitrary JSON fields never become visible-chat
records. Transient state retains only identifiers and hashes, not message
bodies.

**Security and completeness gates:**

- Neither a supplied hook JSON object nor a startup source proves that
  the event came from a trusted physical Codex host. No authenticated
  at-event scope issuer has been established. The code gates
  `_HOST_EVENTS_ADMITTED` and `_AT_TIME_SCOPE_ISSUER_ADMITTED` both
  remain false, cannot be enabled through config, and even a test-patched
  gate does not reach an archive writer.
- Source field observation does **not** establish complete assistant
  output, interim messages, attachments, private-session consent or
  unobserved hooks. The existing learning bridge can short-circuit some
  lifecycle events. No claim of full conversation retention is made.
- No hook registration, bridge dispatch, installer/package manifest edit,
  OS JSONL archive write, Memory mutation, transcript scanning, live
  probing, merge or release occurs in slice 3A.1. Unit tests call only
  the pure observer against artificial hook payloads.
- The next checkpoint must prove host event delivery and per-event
  authenticated physical-scope attribution, including consent/privacy
  semantics, *before* a prospective OS-authorized writer may be staged.
  Old/resumed conversation records cannot be attributed using present
  cwd/scope or a fabricated historical ledger.

Current Codex hook reference:
https://learn.chatgpt.com/docs/hooks (Common input fields,
UserPromptSubmit, Stop, SessionStart).


### 3A.2 Current OS turn correlation (draft, read-only)

`correlate_current_os_turn()` checks a transient prospective hook-field
observation against the **existing OS Bridge** session and turn state.
It uses the Bridge's session lock, validates physical cwd under the
OS root without symlink components, and requires the one and only
workspace to match its active manifest (or the operator root). It
requires a single nonambiguous allowed destination, and rejects
cancelled, stale, mismatched-turn, plan/bypass, and inactive-workspace
events. For user prompts it checks the independently stored OS prompt
and user source SHA-256. Scope is rechecked on every invocation.

The return status is deliberately
`correlated_untrusted_hook_not_authorized`. **This is NOT host
authentication, at-time source provenance, private-session consent,
assistant-text attestation, a durable checkpoint, or permission for an
archive write.** A local process can forge hook JSON; the OS Bridge
does not retain authoritative assistant source bytes.

Neither `bridge.hook` nor the installer calls this correlation function,
and Codex capture admission gates remain hard-disabled. CI uses only
disposable synthetic workspaces and OS state.

Before any archive writer is staged, prove the host event origin,
immutable at-event authority/consent and source coverage through a
separately reviewed host contract. A transient correlation result
must never become a retrospective issuer or authorization token.

### 3A.3 Host source coverage: two noninterchangeable transports

**Existing Codex desktop command hooks:** The released hook contract
provides individual `UserPromptSubmit.prompt` and
`Stop.last_assistant_message` fields, but no verified host origin,
complete visible-message stream, or durable at-event scope/consent
attestation in this adapter. Command hooks may run concurrently;
background completions can be delivered out of order or cancelled.
`transcript_path` is not a stable hook wire format. None of these
fields is allowed to promote a live chat capture or retroactive import.

**Potential alternative for OS-owned sessions:** The documented Codex
App Server v2 uses JSON-RPC over an OS-owned `codex app-server` stdio
child process. A client can observe `turn/started`, `item/completed`
and `turn/completed`, including final `userMessage` and `agentMessage`
items. An OS-owned process/pipe could provide a stronger *transport*
trust boundary than an arbitrary command-hook JSON payload. It would
cover sessions the OS launches and manages, **not automatically existing
Codex desktop conversations**. This is a candidate architecture only.

New `codex_app_server_candidate.py` parses *synthetic in-memory v2
notification dictionaries only*. It requires one prospective turn
boundary, matching thread/turn IDs, one text-only user item, one final
assistant item (`phase=final_answer`), unique item IDs, bounded text,
and successful turn completion. It excludes tool output, reasoning,
plan items and streamed deltas and rejects unknown/ambiguous items,
media, multiple user blocks, missing source items, interrupted/failed
turns, inconsistent identities and unusual lifecycle transitions.
Even a valid candidate always reports
`untrusted_v2_candidate_not_archivable`, with all authenticity, scope,
consent, complete-UI-coverage and writer-admission fields false.
Forged JSON flags such as `authenticated`, `signed`, `scope` or
`consent_verified` cannot change that decision. No app-server
process, socket, transcript, CLI, GitHub provider, external API or
personal file is opened by this module.

**Remaining release gates** before any archive writer integration:

1. OS must own and verify a pinned App Server executable/process and
   private connection lifetime, with explicit trust on the *transport*,
   not JSON attributes. This is not implemented.
2. OS must bind physical scope and user consent/private-session state at
   every event, including workspace changes and turn interruption.
3. Verify all visible message kinds and completeness against the exact
   pinned host release; text-only final-item candidates are insufficient
   to claim a complete chat backup.
4. Define stable source byte provenance/checkpoint recovery or a new
   versioned writer format. Do not populate OS v1 raw-source SHA/offset
   fields from reconstructed JSON or invented records.
5. Independent review and an isolated consented pilot are required
   before hook or App Server capture admission. Both Codex capture
   code gates remain false, and the original bridge/installer is
   unchanged.

Codex sources (reviewed for this synthetic checkpoint):
https://learn.chatgpt.com/docs/hooks and
https://learn.chatgpt.com/docs/app-server

### 3A.4 Disposable OS-owned App Server stdio boundary

The next slice adds `codex_app_server_transport.py` as a **test-only,
locally owned process and framing prototype**. It does not launch Codex.
Tests spawn a disposable pinned Python fixture in a private temporary
directory, using a process handle returned directly by `Popen`, a
restricted environment with no inherited HOME, PYTHONPATH or API
tokens, `shell=False`, no inherited nonstdio file descriptors, and
private stdin/stdout pipes with discarded stderr. The module:

- Verifies that the test executable is the current Python interpreter,
  compares SHA-256 hashes of both the interpreter and fixture script,
  and rejects symlinked or group/world-writable fixture files and
  nonprivate fixture working directories.
- Performs the documented JSONL `initialize` / `initialized` exchange,
  checks the response ID, and rejects unsolicited requests. It never
  automatically approves a server action or sends a turn request.
- Enforces bounded strict UTF-8 JSONL frames, duplicate-key rejection,
  a frame-count limit, timeouts even for incomplete lines, and
  child-termination/cleanup on failures. Only the owning process handle
  can be used; caller-provided PID and external sockets are not accepted.
- Exercises JSONL v2 candidate events in the existing synthetic parser.
  Even a completed candidate remains `untrusted_v2_candidate_not_archivable`.
- Keeps `connect_codex_app_server()` blocked under two hard-disabled
  production admission gates. Even patching both for a test does not
  start Codex or create a permission/capture issuer.

**Scope of evidence:** A SHA-256 check before `exec` is not atomic
attestation of the executable that actually ran, and a parent-owned
subprocess is not a privilege sandbox. This POSIX fixture prototype
does not establish user consent, authenticated at-event workspace
ownership, a signed original source or exact visible output coverage.
Real App Server may execute commands and access the user's files;
**do not turn on the production launcher without an independent
security review, a pinned host contract and explicit consent.**

The prototype does not modify `bridge.py`, `install.py`, hook definitions,
Memory, canonical archives, or any installed OS copy. It does not
open a real Codex App Server, contact a provider, read personal chats,
or migrate Codex desktop history. No user installation or live pilot.

Upstream protocol references:
https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

### 3A.5 Synthetic host trust and recording-consent policy

The **parent OS**, not an App Server event, must choose a new thread,
physical cwd, unique workspace scope and capture consent. Host-provided
`scope`, `signed`, `trusted`, `authenticated`, `consent_verified` and
`private` fields are NOT permission. Existing desktop and resumed
threads must not be imported under the current workspace.

The new `codex_app_server_trust_policy.py` exercises this decision
boundary with a **synthetic-only** owner choice and mutable consent
fixture. No actual owner UI, user credential, token, consent receipt,
authenticated host issuer or production session is implemented.

The synthetic evaluator rejects absent/withdrawn opt-in, private
sessions, historical imports, unexpected capture modes, changed
threads, unsupported events, process replacement, expired lease,
ambiguous or inactive workspace, symlink cwd, wrong harness, and
mismatched OS folder. Every synthetic stream event independently
rechecks parent-owned consent generation, child identity, physical
cwd and current workspace manifest. An opt-out or subsequent opt-in
invalidates the prior lease. The result never contains source text,
and all provenance/consent/writer-admission booleans remain false.

`capture_admission()` always returns blocked. `connect_real_codex()`
also stays blocked when test code patches both development gates.
There is no connection from this module to the existing Bridge
hook dispatcher, installation manifest or private chat archive.

**Remaining host trust work:** independently verify an actual pinned
Codex App Server binary and child/pipe lifetime, design authenticated
and revocable OS UI consent, bind the original parent-side thread/start
and turn/start request/response to fresh physical scope and project
identity at the event boundary, and prove full user-visible message
coverage for a pinned host version. At-event state and a complete
source format cannot be inferred from a current cwd or JSON flags.
The result is still synthetic policy matching, NOT verified real-host
authentication or permission to store conversations.

Security limitations: the prior child binary SHA read is not atomic
attestation; command execution remains potentially privileged; an
in-memory consent flag is not a reviewed UI permission; and no
filesystem precheck alone guarantees protection against concurrent
privileged local changes. Pilot and independent review remain gates.

### 3A.6 Synthetic parent-owned thread and turn request binding

New `codex_app_server_thread_binding.py` models a single prospective
OS-selected conversation across `thread/start` and `turn/start`
requests and corresponding App Server v2 responses. It uses fixed
client-originated JSON-RPC request IDs **only on a single already-owned,
disposable synthetic pipe**. The returned server-assigned `thread.id`
is bound to a matching `thread/started` notice before the client may
construct its one text-only `turn/start` request. That request's
`turn.id` must then match the `turn/started`, item and completion events.

The parent specifies physical `cwd`, initial `ephemeral` thread choice,
read-only sandbox policy, one original text input and no automatic
approval. These fixtures never contact a real model or host. Source
text exists only transiently in an outbound test request; the binding
state stores its SHA-256 only, not raw messages. Streamed item contents
are NOT treated as provenance, and the separate candidate parser
still reports untrusted coverage.

Strict failure cases include wrong, duplicate, unsolicited or reversed
request IDs, a server request masquerading as a notification, mixed
thread/turn IDs, history/fork responses, extra pending items,
failed/interrupted completion, overlapping starts, expired lease,
consent withdrawal, scope pause, changed child connection, and
unsupported/oversized input. A cancellation immediately abandons
the local state before any `turn/interrupt` acknowledgement. **The
synthetic local close flag is shared across earlier immutable state
snapshots**, so callers retaining a pre-cancellation copy cannot resume
using that obsolete snapshot after cancellation or disconnection.
This does not provide atomic revocation against concurrent operations,
an OS trust boundary, or durable cross-process cancellation. A broken
connection can ONLY restart with a fresh `thread/start` request:
it never resumes or imports older conversations under present scope.

**Security boundary:** Request/response correlation on a controlled
stdio pipe is not cryptographic host attestation. The implementation
only accepts a fixture-owned connection and rechecks the synthetic
3A.5 consent/workspace policy on every transition. JSON attributes
still cannot issue authentic scope, user consent or source completeness.
`capture_admission()` and `connect_real_host()` always block, even
when code gates are patched in tests. The existing OS Bridge runtime,
installer, hook wiring, production executable, Memory and OS archive
writer have not changed.

The first strict parser deliberately refuses unsupported notification
orderings rather than retroactively attributing them. A future
pinned real-host pilot and independent review must establish actual
event ordering, source completeness, consent UI and authenticated
transport authority. This prototype cannot backfill Codex desktop
history and must not be treated as a usable chat backup.

Official v2 request examples:
https://learn.chatgpt.com/docs/app-server

### 3A.7 Exact wire source evidence candidate (not an archive)

The existing private chat archive v1 requires completed **original
source record bytes**, a verified SHA-256 digest, genuine source byte
offsets, source event IDs, authenticated physical workspace scope and
authorization checked at the time of persistence. A decoded App
Server JSON notification or reconstructed `json.dumps()` output
cannot meet these requirements, and source offsets from a separate
provider's transcript format must NOT be invented.

New `codex_app_server_source_evidence.py` defines a strictly bounded
**synthetic-only** `ai-verse.codex-app-server-source-candidate/v1`
envelope. Its input is exact caller-supplied UTF-8 JSONL wire bytes,
including the newline, not decoded dictionaries. It validates unique
JSON fields, strict UTF-8, one prospective text-only user and final
assistant item, thread/turn IDs, the successful completion event,
unique item IDs, and bounded ordered frames. Unfinished items,
unrecognized notification kinds, interruptions, media, duplicate
or nonfinal assistant records and partial evidence fail closed.

For each eligible item the in-memory witness records the **unaltered
received wire bytes**, their SHA-256, byte length, frame ordinal and
exact text hash. A stream fingerprint covers the ordered exact frames.
These are fingerprints of SUPPLIED frames, not verified original
provider/host bytes or cryptographic event attestations. Native
source byte offsets remain explicitly absent (`None`), and all
trust, consent, full-UI coverage and writer-admission flags remain
false. Item witness text and raw bytes are excluded from debug repr.

The disposable Python fixture transport now exposes
`next_notification_with_raw()` while preserving its existing
parsed-only API. This lets synthetic tests compare wire bytes
directly with their checksums, even when equivalent JSON uses
different whitespace. No real Codex transcript or host is touched.

`convert_to_v1_archive()` and `source_admission()` unconditionally
return blocked, including when the source evidence development flag
is patched in tests. This new wire candidate is NOT compatible
with the existing v1 archive reader, nor is it a migration or a
production record schema. No v1 source offsets, scope issuer or
authenticated host version is generated.

**Requirements before any archive integration:** verify a pinned
real App Server version and independently controlled OS child
transport, capture exact received frame bytes before parsing,
prove origin/physical scope/consent per event, verify complete
rendered output including media/continuations, and design a
reviewed storage format with exact provenance. Only then can
OS and Memory agree on a new versioned reader/writer contract.
Passing synthetic source tests never enables capture.

Sources: https://learn.chatgpt.com/docs/app-server
and https://openai.com/index/unlocking-the-codex-harness/

### 3A.8 Cross-repo versioned received-wire fixture archive (not admitted)

Official Codex App Server v2 generated JSON schemas define
`userMessage`, `agentMessage`, media, tool and other `ThreadItem`
variants. A narrowly observed final text-only turn is **not** complete
UI coverage. The protocol is evolving: pin an actual host release
and generated schema before a future production integration.

The existing OS archive v1 requires original provider record bytes
and continuous original provider byte offsets. App Server JSON-RPC
stdout only supplies **received** notification wire bytes. Inventing
offsets, regenerating JSON or labeling this provider-origin evidence
would breach the v1 format's provenance contract.

New `codex_app_server_archive_v2.py` implements a separate
`ai-verse.chat-archive-codex-received/v2` envelope **in memory only**.
Header: scope and chat identifiers are UNVERIFIED claims, with
origin/consent/completeness and admission flags forced false.
Frame rows: immutable exact received JSONL bytes encoded in canonical
base64 with original SHA-256/byte length, and a chain digest seeded
from the header. Seal: frame count, whole-stream checksum, last chain
hash, and two text-only item pointers with text hashes. The text is
reconstructed by an independent decoder from the exact received bytes.
The envelope does not contain fabricated provider byte offsets.

The builder accepts only a fully validated 3A.7 synthetic candidate
with matching complete frame hashes, matching text witnesses and all
provenance flags false. It does NOT create a file, archive directory,
Memory record, consent token or host connection. `save_real_chat()`
and `admission()` are hard-blocked even if test flags change.

Memory [draft #37](https://github.com/aiverse-filmmakers/AI-Verse-Memory/pull/37)
implements an independent **in-memory synthetic-only** decoder.
Its cross-repo contract CI pins the original OS #124 builder to
commit `f23d479f50c42636136a102922b42025a1533858`. The
decoder validates canonical envelope, integrity chain, exact wire
hashes, item identities and successful final text-only turn;
it never enters live progressive recall or Memory file discovery.

**Not yet implemented:** production v2 file writer/reader, OS-owned
authenticated session and per-event workspace consent, complete
images/audio/tool/continuation coverage, cryptographic host event
attestation, secure storage and revocation, independently reviewed
schema/version pinning and isolated real-host pilot. Treat both
v2 modules as test fixtures, NOT released chat history support.

Research inputs: generated Codex protocol schema
https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadStartResponse.json
and OWASP Logging Cheat Sheet
https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### 3A.9 Upstream host schema pin and real-host admission requirements

**Research basis (verified 2026-11-09):** Official Codex App Server
generated JSON schemas, pinned to upstream source commit
`openai/codex@e54a5713caf331f42a6eef0166186df5f7563c29`.
The new `codex_host_schema_pin.py` verifies Git object IDs and
schema contents for `ThreadStartParams`, `ThreadStartResponse`,
`TurnStartParams`, `TurnStartResponse`,
`ItemCompletedNotification`, and `TurnCompletedNotification`.
The separate CI job uses sparse checkout at that immutable commit
without building or executing upstream Codex.

**Verified compatibility findings:**

- At this source pin, `ItemCompletedNotification` requires
  `completedAtMs`, `item`, `threadId`, and `turnId`. Earlier 3A.7/3A.8
  synthetic item fixtures OMIT `completedAtMs` and are **not valid**
  complete notification examples for this pinned real-host schema.
  They remain useful isolated format fixtures but cannot support
  a live-host compatibility or complete backup claim.
- The generated `ThreadItem` schema has 19 variants. A final-only
  text implementation cannot promise complete conversation recall.
  The generated `UserInput` has seven kinds: text, image, localImage,
  audio, localAudio, skill and mention. None may be silently downgraded
  into text-only evidence.
- Assistant phase is optional and may be commentary, partial_answer,
  or final_answer; unknown or nonterminal phase fails closed for
  the narrow text fixture. Unknown/extra types require explicit
  versioned support and regression tests before admission.
- `thread/start` and `turn/start` have distinct request and response
  payloads. Physical workspace metadata and a caller-supplied thread
  field are NOT original-message provenance or user consent.

**Before any real Codex archive write, all gates must be independently
implemented, verified, and reviewed:**

1. A version-pinned actual Codex binary/runtime, its approved digest
   and acquisition process, and a privately owned child and stdio
   lifecycle with a provenance link back to OS-originated
   initialize/thread-start/turn-start requests and responses.
   Pinning generated source schemas alone does not attest an executable.
2. An OS-owned user-facing recording consent decision, default opt-out,
   clear per-session disclosure of recording scope and coverage,
   private/no-record boundaries, revocation and retention/deletion
   semantics. Consent must not originate in provider JSON.
3. Per-event physical workspace owner, session, current turn and
   consent revision revalidated at the commit/read boundary under
   an appropriately synchronized OS authority. Filesystem path
   checks and in-memory synthetic leases are not atomic grants.
4. Full item/turn coverage for the exact pinned version, including
   incomplete, interrupted, resumed and media-containing sessions;
   otherwise label the archive explicitly partial and decline
   claims of complete conversation backup.
5. Exact received source bytes, authenticated origin where possible,
   new v2 durable storage with read-time scope checks, stable
   replay/recovery and deterministic rejection of ambiguous data.
   Unkeyed SHA-256 detects accidental or unrecomputed changes but
   does not authenticate a hostile writer or a real host.
6. Independent combined security review, explicitly approved
   isolated real-host pilot, and final installation/release gate.

**Current decision:** `admit_real_capture()` is unconditionally
blocked even when all development flags are patched to true.
`validate_synthetic_completion_shape()` only checks the shape of a
single synthetic text item; it never returns a capture credential or
authorizes any existing v1/v2 writer. No host launch, user data,
installer modification, archive write, Memory discovery or merge.

References:
https://github.com/openai/codex/commit/e54a5713caf331f42a6eef0166186df5f7563c29
https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs
https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
