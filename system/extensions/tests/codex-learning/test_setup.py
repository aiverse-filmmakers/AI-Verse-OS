"""Read-only setup evidence checks for the optional Codex package."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

TEST_DIR = Path(__file__).resolve().parent
PACKAGE = TEST_DIR.parents[1] / "packages" / "ai-verse-codex-learning"
sys.path.insert(0, str(PACKAGE))
from install import FILES, ID, SOURCE, VERSION, setup


class SetupTests(unittest.TestCase):
    def fixture(self, root: Path):
        root.mkdir()
        (root / "AI-VERSE.yaml").write_text('architecture: unified-workspace\n', encoding="utf-8")
        extension = root / ".aiverse/extensions" / ID
        extension.mkdir(parents=True)
        for name in FILES:
            (extension / name).write_bytes((SOURCE / name).read_bytes())
        files = {
            name: hashlib.sha256((extension / name).read_bytes()).hexdigest()
            for name in FILES
        }
        (extension / "install-receipt.json").write_text(json.dumps({"version": VERSION, "files": files}), encoding="utf-8")
        registry = {
            "schema_version": "1.0",
            "extensions": {ID: {"id": ID, "supported": True, "installed": True, "enabled": True,
                                 "version": VERSION}},
        }
        (root / ".aiverse/extensions/registry.json").write_text(json.dumps(registry), encoding="utf-8")
        return extension

    def observed_hooks(self, root: Path):
        bridge = (root / ".aiverse/extensions" / ID / "bridge.py").as_posix()
        hooks = [
            {
                "sourcePath": str(root / ".codex/hooks.json"),
                "command": f"python {bridge} hook",
                "enabled": True,
                "trustStatus": "trusted",
            }
            for _ in range(6)
        ]
        return {"hooks": {"result": {"data": [{"hooks": hooks}]}}}

    def test_setup_check_does_not_create_runtime_or_claim_ready_without_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "AI-Verse"
            self.fixture(root)
            root = root.resolve()
            runtime = root / "runtime/codex-learning"
            build = hashlib.sha256((PACKAGE / "bridge.py").read_bytes()).hexdigest()
            with patch("install.shutil.which", return_value=None):
                result = setup(root)
            self.assertEqual(result["state"], "setup-required")
            self.assertNotIn("[your AI-Verse project]", result["guidance"])
            self.assertIn("AI-Verse project", result["guidance"])
            self.assertFalse(result["execution_observed"])
            self.assertFalse(result["review_observed"])
            self.assertFalse(runtime.exists())

            events = runtime / "events.jsonl"
            events.parent.mkdir(parents=True)
            events.write_text("\n".join([
                json.dumps({"build": build, "event": "UserPromptSubmit", "turn": "turn-1"}),
                json.dumps({"build": build, "event": "review", "turn": "turn-1", "state": "interrupted"}),
            ]) + "\n", encoding="utf-8")
            before = events.read_bytes()
            with patch("install.shutil.which", return_value="codex"), patch(
                "inspect_runtime.inspect", return_value=self.observed_hooks(root)
            ):
                result = setup(root)
            self.assertEqual(result["state"], "setup-required")
            self.assertTrue(result["execution_observed"])
            self.assertFalse(result["review_observed"])
            self.assertEqual(events.read_bytes(), before)

    def test_setup_ready_requires_reviewed_original_turn_and_all_host_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "AI-Verse"
            self.fixture(root)
            root = root.resolve()
            runtime = root / "runtime/codex-learning"
            runtime.mkdir(parents=True)
            build = hashlib.sha256((PACKAGE / "bridge.py").read_bytes()).hexdigest()
            events = runtime / "events.jsonl"
            events.write_text("\n".join([
                json.dumps({"build": build, "event": "UserPromptSubmit", "turn": "turn-1"}),
                json.dumps({"build": build, "event": "review", "turn": "turn-1", "state": "reviewed"}),
            ]) + "\n", encoding="utf-8")
            before = events.read_bytes()
            with patch("install.shutil.which", return_value="codex"), patch(
                "inspect_runtime.inspect", return_value=self.observed_hooks(root)
            ):
                result = setup(root)
            self.assertEqual(result["state"], "ready", result)
            self.assertTrue(result["package_files_verified"])
            self.assertEqual(result["hooks_discovered"], 6)
            self.assertTrue(result["handlers_enabled"])
            self.assertFalse(result["approval_required"])
            self.assertTrue(result["execution_observed"])
            self.assertTrue(result["review_observed"])
            self.assertEqual(events.read_bytes(), before)

            (root / ".aiverse/extensions" / ID / "maintenance.py").write_text("tampered\n", encoding="utf-8")
            with patch("install.shutil.which", return_value="codex"), patch(
                "inspect_runtime.inspect", return_value=self.observed_hooks(root)
            ):
                result = setup(root)
            self.assertEqual(result["state"], "setup-required")
            self.assertFalse(result["package_files_verified"])


if __name__ == "__main__":
    unittest.main()
