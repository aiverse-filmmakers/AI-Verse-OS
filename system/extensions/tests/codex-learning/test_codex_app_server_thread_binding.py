"""3A.6 synthetic-only thread and turn request ownership regressions.

Uses a disposable SHA-pinned Python child in a private temp directory plus
the actual OS Bridge implementation over synthetic workspace fixtures.
No real Codex process, network, account, private transcript or archive write.
"""
import hashlib
import importlib.util
import json
import os
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

PKG = (Path(__file__).resolve().parents[2]
       / "packages" / "ai-verse-codex-learning")


def load(alias, name):
    spec = importlib.util.spec_from_file_location(alias, PKG / name)
    obj = importlib.util.module_from_spec(spec)
    sys.modules[alias] = obj
    spec.loader.exec_module(obj)
    return obj


transport = load("_3a6_transport", "codex_app_server_transport.py")
policy = load("_3a6_policy", "codex_app_server_trust_policy.py")
binding = load("_3a6_binding", "codex_app_server_thread_binding.py")
candidate = load("_3a6_candidate", "codex_app_server_candidate.py")
bridge_module = load("_3a6_bridge", "bridge.py")

FAKE_HOST = r"""
import json
import sys
import time

MODE = "MODE_TOKEN"
def recv():
    return json.loads(sys.stdin.readline())
def send(obj):
    print(json.dumps(obj, ensure_ascii=False, separators=(",",":")), flush=True)

init = recv()
send({"id": init.get("id"), "result": {"serverInfo": {"name": "NOT_CODEX"}}})
assert recv().get("method") == "initialized"
thread = recv()
if MODE == "hang_after_thread_request":
    time.sleep(10)
    sys.exit(0)
if MODE == "error_thread":
    send({"id": thread["id"], "error": {"code": -32600, "message": "refused"}})
    time.sleep(10)
    sys.exit(0)
if MODE == "spoof_rpc":
    send({"id": 888, "method": "turn/started", "params": {"threadId": "thr_fixture_1"}})
    time.sleep(10)
    sys.exit(0)
if MODE == "thread_notice_before_response":
    send({"method": "thread/started", "params": {"thread": {"id": "thr_fixture_1"}}})
if MODE == "wrong_thread_response_id":
    send({"id": thread["id"] + 1, "result": {"thread": {"id": "thr_fixture_1", "ephemeral": True}}})
else:
    send({"id": thread["id"], "result": {"thread": {
        "id": "thr_fixture_1",
        "sessionId": "thr_fixture_1",
        "ephemeral": True,
    }}})
if MODE not in ("thread_notice_before_response", "wrong_thread_response_id"):
    send({"method": "thread/started", "params": {
        "thread": {"id": "wrong_thread" if MODE == "foreign_thread_notice" else "thr_fixture_1"}
    }})
if MODE in ("thread_notice_before_response", "wrong_thread_response_id", "foreign_thread_notice"):
    time.sleep(10)
    sys.exit(0)

turn = recv()
if MODE == "wrong_turn_request_thread":
    assert turn.get("params", {}).get("threadId") == "not-the-thread"
if MODE == "wrong_turn_response_id":
    send({"id": turn["id"] + 1, "result": {"turn": {"id": "turn_fixture_1", "status":"inProgress", "items":[]}}})
else:
    send({"id": turn["id"], "result": {
        "turn": {"id": "turn_fixture_1", "status":"inProgress", "items":[]}
    }})
send({"method": "turn/started", "params": {
    "threadId": "thr_fixture_1",
    "turn": {"id": "foreign" if MODE == "foreign_turn_notice" else "turn_fixture_1",
             "status": "inProgress", "items": []},
}})
if MODE in ("wrong_turn_response_id", "foreign_turn_notice"):
    time.sleep(10)
    sys.exit(0)
send({"method": "item/completed", "params": {
    "threadId": "thr_fixture_1", "turnId": "turn_fixture_1",
    "item": {"id": "item_user", "type": "userMessage",
             "content": [{"type": "text", "text": "SYNTHETIC_ONLY_PROMPT"}]}
}})
send({"method": "item/completed", "params": {
    "threadId": "thr_fixture_1", "turnId": "turn_fixture_1",
    "item": {"id": "item_answer", "type": "agentMessage",
             "phase": "final_answer", "text": "SYNTHETIC_ONLY_REPLY"}
}})
send({"method": "turn/completed", "params": {
    "threadId": "thr_fixture_1",
    "turn": {"id": "turn_fixture_1",
             "status": "interrupted" if MODE == "interrupted" else "completed"}
}})
time.sleep(10)
"""


