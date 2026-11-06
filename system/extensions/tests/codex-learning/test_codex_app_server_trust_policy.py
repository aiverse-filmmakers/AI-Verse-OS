"""Synthetic-only phase 3A.5 parent choice, scope and consent gate tests.

Every test constructs a disposable fake OS + fake App Server Python process.
The actual Codex executable, sessions, credentials, installation, network,
Memory, and canonical archive are never involved.
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

PACKAGE = (Path(__file__).resolve().parents[2]
           / "packages" / "ai-verse-codex-learning")


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, PACKAGE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


policy = _load("_codex_3a5_synthetic_policy", "codex_app_server_trust_policy.py")
transport = _load("_codex_3a5_synthetic_transport", "codex_app_server_transport.py")
candidate = _load("_codex_3a5_synthetic_candidate", "codex_app_server_candidate.py")
os_bridge = _load("_codex_3a5_real_os_bridge", "bridge.py")

FAKE_APP_SERVER = r"""
import json
import sys
import time

initial = json.loads(sys.stdin.readline())
print(json.dumps({"id": initial["id"], "result": {"serverInfo": {
    "name": "TEST ONLY NOT CODEX"}}}), flush=True)
assert json.loads(sys.stdin.readline()) == {"method": "initialized"}

for event in (
    {"method": "turn/started", "params": {
        "threadId": "fixture-thread-1",
        "turn": {"id": "fixture-turn-1", "status": "inProgress", "items": []},
    }},
    {"method": "item/completed", "params": {
        "threadId": "fixture-thread-1", "turnId": "fixture-turn-1",
        "item": {"id": "u-1", "type": "userMessage",
                 "content": [{"type": "text", "text": " synthetic only user 🧪"}]},
    }},
    {"method": "item/completed", "params": {
        "threadId": "fixture-thread-1", "turnId": "fixture-turn-1",
        "item": {"id": "a-1", "type": "agentMessage",
                 "phase": "final_answer", "text": " synthetic only reply"},
    }},
    {"method": "turn/completed", "params": {
        "threadId": "fixture-thread-1",
        "turn": {"id": "fixture-turn-1", "status": "completed"},
    }},
):
    print(json.dumps(event, ensure_ascii=False), flush=True)
