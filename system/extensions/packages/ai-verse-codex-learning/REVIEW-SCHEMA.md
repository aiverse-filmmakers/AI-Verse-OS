# Bounded Codex review

Use bridge.py review --session SESSION --turn ORIGINAL-TURN --token CAPABILITY with JSON on stdin. The hook provides these exact arguments. Use a quoted shell heredoc; never interpolate source material into shell code.

Top-level keys are exactly:

    {"topic": "Short task topic", "summary": "Compact evidence-based outcome.",
     "outcomes": ["Verified result"], "unresolved": [], "candidates": [],
     "persist_digest": false}

Submit the review in the original turn before the final answer, including an empty candidate list when nothing merits retention. Do not add a user-facing acknowledgement for an empty review. Automatic Stop continuations are off by default; a missed review is measurable, not guaranteed to be repaired invisibly. Set persist_digest true only for meaningful work with observed tool evidence or an admitted candidate. A digest is Memory-owned historical navigation, not current authority or an original transcript. Do not retain a full conversation, private reasoning, secrets, or speculative personality traits.

At most four candidates. Example:

    {"route": "memory",
     "parameters": {
       "type": "lesson", "text": "A verified lesson with future value.",
       "confidence": 0.95,
       "admission": {
         "durable": true, "historical": true, "current_truth": false,
         "contains_secret": false, "strategic": false, "permission_expansion": false,
         "privacy_ambiguous": false, "external_authority": false}},
     "evidence": [{"source_id": "user", "quote": "At least three exact words from the actual user prompt"}]}

Run bridge.py sources --session SESSION to get observed source identifiers and types. Tool sources need quotations from actual tool results. JSON envelopes and punctuation are normalized before contiguous word matching; this is not a claim of byte-exact transcript access. The adapter stores only salted token hashes and verifies those word sequences. It never retains source bodies or quotes in diagnostics. Assistant text alone cannot authorize a durable fact. These checks establish observed evidence, not semantic proof that the candidate follows from it: the model must justify relevance/truth and the canonical owner makes final admission.

Do not infer a source ID from list order. Use `sources --session SESSION --match --source-kind tool` and pass the exact observed result quote as plain text on stdin. It returns only matching identifiers and metadata, never source bodies or the quote. Select a matching successful tool source for an observed execution result; matching words in the user's requested output are not proof that a command succeeded. Copy all eight admission fields explicitly, including `external_authority: false`. If an intended capture is refused, report that unresolved outcome rather than declaring that nothing deserved retention.

Memory types include fact, preference, entity, event, experience, workflow, lesson, correction. Stable current preferences belong in the profile route. Corrections require supersedes naming the exact prior historical Memory record. Confidence must be >= 0.85. Current state, strategy, credentials or uncertain privacy must never be disguised as historical Memory.

For a correction, retrieve the prior exact source first and identify what new user or verified tool evidence changes the historical claim. The bridge verifies the target exists, is active and belongs to the same scope before any candidate write. The Memory owner performs retry-safe supersession and preserves the old record; never edit the old atomic Markdown. A missing/cross-scope target is refused rather than stored as an unavailable-owner proposal. A correction does not rewrite current facts owned by profile, Data or Brain.

For route profile, parameters use the existing OS owner shape:

    {"preferences": {"communication": ["Use concise answers by default."]},
     "evidence": {
       "stable": true, "explicit_or_strong": true, "privacy_ambiguous": false,
       "contains_sensitive": false, "contains_secret": false,
       "reason": "The user explicitly gave a durable working preference."}}

Identity uses `name` (a string), and `roles`, `domains`, `ventures`, `notes` (arrays of strings). `ventures` are one line each about what the operator runs or works on, under "What I run and work on"; a line may be `{"text": "...", "project": "<project id>"}` to point at an existing project (one live line per project). For example: `{"identity":{"notes":["As of the stated date, the operator lives in the stated country."]},"evidence":{...}}`. Preference categories `communication`, `working_style`, `quality_expectations`, `avoid` also require arrays of strings. The bridge converts a single plain string in these list fields to a one-element array without changing its meaning; objects or invalid list items are refused before any batch write. The profile owner retains final admission. Permission/approval changes are excluded from learning. Profile writes require operator scope and direct user evidence. Keep workspace corrections scoped unless the user clearly generalizes them.

For route current, parameters are exactly heading, text, old_text, expected_sha256, admission. Admission must be:

    {"current": true, "strategic": false, "contains_secret": false,
     "privacy_ambiguous": false, "high_stakes": false, "data_owned": false,
     "permission_expansion": false}

