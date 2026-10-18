"""Portability and exact-allowlist tests for the optional Codex package."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

TEST_DIR = Path(__file__).resolve().parent
PACKAGE = TEST_DIR.parents[1] / "packages" / "ai-verse-codex-learning"
sys.path.insert(0, str(PACKAGE))
from bridge import DEFAULT_ROOT

FORBIDDEN_MEMBERS = {
    "config.json",
    "hooks.json",
    "install-receipt.json",
    "test_bridge.py",
    "test_intent.py",
    "test_package.py",
}


class PackageTests(unittest.TestCase):
    def test_source_package_resolves_enclosing_os_root(self):
        self.assertEqual(DEFAULT_ROOT, PACKAGE.parents[3])

    def test_generated_archive_matches_exact_public_allowlist(self):
        with tempfile.TemporaryDirectory(prefix="aiverse-codex-package-") as temporary:
            archive_path = Path(temporary) / "package.zip"
            result = subprocess.run(
                [sys.executable, str(PACKAGE / "install.py"), "package", "--output", str(archive_path)],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            response = json.loads(result.stdout)
            self.assertFalse(response["includes_operator_data"])
            self.assertEqual(response["version"], "0.3.0-local")
            with zipfile.ZipFile(archive_path) as archive:
                names = set(archive.namelist())
                manifest = json.loads(archive.read("PACKAGE.json"))
                tracked_manifest = json.loads((PACKAGE / "PACKAGE.json").read_text(encoding="utf-8"))
                self.assertEqual(tracked_manifest, manifest)
                members = names - {"PACKAGE.json"}
                self.assertEqual(members, set(manifest["files"]))
                self.assertFalse(names & FORBIDDEN_MEMBERS)
                for name, expected in manifest["files"].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected, name)
                    body = archive.read(name)
                    self.assertNotIn(b"/Users/", body, name)
                    self.assertNotIn(b"ed9f739e49231284", body, name)
                self.assertEqual(manifest["id"], "ai-verse-codex-learning")
                self.assertEqual(manifest["version"], "0.3.0-local")


if __name__ == "__main__":
    unittest.main()
