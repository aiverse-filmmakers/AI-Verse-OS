# AI-Verse local Codex connection

This extension connects Codex lifecycle events to existing AI-Verse owners. AGENTS.md and AI-VERSE.yaml remain authoritative.

- UserPromptSubmit: scoped current context, stable profile, query-bound Memory recall and concise preflight instructions.
- SessionStart: context restoration after startup, resume and compaction.
- PostToolUse: bounded salted hashes of observed tokens, status and identifiers; one reminder of the actual bound review command within the existing tool turn. Source bodies are not stored and no new user prompt is requested.
- Stop: automatic continuations off by default; if a member explicitly opts in, at most one additional review when a receipt is missing.
- Interrupt / SessionEnd: close operational state without waking a stopped session.

Interrupt records cancellation without waiting for an ongoing review lock. Further owner writes and digest creation stop when cancellation is observed. A write already committed by an owner remains committed; cancellation is not a rollback.

The review command routes historical learning to Memory, stable profile facts to the OS profile owner, operational context to the ownership-aware OS location, and procedures through Brain/Skills. Read REVIEW-SCHEMA.md. Data values and strategy retain their owners. Registration creates no permission/trust.

The model performs semantic review using its existing conversation. It can submit a review within the original turn, avoiding an extra round. Stop continuation consumes another turn and may add visible output/latency. Codex stop_hook_active and per-turn receipts prevent loops. No external LLM API call is used.

Complete review before the final answer without announcing empty receipts. Read REVIEW-SCHEMA.md for same-scope historical correction and complete procedural Skill requirements. Example/template files are filtered out of recall and never become operator identity. maintenance.py report measures completed tool-turn reviews, typed owner effects and explicit operator quality labels; it never infers perfect memory from zero labels.

When the member asks to set up or check this connection, read SETUP.md and use install.py setup/doctor with the installation's admitted runtime. This guidance is available through the registry before hooks are approved. Setup never approves hooks or sends messages to another chat on behalf of the member. The public package/install interface discovers this member's paths and defaults to no automatic follow-ups.

Only this project receives hooks. The entrypoint refuses outside-project events and scope/path escapes. Explicit workspace references, physical workspace cwd and session bindings control visibility; ambiguous scope never broadens retrieval.

Controls: bridge.py set --enabled false; --review-mode meaningful; --review-mode all; --review-mode off. All reviews every normal message. Off keeps context without continuations. Lifecycle remove removes only owned handlers, preserving canonical user state and other hooks.

Status: bridge.py status. Source/receipt metadata: bridge.py sources --session SESSION. Owner reads: bridge.py query --session SESSION --kind context|memory|capabilities|connections.

The hook command contains the script SHA-256. Code changes require regenerating definitions and renewed Codex trust. Never edit trust records or bypass trust for normal use.

Session proofs and receipts live under runtime/codex-learning. Canonical Memory/digests/profile/current state stay with their owners. Review admission expires after 24 hours. Diagnostics exclude prompt, response, tool result, quote and candidate text.

`INTENT.md` describes the Codex adapter's integration with Brain's existing strategic intent owner after explicit handover. Task-continuation Goals are separate. Overall intent is injected only for relevant work; workspace context receives only explicitly linked goals. Strategic reads and writes respect bound sessions, original-user evidence, owner state and confirmation. Workspace links and correction transfer use Brain's owner API; workspace-scoped public snapshots expose only matching goals and redact link metadata. `scripts/purpose-context.mjs` can use the registered read-only Brain public reader. Hook code updates require renewed human trust.

Member skill creation uses the installation-bound Skills library lifecycle. Shared
availability never includes the source workspace's private context, settings or
Connections. Preserve explicit private intent and existing proposal approval.
Use OS scoped discovery and exact identities for same-named alternatives; never
silently prefer a generated built-in copy over an explicitly requested package.

Claude Code: the same hooks run with `--harness claude`. JSON is never typed into a command; the review, `intent`, `sources --match` and `query --depth source` input goes in a new note file inside `runtime/codex-learning/claude-input/`, named with `--input-file`. The bridge deletes the note after reading it. `bridge.py set --enabled false` switches learning off for both apps.

Tidying: when the chat start says tidying is due, run its three `reflect` commands (plan, apply, done) before the final answer; when it says tidying of everything saved is due, run its one `reflect all --auto` command instead. For a tidy the operator asks for, run `reflect all` (last 7 days) or `reflect all --full` (everything). When it includes a tidy note, begin the next reply with it exactly. Use everyday words with the operator: "what I know about you", "projects", "what I remember", "your goals", "AI-Verse OS helpers".


When local chat history is enabled, a tidy plan also returns `chat_placement`
previews for this project's chats and Personal chats. Review those homes too.
An excerpt is only a starting point: inspect relevant exact archived messages
before proposing a different home. Mixed chats stay in their existing restricted
home until the operator reviews them. Never infer permission to move a chat.

Use the same PREFIX as other commands with `history list|plan|move|recover
--session SESSION --turn TURN --token TOKEN` and a JSON object on stdin. List
accepts `{"from":"SCOPE","limit":4}`. Plan accepts `{"archive_id":"ID",
"from":"SOURCE_SCOPE","to":"DESTINATION_SCOPE"}` and requires both homes to
be authorized by the current original user turn. Show the plan and explain that
moving closes capture for this native chat, so a new chat is needed to record
further messages. Move requires a new explicit user confirmation quoting the
plan fingerprint, then `{"fingerprint":"EXACT_HASH","confirm":true,"quote":
"VERBATIM CURRENT USER CONFIRMATION INCLUDING THAT HASH"}`. The confirmation is
checked against this original turn's observed user words, not assistant or tool
text. A stale source invalidates the preview. A refused or interrupted move must
not be replaced with a manual file move. After an interruption, the same exact
confirmed plan can be completed with `history recover`; both homes remain
inaccessible until its verified recovery commits. Source application files are
never changed. Retained message references resolve only in the chat's current
authorized home.


For Memory queries, `archive_page.complete` describes only the chat search scan.
If false, chat counts and matches cover one page, not all saved chats. Continue
with the same depth, query and scope, passing the exact `archive_page.next_cursor`
JSON through `query --archive-cursor`, until complete before claiming nothing was
found. A new query starts a fresh scan. Do not use an archive cursor for exact
source reads. New messages or placements during a scan may require a fresh scan.
The tidy preview also rotates through scoped chats in bounded pages so it does
not repeatedly inspect only the first few chats.
