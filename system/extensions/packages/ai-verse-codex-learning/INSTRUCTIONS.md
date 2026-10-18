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

Local Candidate 0004 adds `INTENT.md`: ordinary goal declarations and corrections route to Brain's existing strategic intent owner after explicit handover. Task-continuation Goals are separate. Overall intent is injected only for relevant work; workspace context receives only explicitly linked goals. Strategic reads and writes respect bound sessions, original-user evidence, owner state and confirmation. The canonical intent's bounded `workspace_links` metadata is a local extension pending Brain-owner review before shared publication. `scripts/purpose-context.mjs` can use the registered read-only Brain public reader. Hook code updates require renewed human trust.
