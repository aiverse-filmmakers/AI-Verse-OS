"""Disposable child-process tests for the inactive Codex App Server design.

These tests start ONLY an isolated Python fixture in a private temp folder.
No real Codex binary, user home, network, credential, app-server process,
existing transcript, OS installation, or canonical archive is accessed.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, PACKAGE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


transport = load("_aiverse_3a4_synthetic_transport", "codex_app_server_transport.py")
candidate = load("_aiverse_3a4_source_candidate", "codex_app_server_candidate.py")

FIXTURE_CODE = r"""
import json
import os
import sys
import time

MODE = "MODE_TOKEN"

def output(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)

line = sys.stdin.readline()
try:
    initial = json.loads(line)
except (ValueError, TypeError):
    sys.exit(2)

if MODE == "junk_handshake":
    sys.stdout.write("JUNK BEFORE INITIALIZE\n")
    sys.stdout.flush()
if MODE == "hung_handshake":
    time.sleep(10)
    sys.exit(0)
if MODE == "bad_handshake_id":
    output({"id": 9, "result": {}})
    sys.exit(0)
if MODE == "handshake_error":
    output({"id": 1, "error": {"code": -32600}})
    sys.exit(0)
if MODE != "junk_handshake":
    output({"id": initial.get("id"), "result": {
        "serverInfo": {"name": "synthetic_not_codex"}}})
else:
    sys.exit(0)

second = sys.stdin.readline()
if not second or json.loads(second).get("method") != "initialized":
    sys.exit(3)

if MODE == "huge_stderr":
    sys.stderr.write("H" * 200000)
    sys.stderr.flush()
if MODE == "long_running":
    time.sleep(10)
    sys.exit(0)
if MODE == "partial":
    sys.stdout.write('{"method":')
    sys.stdout.flush()
    time.sleep(10)
    sys.exit(0)
if MODE == "oversized":
    sys.stdout.write("{" + " " * 67000 + "}\n")
    sys.stdout.flush()
    time.sleep(10)
    sys.exit(0)
if MODE == "invalid_json":
    sys.stdout.write("{not json}\n")
    sys.stdout.flush()
    sys.exit(0)
if MODE == "duplicate_keys":
    sys.stdout.write('{"method":"turn/started","method":"thread/started","params":{}}\n')
    sys.stdout.flush()
    sys.exit(0)
if MODE == "unexpected_request":
    output({"id": 40, "method": "dangerous/tool", "params": {}})
    sys.exit(0)
if MODE == "nonfinite":
    sys.stdout.write('{"method":"turn/started","params":{"bad":NaN}}\n')
    sys.stdout.flush()
    sys.exit(0)
if MODE == "env":
    output({"method": "synthetic/env", "params": {
        "secret_present": "AI_VERSE_TEST_SECRET_TO_EXCLUDE" in os.environ,
        "inherited_home": "HOME" in os.environ,
        "inherited_pythonpath": "PYTHONPATH" in os.environ,
        "has_python_io": os.environ.get("PYTHONIOENCODING") == "utf-8",
    }})
    sys.exit(0)