Read bridge.py query --session SESSION --kind context for the source hash. Eligible headings: Current state, Next useful actions, Pending decisions, Execution state, Connection state; Current facts is operator-only. An empty old_text appends one operational entry; a nonempty value replaces one unique exact span in that heading. No strategic direction, instruction overrides, multiline headings, wholesale copying or Data-owned value duplication. The wrapper resolves current ownership and OS permission, preserves other content, refuses version drift, and writes only the canonical operational file.

For route skills, parameters use the existing Brain/Skills owner shape: candidate, skill_md, task_evidence with substantial_task true. Read the installed owner's admission requirements; do not invent fields. A procedure must reflect real successful repeatable work, scope and provenance, and avoid incident narration. The adapter submits through skills.learning-candidate, not generated runtime skill files. Owner unavailability is reported.

Candidate fields used by the installed owner:

    {"candidate_id":"codex-STABLE-TURN-PROCEDURE", "scope":"workspace:BOUND-ID",
     "suggested_owner":"skills", "kind":"create", "summary":"Reusable verified procedure.",
     "skill_id":"procedure-slug", "evidence_refs":[], "success_signal":["Observed successful execution"],
     "failure_signal":[], "risk":"low", "confidence":0.95, "created_at":"ISO-8601 timestamp",
     "requested_capabilities":[], "requested_dependencies":[], "requires_connection":false,
     "requires_credential":false, "source_ownership":"workspace_local"}

Use agent_learned for a genuinely portable method. Repair proposals also identify target_skill_id. The outer evidence quotes must include an observed successful tool result; the adapter substitutes actual Codex evidence refs. skill_md is a bounded complete package source with SKILL.md frontmatter. Existing owner learning mode governs approval/activation; the real installation currently uses propose mode.

Skill proposals must include Markdown sections for **When to use/Triggers**, **Inputs**, **Procedure/Steps/Method**, **Validation/Verification**, and **Failure/Fallback**. Describe concrete execution, success checks and what to do when they fail. Keep workspace details local. A successful file read is not evidence that the described procedure succeeded; the model must connect the source to actual verified work. Section checks are structural quality gates, not proof of correctness. Brain/Skills retains final admission, evaluation and activation authority.

Run maintenance.py report with an explicit scope to inspect review coverage and typed owner outcomes. A tool-using turn is the coverage heuristic; a missing receipt does not prove a useful lesson was missed. Memory correctness is unmeasured until explicit operator labels exist. Only record a feedback rating when the operator actually gives it, using the real Memory ID and canonical evidence reference; feedback metrics never correct Memory themselves. Corrections still use the owner route above.

The review receipt reports each actual owner effect/refusal. Never announce a saved memory or activated Skill solely because a request was issued.

An interrupted turn cannot admit more learning. Cancellation stops subsequent owner requests and digest creation; it cannot reverse an owner write that already completed.

## Shared member-library placement

When the installation binds a member library, newly approved create proposals
use that library rather than modifying the managed publisher generation.
A portable `agent_learned` method may include `portability` on its candidate:
`{"reusable":true,"contains_workspace_data":false,"contains_credentials":false,"has_workspace_dependencies":false}`.
These declarations need evidence-based semantic review; do not infer them merely
from a skill name, origin workspace or successful execution. Remove private facts
and use explicit scoped inputs first. Missing/uncertain declarations keep workspace
candidates restricted and operator candidates as drafts. Explicit `workspace_local`
intent stays restricted even when the method is portable. Existing proposal/auto
policy still controls activation. Do not set declarations just to pass a gate.

## Note files (Claude Code, optional for Codex)

In Claude Code, which blocks JSON typed into shell commands, the review JSON, `intent` JSON, the `sources --match` quote and the `query --depth source` item go in a new note file inside `runtime/codex-learning/claude-input/` (written with the file Write tool) and are passed with `--input-file PATH` instead of a heredoc. The file must sit directly in that folder. It is deleted after reading, whether the request is accepted or refused. Codex may use the same `--input-file` route; the folder name keeps its old path for compatibility.

## Noticing durable things and correcting them

A correction replaces the old entry through the owner's correction operation; never add a contradicting second entry.

| What the user said | Where it goes |
|---|---|
| Identity fact, communication preference, pet peeve, work habit | route `profile` (add with `preferences`/`identity`) |
| A changed preference ("I changed my mind") | route `profile` with a `correction` object (replaces the old line) |
| A goal, or a change to a goal | Brain `intent capture` (a separate command, not a review candidate); a correction names the prior intent |
| A historical outcome or lesson | route `memory`; a correction uses type `correction` with `supersedes` |
| Project convention, tool quirk, current status in a workspace | route `current` (workspace scope) |

