"""3A.18 existing Dashboard trusted-local-host surface and OS canonical slots.

All roots are disposable test fixtures. No real user credentials, local OS
installation, chat messages, Memory discovery, or Codex model interaction.
The Dashboard source is read only at an exact pinned Git blob.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DETECTOR = ROOT / "scripts" / "workspace-infrastructure.mjs"
PKG = ROOT / "system/extensions/packages/ai-verse-codex-learning"


def load(alias: str, path: Path):
    spec = importlib.util.spec_from_file_location(alias, path)
    obj = importlib.util.module_from_spec(spec)
    sys.modules[alias] = obj
    spec.loader.exec_module(obj)
    return obj


boundary = load("_codex3a18_existing_host_probe",
                HERE / "fixture_os_dashboard_boundary.py")
preview = load("_codex3a18_preview_only",
               PKG / "codex_app_server_preview_authorization.py")


class SourcePinnedDashboardHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_path = os.environ.get(
            "AIVERSE_PINNED_DASHBOARD_SESSION_SOURCE", ""
        )

    def source(self) -> bytes:
        if not self.source_path:
            self.skipTest("pinned Dashboard checkout not supplied in this job")
        return Path(self.source_path).read_bytes()

    def blocked(self, action):
        with self.assertRaises(boundary.HostBoundaryBlocked) as outcome:
            action()
        self.assertEqual(
            str(outcome.exception),
            "unissued Persistent Chats host authority refused",
        )

    def test_exact_pinned_native_host_surface_is_not_a_consent_issuer(self):
        report = boundary.inspect_pinned_dashboard_source(self.source())
        self.assertEqual(
            report.verdict, "pinned_host_surface_present_not_capture_issuer"
        )
        for name in (
            "native_session_authenticated", "dashboard_cookie_verified",
            "os_consent_issued", "scope_authorized_for_capture",
            "host_event_origin_attested", "complete_visible_messages_verified",
            "archive_write_admitted",
        ):
            self.assertFalse(getattr(report, name))
        self.assertNotIn("sessionToken", repr(report))
        self.assertEqual(boundary.admit_real_host_capture(report)["status"],
                         "blocked")

    def test_even_small_host_source_mutation_invalidates_pin(self):
        source = self.source()
        self.blocked(lambda: boundary.inspect_pinned_dashboard_source(
            source + b"\n"
        ))
        self.blocked(lambda: boundary.inspect_pinned_dashboard_source(
            source.replace(b"workspace.get", b"aiverse.codex.capture", 1)
        ))
        self.blocked(lambda: boundary.inspect_pinned_dashboard_source(
            b'{"authenticated": true, "consent": true}'
        ))


@unittest.skipUnless(os.name == "posix" and shutil.which("node"),
                     "canonical owner detector requires POSIX and Node")
class CanonicalWorkspaceHostFixtureTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="aiverse-pc-3a18-owner-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve(strict=True) / "os"
        self.root.mkdir(mode=0o700)
        (self.root / "workspaces").mkdir(mode=0o700)
        for key in ("alpha", "beta"):
            (self.root / "workspaces" / key).mkdir(mode=0o700)
            self.manifest(key, key)
        self.alpha = self.root / "workspaces" / "alpha"
        self.beta = self.root / "workspaces" / "beta"

    def manifest(self, workspace, claimed, status="active"):
        (self.root / "workspaces" / workspace / "WORKSPACE.yaml").write_text(
            'schema_version: "2.0"\nid: ' + claimed +
            '\nstatus: ' + status + '\n', encoding="utf-8",
        )

    def check(self, workspace="alpha"):
        return boundary.check_synthetic_os_workspace(
            self.root, workspace, DETECTOR,
        )

    def blocked(self, fn):
        with self.assertRaises(boundary.HostBoundaryBlocked) as err:
            fn()
        self.assertEqual(
            str(err.exception), "unissued Persistent Chats host authority refused",
        )
        self.assertNotIn(str(self.root), str(err.exception))

    def test_native_os_workspace_detector_and_hard_denial(self):
        self.assertTrue(DETECTOR.is_file())
        for key in ("alpha", "beta"):
            report = self.check(key)
            self.assertEqual(
                report.verdict,
                "canonical_workspace_fixture_detected_not_capture_authority",
            )
            self.assertFalse(report.native_session_authenticated)
            self.assertFalse(report.os_consent_issued)
            self.assertFalse(report.scope_authorized_for_capture)
            self.assertFalse(report.archive_write_admitted)
        self.assertEqual(boundary.admit_real_host_capture(
            {"authenticated": True, "signed": True, "consent": True}
        )["status"], "blocked")

    def test_manifest_status_revocation_refuses_next_event(self):
        self.check()
        self.manifest("alpha", "alpha", status="paused")
        self.blocked(self.check)
        self.manifest("alpha", "alpha", status="disabled")
        self.blocked(self.check)
        self.manifest("alpha", "alpha", status="active")
        self.check()

    def test_wrong_workspace_identity_in_canonical_manifest(self):
        self.check()
        self.manifest("alpha", "beta")
        self.blocked(self.check)
        self.manifest("alpha", "alpha")
        self.check()

    def test_missing_and_nested_workspaces_fail_closed(self):
        self.check()
        original = self.alpha / "WORKSPACE.yaml"
        original.unlink()
        self.blocked(self.check)
        self.manifest("alpha", "alpha")
        child = self.alpha / "nested"
        child.mkdir()
        (child / "WORKSPACE.yaml").write_text("id: hidden\n")
        self.blocked(self.check)

    def test_symlink_root_and_replaced_workspace_fail_closed(self):
        self.check()
        linked = self.root.parent / "alias"
        linked.symlink_to(self.root, target_is_directory=True)
        self.addCleanup(lambda: linked.unlink(missing_ok=True))
        self.blocked(lambda: boundary.check_synthetic_os_workspace(
            linked, "alpha", DETECTOR
        ))
        moved = self.alpha.with_name("old-alpha")
        self.alpha.rename(moved)
        self.alpha.symlink_to(moved, target_is_directory=True)
        self.blocked(self.check)
        self.alpha.unlink()
        moved.rename(self.alpha)

    def test_invalid_scope_and_unsafe_modes_refuse(self):
        for item in ("", "../alpha", "ALPHA", "_template", "alpha/beta",
                     "x" * 65, "operator"):
            with self.subTest(item=item):
                self.blocked(lambda: self.check(item))
        self.alpha.chmod(0o777)
        try:
            self.blocked(self.check)
        finally:
            self.alpha.chmod(0o700)

    def test_real_os_slot_then_synthetic_consent_switch_cannot_grant_capture(self):
        # The canonical OS detector proves a physical slot, not an identity
        # session. Only the artificial test parent chooses opt-in here.
        self.check("alpha")
        process = object()
        owner = preview.SyntheticPreviewOwner(self.root, process)
        owner.set_scope_active("workspace:alpha", True)
        owner.set_scope_active("workspace:beta", True)
        owner.select_scope("workspace:alpha")
        owner.set_preview_consent(True)
        lease = owner.begin_preview(
            scope="workspace:alpha", cwd=self.alpha, process=process,
            thread_id="synthetic-new-root", turn_id="synthetic-new-turn",
        )
        event = {"method": "thread/started", "params": {"thread": {
            "id": "synthetic-new-root",
            "sessionId": "synthetic-new-root",
            "ephemeral": True,
            "forkedFromId": None, "cwd": str(self.alpha), "turns": [],
        }}}
        decision = owner.observe(lease, process=process,
                                 scope="workspace:alpha", event=event)
        self.assertFalse(decision.archive_write_admitted)
        owner.select_scope("workspace:beta")
        self.check("beta")
        with self.assertRaises(preview.PreviewBlocked):
            owner.observe(lease, process=process,
                          scope="workspace:alpha", event=event)
        owner.select_scope("workspace:alpha")
        with self.assertRaises(preview.PreviewBlocked):
            owner.observe(lease, process=process,
                          scope="workspace:alpha", event=event)


if __name__ == "__main__":
    unittest.main()
