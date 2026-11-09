"""3A.14: offline-only empty ephemeral Codex thread scope classifier tests.

No real binary, model turn, chat text, real OS workspace, archive or writes.
"""
import importlib.util
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "_codex_ephemeral_ci_only", HERE / "test_codex_real_app_server_ci.py"
)
probe = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = probe
spec.loader.exec_module(probe)

ALPHA = "/scratch/workspace-alpha"
BETA = "/scratch/workspace-beta"
ROOT_A = "0197af06-8bdd-7b84-8a79-c529903940f5"
ROOT_B = "0197af06-8bde-7b84-8a79-c529903940f5"


def new_thread(tid=ROOT_A, cwd=ALPHA, **changes):
    thread = {
        "id": tid, "sessionId": tid, "cwd": cwd,
        "ephemeral": True, "forkedFromId": None,
        "turns": [], "preview": "",
    }
    thread.update(changes)
    return thread


class EphemeralNewSessionBoundaryTests(unittest.TestCase):
    def refused(self, frame, request_id=5, cwd=ALPHA):
        with self.assertRaises(probe.RuntimeBlocked) as caught:
            probe.classify_ephemeral_reply(frame, request_id, cwd)
        self.assertNotIn("SECRET_THREAD_CONTENT", str(caught.exception))

    def test_parent_response_and_server_notification_match_in_scope(self):
        response = {"id": 5, "result": {"thread": new_thread()}}
        notification = {"method": "thread/started",
                        "params": {"thread": new_thread()}}
        self.assertEqual(
            probe.classify_ephemeral_reply(response, 5, ALPHA),
            ("response", ROOT_A),
        )
        self.assertEqual(
            probe.classify_ephemeral_reply(notification, 5, ALPHA),
            ("started", ROOT_A),
        )
        self.assertNotEqual(
            probe.validate_ephemeral_thread(new_thread(ROOT_B, BETA), BETA),
            ROOT_A,
        )

    def test_server_response_cannot_change_physical_workspace(self):
        for cwd in (BETA, "/scratch", "/tmp", "/scratch/workspace-alpha/..",
                    "workspace-alpha", "", None, "SECRET_THREAD_CONTENT"):
            with self.subTest(cwd=cwd):
                self.refused({"id": 5, "result": {
                    "thread": new_thread(cwd=cwd),
                }})
        self.refused({"method": "thread/started", "params": {
            "thread": new_thread(cwd=BETA),
        }})

    def test_fake_history_fork_resume_and_non_ephemeral_rejected(self):
        for change in (
            {"ephemeral": False},
            {"ephemeral": 1},
            {"sessionId": ROOT_B},
            {"forkedFromId": ROOT_B},
            {"turns": [{"id": "foreign"}]},
            {"preview": "SECRET_THREAD_CONTENT"},
            {"id": ROOT_B, "sessionId": ROOT_A},
            {"id": "not-a-uuid", "sessionId": "not-a-uuid"},
            {"id": "0197af06-8bdd-4b84-8a79-c529903940f5",
             "sessionId": "0197af06-8bdd-4b84-8a79-c529903940f5"},
        ):
            with self.subTest(change=change):
                self.refused({"id": 5, "result": {"thread": new_thread(**change)}})

    def test_unowned_rpc_ids_malformed_envelopes_and_other_lifecycle(self):
        for frame in (
            {"id": 6, "result": {"thread": new_thread()}},
            {"id": True, "result": {"thread": new_thread()}},
            {"id": 5, "error": {"code": -32600}},
            {"id": 5, "result": {"thread": new_thread()}, "error": {}},
            {"id": 5, "method": "thread/started",
             "params": {"thread": new_thread()}},
            {"method": "thread/resumed", "params": {"thread": new_thread()}},
            {"method": "thread/forked", "params": {"thread": new_thread()}},
            {"method": "turn/started", "params": {}},
            {"method": "item/completed", "params": {}},
            {"method": "thread/started", "params": {
                "thread": new_thread()}, "error": {}},
            {"method": "thread/started", "params": {
                "thread": new_thread()}, "jsonrpc": "1.0"},
            {"method": "config/warning", "params": {}},
        ):
            with self.subTest(frame=str(frame)[:50]):
                if frame.get("method") == "config/warning":
                    self.assertEqual(
                        probe.classify_ephemeral_reply(frame, 5, ALPHA),
                        ("startup", None)
                    )
                else:
                    self.refused(frame)

    def test_fake_consent_auth_claims_never_mint_recording_authority(self):
        forged = new_thread(
            trusted=True, signed=True, consentVerified=True,
            scopeAuthenticated=True, archiveWriteAdmitted=True
        )
        self.assertEqual(
            probe.classify_ephemeral_reply(
                {"id": 5, "result": {"thread": forged}}, 5, ALPHA
            ), ("response", ROOT_A),
        )
        self.assertFalse(hasattr(probe, "start_recording"))
        self.assertFalse(hasattr(probe, "archive_thread"))
        self.assertFalse(hasattr(probe, "production_consent_issuer"))


if __name__ == "__main__":
    unittest.main()