time.sleep(10)
"""


class SyntheticOwnerConsentTests(unittest.TestCase):
    def setUp(self):
        if os.name != "posix":
            self.skipTest("3A.5 fixture subprocess requires POSIX")
        tmp = tempfile.TemporaryDirectory(prefix="aiverse-3a5-fake-os-")
        self.addCleanup(tmp.cleanup)
        self.parent = Path(tmp.name).resolve(strict=True)
        self.root = self.parent / "os"
        self.root.mkdir()
        (self.root / "AI-VERSE.yaml").write_text(
            'schema_version: "2.0"\narchitecture: unified-workspace\n',
            encoding="utf-8",
        )
        self.extension = (self.root / ".aiverse/extensions"
                          / "ai-verse-codex-learning")
        self.extension.mkdir(parents=True)
        (self.extension.parent / "registry.json").write_text(json.dumps({
            "schema_version": "1.0", "extensions": {
                "ai-verse-codex-learning": {
                    "id": "ai-verse-codex-learning",
                    "supported": True, "installed": True, "enabled": True,
                },
            },
        }))
        self.alpha = self.root / "workspaces/alpha"
        self.alpha.mkdir(parents=True)
        self.beta = self.root / "workspaces/beta"
        self.beta.mkdir(parents=True)
        self.write_manifest("alpha", status="active")
        self.write_manifest("beta", status="active")
        self.bridge = os_bridge.Bridge(self.root, harness="codex")
        self.fixture = self.parent / "isolated-child"
        self.fixture.mkdir(mode=0o700)
        self.script = self.fixture / "fake_stdio.py"
        self.script.write_text(FAKE_APP_SERVER, encoding="utf-8")
        self.script.chmod(0o600)
        self.python = Path(sys.executable).resolve(strict=True)
        spec = transport.SyntheticChildSpec(
            executable=self.python,
            executable_sha256=hashlib.sha256(self.python.read_bytes()).hexdigest(),
            fixture_script=self.script,
            fixture_sha256=hashlib.sha256(self.script.read_bytes()).hexdigest(),
            private_cwd=self.fixture,
        )
        self.connection = transport.launch_synthetic_fixture(spec)
        self.addCleanup(self.connection.close)
        self.consent = policy.SyntheticConsent(opted_in=True)
        self.intent = policy.OwnerIntent(
            scope="workspace:alpha", cwd=self.alpha,
            expected_thread="fixture-thread-1",
        )

    def write_manifest(self, name, status):
        (self.root / "workspaces" / name / "WORKSPACE.yaml").write_text(
            'schema_version: "2.0"\nid: "' + name
            + '"\nstatus: ' + status + '\n',
            encoding="utf-8",
        )

    def begin(self):
        return policy.begin_synthetic_session(
            self.bridge, self.connection, self.intent, self.consent,
        )

    def event(self, method="turn/started", **parameters):
        return {"method": method, "params": {
            "threadId": "fixture-thread-1", **parameters,
        }}

    def check(self, lease, event=None, **kwargs):
        return policy.check_synthetic_event(
            self.bridge, self.connection, self.intent, self.consent,
            lease, self.event() if event is None else event,
        )

    def blocked(self, fn):
        with self.assertRaises(policy.PolicyBlocked) as error:
            fn()
        self.assertEqual(
            str(error.exception), "synthetic Codex trust/consent check refused",
        )
        self.assertNotIn(str(self.alpha), str(error.exception))

    def test_explicit_preview_only_owner_consent_and_active_workspace(self):
        lease = self.begin()
        self.assertEqual(lease.scope, "workspace:alpha")
        self.assertEqual(lease.cwd, self.alpha)
        self.assertEqual(lease.thread_id, "fixture-thread-1")
        lease, decision = self.check(lease)
        self.assertEqual(lease.checked_events, 1)
        self.assertEqual(
            decision.status,
            "synthetic_policy_match_not_authenticated_or_archivable",
        )
        self.assertFalse(decision.transport_authenticated)
        self.assertFalse(decision.host_event_attested)
        self.assertFalse(decision.scope_attested_at_event)
        self.assertFalse(decision.consent_issued_by_os_ui)
        self.assertFalse(decision.archive_write_admitted)
        self.assertEqual(policy.capture_admission(lease)["status"], "blocked")

    def test_no_consent_or_revoked_consent_refuses_start(self):
        self.consent = policy.SyntheticConsent()
        self.blocked(self.begin)
        self.consent.set_opt_in(True)
        self.begin()
        self.consent.revoke()
        self.blocked(self.begin)

    def test_consent_revocation_between_user_and_assistant_fails_closed(self):
        lease = self.begin()
        first = self.connection.next_notification()
        lease, _ = self.check(lease, first)
        user = self.connection.next_notification()
        lease, _ = self.check(lease, user)
        self.consent.revoke()
        response = self.connection.next_notification()
        self.blocked(lambda: self.check(lease, response))
        self.assertEqual(policy.capture_admission(lease)["status"], "blocked")

    def test_opt_out_or_new_opt_in_cannot_reuse_existing_lease(self):
        lease = self.begin()
        self.consent.set_opt_in(False)
        self.blocked(lambda: self.check(lease))
        self.consent.set_opt_in(True)
        self.blocked(lambda: self.check(lease))
        refreshed = self.begin()
        self.assertNotEqual(
            refreshed.consent_generation, lease.consent_generation,
        )

    def test_private_and_historical_and_nosave_modes_refused(self):
        for changes in (
            {"private_session": True},
            {"historical_import": True},
            {"mode": "record_full_chat"},
            {"mode": "off"},
            {"purpose": "resume_old_thread"},
            {"purpose": "fork_old_thread"},
            {"expected_thread": "not/valid"},
        ):
            with self.subTest(changes=changes):
                self.intent = replace(
                    policy.OwnerIntent(
                        scope="workspace:alpha", cwd=self.alpha,
                        expected_thread="fixture-thread-1",
                    ),
                    **changes,
                )
                self.blocked(self.begin)

    def test_disclosure_from_host_json_cannot_grant_consent_or_scope(self):
        lease = self.begin()
        fake = self.event(
            "item/completed", scope="workspace:beta",
            authenticated=True, signed=True, trusted=True,
            consent_verified=True, private=False,
            text="PRIVATE_HOST_PAYLOAD",
        )
        _, decision = self.check(lease, fake)
        self.assertFalse(decision.consent_issued_by_os_ui)
        self.assertFalse(decision.scope_attested_at_event)
        self.assertFalse(decision.archive_write_admitted)
        self.consent.revoke()
        self.blocked(lambda: self.check(lease, fake))

    def test_workspace_paused_after_start_blocks_next_event(self):
        lease = self.begin()
        lease, _ = self.check(lease)
        self.write_manifest("alpha", status="paused")
        self.blocked(lambda: self.check(lease))
        self.write_manifest("alpha", status="active")
        new = self.begin()
        self.assertEqual(new.scope, "workspace:alpha")

    def test_workspace_identity_mismatch_and_missing_manifest_fail_closed(self):
        self.write_manifest("alpha", status="active")
        (self.alpha / "WORKSPACE.yaml").write_text(
            'schema_version: "2.0"\nid: beta\nstatus: active\n',
        )
        self.blocked(self.begin)
        (self.alpha / "WORKSPACE.yaml").unlink()
        self.blocked(self.begin)

    def test_physical_directory_cannot_relabel_operator_or_other_workspace(self):
        for bad in (
            replace(self.intent, cwd=self.root),
            replace(self.intent, cwd=self.beta),
            replace(self.intent, scope="operator"),
        ):
            self.intent = bad
            self.blocked(self.begin)

    def test_unsafe_symlinked_cwd_denied_with_exact_original_cwd(self):
        symlink = self.root / "workspaces/linked-alpha"
        try:
            symlink.symlink_to(self.alpha, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unsupported")
        self.intent = replace(self.intent, cwd=symlink)
        self.blocked(self.begin)

    def test_existing_operator_only_scope_can_be_planned_separately(self):
        self.intent = replace(
            self.intent, scope="operator", cwd=self.root,
        )
        lease = self.begin()
        self.assertEqual(lease.scope, "operator")

    def test_unexpected_thread_id_and_server_requests_refused(self):
        lease = self.begin()
        for bad in (
            self.event("turn/started", threadId="foreign"),
            self.event("thread/resumed"),
            self.event("thread/forked"),
            self.event("turn/steered"),
            self.event("request/approval"),
            {"id": 3, "method": "turn/started",
             "params": {"threadId": "fixture-thread-1"}},
            {"jsonrpc": "1.0", "method": "turn/started",
             "params": {"threadId": "fixture-thread-1"}},
        ):
            with self.subTest(bad=bad["method"]):
                self.blocked(lambda: self.check(lease, bad))

    def test_expired_lease_or_too_many_events_refused(self):
        lease = self.begin()
        with mock.patch.object(policy.time, "monotonic",
                               return_value=lease.expires_at + 0.1):
            self.blocked(lambda: self.check(lease))
        limit = replace(lease, checked_events=policy.MAX_EVENTS)
        self.blocked(lambda: self.check(limit))

    def test_switch_from_fresh_to_resume_purpose_invalidates_lease(self):
        lease = self.begin()
        self.intent = replace(self.intent, purpose="resume_old_thread")
        self.blocked(lambda: self.check(lease))

    def test_completed_turn_closes_same_lease_to_replay(self):
        lease = self.begin()
        lease, _ = self.check(lease, self.event("turn/completed"))
        self.assertTrue(lease.closed)
        self.blocked(lambda: self.check(lease))

    def test_killed_child_is_not_trusted_by_stale_parent_lease(self):
        lease = self.begin()
        self.connection.close()
        self.blocked(lambda: self.check(lease))

    def test_separate_child_handle_cannot_be_substituted(self):
        lease = self.begin()
        other = self.connection
        with mock.patch.object(
            other, "identity", "external_untrusted_process",
        ):
            self.blocked(lambda: self.check(lease))

    def test_disable_os_extension_or_wrong_harness_refuses(self):
        lease = self.begin()
        with mock.patch.object(self.bridge, "registered", return_value=False):
            self.blocked(lambda: self.check(lease))
        with mock.patch.object(self.bridge, "harness", "claude"):
            # The initial lease remains nonauthentic, but a different
            # harness must not be able to initiate a new one.
            self.blocked(self.begin)

    def test_wrong_harness_during_stream_cannot_use_old_lease(self):
        lease = self.begin()
        with mock.patch.object(self.bridge, "harness", "claude"):
            self.blocked(lambda: self.check(lease))
        self.assertEqual(policy.capture_admission(lease)["status"], "blocked")

    def test_transport_event_sequence_and_app_server_candidate_still_untrusted(self):
        lease = self.begin()
        state = None
        for _ in range(4):
            event = self.connection.next_notification()
            lease, policy_result = self.check(lease, event)
            state, report, status = candidate.observe(state, event)
            self.assertFalse(policy_result.archive_write_admitted)
        self.assertEqual(status, "untrusted_candidate")
        self.assertTrue(lease.closed)
        self.assertFalse(report.authentic_host_origin)
        self.assertFalse(report.consent_verified)
        self.assertFalse(report.writer_admitted)
        self.assertFalse(lease.expires_at <= 0)
        self.assertEqual(policy.capture_admission(lease)["status"], "blocked")

    def test_production_remains_disabled_when_both_flags_mocked(self):
        self.assertEqual(policy.connect_real_codex()["status"], "blocked")
        with (
            mock.patch.object(
                policy, "_PRODUCTION_HOST_ISSUER_ADMITTED", True,
            ),
            mock.patch.object(
                policy, "_PRODUCTION_CONSENT_ISSUER_ADMITTED", True,
            ),
        ):
            self.assertEqual(
                policy.connect_real_codex({"trusted": True})["status"],
                "blocked",
            )
        self.assertFalse(policy._PRODUCTION_HOST_ISSUER_ADMITTED)
        self.assertFalse(policy._PRODUCTION_CONSENT_ISSUER_ADMITTED)


if __name__ == "__main__":
    unittest.main()
