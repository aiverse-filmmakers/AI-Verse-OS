# 3A.20: Strict v2 synthetic event ownership and lifecycle

Status: fixture-only proof. No native-host authorization, real recording, model turn, archive admission or Memory discovery.

## Verified source contract

Pinned official Codex stable release `rust-v0.167.0` generated v2 notification schemas:
- [AgentMessageDeltaNotification](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/schema/json/v2/AgentMessageDeltaNotification.json)
- [PlanDeltaNotification](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/schema/json/v2/PlanDeltaNotification.json)
- [ReasoningSummaryTextDeltaNotification](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/schema/json/v2/ReasoningSummaryTextDeltaNotification.json)
- [ReasoningTextDeltaNotification](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/schema/json/v2/ReasoningTextDeltaNotification.json)
- [CommandExecutionOutputDeltaNotification](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/schema/json/v2/CommandExecutionOutputDeltaNotification.json)

The existing `codex_app_server_source_evidence.py` previously counted listed deltas without matching `itemId` against a preceding `item/started` of the corresponding type, and accepted `item/completed` whose kind/timestamp differed from a previous start of the same ID. Since a delta is not a complete rendered message, accepting a foreign or orphaned delta could hide lifecycle gaps even in a narrow fixture.

The parser now:
1. Tracks the started item type and `startedAtMs` for each ID and rejects duplicate starts.
2. Requires a delta's `itemId` to refer to an active started item, matching one of the pinned kinds (`agentMessage`, `plan`, `reasoning`, `commandExecution`); completed or unstarted IDs are denied.
3. Validates delta text is a bounded UTF-8 string and requires valid `summaryIndex` or `contentIndex` for reasoning variants.
4. Rejects `item/completed` with a changed kind or completion time before its corresponding start.
5. Requires all started items to be completed before `turn/completed`. The existing `userMessage`/final `agentMessage` fixture can still be completed without explicit starts, matching the prior narrow fixture tests.

The previous source-wire test fixture was updated to include a real synthetic `agentMessage` start before its delta, and three tests cover item mismatches, missing/index-invalid reasoning deltas and completion kind/timestamp conflicts. No real Codex API methods, transport, credentials, user data or production permission gates were altered.

**Evidence:** Initial runner failed on an implementation error involving set subtraction after converting the started-item set into a dictionary. Corrected at commit `891d786208bfb29a82a4cd6d3addae0c1fc19e7d`. Independently reran **59/59** targeted source, archive and disk tests in a disposable hosted browser environment. Require passing GitHub Actions on final head as well.

**Important:** This parser intentionally supports only a subset of the complete UI and source event types. It does not establish actual OS-issued consent, complete chat coverage, original provider byte offsets or authenticated process provenance. Even a perfect synthetic parse cannot grant production capture, storage or Memory read access.

Next phase should address a dedicated **native-host recording opt-in** with independent per-event authority and revocation. Do not reuse an authenticated Dashboard cookie as recording consent.
