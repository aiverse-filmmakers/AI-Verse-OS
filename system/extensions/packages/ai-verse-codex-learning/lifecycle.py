#!/usr/bin/env python3
"""Install/remove only this extension's local Codex hook registrations."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import sys
import os
import subprocess

from bridge import Bridge, DEFAULT_ROOT, ID, VERSION, atomic_json, read_json, safe

EVENTS = ["UserPromptSubmit", "SessionStart", "PostToolUse", "Stop", "Interrupt", "SessionEnd"]


def definition(root, python, build=None):
    file = root / ".aiverse/extensions" / ID / "bridge.py"
    build = build or hashlib.sha256(file.read_bytes()).hexdigest()
    argv = [python, str(file), "--root", str(root), "--build", build, "hook"]
    command = subprocess.list2cmdline(argv) if os.name == "nt" else " ".join(shlex.quote(v) for v in argv)
    hooks = {}
    for event in EVENTS:
        handler = {"type": "command", "command": command,
                   "timeout": 3 if event in {"Interrupt", "SessionEnd"} else 30}
        if event in {"UserPromptSubmit", "SessionStart"}:
            handler.update({"additionalContextLimit": 5000, "statusMessage": "Loading AI-Verse context"})
        if event == "Stop":
            handler["statusMessage"] = "Checking AI-Verse learning review"
        group = {"hooks": [handler]}
        if event == "SessionStart":
            group["matcher"] = "startup|resume|compact|fork|clear"
        hooks[event] = [group]
    return {"description": "AI-Verse local Codex context and bounded learning review.",
            "hooks": hooks}


def is_ours(handler, root):
    if not isinstance(handler, dict) or handler.get("type") != "command":
        return False
    try:
        parts = shlex.split(handler.get("command", ""), posix=os.name != "nt")
        if os.name == "nt":
            parts = [part.strip('"') for part in parts]
    except ValueError:
        return False
    return (len(parts) == 7 and re_python(Path(parts[0]).name)
            and parts[1] == str(root / ".aiverse/extensions" / ID / "bridge.py")
            and parts[2:4] == ["--root", str(root)] and parts[4] == "--build"
            and parts[6] == "hook")


def re_python(name):
    import re
    return bool(re.fullmatch(r"python(?:\d+(?:\.\d+)*)?(?:\.exe)?", name, re.I))


def merge(existing, owned, root):
    if not isinstance(existing, dict) or not isinstance(existing.get("hooks", {}), dict):
        raise ValueError("existing Codex hook file is malformed; preserve it")
    output = {**existing, "hooks": dict(existing.get("hooks", {}))}
    for event, groups in list(output["hooks"].items()):
        if not isinstance(groups, list):
            raise ValueError("existing Codex hook groups are malformed; preserve them")
        kept = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise ValueError("existing Codex hook group is malformed; preserve it")
            handlers = [handler for handler in group["hooks"] if not is_ours(handler, root)]
            if handlers:
                kept.append({**group, "hooks": handlers})
        output["hooks"][event] = kept
    for event, groups in owned.items():
        output["hooks"].setdefault(event, []).extend(groups)
    output["hooks"] = {event: groups for event, groups in output["hooks"].items() if groups}
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("command", choices=["stage", "install", "remove"])
    args = parser.parse_args()
    root = Path(args.root).resolve()
    Bridge(root)
    entry_root = root / ".aiverse/extensions" / ID
    registry_file = root / ".aiverse/extensions/registry.json"
    registry = read_json(registry_file, root) if registry_file.exists() else {
        "schema_version": "1.0", "extensions": {}}
    if registry.get("schema_version") != "1.0" or not isinstance(registry.get("extensions"), dict):
        raise ValueError("unsupported registry; preserve it")
    generated = definition(root, sys.executable)
    target = root / ".codex/hooks.json"
    if args.command == "stage":
        atomic_json(entry_root / "hooks.json", generated, root)
    else:
        safe(target, root)
        existing = read_json(target, root) if target.exists() else {"hooks": {}}
        result = merge(existing, generated["hooks"] if args.command == "install" else {}, root)
        atomic_json(target, result, root)
    old = registry["extensions"].get(ID, {})
    registry["extensions"][ID] = {
        **old, "id": ID, "supported": True, "installed": args.command != "remove",
        "enabled": args.command != "remove", "version": VERSION,
        "source": "local-codex-lifecycle-adapter",
        "instructions": f".aiverse/extensions/{ID}/INSTRUCTIONS.md",
        "engine": f".aiverse/extensions/{ID}/bridge.py",
        "adapters": [".codex/hooks.json"] if args.command == "install" else [],
        "hook_build_sha256": hashlib.sha256((entry_root / "bridge.py").read_bytes()).hexdigest(),
        "compatibility": {"os_schema_major": 2, "codex_hooks": "command-v1"},
    }
    atomic_json(registry_file, registry, root)
    print(json.dumps({"state": args.command, "definition": str(
        entry_root / "hooks.json" if args.command == "stage" else target),
        "trust": "user review required in Codex; installer never records trust",
        "canonical_user_state_modified": False}))


if __name__ == "__main__":
    main()
