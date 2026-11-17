#!/usr/bin/env python3
"""Take your OS with you: check that it is ready to move, and repair it after a move or copy.

  python3 scripts/portability.py check    is my OS ready to move? (read only)
  python3 scripts/portability.py repair   after moving, renaming or copying this folder
  python3 scripts/portability.py record   remember where this OS lives now (setup and repair do it)
  python3 scripts/portability.py move-skills   copy my own skills into my-skills inside this folder and use them there

Settings files inside the OS folder hold full paths. After a move they still name the old
folder, so helpers would read and write the old place. repair rewrites the old OS path to the
new one, keeping a backup of every changed file in .aiverse/os/moved-backups/.

Moved or renamed (the old folder is gone): paths are rewritten and everything keeps working.
Copied (the old folder still exists): paths are rewritten so the copy never touches the
original, and the copy's chat helpers are paused until the AI-Verse installer gives the copy
its own program folder. Nothing of the member's is deleted or moved.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
_keep = sys.dont_write_bytecode
sys.dont_write_bytecode = True  # never leave bytecode files in a member's OS folder
try:
    from toolchain import resolve_tool  # noqa: E402
finally:
    sys.dont_write_bytecode = _keep

ROOT = Path(__file__).resolve().parents[1]
LOCATION = ".aiverse/os/location.json"
SETTINGS = [
    ".aiverse/capability-providers.json",
    ".aiverse/brain-host.json",
    ".aiverse/brain-purpose.json",
    ".codex/hooks.json",
    ".claude/settings.local.json",
    ".aiverse/extensions/ai-verse-data/extension.json",
    ".aiverse/extensions/ai-verse-codex-learning/config.json",
    ".aiverse/extensions/ai-verse-codex-learning/hooks.json",
    ".aiverse/extensions/ai-verse-codex-learning/claude-adapter.json",
    ".aiverse/extensions/ai-verse-codex-learning/install-receipt.json",
]
HELPER_FILES = [".claude/settings.local.json", ".codex/hooks.json"]


def is_os(path: Path) -> bool:
    return (path / "AI-VERSE.yaml").is_file() and (path / "system" / "capabilities").is_dir()


def read_location(root: Path):
    try:
        data = json.loads((root / LOCATION).read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("root"), str):
            return data
    except (OSError, ValueError):
        pass
    # Installs from before this check recorded nothing; the Brain host settings name the folder.
    try:
        host = json.loads((root / ".aiverse/brain-host.json").read_text(encoding="utf-8"))
        named = host.get("cwd") or host.get("root") or host.get("os_root")
        command = host.get("command")
        if not named and isinstance(command, list) and "--root" in command[:-1]:
            named = command[command.index("--root") + 1]
        if isinstance(named, str) and Path(named).is_absolute():
            return {"schema_version": 1, "root": named, "inferred": True}
    except (OSError, ValueError):
        pass
    return None


def program_folder_id(root: Path):
    """The 16 character name of this OS's program folder, read from its own settings."""
    import re
    for rel in SETTINGS:
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        found = re.search(r"\.ai-verse-tools[/\\]+([0-9a-f]{16})(?=[/\\\"'])", text)
        if found:
            return found.group(1)
    return None


