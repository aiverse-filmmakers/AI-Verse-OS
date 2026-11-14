"""Skill use is detected from tool calls and recorded through the Skills owner, never blocking a chat."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"))
import bridge  # noqa: E402


class SkillUsageTests(unittest.TestCase):
    def test_claude_skill_tool_and_codex_skill_reads_are_detected(self):
        self.assertEqual(bridge.used_skill({"tool_name": "Skill", "tool_input": {"skill": "copywriting"}}), "copywriting")
        self.assertEqual(bridge.used_skill({"tool_name": "Skill", "tool_input": {"command": "/ai-realism"}}), "ai-realism")
        self.assertEqual(bridge.used_skill({"tool_name": "Read", "tool_input": {
            "file_path": "/os/.claude/skills/ai-realism/SKILL.md"}}), "ai-realism")
        self.assertEqual(bridge.used_skill({"tool_name": "Bash", "tool_input": {
            "command": "sed -n 1,80p .agents/skills/action-items/SKILL.md"}}), "action-items")
        self.assertEqual(bridge.used_skill({"tool_name": "Bash", "tool_input": {
            "command": "cat /os/.agents/skills/action-items/SKILL.md"}}), "action-items")
        self.assertEqual(bridge.used_skill({"tool_name": "exec_command", "tool_input": {
            "cmd": ["cat", "C:\\os\\.agents\\skills\\copywriting\\SKILL.md"]}}), "copywriting")

    def test_other_tool_calls_and_unsafe_names_are_ignored(self):
        self.assertIsNone(bridge.used_skill({"tool_name": "Read", "tool_input": {"file_path": "/os/notes.md"}}))
        self.assertIsNone(bridge.used_skill({"tool_name": "Skill", "tool_input": {"skill": "plugin:thing"}}))
        self.assertIsNone(bridge.used_skill({"tool_name": "Skill", "tool_input": {"skill": "../escape"}}))
        self.assertIsNone(bridge.used_skill({"tool_name": "Read"}))

    def test_recording_without_a_skills_owner_is_a_quiet_no_op(self):
        self.assertFalse(bridge.record_skill_use({"skills_entrypoint": None}, "copywriting"))
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope.py"
            self.assertFalse(bridge.record_skill_use({"skills_entrypoint": str(missing)}, "copywriting"))

    def test_recording_calls_the_skills_usage_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "calls.txt"
            fake = Path(tmp) / "aiverse_skills.py"
            fake.write_text("import sys\nopen(%r, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n" % str(log))
            self.assertTrue(bridge.record_skill_use({"skills_entrypoint": str(fake), "skills_root": "/r"}, "copywriting"))
            self.assertEqual(log.read_text().strip(), "--root /r usage record copywriting --json")



class ProjectSkillNotesTests(unittest.TestCase):
    def project(self, tmp, notes):
        root = Path(tmp)
        base = root / "workspaces" / "alpha"
        folder = base / "context" / "skill-adjustments"
        folder.mkdir(parents=True)
        (base / "WORKSPACE.yaml").write_text("id: alpha\n")
        for name, text in notes.items():
            (folder / f"{name}.md").write_text(text)
        return root

    def test_skill_note_and_other_note_names_are_attached(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.project(tmp, {"copywriting": "Dry tone, no hype.", "marketing": "Price 99."})
            text = bridge.project_skill_notes(root, "workspace:alpha", "copywriting")
            self.assertIn("Dry tone, no hype.", text)
            self.assertIn("follow the project adjustments", text)
            self.assertIn("also has notes on: marketing", text)
            self.assertNotIn("Price 99.", text)

    def test_other_notes_are_named_even_without_a_skill_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.project(tmp, {"marketing": "Price 99."})
            text = bridge.project_skill_notes(root, "workspace:alpha", "social-content")
            self.assertIn("also has notes on: marketing", text)

    def test_no_project_or_no_notes_attaches_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self.project(tmp, {})
            self.assertIsNone(bridge.project_skill_notes(root, "workspace:alpha", "copywriting"))
            self.assertIsNone(bridge.project_skill_notes(root, "operator", "copywriting"))
            self.assertIsNone(bridge.project_skill_notes(root, "workspace:../x", "copywriting"))
            self.assertIsNone(bridge.project_skill_notes(root, "workspace:missing", "copywriting"))

    def test_a_redirected_notes_folder_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as elsewhere:
            root = Path(tmp)
            base = root / "workspaces" / "alpha"
            (base / "context").mkdir(parents=True)
            (base / "WORKSPACE.yaml").write_text("id: alpha\n")
            (Path(elsewhere) / "copywriting.md").write_text("secret")
            (base / "context" / "skill-adjustments").symlink_to(elsewhere)
            self.assertIsNone(bridge.project_skill_notes(root, "workspace:alpha", "copywriting"))


if __name__ == "__main__":
    unittest.main()
