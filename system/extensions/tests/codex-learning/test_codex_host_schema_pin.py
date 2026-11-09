"""3A.9: current immutable upstream Codex schema and fail-closed fixture checks.

CI pins the actual public upstream commit for generated schema checkout.
All ordinary tests use synthetic events. No Codex executable is launched.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

PATH = (
    Path(__file__).resolve().parents[2] / "packages"
    / "ai-verse-codex-learning" / "codex_host_schema_pin.py"
)
spec = importlib.util.spec_from_file_location("_codex_upstream_schema_3a9", PATH)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


class SchemaPreflightSyntheticTests(unittest.TestCase):
    def event(self, *, kind="userMessage", completed=1234):
        item = {"id": "item-1", "type": kind}
        if kind == "userMessage":
            item["content"] = [{"type": "text", "text": " Hello 🧪 中文 "}]
        if kind == "agentMessage":
            item.update({"phase": "final_answer",
                         "text": "Final reply"})
        return {"method": "item/completed", "params": {
            "threadId": "thread-id-1", "turnId": "turn-id-1",
            "completedAtMs": completed, "item": item,
        }}

    def blocked(self, e):
        with self.assertRaises(gate.HostSchemaBlocked) as caught:
            gate.validate_synthetic_completion_shape(e)
        self.assertEqual(
            str(caught.exception),
            "pinned Codex App Server host schema not admitted",
        )

    def test_current_user_and_assistant_text_shapes_remain_untrusted(self):
        for kind in ("userMessage", "agentMessage"):
            result = gate.validate_synthetic_completion_shape(
                self.event(kind=kind)
            )
            self.assertEqual(result["status"],
                "current_schema_text_shape_only_not_authenticated")
            self.assertFalse(result["archive_writes_admitted"])
            self.assertFalse(result["complete_ui_coverage"])

    def test_3a8_old_synthetic_item_is_missing_required_completion_stamp(self):
        old = self.event()
        del old["params"]["completedAtMs"]
        self.blocked(old)

    def test_completed_stamp_must_be_bounded_nonnegative_int(self):
        for stamp in (None, False, True, -1, "170000000", 1.5, 2**63):
            with self.subTest(stamp=stamp):
                self.blocked(self.event(completed=stamp))

    def test_no_unsigned_host_claim_can_mint_an_archive_grant(self):
        fake = self.event()
        fake["params"].update({
            "authenticated": True, "consent": True,
            "atTimeScope": "workspace:alpha",
            "signed": True, "fullUiCoverage": True,
        })
        result = gate.validate_synthetic_completion_shape(fake)
        self.assertFalse(result["archive_writes_admitted"])
        for flags in ((True, True, True, True), (False, True, True, True)):
            with (
                mock.patch.object(gate, "_REAL_HOST_RUNTIME_ATTESTED", flags[0]),
                mock.patch.object(gate, "_OS_CONSENT_ISSUER_ATTESTED", flags[1]),
                mock.patch.object(gate, "_AT_EVENT_SCOPE_ISSUER_ATTESTED", flags[2]),
                mock.patch.object(gate, "_COMPLETE_UI_COVERAGE_ATTESTED", flags[3]),
            ):
                self.assertEqual(
                    gate.admit_real_capture(None, fake)["status"], "blocked"
                )

    def test_media_and_all_unsupported_item_kinds_refused(self):
        for item_kind in (
            "hookPrompt", "plan", "reasoning", "commandExecution",
            "imageGeneration", "sleep", "subAgentActivity", "fileChange",
            "webSearch", [], {"kind": "userMessage"}, None,
        ):
            with self.subTest(item_kind=str(item_kind)):
                self.blocked(self.event(kind=item_kind))
        for kind in ("image", "localImage", "audio", "localAudio",
                     "skill", "mention"):
            with self.subTest(content=kind):
                e = self.event()
                e["params"]["item"]["content"] = [
                    {"type": kind, "text": "not a safe original text record"}
                ]
                self.blocked(e)

    def test_ambiguous_phases_and_missing_assistant_content_refused(self):
        for phase in (None, "commentary", "partial_answer", "unknown"):
            e = self.event(kind="agentMessage")
            e["params"]["item"]["phase"] = phase
            self.blocked(e)
        e = self.event(kind="agentMessage")
        del e["params"]["item"]["text"]
        self.blocked(e)

    def test_synthetic_private_text_not_logged_through_exception(self):
        e = self.event()
        e["params"]["item"]["content"][0]["text"] = "PRIVATE-UNTRUSTED-TEXT"
        e["params"]["completedAtMs"] = "bad"
        with self.assertRaises(gate.HostSchemaBlocked) as caught:
            gate.validate_synthetic_completion_shape(e)
        self.assertNotIn("PRIVATE-UNTRUSTED-TEXT", str(caught.exception))
        self.assertNotIn("thread-id-1", str(caught.exception))

    def test_malformed_rpc_or_identity_refused(self):
        for mutate in (
            lambda e: e.update({"id": 12}),
            lambda e: e.update({"jsonrpc": "1.0"}),
            lambda e: e.update({"method": "item/started"}),
            lambda e: e["params"].update({"turnId": None}),
            lambda e: e["params"].update({"threadId": ""}),
            lambda e: e["params"].update({"item": "not-object"}),
        ):
            e = self.event()
            mutate(e)
            self.blocked(e)

    def test_text_size_encoding_and_missing_text_refused(self):
        for text in ("", "\ud800", "x"*(gate.MAX_ITEM_TEXT_BYTES+1)):
            e = self.event()
            e["params"]["item"]["content"][0]["text"] = text
            self.blocked(e)

    def test_nonmatching_or_fake_upstream_source_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="codex-pin-fake-") as root:
            folder = Path(root).resolve(strict=True)
            (folder / "ItemCompletedNotification.json").write_text(
                '{"properties":{}}', encoding="utf-8"
            )
            with self.assertRaises(gate.HostSchemaBlocked):
                gate.verify_upstream_schema_checkout(folder)
            self.assertEqual(gate.admit_real_capture()["status"], "blocked")

    def test_documented_pinned_source_variants_are_not_complete_chat_coverage(self):
        self.assertEqual(gate.UPSTREAM_ITEM_VARIANTS, 19)
        self.assertEqual(len(gate.SCHEMA_BLOBS), 6)
        self.assertEqual(len(gate.USER_INPUT_KINDS), 7)
        self.assertIn("completedAtMs", gate.CURRENT_REQUIRED_ITEM_COMPLETION)


@unittest.skipUnless(
    os.environ.get("AI_VERSE_PINNED_CODEX_V2_SCHEMA_DIR"),
    "requires separately checked-out immutable upstream Codex schemas",
)
class ImmutableUpstreamSchemaCheckoutTests(unittest.TestCase):
    def test_pinned_actual_generated_codex_schemas(self):
        directory = Path(os.environ[
            "AI_VERSE_PINNED_CODEX_V2_SCHEMA_DIR"
        ]).resolve(strict=True)
        report = gate.verify_upstream_schema_checkout(directory)
        self.assertEqual(report.upstream_commit, gate.UPSTREAM_COMMIT)
        self.assertEqual(
            dict(report.schema_blob_ids), gate.SCHEMA_BLOBS
        )
        self.assertEqual(len(report.item_variants), 19)
        self.assertEqual(len(report.user_input_variants), 7)
        self.assertIn("completedAtMs", report.required_item_completion)
        self.assertFalse(report.runtime_executable_attested)
        self.assertFalse(report.source_stream_authenticated)
        self.assertFalse(report.os_consent_authorized)
        self.assertFalse(report.at_event_scope_authorized)
        self.assertFalse(report.full_ui_coverage_verified)
        self.assertFalse(report.archive_writes_admitted)
        self.assertEqual(gate.admit_real_capture(report)["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
