"""Synthetic-only contract tests for OS-private portable chat archive (slice 1B)."""

import concurrent.futures
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages" / "ai-verse-codex-learning" / "chat_archive.py"
)
spec = importlib.util.spec_from_file_location("_fixture_chat_archive", MODULE_PATH)
a = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = a
spec.loader.exec_module(a)


def digest(data=b"source-jsonl-complete-with-newline\n"):
    return hashlib.sha256(data).hexdigest()


def event(event_id="u-1", *, sequence=1, offset=0, end=100,
          text="  Hello 👩‍🚀\n\ttail  ", message_id="m-1", terminated=True,
          raw=None, block_index=0, **extra):
    # Default source bytes are synthetic fixtures with a terminating newline.
    raw = raw if raw is not None else b"x" * (end - offset - 1) + b"\n"
    return a.ArchiveEvent(
        source_event_id=event_id, source_byte_offset=offset,
        source_end_offset=end, source_record_sha256=digest(raw),
        source_record_bytes=raw,
        block_index=block_index, message_id=message_id, sequence=sequence,
        role="user" if sequence == 1 else "assistant", text=text,
        record_terminated=terminated, **extra,
    )


class ArchiveFixtureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="synthetic-chat-archive-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "os"
        self.root.mkdir()
        (self.root / "AI-VERSE.yaml").write_text("schema_version: '2.0'\n", encoding="utf-8")

    def workspace(self, name="film", *, manifest_id=None):
        path = self.root / "workspaces" / name
        path.mkdir(parents=True, exist_ok=True)
        (path / "WORKSPACE.yaml").write_text(
            "id: '" + (manifest_id or name) + "'\n", encoding="utf-8"
        )

    def archive(self, *, root=None, scope="operator", authorized=None,
                archive_id="portable-chat-a", chat_id="chat-a",
                origin="claude-code", session_id="source-session-a"):
        return a.ChatArchive(
            root or self.root, scope=scope,
            authorized_scope=authorized or scope,
            archive_id=archive_id, chat_id=chat_id,
            origin=origin, session_id=session_id,
        )

    def path(self, archive):
        return (
            self.root / "archives" / "private-chat-history" / "v1"
            / ("operator" if archive.scope == "operator"
               else "workspaces/" + archive.scope.split(":", 1)[1])
            / (archive.archive_id + ".jsonl")
        )

    def test_roundtrip_unicode_exact_and_portable_read_without_provider(self):
        chat = self.archive()
        self.assertEqual(chat.read().status, "missing")
        first = event(text="👩‍🚀  café 中文\n\n\t  ", timestamp="2026-11-05T12:00:00Z",
                      revision="abc123", branch="topic-1",
                      attachment_availability="not_embedded")
        receipt = chat.append(first)
        self.assertEqual(receipt.status, "saved")
        path = self.path(chat)
        self.assertTrue(path.exists())
        self.assertFalse(path.is_symlink())
        self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode) & 0o077, 0)
        read = chat.read()
        self.assertEqual(read.status, "saved")
        self.assertEqual(len(read.messages), 1)
        saved = read.messages[0]
        self.assertEqual(saved["text"], first.text)
        self.assertEqual(saved["timestamp"], first.timestamp)
        self.assertEqual(saved["revision"], first.revision)
        self.assertEqual(saved["branch"], first.branch)
        self.assertEqual(saved["attachment_availability"], "not_embedded")
        self.assertEqual(saved["source_byte_offset"], first.source_byte_offset)

        copied = Path(self.tmp.name) / "copied-os"
        shutil.copytree(self.root, copied)
        shutil.rmtree(self.root)
        relocated = self.archive(root=copied)
        self.assertEqual(relocated.read().messages, read.messages)

    def test_same_text_repeated_messages_are_not_collapsed_or_misidentified(self):
        chat = self.archive()
        one = event("event-1", sequence=1, text="exact match", message_id="message")
        two = event("event-2", sequence=2, text="exact match",
                    message_id="message", offset=120, end=240)
        self.assertEqual(chat.append(one).status, "saved")
        self.assertEqual(chat.append(one).status, "replayed")
        self.assertEqual(chat.append(two).status, "saved")
        self.assertEqual(
            [m["source_event_id"] for m in chat.read().messages],
            ["event-1", "event-2"],
        )
        self.assertEqual([m["text"] for m in chat.read().messages], ["exact match"] * 2)
        self.assertNotEqual(chat.read().messages[0]["archive_record_sha256"],
                            chat.read().messages[1]["archive_record_sha256"])

    def test_same_source_record_can_have_distinct_visible_blocks(self):
        chat = self.archive()
        self.assertEqual(chat.append(event("u-1-block-0", message_id="u-1")).status, "saved")
        self.assertEqual(chat.append(event("u-1-block-2", sequence=2, offset=0,
                                           end=100, block_index=2, message_id="u-1")).status, "saved")
        self.assertEqual(
            [m["block_index"] for m in chat.read().messages], [0, 2]
        )

    def test_changed_payload_same_immutable_event_id_fails_closed(self):
        chat = self.archive()
        original_bytes = b"record v1\n"
        first = event(end=len(original_bytes), raw=original_bytes)
        chat.append(first)
        alterations = [
            event(end=len(original_bytes), raw=original_bytes, text="new text"),
            event(end=len(original_bytes), raw=b"record v2\n"),
            event(offset=1, end=1 + len(original_bytes), raw=original_bytes),
            event(end=len(b"record v1!\n"), raw=b"record v1!\n"),
            event(end=len(original_bytes), raw=original_bytes, message_id="changed"),
        ]
        for changed in alterations:
            with self.subTest(changed=changed), self.assertRaises(a.ArchiveConflict):
                chat.append(changed)
        self.assertEqual(chat.read().messages[0]["text"], first.text)

    def test_source_absolute_utf8_offsets_remain_after_resume(self):
        chat = self.archive()
        # Deliberately emulate an incremental reader resuming from an absolute
        # source offset, not a new chunk-local zero.
        row_one = '{"type":"user","message":{"content":"🌍 中文"}}\n'.encode("utf-8")
        self.assertGreater(len(row_one), len(row_one.decode("utf-8")))
        first = event("record-1:block:0", offset=0, end=len(row_one),
                      raw=row_one)
        second_row = '{"type":"assistant","message":{"content":"a"}}\n'.encode("utf-8")
        second = event("record-2:block:0", sequence=2, offset=len(row_one),
                       end=len(row_one) + len(second_row), raw=second_row,
                       text="a", message_id="m-2")
        chat.append(first)
        resumed = self.archive()
        resumed.append(second)
        read = resumed.read()
        self.assertEqual(
            [m["source_byte_offset"] for m in read.messages], [0, len(row_one)]
        )
        self.assertEqual(read.messages[1]["source_end_offset"],
                         len(row_one) + len(second_row))
        self.assertEqual(chat.append(first).status, "replayed")

    def test_missing_or_conflicting_raw_source_proof_blocks_commit(self):
        chat = self.archive()
        # The raw source bytes are checked against the *absolute* byte span.
        with self.assertRaises(a.ArchiveBlocked):
            chat.append(event(raw=b"short\n", end=100))
        with self.assertRaises(a.ArchiveBlocked):
            chat.append(a.ArchiveEvent(
                source_event_id="u-1", source_byte_offset=0, source_end_offset=5,
                source_record_sha256=digest(b"other"), source_record_bytes=b"good\n",
                block_index=0, message_id="m-1", sequence=1, role="user",
                text="visible", record_terminated=True,
            ))
        self.assertFalse(self.path(chat).exists())

    def test_incomplete_source_record_is_pending_without_even_creating_archive(self):
        chat = self.archive()
        pending = event(terminated=False)
        result = chat.append(pending)
        self.assertEqual(result.status, "pending")
        self.assertFalse(self.path(chat).exists())
        # A valid JSON value without its newline is provisional even if a
        # future adapter incorrectly claims it is already terminated.
        provisional_bytes = b'{"type":"user","message":{"content":"hello"}}'
        no_newline = event(raw=provisional_bytes, end=len(provisional_bytes))
        self.assertEqual(chat.append(no_newline).status, "pending")
        self.assertFalse(self.path(chat).exists())
        committed = event()
        self.assertEqual(chat.append(committed).status, "saved")
        self.assertEqual(chat.append(event("a-2", sequence=2, terminated=False)).status, "pending")
        self.assertEqual(len(chat.read().messages), 1)

    def test_torn_archive_tail_is_reported_and_recovered_before_next_commit(self):
        chat = self.archive()
        first = event()
        chat.append(first)
        archive_path = self.path(chat)
        with archive_path.open("ab") as stream:
            stream.write(b'{"kind":"message","incomplete":')
        partial = chat.read()
        self.assertEqual(partial.status, "partial")
        self.assertEqual(partial.torn_tail_bytes, len(b'{"kind":"message","incomplete":'))
        self.assertEqual(len(partial.messages), 1)
        next_event = event("a-2", sequence=2, offset=100, end=205, text="Recovered")
        result = chat.append(next_event)
        self.assertEqual(result.status, "saved")
        self.assertTrue(result.recovered_torn_tail)
        self.assertEqual([m["text"] for m in chat.read().messages],
                         [first.text, "Recovered"])
        self.assertEqual(chat.read().status, "saved")

    def test_empty_archive_after_failed_initial_write_is_recoverable(self):
        chat = self.archive()
        with mock.patch.object(a, "_write_all", side_effect=OSError("synthetic disk failure")):
            with self.assertRaises(a.ArchiveBlocked) as caught:
                chat.append(event())
        self.assertEqual(caught.exception.status, "blocked")
        self.assertEqual(chat.read().status, "partial")
        self.assertEqual(chat.append(event()).status, "saved")
        self.assertEqual(len(chat.read().messages), 1)

    def test_unsafe_workspace_binding_and_scope_mismatch_are_rejected(self):
        self.workspace("film")
        with self.assertRaises(a.ArchiveBlocked):
            self.archive(scope="workspace:film", authorized="operator")
        with self.assertRaises(a.ArchiveBlocked):
            self.archive(scope="workspace:other")
        self.workspace("wrong", manifest_id="unrelated")
        with self.assertRaises(a.ArchiveBlocked):
            self.archive(scope="workspace:wrong")
        film = self.archive(scope="workspace:film")
        film.append(event())
        operator = self.archive()
        self.assertEqual(operator.read().status, "missing")
        self.assertEqual(len(film.read().messages), 1)

    def test_copy_two_workspace_chat_archives_never_cross_visibility(self):
        self.workspace("film")
        self.workspace("finance")
        film = self.archive(scope="workspace:film", archive_id="shared-id")
        finance = self.archive(scope="workspace:finance", archive_id="shared-id")
        film.append(event(text="film-private"))
        finance.append(event(text="finance-private"))
        self.assertEqual([m["text"] for m in film.read().messages], ["film-private"])
        self.assertEqual([m["text"] for m in finance.read().messages], ["finance-private"])
        with self.assertRaises(a.ArchiveBlocked):
            self.archive(scope="workspace:film", archive_id="shared-id",
                         session_id="impostor-session").read()

    def test_symlink_parent_file_and_manifest_are_rejected(self):
        chat = self.archive()
        chat.append(event())
        original = self.path(chat)
        alternate = Path(self.tmp.name) / "target"
        alternate.write_text("stolen content", encoding="utf-8")
        original.unlink()
        try:
            original.symlink_to(alternate)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable in this fixture environment")
        with self.assertRaises(a.ArchiveBlocked):
            chat.read()
        with self.assertRaises(a.ArchiveBlocked):
            chat.append(event("event-2", sequence=2, offset=101, end=200))
        original.unlink()
        parent = original.parent
        relocated = Path(self.tmp.name) / "shadow"
        parent.rename(relocated)
        parent.symlink_to(relocated, target_is_directory=True)
        with self.assertRaises(a.ArchiveBlocked):
            chat.read()

    def test_bad_committed_integrity_and_invalid_lines_fail_closed(self):
        chat = self.archive()
        chat.append(event())
        path = self.path(chat)
        raw = path.read_bytes()
        # An attacker or bit rot changing stored text is detected before source is returned.
        path.write_bytes(raw.replace(b"Hello", b"Jello"))
        with self.assertRaises(a.ArchiveBlocked):
            chat.read()
        with self.assertRaises(a.ArchiveBlocked):
            chat.append(event("next", sequence=2, offset=100, end=200))
        path.write_bytes(raw + b'{"bad":,}\n')
        with self.assertRaises(a.ArchiveBlocked):
            chat.read()

    def test_conflicting_offset_out_of_order_and_sequence_gap_are_blocked(self):
        chat = self.archive()
        chat.append(event())
        with self.assertRaises(a.ArchiveBlocked):
            chat.append(event("third", sequence=3, offset=105, end=120))
        with self.assertRaises(a.ArchiveConflict):
            chat.append(event("same-offset-changed", sequence=2,
                              offset=0, end=100, raw=b"y" * 99 + b"\n"))
        with self.assertRaises(a.ArchiveBlocked):
            chat.append(event("backwards", sequence=2, offset=0, end=100))
        self.assertEqual(len(chat.read().messages), 1)

    def test_same_event_concurrent_replay_is_serialized(self):
        chat = self.archive()
        original = event()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            outcomes = list(pool.map(chat.append, [original] * 12))
        self.assertEqual([item.status for item in outcomes].count("saved"), 1)
        self.assertEqual([item.status for item in outcomes].count("replayed"), 11)
        self.assertEqual(len(chat.read().messages), 1)


if __name__ == "__main__":
    unittest.main()
