"""Moving, renaming and copying an OS folder: paths follow the folder, a copy never touches the original."""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "portability.py"
checks = 0


def ok(condition, message):
    global checks
    assert condition, message
    checks += 1


def make_os(root: Path, stack: str):
    (root / "system" / "capabilities").mkdir(parents=True)
    (root / "AI-VERSE.yaml").write_text("schema_version: '2.0'\n")
    (root / "scripts").mkdir()
    shutil.copy(SCRIPT, root / "scripts" / "portability.py")
    shutil.copy(SCRIPT.with_name("toolchain.py"), root / "scripts" / "toolchain.py")
    (root / "system" / "toolchain").mkdir(parents=True, exist_ok=True)
    shutil.copy(SCRIPT.parents[1] / "system" / "toolchain" / "manifest.json", root / "system" / "toolchain" / "manifest.json")
    (root / ".aiverse").mkdir()
    (root / ".aiverse/brain-host.json").write_text(json.dumps({"cwd": str(root), "root": str(root), "python": f"{stack}/python",
        "adapter": f"{root}/scripts/ai_verse_host_adapter.py", "sibling": f"{root} 2/other"}))
    (root / ".claude").mkdir()
    (root / ".claude/settings.local.json").write_text(json.dumps({"hooks": f"{stack}/python '{root}/.aiverse/bridge.py' --root '{root}'"}))
    (root / ".codex").mkdir()
    (root / ".codex/hooks.json").write_text(json.dumps({"command": f"'{root}/.aiverse/bridge.py'"}))


def run(root, *args):
    return subprocess.run([sys.executable, str(root / "scripts" / "portability.py"), *args, "--json"],
                          capture_output=True, text=True, cwd=root)


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp).resolve()
    stack = str(base / ".ai-verse-tools" / "abc")

    # Renamed: the old folder is gone.
    old = base / "AI-Verse OS Mine"
    make_os(old, stack)
    run(old, "record")
    new = base / "AI-Verse OS Renamed"
    old.rename(new)
    ok(json.loads(run(new, "check").stdout)["ready"] is False, "a moved OS is not ready until repaired")
    result = json.loads(run(new, "repair").stdout)
    ok(result["state"] == "moved", result)
    host = json.loads((new / ".aiverse/brain-host.json").read_text())
    ok(host["root"] == str(new) and host["adapter"].startswith(str(new) + "/"), host)
    ok(host["python"] == f"{stack}/python", "program folder paths are left as they are")
    ok(host["sibling"] == f"{old} 2/other", "a different folder that only starts with the same name is untouched")
    ok(str(new) in (new / ".claude/settings.local.json").read_text(), "Claude helpers point at the new folder")
    ok(str(old) not in (new / ".codex/hooks.json").read_text(), "Codex helpers no longer name the old folder")
    ok((new / result["backup"] / ".aiverse/brain-host.json").is_file(), "originals are backed up")
    ok(json.loads(run(new, "repair").stdout)["state"] == "in-place", "a second repair changes nothing")

    # An older install with no recorded location: the old folder is read from the Brain host settings.
    legacy_old = base / "Legacy OS"
    make_os(legacy_old, stack)
    legacy_new = base / "Legacy OS moved"
    legacy_old.rename(legacy_new)
    ok(json.loads(run(legacy_new, "repair").stdout)["state"] == "moved", "works without a recorded location")

    # Copied: the original still exists.
    copy = base / "Copy of OS"
    (new / ".aiverse/os").mkdir(parents=True, exist_ok=True)
    (new / ".aiverse/os/install-id").write_text("0123456789abcdef\n")
    shutil.copytree(new, copy)
    ok((copy / ".aiverse/os/install-id").is_file(), "the copy starts with the original's ID, as a real copy would")
    result = json.loads(run(copy, "repair").stdout)
    ok(result["state"] == "copied", result)
    ok(str(new) not in (copy / ".aiverse/brain-host.json").read_text(), "the copy never names the original")
    ok(not (copy / ".claude/settings.local.json").exists() and (copy / ".claude/settings.local.json.paused-copy").exists(),
       "the copy's chat helpers are paused")
    ok(not (copy / ".aiverse/os/install-id").exists(), "the copy does not keep the original's program folder ID")
    ok((new / ".aiverse/os/install-id").is_file(), "the original keeps its program folder ID")
    ok((new / ".claude/settings.local.json").exists(), "the original is untouched")

with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp).resolve()
    root = base / "OS"
    make_os(root, str(base / "stack"))
    personal = base / "home-skills" / "my-pitch"
    personal.mkdir(parents=True)
    (personal / "SKILL.md").write_text("---\nname: my-pitch\ndescription: x\n---\n")
    (root / ".aiverse/capability-providers.json").write_text(json.dumps({"schema_version": 1, "skills_root": str(base / "stack/skills"),
                                                                         "local_skills_root": str(base / "home-skills")}))
    ok(json.loads(run(root, "check").stdout)["ready"] is False, "skills outside the folder block moving")
    result = json.loads(run(root, "move-skills").stdout)
    ok(result["state"] == "moved", result)
    ok((root / "my-skills/my-pitch/SKILL.md").is_file() and personal.is_dir(), "copied, original kept")
    ok(json.loads((root / ".aiverse/capability-providers.json").read_text())["local_skills_root"] == str(root / "my-skills"), "setting switched")
    run(root, "record")
    ok(json.loads(run(root, "check").stdout)["ready"] is True, "now ready to move")
    ok(json.loads(run(root, "move-skills").stdout)["state"] == "already", "running it again changes nothing")

with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp).resolve()
    root = base / "OS"
    make_os(root, str(base / ".ai-verse-tools" / "0123456789abcdef"))
    run(root, "record")
    ok((root / ".aiverse/os/install-id").read_text().strip() == "0123456789abcdef", "the program folder ID is kept inside the OS")

print(f"portability checks passed: {checks}")
