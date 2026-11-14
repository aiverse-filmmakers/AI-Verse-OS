"""Tidy spots a note made out of date by a newer one about the same thing, and only proposes setting it aside."""
import sys
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"
sys.path.insert(0, str(PKG))
import bridge  # noqa: E402
import reflect  # noqa: E402


def tidy():
    t = reflect.Tidy.__new__(reflect.Tidy)
    t.m = bridge
    return t


def rec(i, text, created, scope="operator", kind="fact"):
    return {"id": f"m{i}", "scope": scope, "type": kind, "status": "active", "text": text, "created": created, "tags": ""}


class OutdatedTests(unittest.TestCase):
    def test_newer_numbers_make_the_older_note_out_of_date(self):
        scan = {"records": [rec(1, "My freelance post rate is 300 pounds per post", "2026-09-01"),
                            rec(2, "My freelance post rate is 350 pounds per post", "2026-10-15"),
                            rec(3, "Bogdan trains jiu jitsu three times weekly", "2026-10-01")]}
        items = tidy().outdated({"rejected": []}, scan, [])
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual((item["kind"], item["records"][0]["id"], item["newer_id"]), ("old", "m1", "m2"))
        self.assertIn("350", item["facts"][1])
        self.assertFalse(item["traced"], "always shown as a guess")

    def test_same_numbers_other_projects_and_rejected_items_are_left_alone(self):
        t = tidy()
        same = {"records": [rec(1, "My freelance post rate is 350 pounds per post", "2026-09-01"),
                            rec(2, "My freelance post rate is 350 pounds per post now", "2026-10-15")]}
        self.assertEqual(t.outdated({"rejected": []}, same, []), [])
        other = {"records": [rec(1, "Project budget total is 5000 pounds", "2026-09-01", scope="workspace:beta"),
                             rec(2, "Project budget total is 7000 pounds", "2026-10-15", scope="workspace:beta")]}
        self.assertEqual(t.outdated({"rejected": []}, other, []), [], "a project this chat cannot read is skipped")
        self.assertEqual(len(t.outdated({"rejected": []}, other, ["beta"])), 1)
        key = t.rejected("old", "beta", ["m1"])
        self.assertEqual(t.outdated({"rejected": [{"key": key}]}, other, ["beta"]), [], "an undone change is not offered again")

    def test_corrections_and_notes_without_numbers_are_ignored(self):
        scan = {"records": [rec(1, "My freelance post rate is 300 pounds", "2026-09-01", kind="correction"),
                            rec(2, "My freelance post rate is 350 pounds", "2026-10-15"),
                            rec(3, "I prefer short direct replies always", "2026-09-01"),
                            rec(4, "I prefer short direct replies mostly", "2026-10-01")]}
        self.assertEqual(tidy().outdated({"rejected": []}, scan, []), [])


if __name__ == "__main__":
    unittest.main()
