"""3A.15: synthetic-only scoped owner lease invalidation regression tests.

NO real Codex process, credentials, account, user transcript, archive,
model tokens or local OS services. Synthetic parent-only fake owner model.
"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

PACKAGE = (Path(__file__).resolve().parents[2]
           / "packages" / "ai-verse-codex-learning")
spec = importlib.util.spec_from_file_location(
    "_codex_3a15_owner_preview",
    PACKAGE / "codex_app_server_preview_authorization.py",
)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


@unittest.skipUnless(os.name == "posix", "physical synthetic scope is POSIX only")
class SyntheticOwnerAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aiverse-owner-consent-3a15-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(strict=True) / "os"
        self.root.mkdir(mode=0o700)
        for name in ("alpha", "beta"):
            (self.root / "workspaces" / name).mkdir(
                mode=0o700, parents=True, exist_ok=True,
            )
        self.alpha = self.root / "workspaces" / "alpha"
        self.beta = self.root / "workspaces" / "beta"
        self.process = object()
        self.owner = gate.SyntheticPreviewOwner(self.root, self.process)
        self.owner.set_scope_active("workspace:alpha", True)
        self.owner.set_scope_active("workspace:beta", True)
        self.owner.select_scope("workspace:alpha")
        self.owner.set_preview_consent(True)

    def open(self, scope="workspace:alpha", cwd=None, owner=None,
             process=None, **kwargs):
        owner = self.owner if owner is None else owner
        process = self.process if process is None else process
        if cwd is None:
            cwd = self.alpha if scope == "workspace:alpha" else self.beta
        values = dict(scope=scope, cwd=cwd, process=process,
                      thread_id="new-root-thread", turn_id="new-turn-1")
        values.update(kwargs)
        return owner.begin_preview(**values)

    def event_thread(self, cwd=None):
        return {"method": "thread/started", "params": {"thread": {
            "id": "new-root-thread", "sessionId": "new-root-thread",
            "cwd": str(self.alpha if cwd is None else cwd),
            "ephemeral": True, "forkedFromId": None, "turns": [],
        }}}

    def event_turn(self):
        return {"method": "turn/started", "params": {
            "threadId": "new-root-thread",
            "turn": {"id": "new-turn-1", "items": [], "status": "inProgress"},
        }}

    def event_item(self, method="item/completed"):
        stamp = "startedAtMs" if method == "item/started" else "completedAtMs"
        return {"method": method, "params": {
            "threadId": "new-root-thread", "turnId": "new-turn-1",
            stamp: 1000, "item": {"type": "agentMessage",
                                  "text": "SYNTHETIC_SECRET_ONLY"},
        }}

    def observe(self, lease, event, scope="workspace:alpha", process=None):
        return self.owner.observe(
            lease, process=self.process if process is None else process,
            scope=scope, event=event,
        )

    def refused(self, fn):
        with self.assertRaises(gate.PreviewBlocked) as caught:
            fn()
        self.assertEqual(
            str(caught.exception),
            "synthetic Persistent Chats authorization refused",
        )
        self.assertNotIn(str(self.root), str(caught.exception))
        self.assertNotIn("SYNTHETIC_SECRET_ONLY", str(caught.exception))

    def test_prospective_synthetic_flow_never_grants_capture(self):
        lease = self.open()
        events = [self.event_thread(), self.event_turn(),
                  self.event_item("item/started"),
                  self.event_item("item/completed"),
                  {"method": "turn/completed", "params": {
                      "threadId": "new-root-thread",
                      "turn": {"id": "new-turn-1", "status": "completed"},
                  }}]
        for i, event in enumerate(events, 1):
            decision = self.observe(lease, event)
            self.assertEqual(decision.checked_events, i)
            for name in (
                "authenticated_os_session", "authenticated_codex_host",
                "consent_issued_by_os_ui", "real_scope_issuer_verified",
                "complete_source_coverage", "archive_write_admitted",
            ):
                self.assertFalse(getattr(decision, name))
            self.assertNotIn("SYNTHETIC_SECRET_ONLY", repr(decision))
        self.refused(lambda: self.observe(lease, self.event_item()))
        self.assertEqual(gate.authorize_production_capture()["status"], "blocked")
        self.assertEqual(gate.persist_authenticated_chat()["status"], "blocked")

    def test_default_denial_and_no_fake_consent_in_rpc_frames(self):
        owner = gate.SyntheticPreviewOwner(self.root, self.process)
        owner.set_scope_active("workspace:alpha", True)
        owner.select_scope("workspace:alpha")
        self.refused(lambda: self.open(owner=owner))
        owner.set_preview_consent(True)
        lease = self.open(owner=owner)
        forged = self.event_thread()
        forged["params"]["authenticated"] = True
        forged["params"]["consentIssuedByOsUi"] = True
        forged["params"]["scopeVerified"] = "workspace:alpha"
        decision = owner.observe(
            lease, scope="workspace:alpha", process=self.process, event=forged
        )
        self.assertFalse(decision.archive_write_admitted)
        self.assertFalse(decision.consent_issued_by_os_ui)
        self.assertFalse(decision.authenticated_codex_host)

    def test_midstream_revocation_never_allows_old_lease(self):
        lease = self.open()
        self.observe(lease, self.event_thread())
        self.observe(lease, self.event_turn())
        self.owner.set_preview_consent(False)
        self.refused(lambda: self.observe(lease, self.event_item()))
        self.owner.set_preview_consent(True)
        self.refused(lambda: self.observe(lease, self.event_item()))
        replacement = self.open()
        self.assertIsNot(lease, replacement)
        self.observe(replacement, self.event_thread())

    def test_alpha_beta_alpha_switch_does_not_revive_old_record(self):
        first = self.open()
        self.owner.select_scope("workspace:beta")
        self.refused(lambda: self.observe(first, self.event_thread()))
        beta = self.open(scope="workspace:beta", cwd=self.beta)
        self.assertFalse(beta is first)
        self.owner.select_scope("workspace:alpha")
        self.refused(lambda: self.observe(first, self.event_thread()))
        self.refused(lambda: self.owner.observe(
            beta, scope="workspace:beta", process=self.process,
            event=self.event_thread(self.beta),
        ))
        new = self.open()
        self.observe(new, self.event_thread())

    def test_paused_workspace_cannot_continue_or_open(self):
        lease = self.open()
        self.owner.set_scope_active("workspace:alpha", False)
        self.refused(lambda: self.observe(lease, self.event_thread()))
        self.refused(self.open)
        self.owner.set_scope_active("workspace:alpha", True)
        self.owner.select_scope("workspace:alpha")
        self.refused(lambda: self.observe(lease, self.event_thread()))
        self.observe(self.open(), self.event_thread())

    def test_process_replaced_or_disconnected_invalidates_current(self):
        lease = self.open()
        alternative = object()
        self.refused(lambda: self.observe(
            lease, self.event_thread(), process=alternative,
        ))
        self.owner.replace_owned_process(alternative)
        self.refused(lambda: self.observe(
            lease, self.event_thread(), process=alternative,
        ))
        self.refused(lambda: self.open())
        self.owner.disconnect()
        self.refused(lambda: self.observe(
            lease, self.event_thread(), process=alternative,
        ))

    def test_expired_and_event_budget_leases_fail_closed(self):
        lease = self.open()
        expiration = self.owner._active.expires_at
        with mock.patch.object(gate.time, "monotonic",
                               return_value=expiration):
            self.refused(lambda: self.observe(lease, self.event_thread()))
        self.refused(lambda: self.observe(lease, self.event_thread()))
        lease = self.open()
        self.owner._active.checked_events = gate.MAX_EVENTS
        self.refused(lambda: self.observe(lease, self.event_thread()))

    def test_forged_lease_and_invalid_mode_inputs_refused(self):
        lease = self.open()
        self.refused(lambda: self.observe(
            gate.PreviewLease(object()), self.event_thread(),
        ))
        self.refused(lambda: self.observe(lease, self.event_thread()))
        for options in (
            {"private": True}, {"historical": True},
            {"recording": True}, {"recording": 1},
            {"purpose": "resume_history"}, {"purpose": "record_everything"},
            {"thread_id": "not/allowed"},
            {"turn_id": ""},
        ):
            with self.subTest(options=options):
                self.refused(lambda: self.open(**options))
        self.refused(lambda: self.owner.set_preview_consent(1))
        self.refused(lambda: self.owner.set_scope_active("workspace:beta", 1))

    def test_malformed_event_closes_lease_without_recovering(self):
        invalid = [
            {"id": 3, "result": {}},
            {"method": "thread/resumed", "params": {}},
            {"method": "thread/forked", "params": {}},
            {"method": "turn/started", "params": {}},
            {"method": "thread/started", "params": {
                "thread": {"id": "wrong", "sessionId": "wrong"},
            }},
            {"method": "thread/started", "params": {
                "thread": {"id": "new-root-thread",
                           "sessionId": "foreign", "cwd": str(self.alpha),
                           "ephemeral": True, "turns": []},
            }},
            {"method": "thread/started", "params": {
                "thread": {"id": "new-root-thread",
                           "sessionId": "new-root-thread",
                           "cwd": str(self.beta), "ephemeral": True,
                           "turns": []},
            }},
            {"method": "thread/started", "params": {
                "thread": {"id": "new-root-thread",
                           "sessionId": "new-root-thread",
                           "cwd": str(self.alpha), "ephemeral": False,
                           "turns": []},
            }},
            {"method": "thread/started", "params": {
                "thread": {"id": "new-root-thread",
                           "sessionId": "new-root-thread",
                           "cwd": str(self.alpha), "ephemeral": True,
                           "forkedFromId": "old", "turns": []},
            }},
        ]
        for frame in invalid:
            with self.subTest(frame=frame.get("method", "request")):
                lease = self.open()
                self.refused(lambda: self.observe(lease, frame))
                self.refused(lambda: self.observe(lease, self.event_thread()))

    def test_foreign_turn_and_malformed_timestamp_close_live_lease(self):
        for change in (
            {"threadId": "foreign"},
            {"turnId": "foreign"},
            {"completedAtMs": True},
            {"completedAtMs": -1},
            {"completedAtMs": 1.5},
            {"completedAtMs": (1 << 63)},
            {"item": []},
        ):
            with self.subTest(change=change):
                lease = self.open()
                self.observe(lease, self.event_thread())
                self.observe(lease, self.event_turn())
                frame = self.event_item()
                frame["params"].update(change)
                self.refused(lambda: self.observe(lease, frame))
                self.refused(lambda: self.observe(lease, self.event_item()))

    def test_physical_symlink_and_replaced_inode_refused(self):
        lease = self.open()
        moved = self.root / "workspaces" / "alpha-old"
        self.alpha.rename(moved)
        self.alpha.mkdir(mode=0o700)
        self.refused(lambda: self.observe(lease, self.event_thread()))
        self.refused(lambda: self.open())
        self.alpha.rmdir()
        moved.rename(self.alpha)
        self.owner.select_scope("workspace:alpha")
        current = self.open()
        self.observe(current, self.event_thread())
        current = self.open()
        self.alpha.rename(moved)
        self.alpha.symlink_to(moved, target_is_directory=True)
        self.refused(lambda: self.observe(current, self.event_thread()))
        self.alpha.unlink()
        moved.rename(self.alpha)

    def test_nonparent_scope_no_writes_and_no_production_escape(self):
        parent_path = self.root / "workspaces" / "alpha" / "nested"
        parent_path.mkdir(mode=0o700)
        self.refused(lambda: self.open(cwd=parent_path))
        self.refused(lambda: self.open(scope="operator", cwd=self.root))
        self.refused(lambda: self.open(scope="workspace:beta", cwd=self.beta))
        self.refused(lambda: self.owner.select_scope("workspace:gamma"))
        self.refused(lambda: self.owner.select_scope("workspace:alpha/../beta"))
        before = sorted(str(path) for path in self.root.rglob("*"))
        self.observe(self.open(), self.event_thread())
        self.assertEqual(before, sorted(str(path) for path in self.root.rglob("*")))
        with mock.patch.object(gate, "MAX_EVENTS", 10_000):
            self.assertEqual(
                gate.authorize_production_capture(
                    self.owner, {"consent": True, "host_authenticated": True}
                )["status"], "blocked"
            )
            self.assertEqual(
                gate.persist_authenticated_chat(
                    self.owner, {"trusted": True}
                )["status"], "blocked"
            )


if __name__ == "__main__":
    unittest.main()
