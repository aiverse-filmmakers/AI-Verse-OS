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

Identity uses `name` (a string), and `roles`, `domains`, `notes` (arrays of strings). For example: `{"identity":{"notes":["As of the stated date, the operator lives in the stated country."]},"evidence":{...}}`. Preference categories `communication`, `working_style`, `quality_expectations`, `avoid` also require arrays of strings. The bridge converts a single plain string in these list fields to a one-element array without changing its meaning; objects or invalid list items are refused before any batch write. The profile owner retains final admission. Permission/approval changes are excluded from learning. Profile writes require operator scope and direct user evidence. Keep workspace corrections scoped unless the user clearly generalizes them.

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
