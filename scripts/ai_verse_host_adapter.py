#!/usr/bin/env python3
"""Supported AI-Verse OS host adapter for AI-Verse Brain.

The adapter owns no canonical component state.  It is intentionally usable with
AI-Verse OS alone and discovers optional Memory, Skills and Data capabilities at
runtime.  Optional components may be installed before or after the host config
is created; the config never points at a source checkout.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable, Dict, Iterable, Mapping, Optional
from uuid import uuid4

PROTOCOL = "ai-verse-brain-bridge/1.0"
ADAPTER_ID = "ai-verse-os:host"
LEGACY_ADAPTER_ID = "ai-verse-os:four-component-host"
BASE_OPERATIONS = [
    "read_context",
    "retrieve_history",
    "list_capabilities",
    "list_connections",
    "authorize_action",
    "request_action",
]
DATA_OPERATION = "query_data"
_SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_MAX_SKILL_BYTES = 256 * 1024
_MAX_REGISTRY_BYTES = 1024 * 1024
_EXTENSION_REGISTRY = Path(".aiverse/extensions/registry.json")
_DEFAULT_SKILLS_ROOT = Path.home() / ".aiverse" / "skills"
_DEFAULT_LOCAL_SKILLS_ROOT = Path.home() / ".aiverse" / "local-skills"
_DATA_READ_OPERATIONS = {
    "data.space.list",
    "data.space.get",
    "data.schema.list",
    "data.schema.get",
    "data.schema.migration.preview",
    "data.record.get",
    "data.record.list",
    "data.query",
    "data.aggregate",
    "data.bulk.preview",
    "data.events.list",
    "data.doctor",
    "data.status",
}


class AdapterError(RuntimeError):
    pass


def _json_object(raw: str, label: str) -> Dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AdapterError(f"{label} returned invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise AdapterError(f"{label} must return a JSON object")
    return value


def _run_json(command: Iterable[str], payload: Mapping[str, Any], label: str) -> Dict[str, Any]:
    proc = subprocess.run(
        list(command),
        input=json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":")),
        text=True,
        capture_output=True,
        shell=False,
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        raise AdapterError(f"{label} failed: {detail}")
    return _json_object(proc.stdout, label)


def _load_module(path: Path, name: str):
    if not path.is_file() or path.is_symlink():
        raise AdapterError(f"required component is missing or unsafe: {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AdapterError(f"cannot load component: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _fingerprint(request: Mapping[str, Any]) -> str:
    keys = (
        "action_class",
        "scope",
        "operation",
        "parameters",
        "idempotency_key",
        "in_scope",
        "within_budget",
        "reversible",
        "reason",
    )
    data = {key: request.get(key) for key in keys}
    raw = json.dumps(
        data,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _yaml_scalar(raw: str) -> Any:
    value = raw.strip()
    if not value:
        return None
    if value in {"true", "True"}:
        return True
    if value in {"false", "False"}:
        return False
    if value in {"null", "Null", "~"}:
        return None
    if value.startswith('"') and value.endswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value[1:-1]
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if value.startswith("[") and value.endswith("]"):
        body = value[1:-1].strip()
        if not body:
            return []
        return [_yaml_scalar(item) for item in body.split(",")]
    return value


class AIverseOSHost:
    def __init__(
        self,
        root: Path,
        skills_root: Optional[Path] = None,
        skills_entrypoint: Optional[Path] = None,
        local_skills_root: Optional[Path] = None,
        after_pin: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.skills_root = (
            Path(skills_root).expanduser().resolve()
            if skills_root is not None
            else _DEFAULT_SKILLS_ROOT.expanduser().resolve()
        )
        # Kept only for backward-compatible constructor/config parsing.  Runtime
        # execution no longer depends on a Skills source checkout.
        self.skills_entrypoint = (
            Path(skills_entrypoint).expanduser().resolve()
            if skills_entrypoint is not None
            else None
        )
        self.local_skills_root = (
            Path(local_skills_root).expanduser().resolve()
            if local_skills_root is not None
            else _DEFAULT_LOCAL_SKILLS_ROOT.expanduser().resolve()
        )
        self.after_pin = after_pin
        manifest = self.root / "AI-VERSE.yaml"
        if not manifest.is_file() or manifest.is_symlink():
            raise AdapterError(f"AI-Verse OS root not found: {self.root}")

    @property
    def resolver_cli(self) -> Path:
        return self.root / "scripts" / "capability-resolver-cli.mjs"

    @property
    def current_context_cli(self) -> Path:
        return self.root / "scripts" / "current-context.mjs"

    @property
    def permission_cli(self) -> Path:
        return self.root / "scripts" / "action-permission.mjs"

    @property
    def data_host_cli(self) -> Path:
        return self.root / "scripts" / "data-host.mjs"

    def _safe_repo_file(self, relative: Any, label: str) -> Path:
        if (
            not isinstance(relative, str)
            or not relative
            or "\x00" in relative
            or "\\" in relative
            or relative.startswith("/")
            or re.match(r"^[A-Za-z]:", relative)
        ):
            raise AdapterError(f"{label} must be a safe repository-relative path")
        parts = relative.split("/")
        if any(not part or part in {".", ".."} for part in parts):
            raise AdapterError(f"{label} contains unsafe path segments")
        candidate = self.root.joinpath(*parts)
        if not candidate.exists() or candidate.is_symlink() or not candidate.is_file():
            raise AdapterError(f"{label} is missing or unsafe: {relative}")
        resolved = candidate.resolve()
        if not _inside(resolved, self.root):
            raise AdapterError(f"{label} escapes the OS root")
        return resolved

    def _registry(self) -> Optional[Dict[str, Any]]:
        file = self.root / _EXTENSION_REGISTRY
        if not file.exists():
            return None
        if file.is_symlink() or not file.is_file():
            raise AdapterError("extension registry must be a regular non-symlink file")
        if file.stat().st_size > _MAX_REGISTRY_BYTES:
            raise AdapterError("extension registry is too large")
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except Exception as exc:
            raise AdapterError(f"extension registry is invalid: {exc}") from exc
        if not isinstance(data, dict) or data.get("schema_version") != "1.0":
            raise AdapterError("extension registry schema is unsupported")
        if not isinstance(data.get("extensions"), dict):
            raise AdapterError("extension registry extensions must be an object")
        return data

    def _extension_entry(self, extension_id: str) -> Optional[Dict[str, Any]]:
        registry = self._registry()
        if registry is None:
            return None
        raw = registry["extensions"].get(extension_id)
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise AdapterError(f"{extension_id} registry entry must be an object")
        if raw.get("id") not in {None, extension_id}:
            raise AdapterError(f"{extension_id} registry entry id mismatch")
        if raw.get("supported") is not True or raw.get("installed") is not True:
            return None
        if raw.get("enabled") is not True:
            return None
        return dict(raw)

    def _component_state(self, extension_id: str, *, engine_required: bool = False) -> str:
        try:
            entry = self._extension_entry(extension_id)
            if entry is None:
                return "absent"
            if engine_required:
                self._safe_repo_file(entry.get("engine"), f"{extension_id} engine")
            return "available"
        except AdapterError:
            return "degraded"

    def _data_available(self) -> bool:
        return self._component_state("ai-verse-data", engine_required=True) == "available"

    def describe(self) -> Dict[str, Any]:
        operations = list(BASE_OPERATIONS)
        if self._data_available():
            operations.append(DATA_OPERATION)
        skills_state = "available" if (self.skills_root / ".aiverse" / "active.json").is_file() else "absent"
        return {
            "adapter_id": ADAPTER_ID,
            "protocol_version": "1.0",
            "operations": operations,
            "idempotency_supported": False,
            "metadata": {
                "host": "ai-verse-os",
                "legacy_adapter_id": LEGACY_ADAPTER_ID,
                "memory": self._component_state("ai-verse-memory", engine_required=True),
                "skills": skills_state,
                "data": self._component_state("ai-verse-data", engine_required=True),
                "canonical_state_owned": False,
                "optional_components_dynamic": True,
            },
        }

    def _validate_scope(self, scope: Any) -> str:
        if not isinstance(scope, str) or not _SCOPE.fullmatch(scope):
            raise AdapterError(f"invalid scope: {scope!r}")
        return scope

    def read_context(self, scope: str) -> Dict[str, Any]:
        scope = self._validate_scope(scope)
        proc = subprocess.run(
            [
                "node",
                str(self.current_context_cli),
                "read",
                "--root",
                str(self.root),
                "--scope",
                scope,
            ],
            text=True,
            capture_output=True,
            shell=False,
        )
        if proc.returncode != 0:
            raise AdapterError(
                "OS current-context resolution failed: "
                + (proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
            )
        return _json_object(proc.stdout, "OS current-context resolver")

    def retrieve_history(self, query: str, scope: str) -> list[Dict[str, Any]]:
        scope = self._validate_scope(scope)
        if not isinstance(query, str) or not query.strip():
            raise AdapterError("history query must be non-empty")
        entry = self._extension_entry("ai-verse-memory")
        if entry is None:
            return []
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-memory engine")
        memory = _load_module(engine, "_aiverse_os_host_memory")
        mode = memory.detect_mode(self.root)
        rows = memory.recall(
            query,
            scope=scope,
            limit=12,
            root=self.root,
            mode=mode,
        )
        return [dict(row) for row in rows]

    def _resolver(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        request = {
            **dict(payload),
            "skills_root": str(self.skills_root),
            "local_skills_root": str(self.local_skills_root),
        }
        return _run_json(
            ["node", str(self.resolver_cli), "--root", str(self.root)],
            request,
            "OS capability resolver",
        )

    def list_capabilities(self, scope: str) -> list[Dict[str, Any]]:
        scope = self._validate_scope(scope)
        result = self._resolver(
            {
                "operation": "discover",
                "scope": scope,
                "limit": 200,
            }
        )
        candidates = result.get("candidates")
        if not isinstance(candidates, list) or any(not isinstance(item, dict) for item in candidates):
            raise AdapterError("OS capability resolver returned an invalid candidate list")
        return [dict(item) for item in candidates]

    def _read_connections(self) -> list[Dict[str, Any]]:
        file = self.root / "connections" / "registry.yaml"
        if not file.exists():
            return []
        if file.is_symlink() or not file.is_file():
            raise AdapterError("connections registry must be a regular non-symlink file")
        text = file.read_text(encoding="utf-8", errors="strict")
        first = next(
            (line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")),
            "",
        )
        schema = re.fullmatch(r"schema_version:\s*['\"]?([12])(?:\.\d+)?['\"]?\s*", first)
        if not schema:
            raise AdapterError("connections registry schema is unsupported")
        schema_major = int(schema.group(1))

        rows: list[Dict[str, Any]] = []
        current: Optional[Dict[str, Any]] = None
        nested: Optional[str] = None
        in_connections = False
        for raw in text.splitlines():
            if not raw.strip() or raw.lstrip().startswith("#"):
                continue
            indent = len(raw) - len(raw.lstrip(" "))
            stripped = raw.strip()
            if indent == 0:
                nested = None
                if stripped.startswith("connections:"):
                    in_connections = True
                continue
            if not in_connections:
                continue

            if schema_major == 2 and indent == 2 and stripped.startswith("- "):
                if current is not None:
                    rows.append(current)
                current = {"scope": {}}
                nested = None
                item = stripped[2:]
                if ":" in item:
                    key, value = item.split(":", 1)
                    current[key.strip()] = _yaml_scalar(value)
                continue

            if schema_major == 1 and indent == 2 and stripped.endswith(":"):
                if current is not None:
                    rows.append(current)
                current = {"id": stripped[:-1].strip(), "scope": {}}
                nested = None
                continue

            if current is None:
                continue

            property_indent = 4
            nested_indent = 6
            if indent == property_indent and ":" in stripped:
                key, value = stripped.split(":", 1)
                key = key.strip()
                parsed = _yaml_scalar(value)
                if parsed is None and key in {"scope", "auth"}:
                    nested = key
                    if key == "scope":
                        current.setdefault("scope", {})
                else:
                    nested = None
                    current[key] = parsed
                continue
            if indent >= nested_indent and nested == "scope" and ":" in stripped:
                key, value = stripped.split(":", 1)
                current.setdefault("scope", {})[key.strip()] = _yaml_scalar(value)

        if current is not None:
            rows.append(current)
        return rows

    def list_connections(self, scope: str) -> list[Dict[str, Any]]:
        scope = self._validate_scope(scope)
        workspace_id = scope.split(":", 1)[1] if scope.startswith("workspace:") else None
        result: list[Dict[str, Any]] = []
        for row in self._read_connections():
            connection_id = row.get("id")
            if not isinstance(connection_id, str) or not connection_id:
                raise AdapterError("connections registry contains an entry without id")
            bounds = row.get("scope") if isinstance(row.get("scope"), dict) else {}
            if workspace_id is None:
                if bounds and bounds.get("operator") is False:
                    continue
            else:
                workspaces = bounds.get("workspaces")
                if not isinstance(workspaces, list) or workspace_id not in workspaces:
                    continue
            public = {
                "id": connection_id,
                "name": row.get("name"),
                "purpose": row.get("purpose"),
                "mechanism": row.get("mechanism"),
                "status": row.get("status"),
                "authoritative_for": row.get("authoritative_for")
                if isinstance(row.get("authoritative_for"), list)
                else [],
            }
            result.append({key: value for key, value in public.items() if value is not None})
        return result

    def authorize_action(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(request, Mapping):
            raise AdapterError("action permission request must be an object")
        return _run_json(
            ["node", str(self.permission_cli), "--root", str(self.root)],
            request,
            "OS action permission",
        )

    def _package_digest_v1(self, package_root: Path) -> str:
        root = package_root.resolve(strict=True)
        if not root.is_dir():
            raise AdapterError("selected Skills package is not a directory")
        files: list[tuple[bytes, str, Path]] = []
        for path in root.rglob("*"):
            rel = path.relative_to(root).as_posix()
            if ".git" in path.relative_to(root).parts:
                continue
            if path.is_symlink():
                resolved = path.resolve(strict=True)
                if not _inside(resolved, root):
                    raise AdapterError(f"selected Skills package has escaping symlink: {rel}")
                continue
            if path.is_file():
                files.append((rel.encode("utf-8"), rel, path))
        digest = hashlib.sha256()
        for _, rel, path in sorted(files, key=lambda item: item[0]):
            digest.update(rel.encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
        return digest.hexdigest()

    def _pinned_selection(self, scope: str, capability_id: str) -> Dict[str, Any]:
        selected = self._resolver(
            {
                "operation": "select",
                "scope": scope,
                "qualified_id": capability_id,
            }
        )
        if selected.get("status") != "selected" or not isinstance(selected.get("selection"), dict):
            raise AdapterError(f"requested capability is unavailable: {capability_id}")
        selection = dict(selected["selection"])
        if selection.get("provider") != "aiverse-skills":
            raise AdapterError("capability.read_instructions is currently limited to the immutable Skills provider")
        locator = selection.get("locator")
        if not isinstance(locator, dict):
            raise AdapterError("selected Skills capability is missing locator metadata")
        package_path = Path(str(locator.get("package_path", ""))).resolve()
        generation_path = Path(str(locator.get("generation_root", ""))).resolve()
        try:
            package_path.relative_to(generation_path)
        except ValueError as exc:
            raise AdapterError("selected Skills package escapes its immutable generation") from exc
        if not package_path.is_dir() or package_path.is_symlink():
            raise AdapterError("selected Skills package path is missing or unsafe")
        if self.after_pin is not None:
            self.after_pin(
                {
                    "generation_id": selection.get("generation_id"),
                    "generation_path": str(generation_path),
                    "package_path": str(package_path),
                }
            )
        return selection

    def request_action(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(request, Mapping):
            raise AdapterError("action request must be an object")
        action_class = request.get("action_class")
        scope = self._validate_scope(request.get("scope"))
        operation = request.get("operation")
        parameters = request.get("parameters")
        if action_class != "read_local" or operation != "capability.read_instructions":
            return {
                "status": "failed",
                "effect_occurred": False,
                "result": {
                    "reason": "supported adapter only executes the safe capability.read_instructions local action",
                },
            }
        if not isinstance(parameters, Mapping):
            raise AdapterError("capability action parameters must be an object")
        allowed = {"capability_id", "expected_generation_id", "expected_package_digest"}
        extras = set(parameters) - allowed
        missing = allowed - set(parameters)
        if extras or missing:
            raise AdapterError(
                "capability action parameters must contain exactly "
                "capability_id, expected_generation_id, expected_package_digest"
            )
        capability_id = parameters["capability_id"]
        expected_generation = parameters["expected_generation_id"]
        expected_digest = parameters["expected_package_digest"]
        if not isinstance(capability_id, str) or not capability_id.startswith("aiverse-skills:"):
            raise AdapterError("capability_id must be a qualified aiverse-skills id")
        if not isinstance(expected_generation, str) or not expected_generation:
            raise AdapterError("expected_generation_id is required")
        if (
            not isinstance(expected_digest, Mapping)
            or expected_digest.get("algorithm") != "aiverse-package-sha256-v1"
            or not isinstance(expected_digest.get("value"), str)
            or not _HEX64.fullmatch(expected_digest["value"])
        ):
            raise AdapterError("expected_package_digest is invalid")

        selection = self._pinned_selection(scope, capability_id)
        if selection.get("generation_id") != expected_generation:
            raise AdapterError("capability generation changed before execution pin")
        if selection.get("digest") != dict(expected_digest):
            raise AdapterError("capability package digest changed before execution pin")

        locator = selection["locator"]
        package_path = Path(str(locator["package_path"])).resolve()
        actual_digest = self._package_digest_v1(package_path)
        if actual_digest != expected_digest["value"]:
            raise AdapterError("pinned capability package digest changed on disk")

        skill_md = package_path / "SKILL.md"
        if not skill_md.is_file() or skill_md.is_symlink():
            raise AdapterError("pinned capability is missing a regular SKILL.md")
        data = skill_md.read_bytes()
        if len(data) > _MAX_SKILL_BYTES:
            raise AdapterError("pinned capability SKILL.md exceeds the safe read limit")
        instructions = data.decode("utf-8")
        binding = {
            "request_fingerprint": _fingerprint(request),
            "scope": scope,
            "action_class": "read_local",
            "operation": "capability.read_instructions",
            "provider_id": "aiverse-skills",
            "capability_id": capability_id,
            "generation_id": expected_generation,
            "package_digest": dict(expected_digest),
        }
        receipt = {
            "contract": "aiverse-execution-receipt-v2",
            "receipt_id": f"receipt-{uuid4()}",
            "status": "success",
            "summary": f"Read instructions from pinned capability {capability_id}",
            "binding": binding,
            "effect": {
                "state": "not_occurred",
                "source_kind": "ai_verse_os",
                "source_ref": f"os:capability-read:{capability_id}",
                "independence": "same_context",
            },
            "verification_context": {
                "evaluator_id": ADAPTER_ID,
                "independence": "same_context",
            },
            "verification": [],
            "artifacts": [],
            "warnings": [],
            "remaining_uncertainty": [],
            "trace_id": f"trace-{uuid4()}",
        }
        return {
            "status": "succeeded",
            "effect_occurred": False,
            "result": {
                "receipt": receipt,
                "instructions": instructions,
                "instruction_sha256": hashlib.sha256(data).hexdigest(),
            },
            "execution_binding": binding,
        }

    def query_data(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise AdapterError("query_data payload must be an object")
        scope = self._validate_scope(payload.get("scope"))
        if not scope.startswith("workspace:"):
            raise AdapterError("query_data requires workspace:<id> scope")
        operation = payload.get("operation")
        data_payload = payload.get("payload")
        if operation not in _DATA_READ_OPERATIONS:
            raise AdapterError(f"query_data operation is not read-only/supported: {operation!r}")
        if not isinstance(data_payload, Mapping):
            raise AdapterError("query_data payload.payload must be an object")
        if not self._data_available():
            raise AdapterError("AI-Verse Data is unavailable")
        request = {
            "protocol": "ai-verse-os-data-host/1.0",
            "request_id": f"brain-data-{uuid4()}",
            "operation": "request",
            "scope": scope,
            "data": {
                "operation": operation,
                "payload": dict(data_payload),
            },
            "reason": "Read-only structured-data query requested through the AI-Verse OS Brain host.",
        }
        envelope = _run_json(
            ["node", str(self.data_host_cli), "--root", str(self.root)],
            request,
            "OS Data host",
        )
        if envelope.get("protocol") != "ai-verse-os-data-host/1.0" or envelope.get("ok") is not True:
            raise AdapterError("OS Data host returned an invalid envelope")
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise AdapterError("OS Data host returned an invalid result")
        return result


# Backward-compatible import name for existing callers.  The implementation is
# no longer fixed to four components.
OSFourComponentHost = AIverseOSHost


def _write_config(
    target: Path,
    root: Path,
    skills_root: Optional[Path],
    local_skills_root: Optional[Path],
) -> None:
    adapter_path = Path(__file__).resolve()
    command = [
        sys.executable,
        str(adapter_path),
        "--root",
        str(root.resolve()),
    ]
    if skills_root is not None:
        command.extend(["--skills-root", str(skills_root.resolve())])
    if local_skills_root is not None:
        command.extend(["--local-skills-root", str(local_skills_root.resolve())])
    payload = {
        "schema_version": "1.0",
        "name": "ai-verse-os-host",
        "transport": "json-subprocess",
        "command": command,
        "timeout_seconds": 60,
        "max_input_bytes": 2097152,
        "max_output_bytes": 2097152,
        "max_stderr_bytes": 65536,
        "env_names": [],
        "cwd": str(root.resolve()),
    }
    target = target.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _respond(request: Mapping[str, Any], result: Any = None, error: Optional[str] = None) -> None:
    response: Dict[str, Any] = {
        "protocol": PROTOCOL,
        "request_id": request.get("request_id"),
        "ok": error is None,
    }
    if error is None:
        response["result"] = result
    else:
        response["error"] = {"code": "AI_VERSE_OS_HOST_ERROR", "message": error}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="ai-verse-os-host-adapter")
    parser.add_argument("--root", required=True)
    parser.add_argument("--skills-root")
    # Accepted for compatibility with old generated configs.  It is no longer
    # used or required.
    parser.add_argument("--skills-entrypoint")
    parser.add_argument("--local-skills-root")
    parser.add_argument("--write-config")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(args.root).expanduser().resolve()
    skills_root = Path(args.skills_root).expanduser().resolve() if args.skills_root else None
    legacy_entrypoint = (
        Path(args.skills_entrypoint).expanduser().resolve()
        if args.skills_entrypoint
        else None
    )
    local = Path(args.local_skills_root).expanduser().resolve() if args.local_skills_root else None

    if args.write_config:
        _write_config(Path(args.write_config), root, skills_root, local)
        return 0

    request = _json_object(sys.stdin.read(), "Brain bridge request")
    if request.get("protocol") != PROTOCOL:
        _respond(request, error="protocol mismatch")
        return 2
    operation = request.get("operation")
    payload = request.get("payload")
    if not isinstance(payload, dict):
        _respond(request, error="payload must be an object")
        return 2

    try:
        host = AIverseOSHost(root, skills_root, legacy_entrypoint, local)
        if operation == "describe":
            result = host.describe()
        elif operation == "read_context":
            result = host.read_context(payload.get("scope"))
        elif operation == "retrieve_history":
            result = host.retrieve_history(payload.get("query"), payload.get("scope"))
        elif operation == "list_capabilities":
            result = host.list_capabilities(payload.get("scope"))
        elif operation == "list_connections":
            result = host.list_connections(payload.get("scope"))
        elif operation == "authorize_action":
            result = host.authorize_action(payload.get("request"))
        elif operation == "request_action":
            result = host.request_action(payload.get("request"))
        elif operation == DATA_OPERATION:
            result = host.query_data(payload)
        else:
            raise AdapterError(f"operation is not implemented by this adapter: {operation}")
    except Exception as exc:
        message = str(exc)
        process_label = operation if isinstance(operation, str) else "unknown"
        print(f"ai-verse-os-host-adapter {process_label}: {message}", file=sys.stderr)
        _respond(request, error=message)
        return 1

    _respond(request, result=result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
