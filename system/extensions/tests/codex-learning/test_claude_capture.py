"""Synthetic Claude Code catch-up fixtures, no live host or personal OS paths."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"
sys.path.insert(0, str(PACKAGE))
import bridge as bridge_module  # noqa: E402
from bridge import Bridge, DEFAULT_ROOT  # noqa: E402
from claude_capture import _supplied_source, CaptureBlocked, capture_hook  # noqa: E402


def record(role, content, session, *, uuid="message", **flags):
    row = {
        "type": role, "sessionId": session, "uuid": uuid,
        "message": {"role": role, "content": content}, **flags,
    }
    return (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


class CaptureFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-os-claude-1c-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "os"
        self.root.mkdir()
        shutil.copy2(DEFAULT_ROOT / "AI-VERSE.yaml", self.root / "AI-VERSE.yaml")
        shutil.copy2(DEFAULT_ROOT / "AGENTS.md", self.root / "AGENTS.md")
        shutil.copytree(DEFAULT_ROOT / "scripts", self.root / "scripts",
                        ignore=shutil.ignore_patterns("test-*", "__pycache__"))
        for location in ("operator/context", "workspaces", ".aiverse/extensions/ai-verse-codex-learning"):
            (self.root / location).mkdir(parents=True, exist_ok=True)
        (self.root / "operator/context/CURRENT.md").write_text(
            "# Context\n\n## Current state\n\n- synthetic operator state.\n"
        )
        for workspace in ("alpha", "beta"):
            folder = self.root / "workspaces" / workspace
            (folder / "context").mkdir(parents=True)
            (folder / "WORKSPACE.yaml").write_text(
                f'schema_version: "2.0"\nid: {workspace}\nname: "{workspace.title()}"\nstatus: active\n'
            )
            (folder / "context/CURRENT.md").write_text("## Current state\n\n- fixture state\n")
        registry = {"schema_version": "1.0", "extensions": {
            "ai-verse-codex-learning": {
                "id": "ai-verse-codex-learning", "supported": True,
                "installed": True, "enabled": True,
            }}}
        (self.root / ".aiverse/extensions/registry.json").write_text(json.dumps(registry))
        self.provider = tempfile.TemporaryDirectory(prefix="synthetic-claude-provider-")
        self.addCleanup(self.provider.cleanup)
        self.session = "fixture-session-01"
        self.path = Path(self.provider.name) / (self.session + ".jsonl")
        self.bridge = Bridge(self.root, harness="claude")
        self.bridge.save({
            "schema_version": 1, "session_id": self.session, "scope": "operator",
            "turn": {
                "id": "fixture-turn", "token": "fixture-token", "scope": "operator",
                "state": "active", "created": 1, "allowed": ["operator"],
            },
        })

    def host_event(self, kind="Stop", *, cwd=None, session=None, **extra):
        return {
            "hook_event_name": kind,
            "session_id": session or self.session,
            "cwd": str(cwd or self.root),
            "transcript_path": str(self.path),
            "permission_mode": "default",
            **extra,
        }

    def enable_fixture_capture(self):
        # Never persist enabled flags or production host-coverage admission.
        # A mock affects this synthetic test only and is cleaned up afterward.
        gate = mock.patch("claude_capture._HOST_COVERAGE_ADMITTED", True)
        gate.start()
        self.addCleanup(gate.stop)
        history_gate = mock.patch("claude_capture._HISTORY_PROVENANCE_ISSUER_ADMITTED", True)
        history_gate.start()
        self.addCleanup(history_gate.stop)
        self.bridge.config["capture_enabled"] = True
        self.bridge.config["capture_coverage_verified"] = True

    def attest_synthetic_history(self, scopes=None):
        """Fixture-only stand-in for an OS at-record scope-provenance issuer.

        NEVER infer or backfill provenance this way in production. The real
        1C code intentionally does not mint historical authorizations.
        """
        source = self.path.read_bytes()
        proof = []
        cursor = 0
        while cursor < len(source):
            newline = source.find(b"\n", cursor)
            if newline < 0:
                break
            row = source[cursor:newline + 1]
            proof.append({
                "offset": cursor,
                "end": newline + 1,
                "sha256": hashlib.sha256(row).hexdigest(),
                "scope": "operator",
            })
            cursor = newline + 1
        if scopes is not None:
            self.assertEqual(len(scopes), len(proof))
            for entry, scope in zip(proof, scopes):
                entry["scope"] = scope
        state = self.bridge.state(self.session)
        state["capture_scope_provenance"] = {
            "schema_version": 1,
            "issuer": "os-authorized-at-record",
            "session_id": self.session,
            "transcript_path": str(self.path),
            "records": proof,
        }
        self.bridge.save(state)

    def test_disabled_by_default_even_with_existing_source(self):
        self.path.write_bytes(record("user", "Do not capture me", self.session))
        response = capture_hook(self.bridge, self.host_event())
        self.assertEqual(response["status"], "disabled")
        self.assertFalse((self.root / "archives" / "private-chat-history").exists())
        self.assertFalse(self.bridge.config["capture_enabled"])
        self.assertFalse(self.bridge.config["capture_coverage_verified"])

    def test_needs_both_review_gate_and_capture_switch(self):
        self.path.write_bytes(record("user", "Visible", self.session))
        self.bridge.config["capture_enabled"] = True
        response = capture_hook(self.bridge, self.host_event())
        self.assertEqual(response["status"], "blocked")
        self.assertFalse((self.root / "archives" / "private-chat-history").exists())

    def test_existing_claude_hook_dispatches_only_when_capture_enabled(self):
        called = []
        original_safe = bridge_module.safe
        requested = Path(bridge_module.__file__).with_name("claude_capture.py")

        def preserve_other_checks(path, boundary, **kwargs):
            # In a real installation the source module is copied below OS.
            # This synthetic bridge import lives at the repo source path.
            if Path(path) == requested:
                return path
            return original_safe(path, boundary, **kwargs)

        fake = SimpleNamespace(capture_hook=lambda bridge, event: (
            called.append(event["hook_event_name"]) or {"status": "blocked", "saved": 0}
        ))
        with (mock.patch.object(bridge_module, "safe", side_effect=preserve_other_checks),
              mock.patch.object(bridge_module, "load_module", return_value=fake),
              mock.patch.object(self.bridge, "context", return_value={})):
            self.bridge.hook(self.host_event("SessionStart"))
            self.assertEqual(called, [])
            self.bridge.config["capture_enabled"] = True
            self.bridge.hook(self.host_event("SessionStart"))
            self.assertEqual(called, ["SessionStart"])
            self.assertEqual(self.bridge.state(self.session)["scope"], "operator")

    def test_exact_unicode_catchup_replay_and_no_tool_or_thinking(self):
        self.enable_fixture_capture()
        user = "  🧪 Ελληνικά 中文\n\n\tOriginal user  "
        assistant = "  ✨ Exact assistant\t "
        source = b"".join((
            record("user", user, self.session, uuid="u-1"),
            record("assistant", [
                {"type": "thinking", "thinking": "PRIVATE_CHAIN_OF_THOUGHT"},
                {"type": "text", "text": assistant},
                {"type": "tool_use", "name": "Read", "input": {"secret": "RAW_TOOL"}},
                {"type": "redacted_thinking", "data": "HIDDEN"},
            ], self.session, uuid="a-1"),
            record("user", [{"type": "tool_result", "content": "RAW_TOOL"}], self.session),
            record("assistant", "HIDDEN_SIDECHAIN", self.session, isSidechain=True),
        ))
        self.path.write_bytes(source)
        self.attest_synthetic_history()
        first = capture_hook(self.bridge, self.host_event())
        self.assertEqual(first["status"], "saved", first)
        self.assertEqual(first["saved"], 2)
        replayed = capture_hook(self.bridge, self.host_event())
        self.assertEqual(replayed["status"], "saved")
        self.assertEqual(replayed["replayed"], 2)
        self.assertEqual(replayed["saved"], 0)
        archive = list((self.root / "archives/private-chat-history/v1/operator").glob("*.jsonl"))
        self.assertEqual(len(archive), 1)
        rows = [json.loads(line) for line in archive[0].read_text(encoding="utf-8").splitlines()]
        self.assertEqual([r["text"] for r in rows[1:]], [user, assistant])
        self.assertEqual([r["sequence"] for r in rows[1:]], [1, 2])
        self.assertNotIn("PRIVATE_CHAIN_OF_THOUGHT", archive[0].read_text(encoding="utf-8"))
        self.assertNotIn("RAW_TOOL", archive[0].read_text(encoding="utf-8"))
        self.assertTrue(all(r["source_event_id"] != r["text_sha256"] for r in rows[1:]))

    def test_batch_capture_scans_once_per_callback_and_commits_only_suffix(self):
        self.enable_fixture_capture()
        import claude_capture as capture_module
        original_load = capture_module._module

        def run_batch():
            calls = []

            def instrument(filename, name):
                module = original_load(filename, name)
                if filename != "chat_archive.py":
                    return module
                original_batch = module.ChatArchive.append_batch

                def count_batch(archive, events):
                    with (mock.patch.object(module, "_scan", wraps=module._scan) as scan,
                          mock.patch.object(module, "_write_all", wraps=module._write_all) as write):
                        receipt = original_batch(archive, events)
                    calls.append((len(events), scan.call_count, write.call_count))
                    return receipt

                module.ChatArchive.append_batch = count_batch
                module.ChatArchive.append = lambda *args, **kwargs: self.fail(
                    "capture must never replay through the quadratic append API"
                )
                return module

            with mock.patch("claude_capture._module", side_effect=instrument):
                result = capture_hook(self.bridge, self.host_event())
            self.assertEqual(len(calls), 1)
            return result, calls[0]

        rows = [
            record("user" if n % 2 else "assistant",
                   f"Batch message {n} ✨ 中文", self.session, uuid=f"event-{n}")
            for n in range(1, 61)
        ]
        self.path.write_bytes(b"".join(rows[:40]))
        self.attest_synthetic_history()
        first, first_calls = run_batch()
        self.assertEqual((first["saved"], first["replayed"]), (40, 0))
        self.assertEqual(first_calls, (40, 0, 1))
        self.path.write_bytes(b"".join(rows))
        self.attest_synthetic_history()
        second, second_calls = run_batch()
        self.assertEqual((second["saved"], second["replayed"]), (20, 40))
        self.assertEqual(second_calls, (60, 1, 1))
        replay, replay_calls = run_batch()
        self.assertEqual((replay["saved"], replay["replayed"]), (0, 60))
        self.assertEqual(replay_calls, (60, 1, 0))

    def test_resume_after_incomplete_record_without_committing_it(self):
        self.enable_fixture_capture()
        first = record("user", "First", self.session)
        second = record("assistant", "Delayed", self.session)
        self.path.write_bytes(first + second[:-1])
        self.attest_synthetic_history()
        pending = capture_hook(self.bridge, self.host_event())
        self.assertEqual(pending["status"], "pending", pending)
        self.assertEqual(pending["saved"], 1)
        self.path.write_bytes(first + second)
        self.attest_synthetic_history()
        done = capture_hook(self.bridge, self.host_event("SessionStart"))
        self.assertEqual(done["status"], "saved", done)
        self.assertEqual(done["replayed"], 1)
        self.assertEqual(done["saved"], 1)

    def test_changed_source_same_immutable_position_refused(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("user", "First", self.session))
        self.attest_synthetic_history()
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "saved")
        self.path.write_bytes(record("user", "Changed", self.session))
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        archive = list((self.root / "archives/private-chat-history/v1/operator").glob("*.jsonl"))[0]
        self.assertIn("First", archive.read_text())
        self.assertNotIn("Changed", archive.read_text())

    def test_later_source_truncation_cannot_report_success_or_erase_archive(self):
        self.enable_fixture_capture()
        first = record("user", "First", self.session)
        second = record("assistant", "Second", self.session)
        self.path.write_bytes(first + second)
        self.attest_synthetic_history()
        self.assertEqual(capture_hook(self.bridge, self.host_event())["saved"], 2)
        self.path.write_bytes(first)
        result = capture_hook(self.bridge, self.host_event())
        self.assertEqual(result["status"], "blocked")
        archive = list((self.root / "archives/private-chat-history/v1/operator").glob("*.jsonl"))[0]
        rows = [json.loads(line) for line in archive.read_text().splitlines()]
        self.assertEqual([row["text"] for row in rows[1:]], ["First", "Second"])

    def test_missing_path_and_wrong_session_name_are_blocked(self):
        self.enable_fixture_capture()
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        self.path.write_bytes(record("user", "Good", self.session))
        other = dict(self.host_event())
        other["transcript_path"] = str(Path(self.provider.name) / "another-session.jsonl")
        self.assertEqual(capture_hook(self.bridge, other)["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_private_session_optout_and_credential_are_blocked(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("user", "Visible", self.session))
        self.assertEqual(capture_hook(self.bridge, self.host_event(capture_opt_out=True))["status"], "blocked")
        self.path.write_bytes(record("user", "api_key=sample-secret", self.session))
        self.attest_synthetic_history()
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_wrong_physical_workspace_rejected_and_revocation(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("user", "Visible", self.session))
        other = self.host_event(cwd=self.root / "workspaces/alpha")
        self.assertEqual(capture_hook(self.bridge, other)["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_cancelled_turn_rejected(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("user", "Visible", self.session))
        turn = self.bridge.state(self.session)["turn"]
        self.bridge.save({**self.bridge.state(self.session), "turn": {**turn, "state": "interrupted"}})
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")

    def test_retroactive_state_ledger_cannot_bypass_unreviewed_issuer_gate(self):
        # Even a syntactically valid OS state ledger MUST NOT unlock capture
        # while the independent OS at-record issuer admission is still off.
        self.bridge.config["capture_enabled"] = True
        self.bridge.config["capture_coverage_verified"] = True
        self.path.write_bytes(record("user", "Older conversation", self.session))
        self.attest_synthetic_history()
        with mock.patch("claude_capture._HOST_COVERAGE_ADMITTED", True):
            with mock.patch("claude_capture._module") as loader:
                result = capture_hook(self.bridge, self.host_event())
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(loader.call_count, 0)
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_resumed_history_without_at_record_proofs_zero_writes(self):
        self.enable_fixture_capture()
        self.path.write_bytes(
            record("user", "Older unknown-scope conversation", self.session,
                   uuid="old-session-turn")
            + record("assistant", "Present operator turn", self.session,
                     uuid="current-session-turn")
        )
        # Today's valid operator scope, valid session and supplied source
        # path do not authorize older history. There is no source provenance.
        with mock.patch("claude_capture._module") as load:
            result = capture_hook(self.bridge, self.host_event())
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(load.call_count, 0)
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_resumed_mixed_workspace_history_refused_before_any_archive_write(self):
        self.enable_fixture_capture()
        state = self.bridge.state(self.session)
        state["scope"] = "workspace:alpha"
        state["turn"]["scope"] = "workspace:alpha"
        state["turn"]["allowed"] = ["workspace:alpha"]
        self.bridge.save(state)
        current_cwd = self.root / "workspaces/alpha"
        event = self.host_event(cwd=current_cwd)
        # Check the CURRENT host authorization independently, then prove
        # it is insufficient for an old event bound to another workspace.
        from claude_capture import _host_authorized_scope
        self.assertEqual(_host_authorized_scope(self.bridge, event, self.session),
                         "workspace:alpha")
        self.path.write_bytes(
            record("user", "Older beta private message", self.session,
                   uuid="old-beta")
            + record("assistant", "Current alpha message", self.session,
                     uuid="current-alpha")
        )
        # A separately issued fixture ledger represents at-time OS scope
        # evidence. This mixed snapshot must be rejected IN FULL rather than
        # archiving the first or last visible record in today's workspace.
        self.attest_synthetic_history(
            scopes=["workspace:beta", "workspace:alpha"]
        )
        with mock.patch("claude_capture._module") as load:
            result = capture_hook(self.bridge, event)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(load.call_count, 0, "no parser or writer may load before history preflight")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_ledger_missing_one_completed_record_fails_before_writing(self):
        self.enable_fixture_capture()
        self.path.write_bytes(
            record("user", "First", self.session, uuid="one")
            + record("assistant", "Second", self.session, uuid="two")
        )
        self.attest_synthetic_history()
        state = self.bridge.state(self.session)
        state["capture_scope_provenance"]["records"].pop()
        self.bridge.save(state)
        with mock.patch("claude_capture._module") as load:
            result = capture_hook(self.bridge, self.host_event())
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(load.call_count, 0)
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_mixed_workspace_destinations_are_not_archived_wholesale(self):
        self.enable_fixture_capture()
        state = self.bridge.state(self.session)
        state["turn"]["allowed"] = ["operator", "workspace:alpha"]
        self.bridge.save(state)
        self.path.write_bytes(record("user", "Alpha and operator mixed", self.session))
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_symlink_intermediate_in_host_cwd_is_denied(self):
        self.enable_fixture_capture()
        state = self.bridge.state(self.session)
        state["scope"] = "workspace:alpha"
        state["turn"]["scope"] = "workspace:alpha"
        state["turn"]["allowed"] = ["workspace:alpha"]
        self.bridge.save(state)
        alias = self.root / "workspaces" / "linked-alpha"
        try:
            alias.symlink_to(self.root / "workspaces" / "alpha", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        nested_cwd = alias / "context"
        self.path.write_bytes(record("user", "Only alpha", self.session))
        self.assertEqual(
            capture_hook(self.bridge, self.host_event(cwd=nested_cwd))["status"], "blocked"
        )
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_real_os_action_permission_failure_blocks_capture(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("user", "Visible", self.session))
        policy = self.root / "automations/policies/action-permissions.yaml"
        policy.parent.mkdir(parents=True, exist_ok=True)
        policy.write_text("schema_version: invalid\napproval:\n  external_actions: allow\n")
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_external_cancel_marker_refuses_delayed_capture(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("assistant", "Late write", self.session))
        turn = self.bridge.state(self.session)["turn"]
        marker = self.bridge.session_path(self.session).with_suffix(".cancel")
        marker.write_text(json.dumps({
            "session_id": self.session, "original_turn_id": turn["id"]
        }))
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_recovery_after_new_bridge_instance(self):
        self.enable_fixture_capture()
        self.path.write_bytes(record("user", "Original", self.session))
        self.attest_synthetic_history()
        self.assertEqual(capture_hook(self.bridge, self.host_event())["saved"], 1)
        # A new process uses the existing OS state. Source offsets and IDs
        # cannot reset just because the capture object was reconstructed.
        restored = Bridge(self.root, harness="claude")
        restored.config["capture_enabled"] = True
        restored.config["capture_coverage_verified"] = True
        self.assertEqual(capture_hook(restored, self.host_event())["replayed"], 1)

    def test_source_symlink_ancestor_and_file_refused(self):
        self.path.write_bytes(record("user", "Fixture", self.session))
        alias = Path(self.provider.name) / "alias.jsonl"
        try:
            alias.symlink_to(self.path)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unavailable")
        with self.assertRaises(CaptureBlocked):
            _supplied_source(str(alias), "alias")
        parent = Path(self.provider.name)
        sibling = parent.with_name(parent.name + "-alias")
        try:
            sibling.symlink_to(parent, target_is_directory=True)
            with self.assertRaises(CaptureBlocked):
                _supplied_source(str(sibling / self.path.name), self.session)
        finally:
            if sibling.is_symlink():
                sibling.unlink()

    def test_source_file_replacement_during_fd_open_refused(self):
        self.path.write_bytes(record("user", "First", self.session))
        real_open = os.open
        prepared = self.path.with_name("prepared-replacement.jsonl")
        prepared.write_bytes(record("user", "Replaced", self.session))
        replaced = []

        def swapped(path, flags, *args, **kwargs):
            if str(path) == self.path.name and kwargs.get("dir_fd") is not None and not replaced:
                # os.replace from an already-created inode is deterministic;
                # unlink-then-create can immediately recycle the old inode.
                os.replace(prepared, self.path)
                replaced.append(True)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch("claude_capture.os.open", side_effect=swapped):
            with self.assertRaises(CaptureBlocked):
                _supplied_source(str(self.path), self.session)
        self.assertEqual(replaced, [True])

    def test_flags_alone_cannot_admit_unverified_live_capture(self):
        self.bridge.config["capture_enabled"] = True
        self.bridge.config["capture_coverage_verified"] = True
        self.path.write_bytes(record("user", "Must remain disabled", self.session))
        self.assertEqual(capture_hook(self.bridge, self.host_event())["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())

    def test_inplace_source_rewrite_during_open_refused(self):
        self.path.write_bytes(record("user", "Before", self.session))
        old = self.path.stat()
        real_open = os.open
        injected = []

        def rewritten(path, flags, *args, **kwargs):
            if str(path) == self.path.name and kwargs.get("dir_fd") is not None and not injected:
                # Preserve inode and length while changing text/mtime before
                # its descriptor opens. The metadata snapshot must catch it.
                with self.path.open("r+b") as stream:
                    stream.write(record("user", "After!", self.session))
                    stream.flush()
                os.utime(self.path, ns=(old.st_atime_ns, old.st_mtime_ns + 2_000_000_000))
                injected.append(True)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch("claude_capture.os.open", side_effect=rewritten):
            with self.assertRaises(CaptureBlocked):
                _supplied_source(str(self.path), self.session)
        self.assertEqual(injected, [True])

    def test_source_parent_directory_replacement_during_open_refused(self):
        self.path.write_bytes(record("user", "Before", self.session))
        real_open = os.open
        parent = self.path.parent
        old = parent.with_name(parent.name + "-old")
        replaced = []

        def swapped(path, flags, *args, **kwargs):
            if str(path) == self.path.name and kwargs.get("dir_fd") is not None and not replaced:
                parent.rename(old)
                parent.mkdir()
                (parent / self.path.name).write_bytes(record("user", "Other", self.session))
                replaced.append(True)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch("claude_capture.os.open", side_effect=swapped):
            with self.assertRaises(CaptureBlocked):
                _supplied_source(str(self.path), self.session)
        self.assertEqual(replaced, [True])

    def test_missing_source_path_does_not_discover_history(self):
        self.enable_fixture_capture()
        one = Path(self.provider.name) / "unrelated.jsonl"
        one.write_bytes(record("user", "Do not scan this", self.session))
        result = capture_hook(self.bridge, self.host_event())
        self.assertEqual(result["status"], "blocked")
        self.assertFalse((self.root / "archives/private-chat-history").exists())


if __name__ == "__main__":
    unittest.main()