Profile correction (both apps). Read the exact current line first with `query --session SESSION --kind profile` (operator scope only; it returns `preferences` and `preferences_source_sha256`). Then submit:

    {"route": "profile",
     "parameters": {
       "correction": {"category": "communication",
                      "previous": "Prefers answers as short bullet points.",
                      "replacement": "Prefers answers as short paragraphs."},
       "evidence": {"stable": true, "explicit_or_strong": true, "privacy_ambiguous": false,
                    "contains_sensitive": false, "contains_secret": false,
                    "reason": "The user explicitly changed a durable preference."}},
     "evidence": [{"source_id": "user", "quote": "give me answers as short paragraphs"}]}

`category` is one of communication, working_style, quality_expectations, avoid. `previous` must be the existing line. The bridge fills the expected version and the provenance, and does one internal reread if the file changed in between; if it still cannot apply the change it keeps the proposal pending for the operator. Never type the quote into the owner fields yourself: the bridge stores the authenticated user quote in the owner's provenance reason as `user said: "<quote>"`.



## Destinations: where a candidate is saved

Each turn has its own list of destinations, shown in the instructions as "Where this turn may save". It comes from the folder the chat runs in plus any project the operator named in his own typed words (exact project id, name or alias). Names inside pasted, quoted or code blocks never count. Nothing carries over to the next turn.

- A candidate may carry a top level `"scope": "workspace:<id>"` (or `"operator"`). Without it a `profile` candidate goes to the operator profile and every other route to the turn's main destination.
- Two candidates in one review may go to two destinations. A review that spans destinations does not save a session digest.
- Evidence can only support a write to a destination it came from. The operator's own words support every destination they named. Tool and assistant text supports only the turn's main destination.
- If a name could mean more than one project, the instructions say so. Ask the operator one plain question before saving anything about it.
- A fact about the operator himself, stated by him in a project chat, may go to the profile with `"scope":"operator"` and `"general_fact":{"stated_by_operator_about_self":true,"contains_project_figures":false}`. It needs his own words as evidence and must contain no digits.
- Profile corrections accept `"section":"identity"` with category `roles`, `domains`, `ventures` or `notes`; the bridge checks the identity version instead of the preferences version.
- `query --scope workspace:<id> --turn TURN --token TOKEN` reads context or Memory from one of the turn's destinations (the operator scope is always readable). A scoped query without the active turn id and token, or with a stale or cancelled turn, is refused. `bind` needs them too.
- Startup, resume and compaction never carry a project over: the physical folder decides. Venture lines that point at a project are hidden from chats that may not read that project.
- Clients that do not mark pasted text (Codex): a long message never authorizes a project by name; the AI is told to ask for one explicit choice.

## Tidying (`reflect`)

When the start of a chat says tidying is due, run the three printed commands after the operator's request and before the final answer: `reflect plan`, `reflect apply`, `reflect done` (same `--session --turn --token` as the review command; no JSON, so no note file is needed in either app). A pass looks at no more than 20 recent saves, reads no more than 40 records, makes no more than 5 changes and stops starting new work after about 45 seconds; it says when it was cut short. Only projects in view this turn are tidied. Changes the helpers cannot prove came from the operator's own words are still made, but they are marked "guess" in what is stored.

A finished pass leaves a tidy note. When the start of a chat includes one, begin the next reply with it exactly as given. Never put it in the middle of an answer. If the operator says "undo N", run `reflect undo --note ID --item N`; if they correct an item in words, save the right fact normally and run `reflect undo --note ID --item N --mode corrected`.

`reflect all` (one command, no JSON) tidies saves from every project in batches of 100 records from a saved cursor: the last 7 days by default, `--full` for everything, `--auto` for what was saved since the last tidy (full when none finished or the last full one is over `reflect_full_days` old). It skips records unchanged since they were checked, acts only on real defects (a repeat of an earlier note in the same place, which is removed with the first copy kept and can be undone; details in the wrong place; out-of-date project notes), never shortens or rewrites a record, leaves the same thing in a project and in overall memory alone, and says nothing when nothing needs fixing. It works in any chat. Its result and tidy note give detail only for the current project and general items; other projects are counted, and their detail is shown in a later chat that may read them. Goals that read as the same (full passes) are listed in the note as a suggestion only, because Brain replaces a goal only on the operator's own explicit statement and has no way to restore a replaced goal.

Not in this build: merging two goals that mean the same, linking a goal to a project, and any change to what a goal means. These need Brain to offer a reversible API and an explicit statement from the operator.

## Maintainer feedback (the upgrade list)

Only when `maintainer_feedback` is true in the extension configuration. A remark about how AI-Verse OS itself behaves may be saved with `{"route":"upgrade","parameters":{"text":"..."},"evidence":[...the operator's own words...]}`. The text holds the request only and is refused if it names another project. With the switch off the candidate is ignored. `reflect list` rebuilds the derived view `workspaces/ai-verse-os-development/knowledge/AI-VERSE-OS-UPGRADE-LIST.md`.