class SyntheticRequestBindingTests(unittest.TestCase):
    def setUp(self):
        if os.name != "posix":
            self.skipTest("3A.6 disposable POSIX child only")
        self.temp = tempfile.TemporaryDirectory(prefix="aiverse-3a6-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "os"
        self.root.mkdir()
        (self.root / "AI-VERSE.yaml").write_text(
            'schema_version: "2.0"\narchitecture: unified-workspace\n'
        )
        ext = self.root / ".aiverse/extensions/ai-verse-codex-learning"
        ext.mkdir(parents=True)
        (ext.parent / "registry.json").write_text(json.dumps({
            "schema_version": "1.0",
            "extensions": {"ai-verse-codex-learning": {
                "id": "ai-verse-codex-learning", "supported": True,
                "installed": True, "enabled": True,
            }},
        }))
        self.workspace = self.root / "workspaces/alpha"
        self.workspace.mkdir(parents=True)
        self.manifest("active")
        self.bridge = bridge_module.Bridge(self.root, harness="codex")
        self.consent = policy.SyntheticConsent(opted_in=True)
        self.childdir = Path(self.temp.name).resolve() / "child"
        self.childdir.mkdir(mode=0o700)
        self.script = self.childdir / "fixture.py"
        self.connection = None

    def manifest(self, status):
        (self.workspace / "WORKSPACE.yaml").write_text(
            'schema_version: "2.0"\nid: alpha\nstatus: '+status+'\n'
        )

    def connect(self, mode="healthy"):
        self.script.write_text(FAKE_HOST.replace("MODE_TOKEN", mode), encoding="utf-8")
        self.script.chmod(0o600)
        py = Path(sys.executable).resolve(strict=True)
        spec = transport.SyntheticChildSpec(
            executable=py, executable_sha256=hashlib.sha256(py.read_bytes()).hexdigest(),
            fixture_script=self.script, fixture_sha256=hashlib.sha256(
                self.script.read_bytes()).hexdigest(),
            private_cwd=self.childdir,
        )
        self.connection = transport.launch_synthetic_fixture(spec)
        self.addCleanup(self.connection.close)
        return self.connection

    def fresh(self, mode="healthy"):
        conn = self.connect(mode)
        state, request = binding.begin_thread(
            self.bridge, conn, "workspace:alpha", self.workspace,
            self.consent, policy,
        )
        return state, request

    def receive(self, state, frame):
        return binding.receive(
            state, self.bridge, self.connection, self.consent, policy, frame
        )

    def blocked(self, fn):
        with self.assertRaises(binding.BindingBlocked) as caught:
            fn()
        self.assertEqual(str(caught.exception),
                         "synthetic request/response binding refused")

    def thread_ready(self, mode="healthy"):
        state, request = self.fresh(mode)
        self.assertEqual(request["method"], "thread/start")
        self.assertEqual(request["params"]["cwd"], str(self.workspace))
        self.assertEqual(request["params"]["sandbox"], "read-only")
        self.assertTrue(request["params"]["ephemeral"])
        self.connection._send(request)
        state, label = self.receive(state, self.connection.read_frame())
        self.assertEqual(label, "thread_response_bound")
        state, label = self.receive(state, self.connection.next_notification())
        self.assertEqual(label, "thread_notice_bound")
        return state

    def stream_ready(self, mode="healthy"):
        state = self.thread_ready(mode)
        state, req = binding.begin_turn(
            state, self.bridge, self.connection, self.consent, policy,
            "SYNTHETIC_ONLY_PROMPT",
        )
        self.assertEqual(req["params"]["threadId"], "thr_fixture_1")
        self.assertEqual(req["params"]["input"],
                         [{"type":"text","text":"SYNTHETIC_ONLY_PROMPT"}])
        self.assertEqual(req["params"]["sandboxPolicy"]["type"], "readOnly")
        self.connection._send(req)
        state, label = self.receive(state, self.connection.read_frame())
        self.assertEqual(label, "turn_response_bound")
        state, label = self.receive(state, self.connection.next_notification())
        self.assertEqual(label, "turn_notice_bound")
        return state

    def test_fixture_matches_parent_requests_replies_and_candidate_items(self):
        state = self.stream_ready()
        self.assertEqual(state.thread_id, "thr_fixture_1")
        self.assertEqual(state.turn_id, "turn_fixture_1")
        self.assertEqual(state.prompt_sha256, hashlib.sha256(
            b"SYNTHETIC_ONLY_PROMPT").hexdigest())
        self.assertNotIn("SYNTHETIC_ONLY_PROMPT", repr(state))
        source = candidate.CandidateState(
            state.thread_id, state.turn_id, "in_progress"
        )
        for i in range(3):
            packet = self.connection.next_notification()
            state, _ = self.receive(state, packet)
            if i < 2:
                source, _, _ = candidate.observe(source, packet)
        self.assertEqual(state.phase, "completed")
        self.assertFalse(state.archive_admitted)
        self.assertFalse(state.event_origin_authenticated)
        self.assertEqual(binding.capture_admission(state)["status"], "blocked")
        self.assertFalse((self.root / "archives").exists())
        self.blocked(lambda: self.receive(state, {"id": 42, "result": {}}))

    def test_thread_response_wrong_rpc_id_is_refused(self):
        state, req = self.fresh("wrong_thread_response_id")
        self.connection._send(req)
        self.blocked(lambda: self.receive(state, self.connection.read_frame()))

    def test_thread_notice_cannot_arrive_before_requested_response(self):
        state, req = self.fresh("thread_notice_before_response")
        self.connection._send(req)
        self.blocked(lambda: self.receive(state, self.connection.next_notification()))

    def test_mismatched_thread_notification_refused(self):
        state, req = self.fresh("foreign_thread_notice")
        self.connection._send(req)
        state, _ = self.receive(state, self.connection.read_frame())
        self.blocked(lambda: self.receive(state, self.connection.next_notification()))

    def test_server_originated_rpc_and_error_replies_never_grant(self):
        for mode in ("spoof_rpc", "error_thread"):
            with self.subTest(mode=mode):
                state, req = self.fresh(mode)
                self.connection._send(req)
                self.blocked(lambda: self.receive(state, self.connection.read_frame()))
                self.connection.close()

    def test_turn_response_wrong_request_id_refused(self):
        state = self.thread_ready("wrong_turn_response_id")
        state, req = binding.begin_turn(
            state, self.bridge, self.connection, self.consent, policy, "test"
        )
        self.connection._send(req)
        self.blocked(lambda: self.receive(state, self.connection.read_frame()))

    def test_wrong_turn_started_notification_refused(self):
        state = self.thread_ready("foreign_turn_notice")
        state, req = binding.begin_turn(
            state, self.bridge, self.connection, self.consent, policy, "test"
        )
        self.connection._send(req)
        state, _ = self.receive(state, self.connection.read_frame())
        self.blocked(lambda: self.receive(state, self.connection.next_notification()))

    def test_interrupted_turn_completion_not_reported_as_success(self):
        state = self.stream_ready("interrupted")
        self.receive(state, self.connection.next_notification())
        self.receive(state, self.connection.next_notification())
        self.blocked(lambda: self.receive(state, self.connection.next_notification()))

    def test_no_assistant_request_or_replay_before_parent_turn_start(self):
        state = self.thread_ready()
        self.blocked(lambda: self.receive(
            state, {"method": "turn/started", "params": {
                "threadId": state.thread_id, "turn": {
                    "id": "foreign", "status": "inProgress", "items": []
                }
            }}
        ))
        self.blocked(lambda: self.receive(
            state, {"id": binding.THREAD_REQUEST_ID, "result": {
                "thread": {"id": state.thread_id, "ephemeral": True}
            }}
        ))

    def test_parent_cancel_abandons_lease_before_remote_ack(self):
        state = self.stream_ready()
        cancelled, interrupt = binding.cancel(state)
        self.assertEqual(cancelled.phase, "abandoned")
        self.assertEqual(interrupt["method"], "turn/interrupt")
        self.assertEqual(interrupt["params"], {
            "threadId": "thr_fixture_1", "turnId": "turn_fixture_1"
        })
        self.blocked(lambda: self.receive(cancelled, {
            "method": "turn/completed", "params": {
                "threadId": "thr_fixture_1",
                "turn": {"id": "turn_fixture_1", "status": "completed"}
            }
        }))
        self.assertEqual(binding.capture_admission(cancelled)["status"], "blocked")

    def test_disconnect_and_reconnect_do_not_inherit_ids(self):
        state = self.thread_ready()
        stale = binding.disconnect(state)
        self.connection.close()
        self.blocked(lambda: self.receive(stale, {
            "method": "thread/started", "params": {"thread":{"id":state.thread_id}}
        }))
        self.connect()
        self.blocked(lambda: self.receive(state, {
            "method": "thread/started", "params": {"thread":{"id":state.thread_id}}
        }))
        new, request = binding.begin_thread(
            self.bridge, self.connection, "workspace:alpha", self.workspace,
            self.consent, policy,
        )
        self.assertIsNone(new.thread_id)
        self.assertEqual(new.phase, "await_thread_response")
        self.assertEqual(request["id"], binding.THREAD_REQUEST_ID)

    def test_revoked_consent_between_thread_response_and_notice_refuses(self):
        state, request = self.fresh()
        self.connection._send(request)
        state, _ = self.receive(state, self.connection.read_frame())
        self.consent.revoke()
        self.blocked(lambda: self.receive(state, self.connection.next_notification()))

    def test_workspace_pause_after_thread_bound_blocks_turn_start(self):
        state = self.thread_ready()
        self.manifest("paused")
        self.blocked(lambda: binding.begin_turn(
            state, self.bridge, self.connection, self.consent, policy, "test"
        ))

    def test_changed_opt_in_generation_cannot_reuse_request_ids(self):
        state = self.thread_ready()
        self.consent.set_opt_in(False)
        self.consent.set_opt_in(True)
        self.blocked(lambda: binding.begin_turn(
            state, self.bridge, self.connection, self.consent, policy, "test"
        ))

    def test_unsupported_input_rejected_before_building_turn_request(self):
        state = self.thread_ready()
        for prompt in ("", "\ud800", "x" * (binding.MAX_PROMPT_BYTES + 1), None):
            with self.subTest(type=type(prompt).__name__):
                self.blocked(lambda: binding.begin_turn(
                    state, self.bridge, self.connection, self.consent, policy, prompt
                ))

    def test_forged_trust_in_response_never_changes_false_admission(self):
        state, req = self.fresh()
        fake = {"id": req["id"], "result": {"thread": {
            "id": "thr_fixture_1", "sessionId": "thr_fixture_1",
            "ephemeral": True, "authenticated": True, "scope": "workspace:alpha",
            "consent_verified": True
        }}}
        state, _ = self.receive(state, fake)
        self.assertFalse(state.event_origin_authenticated)
        self.assertFalse(state.consent_issued)
        self.assertFalse(state.scope_authority_issued)
        self.assertFalse(state.archive_admitted)

    def test_fork_or_history_in_thread_response_refused(self):
        state, req = self.fresh()
        for row in (
            {"id":"thr_fixture_1","ephemeral": True, "forkedFromId":"parent"},
            {"id":"thr_fixture_1","ephemeral": True, "turns":[{"id":"old"}]},
            {"id":"thr_fixture_1","ephemeral": False},
            {"id":"thr_fixture_1","ephemeral": True, "sessionId":"different"},
            {"id":"thr_fixture_1","ephemeral": True, "cwd":"/foreign"},
        ):
            with self.subTest(fields=list(row)):
                self.blocked(lambda: self.receive(state, {
                    "id":req["id"], "result":{"thread":row}
                }))

    def test_overlapping_response_replay_and_item_budget_are_refused(self):
        state = self.stream_ready()
        self.blocked(lambda: self.receive(
            state, {"id":binding.TURN_REQUEST_ID,"result":{
                "turn":{"id":"turn_fixture_1","status":"inProgress","items":[]}
            }}
        ))
        limited = replace(state, item_notifications=binding.MAX_ITEM_NOTIFICATIONS)
        self.blocked(lambda: self.receive(limited, {
            "method":"item/completed","params":{
                "threadId":state.thread_id,"turnId":state.turn_id,
                "item":{"id":"test","type":"userMessage"}
            }
        }))

    def test_expired_lease_and_replaced_connection_refuse(self):
        state = self.thread_ready()
        with mock.patch.object(binding.time, "monotonic",
                               return_value=state.expires_at+1):
            self.blocked(lambda: binding.begin_turn(
                state, self.bridge, self.connection, self.consent, policy, "text"
            ))
        with mock.patch.object(self.connection, "identity", "external-connection"):
            self.blocked(lambda: binding.begin_turn(
                state, self.bridge, self.connection, self.consent, policy, "text"
            ))

    def test_no_production_dispatch_even_with_gate_patched_true(self):
        self.assertEqual(binding.connect_real_host()["status"],"blocked")
        with mock.patch.object(binding, "_PRODUCTION_REQUEST_BINDING_ADMITTED", True):
            self.assertEqual(binding.connect_real_host({"trusted":True})["status"],
                             "blocked")
        self.assertFalse(binding._PRODUCTION_REQUEST_BINDING_ADMITTED)


if __name__ == "__main__":
    unittest.main()