output({"method": "turn/started", "params": {
    "threadId": "fixture-thread-1",
    "turn": {"id": "fixture-turn-1", "status": "inProgress", "items": []},
}})
output({"method": "item/completed", "params": {
    "threadId": "fixture-thread-1", "turnId": "fixture-turn-1",
    "item": {"id": "user-1", "type": "userMessage",
             "content": [{"type": "text", "text": " hello 🧪 中文  "}]},
}})
output({"method": "item/completed", "params": {
    "threadId": "fixture-thread-1", "turnId": "fixture-turn-1",
    "item": {"id": "answer-1", "type": "agentMessage",
             "phase": "final_answer", "text": "  finished 🚀\n"},
}})
output({"method": "turn/completed", "params": {
    "threadId": "fixture-thread-1",
    "turn": {"id": "fixture-turn-1", "status": "completed"},
}})
"""


class OwnedStdioSyntheticTests(unittest.TestCase):
    def setUp(self):
        if os.name != "posix":
            self.skipTest("3A.4 isolated POSIX fixture only")
        self.temp = tempfile.TemporaryDirectory(prefix="aiverse-synthetic-3a4-")
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name).resolve(strict=True)
        self.script = self.cwd / "fixture_app_server.py"
        self.python = Path(sys.executable).resolve(strict=True)
        self.assertFalse(self.cwd.stat().st_mode & 0o077)

    def digest(self, path):
        sha = hashlib.sha256()
        with path.open("rb") as file:
            for piece in iter(lambda: file.read(65536), b""):
                sha.update(piece)
        return sha.hexdigest()

    def plan(self, mode="healthy"):
        code = FIXTURE_CODE.replace("MODE_TOKEN", mode)
        self.script.write_text(code, encoding="utf-8")
        self.script.chmod(0o600)
        return transport.SyntheticChildSpec(
            executable=self.python,
            executable_sha256=self.digest(self.python),
            fixture_script=self.script,
            fixture_sha256=self.digest(self.script),
            private_cwd=self.cwd,
        )

    def test_real_owned_fixture_child_and_v2_candidate_do_not_grant_archives(self):
        spec = self.plan()
        with transport.launch_synthetic_fixture(spec) as owned:
            self.assertGreater(owned.pid, 0)
            self.assertEqual(owned.identity,
                             "synthetic_owned_child_not_authenticated_codex")
            self.assertIsNone(owned._process.poll())
            state = None
            for _ in range(4):
                event = owned.next_notification()
                state, report, status = candidate.observe(state, event)
            self.assertEqual(status, "untrusted_candidate")
            self.assertEqual(state.phase, "closed")
            self.assertEqual(state.user_text, " hello 🧪 中文  ")
            self.assertEqual(state.assistant_text, "  finished 🚀\n")
            self.assertFalse(report.authentic_host_origin)
            self.assertFalse(report.authenticated_scope)
            self.assertFalse(report.consent_verified)
            self.assertFalse(report.writer_admitted)
            self.assertEqual(candidate.archive_admission(report)["status"], "blocked")
            process = owned._process
        self.assertIsNotNone(process.poll())
        self.assertFalse((self.cwd / "archives").exists())

    def test_child_pipe_is_closed_and_reaped_even_if_it_waits(self):
        with transport.launch_synthetic_fixture(self.plan("long_running")) as owned:
            self.assertIsNone(owned._process.poll())
            process = owned._process
        self.assertIsNotNone(process.poll())
        owned.close()
        with self.assertRaises(transport.TransportBlocked):
            owned.next_notification(0.1)

    def test_no_user_secrets_home_or_pythonpath_inherited(self):
        with mock.patch.dict(os.environ, {
            "AI_VERSE_TEST_SECRET_TO_EXCLUDE": "PRIVATE_SENTINEL",
            "HOME": "/private/not-to-pass",
            "PYTHONPATH": "/private/not-to-pass",
        }):
            with transport.launch_synthetic_fixture(self.plan("env")) as owned:
                packet = owned.next_notification()
        self.assertEqual(packet["method"], "synthetic/env")
        self.assertFalse(packet["params"]["secret_present"])
        self.assertFalse(packet["params"]["inherited_home"])
        self.assertFalse(packet["params"]["inherited_pythonpath"])
        self.assertTrue(packet["params"]["has_python_io"])

    def test_executable_digest_is_pinned_and_forged_executable_denied(self):
        spec = self.plan()
        with self.assertRaises(transport.TransportBlocked):
            transport.launch_synthetic_fixture(
                transport.SyntheticChildSpec(
                    executable=spec.executable,
                    executable_sha256="0" * 64,
                    fixture_script=spec.fixture_script,
                    fixture_sha256=spec.fixture_sha256,
                    private_cwd=spec.private_cwd,
                )
            )
        forged = self.cwd / "fake-python"
        forged.write_bytes(b"#! /bin/sh\n")
        forged.chmod(0o700)
        with self.assertRaises(transport.TransportBlocked):
            transport.launch_synthetic_fixture(
                transport.SyntheticChildSpec(
                    executable=forged, executable_sha256=self.digest(forged),
                    fixture_script=spec.fixture_script,
                    fixture_sha256=spec.fixture_sha256,
                    private_cwd=spec.private_cwd,
                )
            )

    def test_fixture_digest_is_pinned_and_mismatch_denied(self):
        spec = self.plan()
        self.script.write_text("malicious replaced fixture\n", encoding="utf-8")
        with self.assertRaises(transport.TransportBlocked):
            transport.launch_synthetic_fixture(spec)
        self.assertFalse((self.cwd / "archives").exists())

    def test_symlinked_or_writable_fixture_is_denied(self):
        spec = self.plan()
        self.script.chmod(0o666)
        with self.assertRaises(transport.TransportBlocked):
            transport.launch_synthetic_fixture(spec)
        self.script.chmod(0o600)
        self.script.unlink()
        link = self.cwd / "real.py"
        link.write_text("print('unexpected')\n")
        self.script.symlink_to(link)
        with self.assertRaises(transport.TransportBlocked):
            transport.launch_synthetic_fixture(spec)

    def test_nonprivate_cwd_is_denied(self):
        spec = self.plan()
        self.cwd.chmod(0o755)
        self.addCleanup(lambda: self.cwd.chmod(0o700))
        with self.assertRaises(transport.TransportBlocked):
            transport.launch_synthetic_fixture(spec)

    def test_invalid_handshake_and_extra_stdout_are_fail_closed(self):
        for mode in ("bad_handshake_id", "handshake_error", "junk_handshake"):
            with self.subTest(mode=mode), self.assertRaises(transport.TransportBlocked):
                transport.launch_synthetic_fixture(self.plan(mode))

    def test_partial_stdout_never_hangs_indefinitely(self):
        with transport.launch_synthetic_fixture(self.plan("partial")) as owned:
            with self.assertRaises(transport.TransportBlocked) as caught:
                owned.next_notification(timeout=0.1)
            self.assertIn("timed out", str(caught.exception))

    def test_oversized_duplicate_invalid_and_nan_frames_are_rejected(self):
        for mode in ("oversized", "invalid_json", "duplicate_keys", "nonfinite"):
            with self.subTest(mode=mode):
                with transport.launch_synthetic_fixture(self.plan(mode)) as owned:
                    with self.assertRaises(transport.TransportBlocked):
                        owned.next_notification(timeout=1)

    def test_child_server_request_never_invokes_user_action(self):
        with transport.launch_synthetic_fixture(self.plan("unexpected_request")) as owned:
            with self.assertRaisesRegex(
                transport.TransportBlocked, "unexpected synthetic RPC frame"
            ):
                owned.next_notification()

    def test_received_frame_budget_enforced(self):
        with transport.launch_synthetic_fixture(self.plan()) as owned:
            with mock.patch.object(transport, "MAX_RECEIVED_FRAMES", 2):
                first = owned.next_notification()
                self.assertEqual(first["method"], "turn/started")
                with self.assertRaises(transport.TransportBlocked):
                    owned.next_notification()

    def test_stderr_flood_is_discarded_not_logged_or_blocking(self):
        with transport.launch_synthetic_fixture(self.plan("huge_stderr")) as owned:
            first = owned.next_notification()
            self.assertEqual(first["method"], "turn/started")

    def test_production_gate_refuses_even_if_test_patched_true(self):
        self.assertEqual(
            transport.connect_codex_app_server(),
            {"status": "blocked", "reason": "Codex transport unadmitted"},
        )
        with (mock.patch.object(transport, "_PRODUCTION_APP_SERVER_ADMITTED", True),
              mock.patch.object(transport, "_APP_SERVER_HOST_SCOPE_ISSUER_ADMITTED", True)):
            self.assertEqual(
                transport.connect_codex_app_server({"path": "codex"}),
                {"status": "blocked",
                 "reason": "host provenance issuer not implemented"},
            )
        self.assertFalse(transport._PRODUCTION_APP_SERVER_ADMITTED)
        self.assertFalse(transport._APP_SERVER_HOST_SCOPE_ISSUER_ADMITTED)


if __name__ == "__main__":
    unittest.main()
