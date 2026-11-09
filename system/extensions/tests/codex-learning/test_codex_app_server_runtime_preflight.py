"""3A.11 private synthetic executable preflight, never Codex or real user data."""
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

PACKAGE = (Path(__file__).resolve().parents[2] / "packages"
           / "ai-verse-codex-learning")
spec = importlib.util.spec_from_file_location(
    "_persistent_chats_3a11_runtime", PACKAGE / "codex_app_server_runtime_preflight.py"
)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


@unittest.skipUnless(os.name == "posix", "private POSIX file descriptor contract")
class CandidateRuntimePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="persistent-chats-runtime-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(strict=True)
        self.binary = self.root / "codex"
        self.binary.write_bytes(b"NOT-CODEX-SYNTHETIC-FIXTURE\x00" * 3)
        self.binary.chmod(0o700)

    def proposal(self, **kwargs):
        values = dict(
            private_root=self.root,
            expected_sha256=hashlib.sha256(self.binary.read_bytes()).hexdigest(),
        )
        values.update(kwargs)
        return gate.ProposedRuntime(**values)

    def blocked(self, fn):
        with self.assertRaises(gate.RuntimePreflightBlocked) as caught:
            fn()
        self.assertEqual(
            str(caught.exception), "unverified Codex runtime candidate refused",
        )
        self.assertNotIn(str(self.root), str(caught.exception))

    def test_exact_private_file_returns_untrusted_receipt(self):
        receipt = gate.inspect_candidate(self.proposal())
        self.assertEqual(receipt.file_size, self.binary.stat().st_size)
        self.assertEqual(receipt.observed_sha256,
                         hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertEqual(receipt.verdict, "caller_digest_match_not_host_attestation")
        for name in (
            "approved_release_verified", "executed_bytes_verified",
            "real_host_authenticated", "process_owned_by_os",
            "consent_issued_by_os", "scope_at_event_verified",
            "archive_write_admitted",
        ):
            self.assertFalse(getattr(receipt, name))
        self.assertNotIn(str(self.root), repr(receipt))
        self.assertEqual(gate.admit_real_host(receipt)["status"], "blocked")
        self.assertEqual(gate.connect_real_codex(receipt)["status"], "blocked")

    def test_changed_or_unapproved_bytes_fail(self):
        proposal = self.proposal()
        self.binary.write_bytes(b"other synthetic bytes")
        self.blocked(lambda: gate.inspect_candidate(proposal))
        self.blocked(lambda: gate.inspect_candidate(
            self.proposal(expected_sha256="0" * 64)
        ))

    def test_no_path_or_claim_can_select_arbitrary_executable(self):
        for values in (
            {"executable_name": "../other"},
            {"executable_name": "/usr/bin/codex"},
            {"executable_name": "python"},
            {"source_schema_commit": "0" * 40},
            {"private_root": Path("relative")},
            {"expected_sha256": True},
            {"expected_sha256": "A" * 64},
            {"expected_sha256": "not-a-hash"},
        ):
            with self.subTest(values=list(values)):
                self.blocked(lambda: gate.inspect_candidate(self.proposal(**values)))

    def test_parent_and_file_symlinks_refused(self):
        alias = self.root.parent / (self.root.name + "-alias")
        alias.symlink_to(self.root, target_is_directory=True)
        self.addCleanup(lambda: alias.unlink(missing_ok=True))
        self.blocked(lambda: gate.inspect_candidate(
            self.proposal(private_root=alias)
        ))
        target = self.root / "real-codex"
        self.binary.rename(target)
        self.binary.symlink_to(target)
        self.blocked(lambda: gate.inspect_candidate(
            self.proposal(expected_sha256=hashlib.sha256(target.read_bytes()).hexdigest())
        ))

    def test_private_owner_permissions_are_mandatory(self):
        proposal = self.proposal()
        self.root.chmod(0o750)
        self.blocked(lambda: gate.inspect_candidate(proposal))
        self.root.chmod(0o700)
        self.binary.chmod(0o770)
        self.blocked(lambda: gate.inspect_candidate(proposal))
        self.binary.chmod(0o600)
        self.blocked(lambda: gate.inspect_candidate(proposal))
        self.binary.chmod(0o700)
        with mock.patch.object(gate.os, "getuid", return_value=os.getuid() + 1):
            self.blocked(lambda: gate.inspect_candidate(proposal))

    def test_directory_named_codex_and_empty_file_refused(self):
        self.binary.unlink()
        self.binary.mkdir()
        self.blocked(lambda: gate.inspect_candidate(
            self.proposal(expected_sha256="0" * 64)
        ))
        self.binary.rmdir()
        self.binary.write_bytes(b"")
        self.binary.chmod(0o700)
        self.blocked(lambda: gate.inspect_candidate(
            self.proposal(expected_sha256=hashlib.sha256(b"").hexdigest())
        ))

    def test_strict_budget_and_invalid_runtime_type_refuse(self):
        proposal = self.proposal()
        with mock.patch.object(gate, "MAX_CANDIDATE_BYTES", 2):
            self.blocked(lambda: gate.inspect_candidate(proposal))
        self.blocked(lambda: gate.inspect_candidate({}))
        self.blocked(lambda: gate.inspect_candidate(None))

    def test_zero_spawn_and_forged_authorization_cannot_unlock(self):
        with mock.patch("subprocess.Popen",
                        side_effect=AssertionError("MUST NOT LAUNCH")):
            receipt = gate.inspect_candidate(self.proposal())
        self.assertFalse(receipt.real_host_authenticated)
        with (mock.patch.object(gate, "_RUNTIME_ADMITTED", True),
              mock.patch.object(gate, "_CONSENT_ISSUER_VERIFIED", True),
              mock.patch.object(gate, "_SCOPE_ISSUER_VERIFIED", True)):
            self.assertEqual(gate.admit_real_host(
                receipt, {"authenticated": True, "scope": "operator",
                          "consent": True})["status"], "blocked")
            self.assertEqual(gate.connect_real_codex(
                receipt, {"command": "codex app-server"})["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
