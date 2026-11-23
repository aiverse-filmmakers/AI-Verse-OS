import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4


path = Path(__file__).resolve().parents[1] / "system/capabilities/learn/scripts/read-history.py"
spec = importlib.util.spec_from_file_location("learn_history", path)
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class LearnHistoryTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.session = str(uuid4())
        self.turn = str(uuid4())

    def start(self, host, source=None, turn=None, request_stdin=False):
        result = history.prepare(SimpleNamespace(
            host=host, session=self.session, turn=turn, cwd=self.root,
            request_stdin=request_stdin, source=source))
        self.addCleanup(Path(result["index"]).unlink)
        return result

    def collect(self, receipt):
        cursor = receipt["next"]
        records = []
        fragments = []
        while cursor is not None:
            result = history.page(SimpleNamespace(index=receipt["index"], cursor=cursor))
            self.assertLess(len(json.dumps(result)), history.PAGE_BYTES + 256)
            for block in result["records"]:
                self.assertEqual(block["start"], sum(map(len, fragments)))
                fragments.append(block["data"])
                if block["last"]:
                    records.append(json.loads("".join(fragments)))
                    fragments.clear()
            cursor = result["next"]
        self.assertTrue(result["end_of_index"])
        self.assertEqual(result["reviewed_through"], receipt["last_line"])
        self.assertEqual(fragments, [])
        return records

    def write(self, path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def codex_user(self, text):
        metadata = {"content_item_kinds": ["user.text"],
                    "content_item_metadata": [{"provenance": {"type": "user"}}]}
        return self.item("message", role="user", content=[{"type": "input_text", "text": text}],
                         internal_chat_message_metadata_passthrough=metadata)

    @staticmethod
    def item(kind, **fields):
        return {"type": "response_item", "payload": {"type": kind, **fields}}

    def test_codex_custom_storage_preserves_attempts_across_compaction(self):
        source = self.root / "custom/sessions/2026/11/23" / f"rollout-2026-11-23-{self.session}.jsonl"
        prompt = 'Use this light: "soft," with blue reflections.\n' * 700
        self.write(source, [
            {"type": "session_meta", "payload": {"id": self.session, "cwd": str(self.root)}},
            self.codex_user("First day"),
            self.item("reasoning", summary=[{"text": "HIDDEN_REASONING"}]),
            self.item("function_call", name="external_image_tool", call_id="call-1",
                      arguments=json.dumps({"prompt": prompt})),
            self.codex_user("Mid task: keep the old wall."),
            {"type": "compacted", "payload": {"message": "COMPRESSED_ONLY"}},
            self.item("function_call_output", call_id="call-1", output="result-1"),
            self.codex_user("Second day: the reflections in result-1 worked."),
            {"type": "turn_context", "payload": {"turn_id": self.turn, "cwd": str(self.root)}},
            self.codex_user("/learn"),
            self.codex_user("AFTER_INVOCATION"),
        ])
        with patch.dict("os.environ", {"CODEX_HOME": str(self.root / "custom")}):
            receipt = self.start("codex", turn=self.turn)
        self.assertEqual(receipt["gaps"], [])
        records = self.collect(receipt)
        self.assertEqual(records[0]["content"][0]["text"], "First day")
        self.assertEqual(json.loads(records[1]["content"]["arguments"])["prompt"], prompt)
        self.assertEqual(records[2]["content"][0]["text"], "Mid task: keep the old wall.")
        self.assertEqual(records[3]["content"]["call_id"], "call-1")
        self.assertIn("reflections in result-1", records[4]["content"][0]["text"])
        self.assertEqual(records[5]["content"][0]["text"], "/learn")
        self.assertEqual(len(records), 6)
        with source.open("r+b") as stream:
            stream.seek(source.read_bytes().index(b"First day"))
            stream.write(b"Different")
        with self.assertRaisesRegex(history.HistoryError, "source record changed"):
            self.collect(receipt)

    def test_claude_uses_current_branch_and_follows_original_compaction_parent(self):
        source = self.root / "custom/projects/project" / f"{self.session}.jsonl"
        first, call, result, alternate, boundary, feedback = [str(uuid4()) for _ in range(6)]

        def message(key, parent, role, content, **extra):
            return {"type": role, "uuid": key, "parentUuid": parent,
                    "sessionId": self.session, "cwd": str(self.root),
                    "message": {"role": role, "content": content}, **extra}

        self.write(source, [
            message(first, None, "user", "Original brief"),
            message(call, first, "assistant", [{"type": "thinking", "thinking": "PRIVATE"},
                    {"type": "tool_use", "id": "img", "name": "image_tool",
                     "input": {"type": "image", "prompt": "soft light"}}]),
            message(result, call, "user", [{"type": "tool_result", "tool_use_id": "img",
                    "content": [{"type": "text", "text": "job-1"}]}]),
            message(alternate, first, "user", "ABANDONED_BRANCH"),
            {"type": "system", "subtype": "compact_boundary", "uuid": boundary,
             "logicalParentUuid": result, "parentUuid": None},
            message(feedback, boundary, "user", "Job 1 looked good.", timestamp="2026-11-23"),
            message(self.turn, feedback, "user",
                    "<command-message>learn</command-message>\n<command-name>/learn</command-name>"),
        ])
        with patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(self.root / "custom")}):
            with patch("sys.stdin", io.StringIO("/learn")):
                receipt = self.start("claude", request_stdin=True)
        self.assertEqual(receipt["gaps"], [])
        records = self.collect(receipt)
        self.assertEqual(records[0]["content"], "Original brief")
        self.assertEqual(records[1]["content"], [
            {"type": "tool_use", "id": "img", "name": "image_tool",
             "input": {"type": "image", "prompt": "soft light"}}])
        self.assertEqual(records[2]["content"][0]["tool_use_id"], "img")
        self.assertEqual(records[3]["content"], "Job 1 looked good.")
        self.assertIn("/learn", records[4]["content"])
        self.assertEqual(len(records), 5)

    def test_claude_reports_missing_parent(self):
        source = self.root / f"{self.session}.jsonl"
        self.write(source, [{"type": "user", "uuid": self.turn, "parentUuid": str(uuid4()),
                            "sessionId": self.session, "cwd": str(self.root),
                            "message": {"role": "user", "content": "/learn"}}])
        receipt = self.start("claude", source=source, turn=self.turn)
        self.assertTrue(receipt["gaps"])

    def test_claude_reads_delivered_mid_task_feedback_once_and_flags_unknown_delivery(self):
        source = self.root / f"{self.session}.jsonl"
        first, call, delivered, original, result, other_branch = [str(uuid4()) for _ in range(6)]

        def record(kind, key, parent, **fields):
            return {"type": kind, "uuid": key, "parentUuid": parent,
                    "sessionId": self.session, "cwd": str(self.root), **fields}

        def queue(operation, content):
            return {"type": "queue-operation", "operation": operation,
                    "content": content, "sessionId": self.session}

        prompt = "Preserve the camera but change the light." * 600
        attachment = {"type": "queued_command", "source_uuid": original, "commandMode": "prompt",
                      "prompt": [{"type": "text", "text": "Keep the old wall."}],
                      "origin": {"kind": "human"}, "timestamp": "2026-11-23T12:00:00Z"}
        self.write(source, [
            record("user", first, None, message={"content": "First brief"}),
            record("assistant", call, first, message={"content": [
                {"type": "tool_use", "id": "job", "input": {"prompt": prompt}}]}),
            queue("enqueue", "Cancelled before delivery."),
            queue("remove", "Cancelled before delivery."),
            queue("enqueue", "Keep the old wall."),
            record("attachment", delivered, call, attachment=attachment),
            record("attachment", other_branch, first, attachment={**attachment,
                   "source_uuid": other_branch, "prompt": "Abandoned branch"}),
            record("user", original, delivered, message={"content": "Keep the old wall."}),
            record("user", result, original, message={"content": [{"type": "tool_result",
                   "tool_use_id": "job", "content": "Rendered"}]}),
            queue("enqueue", "No delivery recorded."),
            record("user", self.turn, result, message={"content": "/learn"}),
        ])
        receipt = self.start("claude", source=source, turn=self.turn)
        self.assertEqual(receipt["gaps"], [
            "Claude queue entry at line 10 has no confirmed delivery on this branch."])
        records = self.collect(receipt)
        self.assertEqual([value.get("record_kind") for value in records].count("queued_user_message"), 1)
        self.assertEqual(history.message_text(records[2]["content"]), "Keep the old wall.")
        self.assertEqual(records[2]["submitted_at"], attachment["timestamp"])
        self.assertEqual(records[3]["content"][0]["tool_use_id"], "job")
        self.assertNotIn("Abandoned", json.dumps(records))

        # Each page uses a fresh process, as after a context reset.
        def run_page(cursor):
            return json.loads(subprocess.check_output([
                sys.executable, str(path), "page", "--index", receipt["index"],
                "--cursor", *map(str, cursor)], text=True, encoding="utf-8"))
        original_page = run_page(receipt["next"])
        saved_cursor = json.loads(json.dumps(original_page["next"]))
        next_page = run_page(saved_cursor)
        self.assertEqual(next_page["records"][0]["line"], original_page["records"][-1]["line"])
        self.assertEqual(next_page["records"][0]["start"], original_page["records"][-1]["end"])

    def test_claude_exact_text_cannot_pick_an_older_turn(self):
        source = self.root / f"{self.session}.jsonl"
        previous = str(uuid4())
        self.write(source, [
            {"type": "user", "uuid": key, "parentUuid": parent, "sessionId": self.session,
             "cwd": str(self.root), "message": {"role": "user", "content": text}}
            for key, parent, text in [(previous, None, "/learn"), (self.turn, previous, "More feedback")]
        ])
        with patch("sys.stdin", io.StringIO("/learn")):
            with self.assertRaisesRegex(history.HistoryError, "not yet identifiable"):
                self.start("claude", source=source, request_stdin=True)


if __name__ == "__main__":
    unittest.main()