def record(root: Path, keep_id: bool = True) -> dict:
    # A permanent ID so the updater finds this OS's program folder even after a rename.
    id_file = root / ".aiverse/os/install-id"
    if keep_id and not id_file.exists():
        found = program_folder_id(root)
        if found:
            id_file.parent.mkdir(parents=True, exist_ok=True)
            id_file.write_text(found + "\n", encoding="utf-8")
    path = root / LOCATION
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {"schema_version": 1, "root": str(root), "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return data


def forms(path: str):
    """The ways a path can appear in a settings file: plain, JSON escaped, and shell quoted."""
    yield path
    escaped = json.dumps(path)[1:-1]
    if escaped != path:
        yield escaped


def replace_root(text: str, old: str, new: str) -> tuple[str, int]:
    """Replace the old OS path only where it is the whole folder (followed by /, a quote or the end)."""
    count = 0
    for old_form, new_form in zip(forms(old), forms(new)):
        out, i = [], 0
        while True:
            j = text.find(old_form, i)
            if j < 0:
                out.append(text[i:])
                break
            end = j + len(old_form)
            after = text[end:end + 1]
            if after in ("", "/", "\\", '"', "'", "\n", ",", ")", "*"):
                out.append(text[i:j] + new_form)
                count += 1
            else:
                out.append(text[i:end])
            i = end
        text = "".join(out)
    return text, count


def files_naming(root: Path, old: str):
    found = []
    for rel in SETTINGS:
        path = root / rel
        if path.is_file() and not path.is_symlink():
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                continue
            if replace_root(text, old, "\0")[1]:
                found.append(rel)
    return found


def personal_skills_root(root: Path):
    try:
        data = json.loads((root / ".aiverse/capability-providers.json").read_text(encoding="utf-8"))
        value = data.get("local_skills_root")
        return Path(value) if isinstance(value, str) else None
    except (OSError, ValueError):
        return None


def check(root: Path) -> dict:
    problems, notes = [], []
    location = read_location(root)
    if location and location["root"] != str(root):
        problems.append(f"This OS was moved or copied from {location['root']}. Run: python3 scripts/portability.py repair")
    skills = personal_skills_root(root)
    if skills and root not in skills.resolve().parents and skills.resolve() != root:
        problems.append(f"Your own skills live outside this folder ({skills}), so a copy would leave them behind. "
                        "Ask your assistant to move them into my-skills inside the OS folder.")
    elif skills:
        notes.append("Your own skills are inside this folder.")
    notes.append("Program files (the skill library, memory engine, updater) live next to this folder and are "
                 "rebuilt by the AI-Verse installer on a new computer; they are not yours to carry.")
    return {"ready": not problems, "problems": problems, "notes": notes, "root": str(root)}


def repair(root: Path) -> dict:
    location = read_location(root)
    if not location or location["root"] == str(root):
        record(root)
        return {"state": "in-place", "message": "This OS is where it was set up. Nothing to repair."}
    old = location["root"]
    copied = Path(old) != root and is_os(Path(old))
    backup = root / ".aiverse/os/moved-backups" / time.strftime("%Y%m%dT%H%M%S")
    changed = []
    for rel in files_naming(root, old):
        path = root / rel
        text = path.read_text(encoding="utf-8")
        new_text, _count = replace_root(text, old, str(root))
        (backup / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup / rel)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(new_text, encoding="utf-8")
        os.replace(tmp, path)
        changed.append(rel)
    paused = []
    if copied:
        for rel in HELPER_FILES:
            path = root / rel
            if path.is_file():
                (backup / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, backup / rel)
                os.replace(path, path.with_name(path.name + ".paused-copy"))
                paused.append(rel)
        # The original's permanent ID must not travel with a copy, or both would share one program folder.
        id_file = root / ".aiverse/os/install-id"
        if id_file.is_file():
            (backup / ".aiverse/os").mkdir(parents=True, exist_ok=True)
            os.replace(id_file, backup / ".aiverse/os/install-id")
            paused.append(".aiverse/os/install-id")
    record(root, keep_id=not copied)
    if copied:
        message = (f"This folder is a copy of {old}. It now points only at itself, and its chat helpers are paused "
                   "so they cannot touch the original. Run the AI-Verse installer in this folder to give the copy "
                   "its own program folder.")
    else:
        message = (f"This OS moved from {old}. Its settings now point here and its helpers keep working. "
                   "Next, run 'aiverse project-rebind' here so updates know the new place too.")
    return {"state": "copied" if copied else "moved", "from": old, "changed": changed, "paused": paused,
            "backup": str(backup.relative_to(root)) if changed or paused else None, "message": message}


def _tree(path: Path):
    return {p.relative_to(path).as_posix(): p.read_bytes() for p in sorted(path.rglob("*"))
            if p.is_file() and not p.is_symlink()}


def move_skills(root: Path) -> dict:
    """Copy the personal skills into <OS>/my-skills, verify every byte, then switch the setting to it.
    The old folder is left in place; nothing is deleted."""
    import subprocess
    config_file = root / ".aiverse/capability-providers.json"
    try:
        config = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"state": "unavailable", "message": "This OS has no skills setting yet; nothing to move."}
    old = Path(config.get("local_skills_root", "")).expanduser()
    new = root / "my-skills"
    if old.resolve() == new.resolve():
        return {"state": "already", "message": "Your own skills already live in my-skills inside this folder."}
    if not old.is_dir():
        return {"state": "unavailable", "message": f"Your skills folder {old} was not found; nothing moved."}
    if new.exists() and any(new.iterdir()) and _tree(new) != _tree(old):
        return {"state": "refused", "message": "my-skills already holds different files; nothing changed."}
    shutil.copytree(old, new, symlinks=False, dirs_exist_ok=True)
    if _tree(new) != _tree(old):
        return {"state": "refused", "message": "The copy did not match the original exactly; the setting was not changed."}
    before = config_file.read_bytes()
    config["local_skills_root"] = str(new)
    tmp = config_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, config_file)
    entry, managed = config.get("skills_entrypoint"), config.get("skills_root")
    if entry and Path(entry).is_file():
        result = subprocess.run([sys.executable, entry, "--root", managed, "library", "--library-root", str(new),
                                 "configure-learning", "--apply"], capture_output=True, text=True)
        if result.returncode != 0:
            config_file.write_bytes(before)
            return {"state": "refused", "message": "The skills library did not accept the new folder, so the setting "
                    "was put back. Your skills are still where they were. " + result.stderr.strip()[:300]}
    sync = root / "scripts" / "sync-my-skills.mjs"
    node = resolve_tool("node")
    if sync.is_file() and node:
        subprocess.run([node, str(sync)], capture_output=True, text=True, cwd=root)
    return {"state": "moved", "from": str(old), "to": str(new),
            "message": f"Your own skills now live in my-skills inside this folder. The old folder {old} is untouched; "
                       "delete it yourself once you have checked everything works."}


def main(argv) -> int:
    action = argv[1] if len(argv) > 1 else "check"
    as_json = "--json" in argv
    root = Path(os.environ.get("AI_VERSE_OS_ROOT") or ROOT).resolve()
    if not is_os(root):
        print("This is not an AI-Verse OS folder.", file=sys.stderr)
        return 2
    if action == "record":
        result = record(root)
    elif action == "repair":
        result = repair(root)
    elif action == "check":
        result = check(root)
    elif action == "move-skills":
        result = move_skills(root)
    else:
        print(__doc__)
        return 2
    if as_json:
        print(json.dumps(result, indent=2))
    elif action == "check":
        print("Your OS is ready to move: take this one folder." if result["ready"] else "Not ready to move yet:")
        for line in result["problems"]:
            print("  - " + line)
        for line in result["notes"]:
            print("  " + line)
    else:
        print(result.get("message", "Recorded where this OS lives."))
    return 0 if action != "check" or result["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
