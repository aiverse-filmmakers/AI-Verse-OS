"""The reality check runs on a bare OS folder, writes nothing outside .aiverse/reality-check and reports plainly."""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "reality-check.py"


def run(root, *args):
    return subprocess.run([sys.executable, str(root / "scripts" / "reality-check.py"), *args],
                          capture_output=True, text=True, cwd=root, check=True)


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / "scripts").mkdir()
    shutil.copy(SOURCE, root / "scripts" / "reality-check.py")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    before = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if ".git" not in p.parts)

    text = run(root).stdout
    assert text.startswith("AI-Verse reality check"), text
    assert "Original chats are saved locally" in text, text
    assert "private chat saving is off" in text, text

    payload = json.loads(run(root, "--json").stdout)
    titles = {item["title"] for item in payload["results"]}
    assert "Original chats are saved locally" in titles, payload
    assert payload["problems"] == sum(1 for item in payload["results"] if not item["ok"]), payload

    archive = root / "archives" / "private-chat-history" / "v1"
    archive.mkdir(parents=True)
    (archive / "chat.jsonl").write_text("{}\n")
    payload = json.loads(run(root, "--json").stdout)
    archive_result = next(item for item in payload["results"] if item["title"] == "Original chats are saved locally")
    assert archive_result["ok"], archive_result

    after = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if ".git" not in p.parts)
    created = set(after) - set(before)
    assert all(path.startswith("archives") or path.startswith(".aiverse/reality-check") for path in created), created

print("reality-check: 4 checks passed")
