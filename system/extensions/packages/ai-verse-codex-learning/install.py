#!/usr/bin/env python3
"""Portable extension package/install/setup interface for AI-Verse Distribution."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

from bridge import Bridge, DEFAULT_ROOT, ID, VERSION, atomic_json, read_json, safe, utc
from lifecycle import claude_build, claude_definition, definition, is_ours_claude, merge

SOURCE = Path(__file__).resolve().parent
FILES = ("bridge.py", "lifecycle.py", "install.py", "maintenance.py", "inspect_runtime.py",
         "INSTRUCTIONS.md", "README.md", "REVIEW-SCHEMA.md", "SETUP.md", "intent.py", "brain_read.py", "INTENT.md")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata_for(root, explicit=None):
    candidates = [Path(explicit)] if explicit else list((root.parent / ".ai-verse-tools").glob("*/project.json"))
    matches = []
    for path in candidates:
        if path.stat().st_size > 1_000_000:
            continue
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("schema_version") == 1 and Path(value.get("project", "")).resolve() == root:
            matches.append((path, value))
    if len(matches) > 1:
        raise ValueError("multiple installation records match this project; supply the admitted metadata file")
    if explicit and not matches:
        raise ValueError("installation metadata belongs to another project")
    return matches[0][1] if matches else {}


def discover(root, options):
    metadata = metadata_for(root, options.get("metadata"))
    components = metadata.get("checks", {}).get("doctor", {}).get("components", {})
    brain = components.get("ai-verse-brain", {}).get("argv", [])
    owner_python = Path(brain[0]).parent / ("python.exe" if os.name == "nt" else "python") if brain else None
    python = options.get("python") or (str(owner_python) if owner_python and owner_python.is_file() else metadata.get("python")) or sys.executable
    # Resolving a venv symlink to its base Python loses the installed owner packages.
    python = str(Path(python).absolute())
    check_code = "import sys,sqlite3;assert sys.version_info >= (3,9)"
    if brain:
        check_code += ";import aiverse_brain"
    check = subprocess.run([python, "-c", check_code],
                           capture_output=True, timeout=10)
    if check.returncode:
        raise ValueError("setup requires Python >=3.9 with the admitted owner's packages; provision it through Distribution")
    node = options.get("node") or metadata.get("managed_node", {}).get("node") or shutil.which("node")
    if not node or not Path(node).is_file():
        raise ValueError("setup requires the project's admitted Node runtime")
    node = Path(node).resolve()
    binding_cli = root / "scripts/capability-configuration-cli.mjs"
    if binding_cli.is_file():
        result = subprocess.run([str(node), str(binding_cli), "--root", str(root)], input=json.dumps({"operation": "read"}), capture_output=True, text=True, check=True)
        binding = json.loads(result.stdout)
        if binding.get("configured"):
            options = dict(options)
            for key, value in (("skills_root", binding["skillsRoot"]), ("skills_entrypoint", binding.get("skillsEntrypoint"))):
                if value:
                    if options.get(key) and Path(options[key]).resolve() != Path(value).resolve():
                        raise ValueError("helper runtime options differ from the installation Skills binding")
                    options[key] = value
    skills = components.get("ai-verse-skills", {}).get("argv", [])
    skills_root = options.get("skills_root")
    if not skills_root and "--root" in skills:
        skills_root = skills[skills.index("--root") + 1]
    entrypoint = options.get("skills_entrypoint") or (skills[1] if len(skills) > 1 and skills[1].endswith(".py") else None)
    if bool(skills_root) != bool(entrypoint):
        raise ValueError("Skills root and admitted entrypoint must be supplied together")
    if entrypoint and (not Path(entrypoint).is_file() or not Path(skills_root).is_dir()):
        raise ValueError("Skills installation paths are unavailable")
    return {"python": python, "runtime_path": str(node.parent),
            "skills_root": str(Path(skills_root).resolve()) if skills_root else None,
            "skills_entrypoint": str(Path(entrypoint).resolve()) if entrypoint else None}


def package(output):
    manifest = {"schema_version": 1, "id": ID, "version": VERSION,
                "files": {name: sha(SOURCE / name) for name in FILES}}
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(SOURCE / name, name)
        archive.writestr("PACKAGE.json", json.dumps(manifest, indent=2) + "\n")
    return {"package": str(output), "sha256": sha(output), "version": VERSION,
            "includes_operator_data": False, "files": list(FILES)}


def install(root, options):
    root = Path(root).resolve()
    manifest = safe(root / "AI-VERSE.yaml", root, file=True).read_text(encoding="utf-8")
    if "unified-workspace" not in manifest:
        raise ValueError("target is not a compatible AI-Verse OS")
    target = root / ".aiverse/extensions" / ID
    same = SOURCE == target
    if not same:
        admitted = json.loads((SOURCE / "PACKAGE.json").read_text(encoding="utf-8"))
        if admitted.get("id") != ID or admitted.get("version") != VERSION or set(admitted.get("files", {})) != set(FILES):
            raise ValueError("invalid package manifest")
        if any(sha(safe(SOURCE / name, SOURCE, file=True)) != admitted["files"][name] for name in FILES):
            raise ValueError("package integrity mismatch")
    runtime = discover(root, options)
    ledger_path = target / "install-receipt.json"
    prior = read_json(ledger_path, root) if ledger_path.exists() else {}
    for name in FILES:
        destination = safe(target / name, root)
        if destination.exists() and not same and sha(destination) != sha(SOURCE / name):
            if prior.get("files", {}).get(name) != sha(destination):
                raise ValueError("preserve locally modified or unknown extension file: " + name)
    config_path = safe(target / "config.json", root)
    existing = read_json(config_path, root) if config_path.exists() else {}
    config = {**existing, "schema_version": 1, "enabled": existing.get("enabled", True),
              "review_mode": existing.get("review_mode", "off"),
              **{key: value for key, value in runtime.items() if key != "python"}}
    hooks_path = safe(root / ".codex/hooks.json", root)
    hooks = read_json(hooks_path, root) if hooks_path.exists() else {"hooks": {}}
    # Relocation: remove only exact owned commands recorded in the previous receipt.
    owned = set(prior.get("hook_commands", []))
    expected_handlers = {(item["event"], item["handler"]["command"]): item for item in prior.get("handlers", [])}
    for event, groups in hooks.get("hooks", {}).items():
        for group in groups:
            for handler in group["hooks"]:
                if handler.get("command") in owned:
                    expected = expected_handlers.get((event, handler["command"]))
                    if expected and (handler != expected["handler"] or
                                     {k: v for k, v in group.items() if k != "hooks"} != expected["group"]):
                        raise ValueError("preserve locally modified owned hook: " + event)
            group["hooks"] = [h for h in group["hooks"] if h.get("command") not in owned]
    generated = definition(root, runtime["python"], build=sha(SOURCE / "bridge.py"))
    hooks = merge(hooks, generated["hooks"], root)
    registry_path = safe(root / ".aiverse/extensions/registry.json", root)
    registry = read_json(registry_path, root) if registry_path.exists() else {"schema_version": "1.0", "extensions": {}}
    if registry.get("schema_version") != "1.0" or not isinstance(registry.get("extensions"), dict):
        raise ValueError("preserve unsupported extension registry")
    registry["extensions"][ID] = {**registry["extensions"].get(ID, {}), "id": ID,
        "supported": True, "installed": True, "enabled": config["enabled"], "version": VERSION,
        "source": "ai-verse-codex-learning-package", "engine": f".aiverse/extensions/{ID}/bridge.py",
        "instructions": f".aiverse/extensions/{ID}/INSTRUCTIONS.md", "adapters": [".codex/hooks.json"],
        "hook_build_sha256": sha(SOURCE / "bridge.py"),
        "compatibility": {"os_schema_major": 2, "codex_hooks": "command-v1"}}
    # All conflicts and dependencies are checked before the first write. Preserve bytes on a failed transaction.
    destinations = [target / name for name in FILES] + [config_path, hooks_path, registry_path, ledger_path]
    backup = {file: file.read_bytes() if file.exists() else None for file in destinations}
    try:
        target.mkdir(parents=True, exist_ok=True)
        if not same:
            for name in FILES:
                destination = safe(target / name, root)
                _atomic_write_bytes(destination, (SOURCE / name).read_bytes())
        atomic_json(config_path, config, root)
        atomic_json(hooks_path, hooks, root)
        atomic_json(registry_path, registry, root)
        ledger = {"schema_version": 1, "version": VERSION, "root": str(root), "python": runtime["python"],
                  "installed_at": utc(), "files": {name: sha(target / name) for name in FILES},
                  "handlers": [{"event": event, "group": {k: v for k, v in group.items() if k != "hooks"}, "handler": handler}
                               for event, groups in generated["hooks"].items() for group in groups for handler in group["hooks"]],
                  "hook_commands": [h["command"] for groups in generated["hooks"].values() for group in groups for h in group["hooks"]]}
        atomic_json(ledger_path, ledger, root)
        Bridge(root)  # Validate generated configuration through the actual runtime.
    except Exception:
        for file, data in backup.items():
            if data is None:
                file.unlink(missing_ok=True)
            else:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(data)
        raise
    return {"state": "setup-required", "installed": True, "version": VERSION,
            "trust_modified": False, "next_step": "Open Codex Settings → Hooks, review this project's six hooks, then say Done in the setup chat.",
            "review_mode": config["review_mode"], "canonical_user_state_modified": False}


def _restore_bytes(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".restore", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _atomic_write_bytes(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        if mode is not None:
            if hasattr(os, "fchmod"):
                os.fchmod(fd, mode)
            else:
                os.chmod(temporary, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def remove(root):
    """Disable this package only after proving every removed hook is still owned."""
    root = Path(root).resolve()
    registry_file = safe(root / ".aiverse/extensions/registry.json", root, file=True)
    hooks_file = safe(root / ".codex/hooks.json", root, file=True)
    receipt_file = safe(root / ".aiverse/extensions" / ID / "install-receipt.json", root, file=True)
    if not registry_file.is_file():
        if hooks_file.exists():
            from lifecycle import is_ours, merge
            hooks = read_json(hooks_file, root)
            merge(hooks, {}, root)
            if any(is_ours(handler, root)
                   for groups in hooks["hooks"].values()
                   for group in groups
                   for handler in group["hooks"]):
                raise ValueError("extension registry is missing; hook ownership cannot be verified")
        return {"state": "absent", "canonical_state_preserved": True,
                "extension_files_preserved": True, "trust_modified": False}

    registry = read_json(registry_file, root)
    if registry.get("schema_version") != "1.0" or not isinstance(registry.get("extensions"), dict):
        raise ValueError("unsupported extension registry; preserve it")
    entry = registry["extensions"].get(ID)
    if entry is None:
        raise ValueError("package registration is missing; hook ownership cannot be verified")
    if not isinstance(entry, dict) or entry.get("id", ID) != ID:
        raise ValueError("package registration is malformed; preserve it")
    if not receipt_file.is_file():
        raise ValueError("package ownership receipt is missing; preserve registered hooks")

    prior = read_json(receipt_file, root)
    commands = prior.get("hook_commands")
    handlers = prior.get("handlers")
    if (
        prior.get("schema_version") != 1
        or not isinstance(prior.get("version"), str)
        or entry.get("version") != prior.get("version")
        or not isinstance(commands, list)
        or not commands
        or any(not isinstance(command, str) or not command for command in commands)
        or not isinstance(handlers, list)
    ):
        raise ValueError("package ownership receipt is invalid; preserve registered hooks")
    owned = set(commands)
    expected = {}
    for row in handlers:
        if not isinstance(row, dict) or not isinstance(row.get("event"), str):
            raise ValueError("package hook ownership receipt is invalid; preserve registered hooks")
        group = row.get("group")
        handler = row.get("handler")
        command = handler.get("command") if isinstance(handler, dict) else None
        if (
            not isinstance(group, dict)
            or not isinstance(handler, dict)
            or command not in owned
            or (row["event"], command) in expected
        ):
            raise ValueError("package hook ownership receipt is invalid; preserve registered hooks")
        expected[(row["event"], command)] = row
    if {command for _, command in expected} != owned:
        raise ValueError("package hook ownership receipt is incomplete; preserve registered hooks")

    hooks_existed = hooks_file.exists()
    hooks = read_json(hooks_file, root) if hooks_existed else {"hooks": {}}
    from lifecycle import is_ours, merge
    merge(hooks, {}, root)  # Validate the full shared hook document before changing it.
    actual_owned = set()
    updated_hooks = {**hooks, "hooks": {}}
    for event, groups in hooks["hooks"].items():
        retained_groups = []
        for group in groups:
            metadata = {key: value for key, value in group.items() if key != "hooks"}
            retained_handlers = []
            removed_from_group = False
            for handler in group["hooks"]:
                command = handler.get("command") if isinstance(handler, dict) else None
                if command in owned:
                    recorded = expected.get((event, command))
                    if (
                        recorded is None
                        or handler != recorded["handler"]
                        or metadata != recorded["group"]
                    ):
                        raise ValueError(f"preserve locally modified owned hook: {event}")
                    actual_owned.add((event, command))
                    removed_from_group = True
                elif is_ours(handler, root):
                    raise ValueError(f"hook ownership cannot be verified: {event}")
                else:
                    retained_handlers.append(handler)
            if retained_handlers:
                retained_groups.append({**group, "hooks": retained_handlers})
            elif not removed_from_group:
                retained_groups.append(group)
        updated_hooks["hooks"][event] = retained_groups
    updated_hooks["hooks"] = {
        event: groups for event, groups in updated_hooks["hooks"].items()
        if groups or not hooks["hooks"].get(event)
    }

    if entry.get("installed") is not True and not actual_owned:
        if entry.get("enabled") is not False or entry.get("adapters") != []:
            raise ValueError("package registration is inconsistent; preserve it")
        return {"state": "absent", "canonical_state_preserved": True,
                "extension_files_preserved": True, "trust_modified": False}
    if actual_owned != set(expected):
        raise ValueError("registered hooks are incomplete; preserve package state")
    updated_registry = json.loads(json.dumps(registry))
    updated_registry["extensions"][ID].update(
        {"installed": False, "enabled": False, "adapters": []}
    )
    backups = {
        hooks_file: hooks_file.read_bytes() if hooks_existed else None,
        registry_file: registry_file.read_bytes(),
    }
    try:
        if hooks_existed:
            atomic_json(hooks_file, updated_hooks, root)
        atomic_json(registry_file, updated_registry, root)
        written_registry = read_json(registry_file, root)
        written_entry = written_registry["extensions"].get(ID, {})
        if (written_entry.get("installed") is not False
                or written_entry.get("enabled") is not False
                or written_entry.get("adapters") != []):
            raise ValueError("package removal did not verify")
    except Exception:
        for path, payload in backups.items():
            if payload is None:
                path.unlink(missing_ok=True)
            else:
                _restore_bytes(path, payload)
        raise
    return {"state": "absent", "canonical_state_preserved": True,
            "extension_files_preserved": True, "trust_modified": False}


# ---------------------------------------------------------------------------
# Claude Code adapter: manages only ROOT/.claude/settings.local.json and one record file.
# It never touches .codex/, the shared registry entry, the install receipt or config.json.
# ---------------------------------------------------------------------------
CLAUDE_SUBCOMMANDS = ("review", "sources", "query", "intent")


def claude_paths(root):
    return (root / ".claude/settings.local.json",
            root / ".aiverse/extensions" / ID / "claude-adapter.json")


def _package_verified(root):
    try:
        registry = read_json(root / ".aiverse/extensions/registry.json", root)
        entry = registry.get("extensions", {}).get(ID, {})
        receipt = read_json(root / f".aiverse/extensions/{ID}/install-receipt.json", root)
        expected = {name: sha(SOURCE / name) for name in FILES}
        installed = {name: sha(safe(root / f".aiverse/extensions/{ID}" / name, root, file=True)) for name in FILES}
        return (isinstance(entry, dict) and entry.get("id") == ID and entry.get("installed") is True
                and entry.get("version") == VERSION and receipt.get("files") == expected and installed == expected)
    except (OSError, ValueError):
        return False


def _claude_load(path, root):
    """Return (bytes or None, parsed object). A file that is not a JSON object is refused untouched."""
    if not path.exists():
        return None, {}
    raw = safe(path, root, file=True).read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ValueError("existing Claude settings file is not valid JSON; preserve it")
    if not isinstance(value, dict):
        raise ValueError("existing Claude settings file is not a JSON object; preserve it")
    if "hooks" in value and not isinstance(value["hooks"], dict):
        raise ValueError("existing Claude hooks are malformed; preserve them")
    permissions = value.get("permissions", {})
    if not isinstance(permissions, dict) or not isinstance(permissions.get("allow", []), list):
        raise ValueError("existing Claude permissions are malformed; preserve them")
    for event, groups in value.get("hooks", {}).items():
        if not isinstance(groups, list) or any(not isinstance(g, dict) or not isinstance(g.get("hooks"), list)
                                               for g in groups):
            raise ValueError("existing Claude hook groups are malformed; preserve them")
    return raw, value


def _claude_dump(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _claude_rules(root, python):
    prefix = " ".join(shlex.quote(v) for v in [python, str(root / ".aiverse/extensions" / ID / "bridge.py"),
                                               "--harness", "claude"])
    folder = (root / "runtime/codex-learning/claude-input").as_posix()
    rules = [f"Bash({prefix} {name}:*)" for name in CLAUDE_SUBCOMMANDS]
    rules.append(f"Edit(/{folder}/**)")
    return rules


def _strip_ours(hooks, root):
    for event, groups in list(hooks.items()):
        kept = []
        for group in groups:
            handlers = [h for h in group["hooks"] if not is_ours_claude(h, root)]
            if handlers:
                kept.append({**group, "hooks": handlers})
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]


def _claude_write(settings_file, record_file, settings_bytes, record):
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_bytes(settings_file, settings_bytes)
    _atomic_write_bytes(record_file, (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def _claude_rollback(settings_file, record_file, before_settings, before_record):
    for path, payload in ((settings_file, before_settings), (record_file, before_record)):
        if payload is None:
            path.unlink(missing_ok=True)
        else:
            _restore_bytes(path, payload)


def claude_install(root, options):
    root = Path(root).resolve()
    if not _package_verified(root):
        raise ValueError("install the learning package first (install) and make sure its files match the package")
    settings_file, record_file = claude_paths(root)
    safe(settings_file, root)
    safe(record_file, root)
    receipt = read_json(root / f".aiverse/extensions/{ID}/install-receipt.json", root)
    python = str(Path(options.get("python") or receipt.get("python") or sys.executable).absolute())
    build = sha(root / f".aiverse/extensions/{ID}/bridge.py")
    before_settings, settings = _claude_load(settings_file, root)
    before_record = record_file.read_bytes() if record_file.exists() else None
    record = json.loads(before_record) if before_record else None
    if record is not None and (not isinstance(record, dict) or record.get("schema_version") != 1):
        raise ValueError("unsupported Claude adapter record; preserve it")

    if record is None:
        permissions = settings.get("permissions", {})
        record = {"schema_version": 1,
                  "original": ({"absent": True} if before_settings is None
                               else {"bytes_base64": base64.b64encode(before_settings).decode("ascii")}),
                  "original_auto_memory": ({"present": True, "value": settings["autoMemoryEnabled"]}
                                           if "autoMemoryEnabled" in settings else {"present": False}),
                  "added_allow_rules": [], "exact_restore_ok": True}
    elif before_settings is None or sha_bytes(before_settings) != record.get("settings_sha256"):
        record["exact_restore_ok"] = False

    hooks = settings.setdefault("hooks", {}) if "hooks" in settings else {}
    _strip_ours(hooks, root)
    generated = claude_definition(root, python, build=build)
    for event, groups in generated["hooks"].items():
        hooks.setdefault(event, []).extend(groups)
    settings["hooks"] = hooks

    permissions = settings.setdefault("permissions", {})
    allow = permissions.setdefault("allow", [])
    desired = _claude_rules(root, python)
    previously_ours = [rule for rule in record["added_allow_rules"] if rule in allow]
    for rule in previously_ours:
        if rule not in desired:
            allow.remove(rule)
    added = [rule for rule in record["added_allow_rules"] if rule in desired and rule in allow]
    for rule in desired:
        if rule not in allow:
            allow.append(rule)
            added.append(rule)
    record["added_allow_rules"] = added
    settings["autoMemoryEnabled"] = False

    record.update({"written_hooks": generated["hooks"], "written_auto_memory": False, "build": build,
                   "python": python, "updated_at": utc()})
    data = _claude_dump(settings)
    record["settings_sha256"] = sha_bytes(data)
    try:
        _claude_write(settings_file, record_file, data, record)
    except Exception:
        _claude_rollback(settings_file, record_file, before_settings, before_record)
        raise
    return {"state": "installed", "settings": str(settings_file), "build": build,
            "allow_rules_added": list(added), "auto_memory": "off for this project",
            "exact_restore_ok": record["exact_restore_ok"], "codex_modified": False,
            "next_step": "Start a new Claude Code chat from this folder. The first time, Claude Code may ask you to trust the folder."}


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def claude_remove(root):
    root = Path(root).resolve()
    settings_file, record_file = claude_paths(root)
    safe(settings_file, root)
    safe(record_file, root)
    if not record_file.exists():
        return {"state": "absent", "message": "No Claude adapter record; nothing was changed."}
    before_record = record_file.read_bytes()
    record = json.loads(before_record)
    before_settings, settings = _claude_load(settings_file, root)
    left_in_place = []
    if record.get("exact_restore_ok") is True and before_settings is not None \
            and sha_bytes(before_settings) == record.get("settings_sha256"):
        if record["original"].get("absent"):
            settings_file.unlink(missing_ok=True)
        else:
            _atomic_write_bytes(settings_file, base64.b64decode(record["original"]["bytes_base64"]))
        mode = "exact"
    else:
        mode = "selective"
        original_bytes = None if record["original"].get("absent") else base64.b64decode(record["original"]["bytes_base64"])
        original = json.loads(original_bytes) if original_bytes else {}
        written = {event: [h for g in groups for h in g["hooks"]] for event, groups in record.get("written_hooks", {}).items()}
        hooks = settings.get("hooks", {})
        for event, groups in list(hooks.items()):
            kept = []
            for group in groups:
                handlers = []
                for handler in group["hooks"]:
                    if is_ours_claude(handler, root):
                        if handler in written.get(event, []):
                            continue
                        left_in_place.append(f"hook {event} (changed after install)")
                    handlers.append(handler)
                if handlers:
                    kept.append({**group, "hooks": handlers})
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
        if "hooks" in settings and not hooks and "hooks" not in original:
            del settings["hooks"]
        permissions = settings.get("permissions", {})
        allow = permissions.get("allow", [])
        for rule in record.get("added_allow_rules", []):
            if rule in allow:
                allow.remove(rule)
        if "allow" in permissions and not allow and "allow" not in original.get("permissions", {}):
            del permissions["allow"]
        if "permissions" in settings and not permissions and "permissions" not in original:
            del settings["permissions"]
        if settings.get("autoMemoryEnabled") == record.get("written_auto_memory") and "autoMemoryEnabled" in settings:
            previous = record.get("original_auto_memory", {})
            if previous.get("present"):
                settings["autoMemoryEnabled"] = previous["value"]
            else:
                del settings["autoMemoryEnabled"]
        elif "autoMemoryEnabled" in settings:
            left_in_place.append("autoMemoryEnabled (changed after install)")
        if settings or before_settings is not None:
            if not settings and original_bytes is None:
                settings_file.unlink(missing_ok=True)
            else:
                _atomic_write_bytes(settings_file, _claude_dump(settings))
    try:
        record_file.unlink()
    except Exception:
        _claude_rollback(settings_file, record_file, before_settings, before_record)
        raise
    return {"state": "removed", "restore": mode, "left_in_place": left_in_place, "codex_modified": False}


def claude_doctor(root, python=None):
    root = Path(root).resolve()
    settings_file, record_file = claude_paths(root)
    result = {"state": "setup-required", "package_files_verified": _package_verified(root),
              "hooks_present": 0, "hooks_expected": 5, "build_matches": None, "allow_rules_missing": [],
              "auto_memory_off": False, "exact_restore_ok": None, "execution_observed": False,
              "review_observed": False, "guidance": []}
    try:
        _, settings = _claude_load(settings_file, root)
    except (OSError, ValueError) as error:
        result["guidance"].append(str(error))
        return result
    if record_file.exists():
        result["exact_restore_ok"] = read_json(record_file, root).get("exact_restore_ok")
    bridge = root / f".aiverse/extensions/{ID}/bridge.py"
    build = sha(bridge) if bridge.is_file() else None
    builds = set()
    for event, groups in settings.get("hooks", {}).items():
        for group in groups:
            for handler in group["hooks"]:
                if is_ours_claude(handler, root):
                    result["hooks_present"] += 1
                    builds.add(claude_build(handler))
    result["build_matches"] = (builds == {build}) if builds else None
    python = python or (read_json(record_file, root).get("python") if record_file.exists() else None)
    if python:
        allow = settings.get("permissions", {}).get("allow", [])
        result["allow_rules_missing"] = [rule for rule in _claude_rules(root, python) if rule not in allow]
    else:
        result["allow_rules_missing"] = ["unknown (no record)"]
    result["auto_memory_off"] = settings.get("autoMemoryEnabled") is False
    events = root / "runtime/codex-learning/events.jsonl"
    if events.exists() and events.stat().st_size <= 4_000_000 and build:
        rows = []
        for line in events.read_text(encoding="utf-8").splitlines()[-5000:]:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        claude_rows = [r for r in rows if r.get("harness") == "claude" and r.get("build") == build]
        result["execution_observed"] = any(r.get("event") == "UserPromptSubmit" for r in claude_rows)
        result["review_observed"] = any(r.get("event") == "review" and r.get("state") == "reviewed" for r in claude_rows)
    if builds and result["build_matches"] is False:
        result["state"] = "refresh-needed"
        result["guidance"].append("The Claude hooks point at an older build: run claude-install again to refresh.")
    elif (result["package_files_verified"] and result["hooks_present"] == 5 and not result["allow_rules_missing"]
          and result["auto_memory_off"] and result["build_matches"]):
        result["state"] = "ready" if result["execution_observed"] and result["review_observed"] else "installed"
        if result["state"] == "installed":
            result["guidance"].append("Hooks are in place. Open a new Claude Code chat in this folder to see them run.")
    else:
        result["guidance"].append("Run claude-install to set up the Claude Code hooks, permissions and memory switch.")
    return result


def setup(root, codex=None):
    root = Path(root).resolve()
    bridge = Bridge(root, create_runtime=False)
    package_files_verified = False
    installed_version = None
    extension_entry = {}
    try:
        registry = read_json(root / ".aiverse/extensions/registry.json", root)
        entry = registry.get("extensions", {}).get(ID, {})
        extension_entry = entry if isinstance(entry, dict) else {}
        receipt = read_json(root / f".aiverse/extensions/{ID}/install-receipt.json", root)
        installed_version = extension_entry.get("version")
        expected_files = {name: sha(SOURCE / name) for name in FILES}
        installed_files = {
            name: sha(safe(root / f".aiverse/extensions/{ID}" / name, root, file=True))
            for name in FILES
        }
        package_files_verified = (
            extension_entry.get("id") == ID
            and extension_entry.get("supported") is True
            and extension_entry.get("installed") is True
            and installed_version == VERSION
            and receipt.get("version") == VERSION
            and receipt.get("files") == expected_files
            and installed_files == expected_files
        )
    except (OSError, ValueError):
        pass
    enabled = extension_entry.get("enabled") is True and bridge.config["enabled"] is True
    result = {"state": "setup-required", "installed": extension_entry.get("installed") is True,
              "enabled": enabled,
              "version": VERSION, "installed_version": installed_version,
              "package_files_verified": package_files_verified,
              "review_mode": bridge.config["review_mode"], "project": root.name,
              "approval_required": None, "execution_observed": False, "review_observed": False,
              "guidance": (SOURCE / "SETUP.md").read_text(encoding="utf-8").replace(
                  "[your AI-Verse project]", root.name
              )}
    executable = codex or shutil.which("codex")
    if executable:
        from inspect_runtime import inspect
        try:
            observed = inspect(root, codex=executable)
            hooks = [h for row in observed.get("hooks", {}).get("result", {}).get("data", [])
                     for h in row.get("hooks", []) if h.get("sourcePath") == str(root / ".codex/hooks.json")
                     and f".aiverse/extensions/{ID}/bridge.py" in h.get("command", "").replace("\\", "/")]
            result["hooks_discovered"] = len(hooks)
            result["handlers_enabled"] = len(hooks) == 6 and all(h.get("enabled") is True for h in hooks)
            result["approval_required"] = any(h.get("trustStatus") != "trusted" for h in hooks) if hooks else None
        except (OSError, ValueError, RuntimeError, TimeoutError):
            result["discovery"] = "unavailable; keep setup pending"
    events = root / "runtime/codex-learning/events.jsonl"
    if events.exists() and events.stat().st_size <= 4_000_000:
        rows = [json.loads(s) for s in events.read_text(encoding="utf-8").splitlines()[-5000:]]
        rows = [r for r in rows if r.get("harness", "codex") == "codex"]
        build = sha(root / f".aiverse/extensions/{ID}/bridge.py")
        result["execution_observed"] = any(r.get("build") == build and r.get("event") == "UserPromptSubmit" for r in rows)
        result["review_observed"] = any(
            r.get("build") == build and r.get("event") == "review" and r.get("state") == "reviewed"
            for r in rows
        )
    if (result["package_files_verified"] and result["enabled"] and result.get("handlers_enabled")
            and result["approval_required"] is False and result["execution_observed"] and result["review_observed"]):
        result["state"] = "ready"
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["package", "install", "setup", "doctor", "descriptor", "remove",
                                       "claude-install", "claude-doctor", "claude-remove"])
    p.add_argument("--root", default=str(DEFAULT_ROOT))
    p.add_argument("--output")
    for name in ("metadata", "python", "node", "skills-root", "skills-entrypoint", "codex"):
        p.add_argument("--" + name)
    p.add_argument("--json", action="store_true")
    args = p.parse_args()
    options = vars(args)
    root = Path(args.root).resolve()
    try:
        if args.command == "package":
            if not args.output:
                p.error("package requires --output")
            result = package(args.output)
        elif args.command == "install":
            result = install(root, options)
        elif args.command == "remove":
            result = remove(root)
        elif args.command == "claude-install":
            result = claude_install(root, options)
        elif args.command == "claude-remove":
            result = claude_remove(root)
        elif args.command == "claude-doctor":
            result = claude_doctor(root, args.python)
        else:
            result = setup(root, args.codex)
            if args.command == "descriptor":
                result.update({"component_id": ID, "version": VERSION,
                    "owner": ID, "os_schema_major": 2, "public_commands": ["install", "setup", "doctor", "descriptor", "remove"],
                    "authority_transfer": False, "preserves_canonical_state": True,
                    "platform_status": {"macos": "local runtime checked", "linux": "implementation; native release test required", "windows": "implementation; native release test required"}})
        if args.json or args.command not in {"setup", "doctor"}:
            print(json.dumps(result))
        else:
            print(result["guidance"].replace("[your AI-Verse project]", root.name))
            print("\nObserved setup state: " + result["state"])
        return 0
    except Exception as error:
        print(json.dumps({"state": "setup-required", "ok": False, "error": str(error)[:300]}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
