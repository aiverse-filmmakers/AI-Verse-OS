"""Phase 3A.43: prove every named production capture entry stays blocked.

This checks committed OS Python release-entrypoint code and exercises the
callable denial gates. It DOES NOT audit every possible future entrypoint,
authenticate macOS, install Codex, read private transcripts, or prove the
Dashboard's browser permission boundary. Dashboard CI separately owns that.
"""
from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = (Path(__file__).resolve().parents[2] / "packages"
        / "ai-verse-codex-learning")

FLAGS = {
    "codex_capture.py": ("_HOST_EVENTS_ADMITTED",
                         "_AT_TIME_SCOPE_ISSUER_ADMITTED"),
    "codex_app_server_candidate.py": (
        "_APP_SERVER_OWNED_TRANSPORT_ADMITTED",),
    "codex_app_server_trust_policy.py": (
        "_PRODUCTION_HOST_ISSUER_ADMITTED",
        "_PRODUCTION_CONSENT_ISSUER_ADMITTED"),
    "codex_app_server_archive_v2.py": ("_RECORDING_ENABLED",),
    "codex_host_schema_pin.py": (
        "_REAL_HOST_RUNTIME_ATTESTED",
        "_OS_CONSENT_ISSUER_ATTESTED",
        "_AT_EVENT_SCOPE_ISSUER_ATTESTED",
        "_COMPLETE_UI_COVERAGE_ATTESTED"),
}


def flags_are_unissued(source: str, expected: tuple[str, ...]) -> bool:
    """Require exact module-level False assignments, never caller claims."""
    try:
        code = ast.parse(source)
    except SyntaxError:
        return False
    assignments = {}
    for node in code.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments.setdefault(target.id, []).append(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target,
                                                             ast.Name):
            assignments.setdefault(node.target.id, []).append(node.value)
    return all(
        len(assignments.get(name, [])) == 1
        and isinstance(assignments[name][0], ast.Constant)
        and assignments[name][0].value is False
        for name in expected
    )


def load(name: str):
    filename = ROOT / name
    alias = "_aiverse_3a43_" + name.replace(".", "_")
    spec = importlib.util.spec_from_file_location(alias, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


class ReleaseCaptureDenialTests(unittest.TestCase):
    def test_all_named_release_enablement_flags_are_fixed_false(self):
        for file, names in FLAGS.items():
            with self.subTest(file=file):
                self.assertTrue(flags_are_unissued(
                    (ROOT / file).read_text(encoding="utf-8"), names))

    def test_activating_any_guard_is_detected_in_memory(self):
        for file, names in FLAGS.items():
            source = (ROOT / file).read_text(encoding="utf-8")
            for flag in names:
                with self.subTest(file=file, flag=flag):
                    changed = source.replace(flag + " = False",
                                             flag + " = True", 1)
                    self.assertNotEqual(changed, source)
                    self.assertFalse(flags_are_unissued(changed, names))

    def test_callable_production_gates_always_deny_even_forged_signatures(self):
        forged = {"teamId": "AAAAAAAAAA", "signed": True,
                  "deviceOwnerAuthenticated": True, "consented": True,
                  "scope": "operator", "captureAuthorized": True,
                  "hostEventOriginAttested": True,
                  "completeVisibleMessagesVerified": True}
        preview = load("codex_app_server_preview_authorization.py")
        archive = load("codex_app_server_archive_v2.py")
        schema = load("codex_host_schema_pin.py")
        trust = load("codex_app_server_trust_policy.py")
        for decision in (
            preview.authorize_production_capture(forged, forged),
            preview.persist_authenticated_chat(forged, forged),
            archive.admission(b"PRIVATE_FIXTURE_BYTES"),
            archive.save_real_chat(b"PRIVATE_FIXTURE_BYTES"),
            schema.admit_real_capture(forged, forged, forged),
            trust.capture_admission(forged),
        ):
            self.assertEqual(decision["status"], "blocked")
            self.assertNotIn("PRIVATE_FIXTURE_BYTES", repr(decision))

    def test_event_preview_cannot_write_after_synthetic_complete_turn(self):
        gate = load("codex_app_server_event_admission_preview.py")
        owner = gate.SyntheticOwner("operator", "/scratch/operator", 1501)
        preview = gate.ProspectiveEventPreview(owner)
        self.assertFalse(preview.recording_permitted())
        self.assertFalse(preview.persist("UNTRUSTED_BODY"))
        self.assertFalse(preview.retrieve_memory("UNTRUSTED_BODY"))
        self.assertFalse(gate.EventVerdict(4, True).archive_write_admitted)


if __name__ == "__main__":
    unittest.main()
