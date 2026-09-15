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
import tempfile
from datetime import datetime, timezone
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
PROGRESSIVE_HISTORY_OPERATION = "retrieve_history_progressive"
PROGRESSIVE_RECALL_VERSION = "memory.progressive-recall.v1"
_PROGRESSIVE_DEPTHS = {"catalog", "summary", "detail", "source"}
_PROGRESSIVE_MAX_QUERY_CHARS = 4096
_PROGRESSIVE_MIN_BYTES = 4096
_PROGRESSIVE_MAX_BYTES = 65536
_PROGRESSIVE_MAX_ITEMS = 20
_PROGRESSIVE_EVIDENCE_MAX_BYTES = 65536
DATA_OPERATION = "query_data"
_SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_MAX_SKILL_BYTES = 256 * 1024
_MAX_REGISTRY_BYTES = 1024 * 1024
_EXTENSION_REGISTRY = Path(".aiverse/extensions/registry.json")
_MIGRATION_MAX_SOURCE_BYTES = 1024 * 1024
_MIGRATION_MAX_PLAN_BYTES = 512 * 1024
_MIGRATION_MAX_WORKSPACES = 32
_MIGRATION_MAX_MEMORIES = 128
_MIGRATION_MAX_DATA_ITEMS = 128
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
        encoding="utf-8",
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

    @property
    def workspace_owner_cli(self) -> Path:
        return self.root / "scripts" / "workspace-owner.mjs"

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

    def _memory_progressive_state(self) -> str:
        try:
            entry = self._extension_entry("ai-verse-memory")
            if entry is None:
                return "absent"
            engine = self._safe_repo_file(entry.get("engine"), "ai-verse-memory engine")
            memory = _load_module(engine, "_aiverse_os_host_memory_progressive_probe")
            if (
                getattr(memory, "PROGRESSIVE_RECALL_VERSION", None) != PROGRESSIVE_RECALL_VERSION
                or not callable(getattr(memory, "progressive_recall", None))
            ):
                return "incompatible"
            return "available"
        except Exception:
            return "degraded"

    def describe(self) -> Dict[str, Any]:
        operations = list(BASE_OPERATIONS)
        memory_progressive = self._memory_progressive_state()
        if memory_progressive == "available":
            operations.append(PROGRESSIVE_HISTORY_OPERATION)
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
                "memory_progressive_recall": memory_progressive,
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
            encoding="utf-8",
            capture_output=True,
            shell=False,
        )
        if proc.returncode != 0:
            raise AdapterError(
                "OS current-context resolution failed: "
                + (proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
            )
        current = _json_object(proc.stdout, "OS current-context resolver")
        if scope.startswith("workspace:") and self._data_available():
            current["structured_data"] = self._data_orientation(scope)
        return current

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

    def _validate_progressive_evidence_scope(
        self,
        bound_scope: str,
        evidence_ref: Mapping[str, Any],
    ) -> None:
        evidence_scope = self._validate_scope(evidence_ref.get("scope"))
        if bound_scope == "operator":
            allowed = {"operator"}
        else:
            allowed = {bound_scope, "operator"}
        if evidence_scope not in allowed:
            raise AdapterError(
                f"progressive evidence scope {evidence_scope!r} is not visible from {bound_scope!r}"
            )
        try:
            encoded = json.dumps(
                dict(evidence_ref),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise AdapterError(f"progressive evidence_ref is not JSON-safe: {exc}") from exc
        if len(encoded) > _PROGRESSIVE_EVIDENCE_MAX_BYTES:
            raise AdapterError("progressive evidence_ref exceeds the safe size limit")

    def retrieve_history_progressive(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise AdapterError("progressive history payload must be an object")
        allowed = {
            "version",
            "depth",
            "scope",
            "query",
            "limit",
            "max_bytes",
            "evidence_ref",
        }
        extras = set(payload) - allowed
        required = {"version", "depth", "scope"}
        missing = required - set(payload)
        if extras or missing:
            raise AdapterError(
                "progressive history payload has invalid fields: "
                + ", ".join(sorted(extras | missing))
            )

        version = payload.get("version")
        if version != PROGRESSIVE_RECALL_VERSION:
            raise AdapterError(
                f"unsupported progressive history version: {version!r}"
            )
        depth = payload.get("depth")
        if depth not in _PROGRESSIVE_DEPTHS:
            raise AdapterError(f"unsupported progressive history depth: {depth!r}")
        scope = self._validate_scope(payload.get("scope"))

        query = payload.get("query", "")
        if not isinstance(query, str):
            raise AdapterError("progressive history query must be a string")
        query = query.strip()
        if len(query) > _PROGRESSIVE_MAX_QUERY_CHARS:
            raise AdapterError(
                f"progressive history query exceeds {_PROGRESSIVE_MAX_QUERY_CHARS} characters"
            )
        if depth != "catalog" and not query:
            raise AdapterError(f"progressive history depth {depth!r} requires a non-empty query")

        limit = payload.get("limit", 8)
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= _PROGRESSIVE_MAX_ITEMS
        ):
            raise AdapterError(
                f"progressive history limit must be an integer between 1 and {_PROGRESSIVE_MAX_ITEMS}"
            )
        max_bytes = payload.get("max_bytes", 16384)
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or not _PROGRESSIVE_MIN_BYTES <= max_bytes <= _PROGRESSIVE_MAX_BYTES
        ):
            raise AdapterError(
                "progressive history max_bytes must be between "
                f"{_PROGRESSIVE_MIN_BYTES} and {_PROGRESSIVE_MAX_BYTES}"
            )

        evidence_ref = payload.get("evidence_ref")
        if depth == "source":
            if not isinstance(evidence_ref, Mapping):
                raise AdapterError(
                    "progressive source depth requires evidence_ref from a prior detail item"
                )
            self._validate_progressive_evidence_scope(scope, evidence_ref)
        elif evidence_ref is not None:
            raise AdapterError("progressive evidence_ref is only valid for source depth")

        entry = self._extension_entry("ai-verse-memory")
        if entry is None:
            raise AdapterError("AI-Verse Memory is unavailable")
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-memory engine")
        memory = _load_module(engine, "_aiverse_os_host_memory_progressive")
        progressive = getattr(memory, "progressive_recall", None)
        installed_version = getattr(memory, "PROGRESSIVE_RECALL_VERSION", None)
        if installed_version != version or not callable(progressive):
            raise AdapterError(
                f"installed AI-Verse Memory does not support {version}"
            )

        mode = memory.detect_mode(self.root)
        try:
            result = progressive(
                query,
                version=version,
                depth=depth,
                scope=scope,
                limit=limit,
                max_bytes=max_bytes,
                evidence_ref=dict(evidence_ref) if evidence_ref is not None else None,
                root=self.root,
                mode=mode,
            )
        except (ValueError, RuntimeError, OSError) as exc:
            raise AdapterError(f"Memory progressive recall rejected request: {exc}") from exc

        if not isinstance(result, dict):
            raise AdapterError("Memory progressive recall returned a non-object result")
        if result.get("api_version") != version:
            raise AdapterError("Memory progressive recall version mismatch")
        if result.get("depth") != depth:
            raise AdapterError("Memory progressive recall depth mismatch")
        if result.get("scope") != scope:
            raise AdapterError("Memory progressive recall scope mismatch")
        try:
            result_bytes = len(
                json.dumps(
                    result,
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                    allow_nan=False,
                ).encode("utf-8")
            )
        except (TypeError, ValueError) as exc:
            raise AdapterError(f"Memory progressive recall returned invalid JSON data: {exc}") from exc
        if result_bytes > max_bytes:
            raise AdapterError(
                f"Memory progressive recall exceeded the requested {max_bytes}-byte budget"
            )
        return result

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

    def _skills_owner_entrypoint(self) -> Path:
        path = self.skills_entrypoint
        if path is None:
            raise AdapterError(
                "Skills owner mutation entrypoint is not configured; runtime reads remain available"
            )
        if not path.is_file() or path.is_symlink():
            raise AdapterError(f"Skills owner mutation entrypoint is missing or unsafe: {path}")
        return path.resolve()

    def _run_skills_owner_cli(self, args: Iterable[str], label: str) -> Dict[str, Any]:
        entrypoint = self._skills_owner_entrypoint()
        proc = subprocess.run(
            [
                sys.executable,
                str(entrypoint),
                "--root",
                str(self.skills_root),
                *list(args),
            ],
            text=True,
            encoding="utf-8",
            capture_output=True,
            shell=False,
        )
        if proc.returncode != 0:
            detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
            return {
                "owner_refused": True,
                "reason": detail[:4000],
            }
        try:
            return _json_object(proc.stdout, label)
        except AdapterError as exc:
            raise AdapterError(f"{label} returned invalid JSON: {exc}") from exc

    def _request_skills_learning_candidate(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not isinstance(parameters, Mapping):
            raise AdapterError("skills.learning-candidate parameters must be an object")
        allowed = {"candidate", "skill_md", "task_evidence"}
        extras = set(parameters) - allowed
        missing = {"candidate", "skill_md", "task_evidence"} - set(parameters)
        if extras or missing:
            raise AdapterError(
                "skills.learning-candidate parameters must contain exactly candidate, skill_md, task_evidence"
            )

        candidate = parameters.get("candidate")
        task_evidence = parameters.get("task_evidence")
        skill_md = parameters.get("skill_md")
        if not isinstance(candidate, Mapping):
            raise AdapterError("skills.learning-candidate candidate must be an object")
        if not isinstance(task_evidence, Mapping):
            raise AdapterError("skills.learning-candidate task_evidence must be an object")
        if set(task_evidence) != {"substantial_task"} or not isinstance(task_evidence.get("substantial_task"), bool):
            raise AdapterError("task_evidence must contain exactly substantial_task:boolean")
        if not isinstance(skill_md, str) or not skill_md.strip():
            raise AdapterError("skills.learning-candidate requires non-empty SKILL.md content")
        encoded = skill_md.encode("utf-8")
        if len(encoded) > _MAX_SKILL_BYTES:
            raise AdapterError("skills.learning-candidate SKILL.md exceeds the safe size limit")
        if "\x00" in skill_md:
            raise AdapterError("skills.learning-candidate SKILL.md contains a NUL byte")

        brain_entry = self._extension_entry("ai-verse-brain")
        if brain_entry is None:
            raise AdapterError("AI-Verse Brain is unavailable")
        try:
            from aiverse_brain.learning import admit_skills_learning_candidate
        except Exception as exc:
            raise AdapterError(f"AI-Verse Brain learning-candidate gate is unavailable: {exc}") from exc

        admission = admit_skills_learning_candidate(
            dict(candidate),
            bound_scope=scope,
            substantial_task=task_evidence["substantial_task"],
        )
        if not isinstance(admission, dict) or admission.get("state") not in {"admitted", "ignored"}:
            raise AdapterError("Brain learning-candidate gate returned an invalid result")
        if admission["state"] == "ignored":
            return {
                "status": "succeeded",
                "effect_occurred": False,
                "result": {"learning_candidate": admission},
                "execution_binding": {
                    "request_fingerprint": _fingerprint(request),
                    "scope": scope,
                    "action_class": "write_local_reversible",
                    "operation": "skills.learning-candidate",
                },
            }

        envelope = admission.get("envelope")
        if not isinstance(envelope, dict):
            raise AdapterError("Brain admitted candidate without a Skills envelope")

        with tempfile.TemporaryDirectory(
            prefix=".aiverse-learning-route-",
            dir=str(self.skills_root.parent),
        ) as temp_name:
            temp_root = Path(temp_name)
            candidate_dir = temp_root / "candidate"
            candidate_dir.mkdir(mode=0o700)
            (candidate_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
            envelope_path = temp_root / "envelope.json"
            envelope_path.write_text(
                json.dumps(envelope, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
                encoding="utf-8",
            )

            submitted = self._run_skills_owner_cli(
                [
                    "learning",
                    "submit",
                    "--envelope",
                    str(envelope_path),
                    "--candidate-dir",
                    str(candidate_dir),
                    "--trigger",
                    "post-run",
                    "--json",
                ],
                "Skills learning submit",
            )
            if submitted.get("owner_refused") is True:
                return {
                    "status": "blocked",
                    "effect_occurred": False,
                    "result": {
                        "learning_candidate": admission,
                        "skills": submitted,
                    },
                    "execution_binding": {
                        "request_fingerprint": _fingerprint(request),
                        "scope": scope,
                        "action_class": "write_local_reversible",
                        "operation": "skills.learning-candidate",
                    },
                }

            proposal_id = submitted.get("proposal_id")
            state = submitted.get("state")
            replay = submitted.get("idempotent_replay") is True
            final = submitted
            if not replay and isinstance(proposal_id, str) and state in {"proposal", "pending_approval", "auto_eligible"}:
                final = self._run_skills_owner_cli(
                    [
                        "proposals",
                        "evaluate",
                        proposal_id,
                        "--apply-auto",
                        "--json",
                    ],
                    "Skills learning evaluate",
                )
                if final.get("owner_refused") is True:
                    return {
                        "status": "blocked",
                        "effect_occurred": True,
                        "result": {
                            "learning_candidate": admission,
                            "skills_submission": submitted,
                            "skills_evaluation": final,
                        },
                        "execution_binding": {
                            "request_fingerprint": _fingerprint(request),
                            "scope": scope,
                            "action_class": "write_local_reversible",
                            "operation": "skills.learning-candidate",
                            "proposal_id": proposal_id,
                        },
                    }

        return {
            "status": "succeeded",
            "effect_occurred": not replay,
            "result": {
                "learning_candidate": admission,
                "skills_submission": submitted,
                "skills_result": final,
                "idempotent_replay": replay,
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "skills.learning-candidate",
                "proposal_id": proposal_id,
                "proposal_state": final.get("state") if isinstance(final, dict) else None,
            },
        }

    def _request_memory_capture(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not isinstance(parameters, Mapping):
            raise AdapterError("memory.capture parameters must be an object")
        entry = self._extension_entry("ai-verse-memory")
        if entry is None:
            raise AdapterError("AI-Verse Memory is unavailable")
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-memory engine")
        memory = _load_module(engine, "_aiverse_os_host_memory_capture")
        capture = getattr(memory, "capture_candidate", None)
        if not callable(capture):
            raise AdapterError("installed AI-Verse Memory does not support safe automatic capture")

        candidate = dict(parameters)
        requested_scope = candidate.get("scope")
        requested_workspace = candidate.get("workspace")
        if scope == "operator":
            if requested_workspace not in {None, ""}:
                raise AdapterError("operator-scoped memory.capture cannot target a workspace")
            if requested_scope not in {None, "", "operator", "global"}:
                raise AdapterError("operator-scoped memory.capture has a conflicting candidate scope")
            candidate["scope"] = "operator"
            candidate.pop("workspace", None)
        else:
            workspace_id = scope.split(":", 1)[1]
            if requested_workspace not in {None, "", workspace_id}:
                raise AdapterError("workspace memory.capture cannot target another workspace")
            if requested_scope not in {None, "", scope}:
                raise AdapterError("workspace memory.capture has a conflicting candidate scope")
            candidate["workspace"] = workspace_id
            candidate.pop("scope", None)

        result = capture(candidate, root=self.root)
        if not isinstance(result, dict):
            raise AdapterError("AI-Verse Memory capture returned an invalid result")
        state = result.get("state")
        accepted = state in {"captured", "existing", "ignored"}
        return {
            "status": "succeeded" if accepted else "blocked",
            "effect_occurred": bool(result.get("changed")),
            "result": {"memory_capture": result},
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "memory.capture",
                "memory_id": result.get("memory_id"),
            },
        }

    def _request_memory_session_digest(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not isinstance(parameters, Mapping):
            raise AdapterError("memory.session_digest parameters must be an object")
        allowed = {
            "session_id",
            "run_id",
            "topic",
            "summary",
            "significant_outcomes",
            "unresolved_items",
            "source_coverage",
            "source_fingerprint",
            "completed_at",
        }
        extras = set(parameters) - allowed
        required = {
            "session_id",
            "run_id",
            "topic",
            "summary",
            "source_coverage",
            "source_fingerprint",
            "completed_at",
        }
        missing = required - set(parameters)
        if extras or missing:
            raise AdapterError(
                "memory.session_digest accepts only compact Gateway digest fields and requires "
                "session_id, run_id, topic, summary, source_coverage, source_fingerprint, completed_at"
            )

        session_id = parameters.get("session_id")
        run_id = parameters.get("run_id")
        safe_id = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
        if not isinstance(session_id, str) or not safe_id.fullmatch(session_id):
            raise AdapterError("memory.session_digest session_id is invalid")
        if not isinstance(run_id, str) or not safe_id.fullmatch(run_id):
            raise AdapterError("memory.session_digest run_id is invalid")

        topic = parameters.get("topic")
        summary = parameters.get("summary")
        if not isinstance(topic, str) or not topic.strip() or len(topic.strip()) > 240:
            raise AdapterError("memory.session_digest topic must be 1..240 characters")
        if not isinstance(summary, str) or not summary.strip() or len(summary.strip()) > 6000:
            raise AdapterError("memory.session_digest summary must be 1..6000 characters")

        def bounded_strings(name: str, value: Any, *, limit: int, item_limit: int) -> list[str]:
            if value is None:
                return []
            if not isinstance(value, list) or len(value) > limit:
                raise AdapterError(f"memory.session_digest {name} must be an array with at most {limit} items")
            result: list[str] = []
            for item in value:
                if not isinstance(item, str) or not item.strip() or len(item.strip()) > item_limit:
                    raise AdapterError(
                        f"memory.session_digest {name} entries must be non-empty strings up to {item_limit} characters"
                    )
                normalized = item.strip()
                if normalized not in result:
                    result.append(normalized)
            return result

        significant = bounded_strings(
            "significant_outcomes",
            parameters.get("significant_outcomes", []),
            limit=24,
            item_limit=1200,
        )
        unresolved = bounded_strings(
            "unresolved_items",
            parameters.get("unresolved_items", []),
            limit=24,
            item_limit=1200,
        )
        coverage = bounded_strings(
            "source_coverage",
            parameters.get("source_coverage"),
            limit=8,
            item_limit=2048,
        )
        if not coverage:
            raise AdapterError("memory.session_digest source_coverage cannot be empty")
        expected_prefix = f"gateway:run:{run_id}:"
        if any(not item.startswith(expected_prefix) for item in coverage):
            raise AdapterError("memory.session_digest source_coverage must be bound to the supplied Gateway run")

        source_fingerprint = parameters.get("source_fingerprint")
        if (
            not isinstance(source_fingerprint, str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", source_fingerprint)
        ):
            raise AdapterError("memory.session_digest source_fingerprint must be sha256:<64 lowercase hex>")

        completed_at = parameters.get("completed_at")
        if not isinstance(completed_at, str) or not completed_at.strip() or len(completed_at.strip()) > 128:
            raise AdapterError("memory.session_digest completed_at is invalid")

        entry = self._extension_entry("ai-verse-memory")
        if entry is None:
            raise AdapterError("AI-Verse Memory is unavailable")
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-memory engine")
        memory = _load_module(engine, "_aiverse_os_host_memory_session_digest")
        writer = getattr(memory, "write_session_digest", None)
        if not callable(writer):
            raise AdapterError("installed AI-Verse Memory does not support session digests")

        digest_id, path, created = writer(
            session_id,
            summary.strip(),
            run_id=run_id,
            scope=scope,
            topic=topic.strip(),
            unresolved_items=unresolved,
            significant_outcomes=significant,
            source_refs=[
                f"gateway:session:{session_id}",
                f"gateway:run:{run_id}",
            ],
            provenance={
                "owner": "ai-verse-gateway",
                "kind": "completed_session",
                "session_id": session_id,
                "run_id": run_id,
            },
            source_coverage=coverage,
            source_fingerprint=source_fingerprint,
            source_version="gateway-run-v1",
            completed_at=completed_at.strip(),
            root=self.root,
            effect_id=f"gateway:{run_id}:session-digest",
        )
        state = "captured" if created else "existing"
        return {
            "status": "succeeded",
            "effect_occurred": bool(created),
            "result": {
                "memory_session_digest": {
                    "state": state,
                    "changed": bool(created),
                    "digest_id": digest_id,
                    "scope": scope,
                    "session_id": session_id,
                    "run_id": run_id,
                    "path": memory.relpath(path, self.root),
                },
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "memory.session_digest",
                "digest_id": digest_id,
            },
        }

    def _request_workspace_ensure(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not isinstance(parameters, Mapping):
            raise AdapterError("workspace.ensure parameters must be an object")
        allowed = {"workspace", "evidence", "authority", "provenance"}
        extras = set(parameters) - allowed
        missing = {"workspace", "evidence", "authority"} - set(parameters)
        if extras or missing:
            raise AdapterError(
                "workspace.ensure parameters must contain workspace, evidence, authority "
                "and optional provenance only"
            )
        workspace = parameters.get("workspace")
        if not isinstance(workspace, Mapping):
            raise AdapterError("workspace.ensure workspace must be an object")
        requested_id = workspace.get("id")
        if scope.startswith("workspace:"):
            bound_id = scope.split(":", 1)[1]
            if requested_id != bound_id:
                raise AdapterError(
                    "workspace-scoped workspace.ensure may only evolve its already-bound workspace"
                )

        proc = subprocess.run(
            [
                "node",
                str(self.workspace_owner_cli),
                "ensure",
                "--root",
                str(self.root),
            ],
            input=json.dumps(dict(parameters), ensure_ascii=False, separators=(",", ":")),
            text=True,
            capture_output=True,
            shell=False,
        )
        if proc.returncode != 0:
            detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
            raise AdapterError(f"OS workspace owner failed: {detail}")
        organized = _json_object(proc.stdout, "OS workspace owner")
        state = organized.get("state")
        accepted = state in {"created", "evolved", "existing", "ignored-trivial"}
        return {
            "status": "succeeded" if accepted else "blocked",
            "effect_occurred": bool(organized.get("changed")),
            "result": {
                "workspace_organization": organized,
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "workspace.ensure",
                "workspace_id": (
                    organized.get("workspace", {}).get("id")
                    if isinstance(organized.get("workspace"), dict)
                    else None
                ),
            },
        }

    @staticmethod
    def _temporary_worker_budget(value: Any) -> Dict[str, Any]:
        if value is None:
            value = {}
        if not isinstance(value, Mapping):
            raise AdapterError("workers.temporary budget must be an object")
        allowed = {"token_limit", "cost_limit", "wall_clock_seconds"}
        extras = set(value) - allowed
        if extras:
            raise AdapterError(
                "workers.temporary budget contains unsupported fields: "
                + ", ".join(sorted(extras))
            )
        budget: Dict[str, Any] = {
            "max_workers": 1,
            "max_tasks": 1,
            "max_actions": 1,
            "max_hops": 0,
            "token_limit": 4096,
            "wall_clock_seconds": 120,
        }
        for key in allowed:
            if key not in value:
                continue
            item = value[key]
            if not isinstance(item, (int, float)) or isinstance(item, bool) or item <= 0:
                raise AdapterError(f"workers.temporary budget {key} must be a positive number")
            if key in {"token_limit", "wall_clock_seconds"} and int(item) != item:
                raise AdapterError(f"workers.temporary budget {key} must be an integer")
            budget[key] = int(item) if key in {"token_limit", "wall_clock_seconds"} else float(item)
        budget["token_limit"] = min(int(budget["token_limit"]), 16384)
        budget["wall_clock_seconds"] = min(int(budget["wall_clock_seconds"]), 300)
        return budget

    @staticmethod
    def _temporary_worker_runtime(value: Any) -> Dict[str, Any]:
        if not isinstance(value, Mapping):
            raise AdapterError("workers.temporary runtime must be an object")
        if any(key in value for key in ("api_key", "token", "authorization", "credential")):
            raise AdapterError("workers.temporary runtime must not contain raw credentials")
        adapter = value.get("adapter")
        if adapter == "deterministic":
            if set(value) != {"adapter"}:
                raise AdapterError("deterministic workers.temporary runtime contains unsupported fields")
            return {"adapter": "deterministic"}
        if adapter != "openai-compatible":
            raise AdapterError("workers.temporary runtime adapter is not supported for automatic temporary help")
        allowed = {"adapter", "endpoint", "model", "api_key_env"}
        extras = set(value) - allowed
        if extras:
            raise AdapterError(
                "openai-compatible workers.temporary runtime contains unsupported fields: "
                + ", ".join(sorted(extras))
            )
        endpoint = value.get("endpoint")
        model = value.get("model")
        if (
            not isinstance(endpoint, str)
            or not endpoint.startswith(("http://", "https://"))
            or len(endpoint) > 2048
            or any(ch.isspace() for ch in endpoint)
        ):
            raise AdapterError("workers.temporary runtime endpoint must be a bounded HTTP(S) URL")
        if not isinstance(model, str) or not model.strip() or len(model.strip()) > 256:
            raise AdapterError("workers.temporary runtime model is invalid")
        result: Dict[str, Any] = {
            "adapter": "openai-compatible",
            "endpoint": endpoint,
            "model": model.strip(),
        }
        handle = value.get("api_key_env")
        if handle is not None:
            if not isinstance(handle, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", handle):
                raise AdapterError("workers.temporary runtime api_key_env is invalid")
            result["api_key_env"] = handle
        return result

    def _run_multiple_bots_temporary_worker(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        entry = self._extension_entry("ai-verse-multiple-bots")
        if entry is None:
            raise AdapterError("AI-Verse Multiple Bots is unavailable")
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-multiple-bots engine")
        source = (
            'import { pathToFileURL } from "node:url";'
            'let raw=""; for await (const chunk of process.stdin) raw += chunk;'
            'const engine = await import(pathToFileURL(process.argv[1]).href);'
            'if (typeof engine.runScopedTemporaryWorker !== "function") '
            'throw new Error("Installed Multiple Bots does not support run-scoped temporary Workers");'
            'const result = await engine.runScopedTemporaryWorker(JSON.parse(raw));'
            'process.stdout.write(JSON.stringify(result));'
        )
        return _run_json(
            ["node", "--input-type=module", "--eval", source, str(engine)],
            payload,
            "Multiple Bots temporary Worker owner",
        )

    def _request_temporary_worker(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not scope.startswith("workspace:"):
            raise AdapterError("workers.temporary requires workspace scope")
        if not isinstance(parameters, Mapping):
            raise AdapterError("workers.temporary parameters must be an object")
        allowed = {
            "objective",
            "role_title",
            "reason",
            "runtime",
            "skill_refs",
            "required_constraints",
            "budget",
            "task_evidence",
            "provenance",
        }
        extras = set(parameters) - allowed
        missing = {"objective", "role_title", "reason", "runtime", "task_evidence", "provenance"} - set(parameters)
        if extras or missing:
            raise AdapterError(
                "workers.temporary parameters have invalid fields: "
                + ", ".join(sorted(extras | missing))
            )

        evidence = parameters.get("task_evidence")
        expected_evidence = {
            "substantial_task",
            "temporary_help_useful",
            "permission_expansion",
            "durable_commitment",
            "external_effect",
        }
        if not isinstance(evidence, Mapping) or set(evidence) != expected_evidence:
            raise AdapterError("workers.temporary task_evidence shape is invalid")
        if any(not isinstance(evidence[key], bool) for key in expected_evidence):
            raise AdapterError("workers.temporary task_evidence values must be boolean")
        if (
            evidence["substantial_task"] is not True
            or evidence["temporary_help_useful"] is not True
            or evidence["permission_expansion"] is not False
            or evidence["durable_commitment"] is not False
            or evidence["external_effect"] is not False
        ):
            return {
                "status": "succeeded",
                "effect_occurred": False,
                "result": {
                    "temporary_worker": {
                        "state": "ignored",
                        "reason": "temporary help did not pass the safe internal-work admission boundary",
                    }
                },
                "execution_binding": {
                    "request_fingerprint": _fingerprint(request),
                    "scope": scope,
                    "action_class": "write_local_reversible",
                    "operation": "workers.temporary",
                },
            }

        provenance = parameters.get("provenance")
        if not isinstance(provenance, Mapping) or set(provenance) != {"run_id", "session_id"}:
            raise AdapterError("workers.temporary provenance must contain exactly run_id and session_id")
        run_id = provenance.get("run_id")
        session_id = provenance.get("session_id")
        if (
            not isinstance(run_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", run_id)
            or not isinstance(session_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id)
        ):
            raise AdapterError("workers.temporary trusted provenance IDs are invalid")

        objective = parameters.get("objective")
        role_title = parameters.get("role_title")
        reason = parameters.get("reason")
        for label, value, maximum in (
            ("objective", objective, 4000),
            ("role_title", role_title, 160),
            ("reason", reason, 1000),
        ):
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
                raise AdapterError(f"workers.temporary {label} is invalid")

        skill_refs = parameters.get("skill_refs", [])
        constraints = parameters.get("required_constraints", [])
        if (
            not isinstance(skill_refs, list)
            or len(skill_refs) > 12
            or any(not isinstance(item, str) or not item.startswith("aiverse-skills:") for item in skill_refs)
        ):
            raise AdapterError("workers.temporary skill_refs are invalid")
        if (
            not isinstance(constraints, list)
            or len(constraints) > 32
            or any(not isinstance(item, str) or not item.strip() or len(item) > 1000 for item in constraints)
        ):
            raise AdapterError("workers.temporary required_constraints are invalid")

        runtime = self._temporary_worker_runtime(parameters.get("runtime"))
        run_budget = self._temporary_worker_budget(parameters.get("budget"))
        worker_budget = {
            key: value
            for key, value in run_budget.items()
            if key not in {"max_workers", "max_tasks"}
        }
        leader_id = "runtime_gateway_" + hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:24]
        workspace_id = scope.split(":", 1)[1]
        owner_result = self._run_multiple_bots_temporary_worker(
            {
                "leaderId": leader_id,
                "workspaceId": workspace_id,
                "rootObjectiveId": "gateway:" + run_id,
                "objective": objective.strip(),
                "roleTitle": role_title.strip(),
                "reason": reason.strip(),
                "runtimeLeader": {
                    "runtime": runtime,
                    "allowedTools": [],
                    "allowedConnections": [],
                    "skillRefs": list(dict.fromkeys(skill_refs)),
                },
                "requiredConstraints": list(dict.fromkeys(item.strip() for item in constraints)),
                "skillRefs": list(dict.fromkeys(skill_refs)),
                "tools": [],
                "connections": [],
                "runBudget": run_budget,
                "workerBudget": worker_budget,
                "expectedOutput": {"contract": "artifact-or-structured-result"},
            }
        )
        execution_status = owner_result.get("execution_status")
        artifact = owner_result.get("artifact")
        artifact_payload = artifact.get("payload") if isinstance(artifact, Mapping) else None
        output = artifact_payload.get("inline_content") if isinstance(artifact_payload, Mapping) else None
        usage = artifact_payload.get("usage") if isinstance(artifact_payload, Mapping) else {}
        worker = owner_result.get("worker")
        worker_payload = worker.get("payload") if isinstance(worker, Mapping) else {}
        run = owner_result.get("run")
        run_payload = run.get("payload") if isinstance(run, Mapping) else {}
        completed = (
            execution_status == "completed"
            and isinstance(worker_payload, Mapping)
            and worker_payload.get("kind") == "temporary"
            and worker_payload.get("status") == "expired"
            and isinstance(run_payload, Mapping)
            and run_payload.get("leader_kind") == "runtime"
            and run_payload.get("leader_lifecycle") == "run_scoped"
        )
        return {
            "status": "succeeded" if completed else "blocked",
            "effect_occurred": True,
            "result": {
                "temporary_worker": {
                    "state": "completed" if completed else "blocked",
                    "output": output if completed else None,
                    "usage": usage if isinstance(usage, Mapping) else {},
                    "artifact_id": artifact.get("id") if isinstance(artifact, Mapping) else None,
                    "worker_id": worker.get("id") if isinstance(worker, Mapping) else None,
                    "run_id": run.get("id") if isinstance(run, Mapping) else None,
                    "cleanup": owner_result.get("cleanup"),
                }
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "workers.temporary",
                "owner": "ai-verse-multiple-bots",
                "gateway_run_id": run_id,
            },
        }

    @staticmethod
    def _permanent_bot_runtime(value: Any) -> Dict[str, Any]:
        if not isinstance(value, Mapping):
            raise AdapterError("bots.permanent runtime must be an object")
        if any(key in value for key in ("api_key", "token", "authorization", "credential")):
            raise AdapterError("bots.permanent runtime must not contain raw credentials")
        adapter = value.get("adapter")
        if adapter == "deterministic":
            if set(value) != {"adapter"}:
                raise AdapterError("deterministic bots.permanent runtime contains unsupported fields")
            return {"adapter": "deterministic"}
        if adapter != "openai-compatible":
            raise AdapterError("bots.permanent runtime adapter is not supported")
        allowed = {"adapter", "endpoint", "model", "api_key_env"}
        extras = set(value) - allowed
        if extras:
            raise AdapterError(
                "openai-compatible bots.permanent runtime contains unsupported fields: "
                + ", ".join(sorted(extras))
            )
        endpoint = value.get("endpoint")
        model = value.get("model")
        if (
            not isinstance(endpoint, str)
            or not endpoint.startswith(("http://", "https://"))
            or len(endpoint) > 2048
            or any(ch.isspace() for ch in endpoint)
        ):
            raise AdapterError("bots.permanent runtime endpoint must be a bounded HTTP(S) URL")
        if not isinstance(model, str) or not model.strip() or len(model.strip()) > 256:
            raise AdapterError("bots.permanent runtime model is invalid")
        result: Dict[str, Any] = {
            "adapter": "openai-compatible",
            "endpoint": endpoint,
            "model": model.strip(),
        }
        handle = value.get("api_key_env")
        if handle is not None:
            if not isinstance(handle, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", handle):
                raise AdapterError("bots.permanent runtime api_key_env is invalid")
            result["api_key_env"] = handle
        return result

    def _run_multiple_bots_create_durable(self, manifest: Mapping[str, Any]) -> Dict[str, Any]:
        entry = self._extension_entry("ai-verse-multiple-bots")
        if entry is None:
            raise AdapterError("AI-Verse Multiple Bots is unavailable")
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-multiple-bots engine")
        source = (
            'import { pathToFileURL } from "node:url";'
            'let raw=""; for await (const chunk of process.stdin) raw += chunk;'
            'const engine = await import(pathToFileURL(process.argv[1]).href);'
            'if (typeof engine.createDurableBot !== "function") '
            'throw new Error("Installed Multiple Bots does not support durable Bot creation");'
            'const result = await engine.createDurableBot(JSON.parse(raw));'
            'process.stdout.write(JSON.stringify(result));'
        )
        return _run_json(
            ["node", "--input-type=module", "--eval", source, str(engine)],
            manifest,
            "Multiple Bots durable Bot owner",
        )

    def _request_permanent_bot(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not isinstance(parameters, Mapping):
            raise AdapterError("bots.permanent parameters must be an object")
        allowed = {
            "name",
            "role_title",
            "mission",
            "skill_refs",
            "runtime",
            "consent",
            "provenance",
        }
        extras = set(parameters) - allowed
        missing = {"name", "role_title", "mission", "runtime", "consent", "provenance"} - set(parameters)
        if extras or missing:
            raise AdapterError(
                "bots.permanent parameters have invalid fields: "
                + ", ".join(sorted(extras | missing))
            )

        consent = parameters.get("consent")
        if not isinstance(consent, Mapping):
            raise AdapterError("bots.permanent requires trusted explicit consent")
        mode = consent.get("mode")
        expected_keys = {"explicit", "mode", "user_message_digest"}
        if mode == "affirmative_to_recommendation":
            expected_keys.add("recommendation_message_digest")
        if set(consent) != expected_keys:
            raise AdapterError("bots.permanent consent shape is invalid")
        if consent.get("explicit") is not True or mode not in {
            "direct_request",
            "affirmative_to_recommendation",
        }:
            raise AdapterError("bots.permanent requires explicit user consent")
        digest_pattern = r"^sha256:[a-f0-9]{64}$"
        if not isinstance(consent.get("user_message_digest"), str) or not re.fullmatch(
            digest_pattern, consent["user_message_digest"]
        ):
            raise AdapterError("bots.permanent user consent digest is invalid")
        if mode == "affirmative_to_recommendation" and (
            not isinstance(consent.get("recommendation_message_digest"), str)
            or not re.fullmatch(digest_pattern, consent["recommendation_message_digest"])
        ):
            raise AdapterError("bots.permanent recommendation digest is invalid")

        provenance = parameters.get("provenance")
        if not isinstance(provenance, Mapping) or set(provenance) != {"run_id", "session_id"}:
            raise AdapterError("bots.permanent provenance must contain exactly run_id and session_id")
        run_id = provenance.get("run_id")
        session_id = provenance.get("session_id")
        if (
            not isinstance(run_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", run_id)
            or not isinstance(session_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id)
        ):
            raise AdapterError("bots.permanent trusted provenance IDs are invalid")

        name = parameters.get("name")
        role_title = parameters.get("role_title")
        mission = parameters.get("mission")
        for label, value, maximum in (
            ("name", name, 160),
            ("role_title", role_title, 160),
            ("mission", mission, 2000),
        ):
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
                raise AdapterError(f"bots.permanent {label} is invalid")

        skill_refs = parameters.get("skill_refs", [])
        if (
            not isinstance(skill_refs, list)
            or len(skill_refs) > 12
            or any(not isinstance(item, str) or not item.startswith("aiverse-skills:") for item in skill_refs)
        ):
            raise AdapterError("bots.permanent skill_refs are invalid")

        runtime = self._permanent_bot_runtime(parameters.get("runtime"))
        unique_skill_refs = list(dict.fromkeys(skill_refs))
        for skill_ref in unique_skill_refs:
            self._pinned_selection(scope, skill_ref)
        stable_name = name.strip()
        identity_digest = hashlib.sha256(
            (scope + "\0" + stable_name.casefold()).encode("utf-8")
        ).hexdigest()[:24]
        bot_id = "bot_durable_" + identity_digest
        bot_scope: Dict[str, Any] = {"type": "operator"}
        if scope.startswith("workspace:"):
            bot_scope = {
                "type": "workspace",
                "workspace_id": scope.split(":", 1)[1],
            }
        manifest = {
            "schema_version": "1.0",
            "id": bot_id,
            "name": stable_name,
            "kind": "durable",
            "status": "active",
            "role": {
                "title": role_title.strip(),
                "mission": mission.strip(),
            },
            "runtime": runtime,
            "execution": {"environment_policy": "shared_workspace"},
            "scope": bot_scope,
            "capabilities": {
                "skill_refs": unique_skill_refs,
            },
            "permissions": {
                "policy_ref": "default-bot",
                "allowed_peers": [],
                "allowed_tools": [],
                "allowed_connections": [],
                "can_create_workers": False,
                "can_handoff": False,
            },
            "coordination": {
                "default_mode": "direct",
                "max_parallel_workers": 0,
                "max_hops": 0,
            },
            "lifecycle": {
                "created_via": "gateway_explicit_consent",
                "consent": dict(consent),
                "provenance": {
                    "gateway_run_id": run_id,
                    "gateway_session_id": session_id,
                },
            },
        }
        owner_result = self._run_multiple_bots_create_durable(manifest)
        state = owner_result.get("state")
        bot = owner_result.get("bot")
        if state not in {"created", "existing"} or not isinstance(bot, Mapping):
            raise AdapterError("Multiple Bots durable Bot owner returned an invalid result")
        payload = bot.get("payload")
        if (
            bot.get("id") != bot_id
            or not isinstance(payload, Mapping)
            or payload.get("kind") != "durable"
            or payload.get("status") != "active"
        ):
            raise AdapterError("Multiple Bots durable Bot owner returned inconsistent canonical state")

        return {
            "status": "succeeded",
            "effect_occurred": state == "created",
            "result": {
                "permanent_bot": {
                    "state": state,
                    "bot": dict(bot),
                    "consent_mode": mode,
                }
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "modify_canonical_state",
                "operation": "bots.permanent",
                "owner": "ai-verse-multiple-bots",
                "gateway_run_id": run_id,
            },
        }

    def _run_automations_create_definition(self, definition: Mapping[str, Any]) -> Dict[str, Any]:
        entry = self._extension_entry("ai-verse-automations")
        if entry is None:
            raise AdapterError("AI-Verse Automations is unavailable")
        engine = self._safe_repo_file(entry.get("engine"), "ai-verse-automations engine")
        return _run_json(
            [sys.executable, str(engine)],
            {
                "operation": "create_definition",
                "definition": dict(definition),
            },
            "Automations definition owner",
        )

    def _request_automation_create(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if not isinstance(parameters, Mapping):
            raise AdapterError("automations.create parameters must be an object")
        allowed = {"name", "objective", "trigger", "consent", "provenance"}
        extras = set(parameters) - allowed
        missing = allowed - set(parameters)
        if extras or missing:
            raise AdapterError(
                "automations.create parameters have invalid fields: "
                + ", ".join(sorted(extras | missing))
            )

        consent = parameters.get("consent")
        if not isinstance(consent, Mapping):
            raise AdapterError("automations.create requires trusted explicit consent")
        mode = consent.get("mode")
        expected_consent = {"explicit", "mode", "user_message_digest"}
        if mode == "affirmative_to_recommendation":
            expected_consent.add("recommendation_message_digest")
        if set(consent) != expected_consent:
            raise AdapterError("automations.create consent shape is invalid")
        if consent.get("explicit") is not True or mode not in {
            "direct_request",
            "affirmative_to_recommendation",
        }:
            raise AdapterError("automations.create requires explicit user consent")
        digest_pattern = r"^sha256:[a-f0-9]{64}$"
        if not isinstance(consent.get("user_message_digest"), str) or not re.fullmatch(
            digest_pattern, consent["user_message_digest"]
        ):
            raise AdapterError("automations.create user consent digest is invalid")
        if mode == "affirmative_to_recommendation" and (
            not isinstance(consent.get("recommendation_message_digest"), str)
            or not re.fullmatch(digest_pattern, consent["recommendation_message_digest"])
        ):
            raise AdapterError("automations.create recommendation digest is invalid")

        provenance = parameters.get("provenance")
        if not isinstance(provenance, Mapping) or set(provenance) != {"run_id", "session_id"}:
            raise AdapterError("automations.create provenance must contain exactly run_id and session_id")
        run_id = provenance.get("run_id")
        session_id = provenance.get("session_id")
        if (
            not isinstance(run_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", run_id)
            or not isinstance(session_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", session_id)
        ):
            raise AdapterError("automations.create trusted provenance IDs are invalid")

        name = parameters.get("name")
        objective = parameters.get("objective")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 160:
            raise AdapterError("automations.create name is invalid")
        if not isinstance(objective, str) or not objective.strip() or len(objective.strip()) > 4000:
            raise AdapterError("automations.create objective is invalid")

        trigger = parameters.get("trigger")
        if not isinstance(trigger, Mapping) or set(trigger) != {"kind", "spec"}:
            raise AdapterError("automations.create trigger must contain exactly kind and spec")
        trigger_kind = trigger.get("kind")
        trigger_spec = trigger.get("spec")
        if trigger_kind not in {"cron", "interval"} or not isinstance(trigger_spec, Mapping):
            raise AdapterError("automations.create supports recurring cron or interval triggers only")
        try:
            trigger_bytes = json.dumps(
                dict(trigger_spec),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise AdapterError(f"automations.create trigger is not JSON-safe: {exc}") from exc
        if len(trigger_bytes) > 16 * 1024:
            raise AdapterError("automations.create trigger exceeds the safe size limit")

        canonical_trigger = {
            "kind": trigger_kind,
            "spec": dict(trigger_spec),
        }
        stable_name = name.strip()
        stable_objective = objective.strip()
        identity_material = {
            "scope": scope,
            "name": stable_name.casefold(),
            "objective": stable_objective,
            "trigger": canonical_trigger,
            "target_kind": "gateway",
            "action_class": "read_local",
        }
        semantic_digest = hashlib.sha256(
            json.dumps(
                identity_material,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()

        definition = {
            "name": stable_name,
            "scope": scope,
            "target_kind": "gateway",
            "target_ref": None,
            "action_class": "read_local",
            "wake": {
                "objective": stable_objective,
                "created_via": "gateway_explicit_consent",
                "consent": dict(consent),
            },
            "trigger": canonical_trigger,
            "idempotency_key": "gateway-consented:" + semantic_digest,
        }
        owner_result = self._run_automations_create_definition(definition)
        state = owner_result.get("state")
        automation = owner_result.get("automation")
        created_trigger = owner_result.get("trigger")
        if (
            state not in {"created", "existing"}
            or not isinstance(automation, Mapping)
            or not isinstance(created_trigger, Mapping)
            or automation.get("scope") != scope
            or automation.get("target_kind") != "gateway"
            or automation.get("action_class") != "read_local"
            or created_trigger.get("kind") != trigger_kind
        ):
            raise AdapterError("Automations owner returned inconsistent canonical state")

        return {
            "status": "succeeded",
            "effect_occurred": state == "created",
            "result": {
                "automation": {
                    "state": state,
                    "automation_id": automation.get("id"),
                    "trigger_id": created_trigger.get("id"),
                    "trigger_kind": trigger_kind,
                    "next_run_at": created_trigger.get("next_run_at"),
                    "consent_mode": mode,
                }
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "modify_canonical_state",
                "operation": "automations.create",
                "owner": "ai-verse-automations",
                "gateway_run_id": run_id,
            },
        }

    def _migration_receipts_root(self) -> Path:
        operator = self.root / "operator"
        if not operator.is_dir() or operator.is_symlink():
            raise AdapterError("operator owner root is unavailable or unsafe")
        inbox = operator / "inbox"
        if inbox.exists():
            if inbox.is_symlink() or not inbox.is_dir():
                raise AdapterError("operator inbox is unsafe")
        else:
            inbox.mkdir(mode=0o700)
        base = inbox / "migration-imports"
        if base.exists():
            if base.is_symlink() or not base.is_dir():
                raise AdapterError("migration import receipt directory is unsafe")
        else:
            base.mkdir(mode=0o700)
        if not _inside(base.resolve(), operator.resolve()):
            raise AdapterError("migration import receipt directory escapes operator ownership")
        return base

    @staticmethod
    def _migration_bounded_list(plan: Mapping[str, Any], key: str, limit: int) -> list[Any]:
        value = plan.get(key, [])
        if not isinstance(value, list) or len(value) > limit:
            raise AdapterError(f"migration.import {key} must be an array with at most {limit} items")
        return list(value)

    def _migration_execute_subaction(
        self,
        *,
        action_class: str,
        scope: str,
        operation: str,
        parameters: Mapping[str, Any],
        idempotency_key: str,
        reason: str,
        executor: Optional[Callable[[Mapping[str, Any], str, Mapping[str, Any]], Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        subrequest: Dict[str, Any] = {
            "action_class": action_class,
            "scope": self._validate_scope(scope),
            "operation": operation,
            "parameters": dict(parameters),
            "idempotency_key": idempotency_key,
            "in_scope": True,
            "within_budget": True,
            "reversible": action_class == "write_local_reversible",
            "reason": reason,
        }
        subrequest["request_fingerprint"] = _fingerprint(subrequest)
        authorization = self.authorize_action(subrequest)
        if not isinstance(authorization, Mapping) or authorization.get("decision") != "allow":
            return {
                "status": "blocked",
                "effect_occurred": False,
                "result": {
                    "reason": "owner authorization did not allow the migration subaction",
                    "authorization": {
                        "decision": authorization.get("decision") if isinstance(authorization, Mapping) else None,
                    },
                },
            }
        if executor is not None:
            return executor(subrequest, scope, dict(parameters))
        return self.request_action(subrequest)

    @staticmethod
    def _compact_migration_result(kind: str, index: int, result: Mapping[str, Any]) -> Dict[str, Any]:
        compact: Dict[str, Any] = {
            "index": index,
            "status": result.get("status"),
            "effect_occurred": result.get("effect_occurred") is True,
        }
        payload = result.get("result")
        if not isinstance(payload, Mapping):
            return compact
        if kind == "workspace":
            organized = payload.get("workspace_organization")
            if isinstance(organized, Mapping):
                compact["state"] = organized.get("state")
                workspace = organized.get("workspace")
                if isinstance(workspace, Mapping):
                    compact["workspace_id"] = workspace.get("id")
        elif kind == "memory":
            captured = payload.get("memory_capture")
            if isinstance(captured, Mapping):
                compact["state"] = captured.get("state")
                compact["memory_id"] = captured.get("memory_id")
        elif kind == "data":
            candidate = payload.get("data_candidate")
            if isinstance(candidate, Mapping):
                compact["state"] = candidate.get("state")
            record = payload.get("record")
            if isinstance(record, Mapping):
                compact["record_state"] = record.get("state")
        if isinstance(payload.get("reason"), str):
            compact["reason"] = payload.get("reason")[:500]
        return compact

    def _request_migration_import(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if scope != "operator":
            raise AdapterError("migration.import must begin at operator scope")
        if not isinstance(parameters, Mapping) or set(parameters) != {"source", "plan"}:
            raise AdapterError("migration.import parameters must contain exactly source and plan")

        source = parameters.get("source")
        plan = parameters.get("plan")
        if not isinstance(source, Mapping) or not isinstance(plan, Mapping):
            raise AdapterError("migration.import source and plan must be objects")
        source_allowed = {"kind", "text", "label"}
        if set(source) - source_allowed:
            raise AdapterError("migration.import source contains unsupported fields")
        source_kind = source.get("kind")
        source_text = source.get("text")
        source_label = source.get("label")
        if not isinstance(source_kind, str) or not source_kind.strip() or len(source_kind.strip()) > 80:
            raise AdapterError("migration.import source.kind is invalid")
        if not isinstance(source_text, str) or not source_text.strip() or "\x00" in source_text:
            raise AdapterError("migration.import source.text must be non-empty text")
        source_bytes = source_text.encode("utf-8")
        if len(source_bytes) > _MIGRATION_MAX_SOURCE_BYTES:
            raise AdapterError(
                f"migration.import source exceeds {_MIGRATION_MAX_SOURCE_BYTES} bytes; split it into bounded chunks"
            )
        if source_label is not None and (
            not isinstance(source_label, str) or not source_label.strip() or len(source_label.strip()) > 240
        ):
            raise AdapterError("migration.import source.label is invalid when provided")

        plan_allowed = {"workspaces", "memories", "data"}
        extras = set(plan) - plan_allowed
        if extras:
            raise AdapterError(
                "migration.import plan contains unsupported sections: " + ", ".join(sorted(extras))
            )
        try:
            plan_bytes = json.dumps(
                dict(plan),
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise AdapterError(f"migration.import plan is not JSON-safe: {exc}") from exc
        if len(plan_bytes) > _MIGRATION_MAX_PLAN_BYTES:
            raise AdapterError(
                f"migration.import plan exceeds {_MIGRATION_MAX_PLAN_BYTES} bytes; split it into bounded chunks"
            )

        workspaces = self._migration_bounded_list(
            plan, "workspaces", _MIGRATION_MAX_WORKSPACES
        )
        memories = self._migration_bounded_list(
            plan, "memories", _MIGRATION_MAX_MEMORIES
        )
        data_items = self._migration_bounded_list(
            plan, "data", _MIGRATION_MAX_DATA_ITEMS
        )

        source_digest = hashlib.sha256(source_bytes).hexdigest()
        plan_digest = hashlib.sha256(plan_bytes).hexdigest()
        import_key = hashlib.sha256(
            f"{source_digest}:{plan_digest}".encode("utf-8")
        ).hexdigest()
        receipts_root = self._migration_receipts_root()
        receipt_path = receipts_root / f"{import_key}.json"
        if receipt_path.exists():
            if receipt_path.is_symlink() or not receipt_path.is_file():
                raise AdapterError("existing migration import receipt is unsafe")
            try:
                existing = json.loads(receipt_path.read_text(encoding="utf-8"))
            except Exception as exc:
                raise AdapterError(f"existing migration import receipt is invalid: {exc}") from exc
            if (
                not isinstance(existing, dict)
                or existing.get("source_sha256") != source_digest
                or existing.get("plan_sha256") != plan_digest
            ):
                raise AdapterError("migration import idempotency receipt does not match its source/plan")
            return {
                "status": "succeeded",
                "effect_occurred": False,
                "result": {"migration_import": {**existing, "replayed": True}},
                "execution_binding": {
                    "request_fingerprint": _fingerprint(request),
                    "scope": scope,
                    "action_class": "write_local_reversible",
                    "operation": "migration.import",
                    "source_sha256": source_digest,
                    "plan_sha256": plan_digest,
                },
            }

        workspace_results: list[Dict[str, Any]] = []
        memory_results: list[Dict[str, Any]] = []
        data_results: list[Dict[str, Any]] = []
        any_effect = False

        for index, raw in enumerate(workspaces):
            if not isinstance(raw, Mapping):
                workspace_results.append({"index": index, "status": "rejected", "reason": "workspace plan item must be an object"})
                continue
            if "provenance" in raw:
                workspace_results.append({"index": index, "status": "rejected", "reason": "workspace migration item may not supply trusted provenance"})
                continue
            params = dict(raw)
            params["provenance"] = {
                "trigger_ref": f"migration:sha256:{source_digest}",
                "classifier": "migration-runtime",
                "source": source_kind.strip(),
            }
            try:
                sub = self._migration_execute_subaction(
                    action_class="write_local_reversible",
                    scope="operator",
                    operation="workspace.ensure",
                    parameters=params,
                    idempotency_key=f"migration:{import_key}:workspace:{index}",
                    reason="Create or evolve a clear substantial workspace found in an explicit migration drop.",
                )
                compact = self._compact_migration_result("workspace", index, sub)
                any_effect = any_effect or compact["effect_occurred"]
                workspace_results.append(compact)
            except Exception as exc:
                workspace_results.append({"index": index, "status": "rejected", "reason": str(exc)[:500]})

        for index, raw in enumerate(memories):
            if not isinstance(raw, Mapping):
                memory_results.append({"index": index, "status": "rejected", "reason": "memory plan item must be an object"})
                continue
            item = dict(raw)
            item_scope = item.pop("scope", "operator")
            try:
                item_scope = self._validate_scope(item_scope)
            except Exception as exc:
                memory_results.append({"index": index, "status": "rejected", "reason": str(exc)[:500]})
                continue
            forbidden = {"source", "evidence_refs", "effect_id", "workspace"}
            supplied = forbidden.intersection(item)
            if supplied:
                memory_results.append({
                    "index": index,
                    "status": "rejected",
                    "reason": "memory migration item supplied trusted fields: " + ", ".join(sorted(supplied)),
                })
                continue
            item["source"] = f"migration-drop:{source_kind.strip()}:sha256:{source_digest}"
            item["evidence_refs"] = [f"migration-source:sha256:{source_digest}"]
            item["effect_id"] = f"migration:{import_key}:memory:{index}"
            try:
                sub = self._migration_execute_subaction(
                    action_class="write_local_reversible",
                    scope=item_scope,
                    operation="memory.capture",
                    parameters=item,
                    idempotency_key=f"migration:{import_key}:memory:{index}",
                    reason="Import a high-confidence durable historical item through the Memory owner.",
                )
                compact = self._compact_migration_result("memory", index, sub)
                any_effect = any_effect or compact["effect_occurred"]
                memory_results.append(compact)
            except Exception as exc:
                memory_results.append({"index": index, "status": "rejected", "reason": str(exc)[:500]})

        for index, raw in enumerate(data_items):
            if not isinstance(raw, Mapping):
                data_results.append({"index": index, "status": "rejected", "reason": "Data plan item must be an object"})
                continue
            if set(raw) != {"scope", "candidate"}:
                data_results.append({"index": index, "status": "rejected", "reason": "Data migration item must contain exactly scope and candidate"})
                continue
            item_scope = raw.get("scope")
            candidate = raw.get("candidate")
            try:
                item_scope = self._validate_scope(item_scope)
                if not item_scope.startswith("workspace:"):
                    raise AdapterError("Data migration items require workspace scope")
            except Exception as exc:
                data_results.append({"index": index, "status": "rejected", "reason": str(exc)[:500]})
                continue
            if not isinstance(candidate, Mapping):
                data_results.append({"index": index, "status": "rejected", "reason": "Data migration candidate must be an object"})
                continue
            candidate = dict(candidate)
            forbidden = {
                "candidate_id", "scope", "evidence_refs", "created_at", "task_evidence",
                "actor", "authorization", "approval", "idempotency_key", "idempotencyKey",
            }
            supplied = forbidden.intersection(candidate)
            if supplied:
                data_results.append({
                    "index": index,
                    "status": "rejected",
                    "reason": "Data migration candidate supplied trusted fields: " + ", ".join(sorted(supplied)),
                })
                continue
            candidate.update({
                "candidate_id": f"migration-data-{import_key[:24]}-{index}",
                "scope": item_scope,
                "evidence_refs": [f"migration-source:sha256:{source_digest}"],
                "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            })
            params = {
                "candidate": candidate,
                "task_evidence": {"substantial_task": True},
            }
            try:
                sub = self._migration_execute_subaction(
                    action_class="write_local_reversible",
                    scope=item_scope,
                    operation="data.structured-truth",
                    parameters=params,
                    idempotency_key=f"migration:{import_key}:data:{index}",
                    reason="Import clear current structured operational truth through Brain admission and the Data owner.",
                    executor=lambda subrequest, sub_scope, subparams: self._request_data_structured_truth(
                        subrequest,
                        sub_scope,
                        subparams,
                        actor_id="ai-verse-migration-import",
                    ),
                )
                compact = self._compact_migration_result("data", index, sub)
                any_effect = any_effect or compact["effect_occurred"]
                data_results.append(compact)
            except Exception as exc:
                data_results.append({"index": index, "status": "rejected", "reason": str(exc)[:500]})

        completed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        receipt = {
            "schema_version": "1.0",
            "owner": "ai-verse-os",
            "operation": "migration.import",
            "source_kind": source_kind.strip(),
            "source_label": source_label.strip() if isinstance(source_label, str) else None,
            "source_sha256": source_digest,
            "source_bytes": len(source_bytes),
            "plan_sha256": plan_digest,
            "import_key": import_key,
            "completed_at": completed_at,
            "workspaces": workspace_results,
            "memories": memory_results,
            "data": data_results,
            "counts": {
                "workspace_items": len(workspaces),
                "memory_items": len(memories),
                "data_items": len(data_items),
                "effects": sum(
                    1
                    for row in [*workspace_results, *memory_results, *data_results]
                    if row.get("effect_occurred") is True
                ),
            },
            "raw_source_persisted": False,
            "replayed": False,
        }
        temp_path = receipt_path.with_name(f".{receipt_path.name}.{uuid4().hex}.tmp")
        temp_path.write_text(
            json.dumps(receipt, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        temp_path.replace(receipt_path)

        return {
            "status": "succeeded",
            "effect_occurred": any_effect,
            "result": {"migration_import": receipt},
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "migration.import",
                "source_sha256": source_digest,
                "plan_sha256": plan_digest,
            },
        }

    def request_action(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(request, Mapping):
            raise AdapterError("action request must be an object")
        action_class = request.get("action_class")
        scope = self._validate_scope(request.get("scope"))
        operation = request.get("operation")
        parameters = request.get("parameters")

        if action_class == "write_local_reversible" and operation == "migration.import":
            return self._request_migration_import(request, scope, parameters)
        if action_class == "write_local_reversible" and operation == "workspace.ensure":
            return self._request_workspace_ensure(request, scope, parameters)
        if action_class == "write_local_reversible" and operation == "memory.capture":
            return self._request_memory_capture(request, scope, parameters)
        if action_class == "write_local_reversible" and operation == "memory.session_digest":
            return self._request_memory_session_digest(request, scope, parameters)
        if action_class == "write_local_reversible" and operation == "skills.learning-candidate":
            return self._request_skills_learning_candidate(request, scope, parameters)
        if action_class == "write_local_reversible" and operation == "data.structured-truth":
            return self._request_data_structured_truth(request, scope, parameters)
        if action_class == "write_local_reversible" and operation == "workers.temporary":
            return self._request_temporary_worker(request, scope, parameters)
        if action_class == "modify_canonical_state" and operation == "bots.permanent":
            return self._request_permanent_bot(request, scope, parameters)
        if action_class == "modify_canonical_state" and operation == "automations.create":
            return self._request_automation_create(request, scope, parameters)
        if action_class == "read_local" and operation in _DATA_READ_OPERATIONS:
            return self._request_data_read(request, scope, operation, parameters)

        if action_class != "read_local" or operation != "capability.read_instructions":
            return {
                "status": "failed",
                "effect_occurred": False,
                "result": {
                    "reason": (
                        "supported adapter executes capability.read_instructions plus the safe "
                        "migration.import, workspace.ensure, memory.capture, memory.session_digest, skills.learning-candidate, data.structured-truth, workers.temporary, explicit-consent bots.permanent, explicit-consent automations.create and bounded Data reads only"
                    ),
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


    def _run_data_host_request(
        self,
        scope: str,
        operation: str,
        payload: Mapping[str, Any],
        reason: str,
        *,
        actor: Optional[Mapping[str, str]] = None,
    ) -> Dict[str, Any]:
        scope = self._validate_scope(scope)
        if not scope.startswith("workspace:"):
            raise AdapterError("Data owner requests require workspace:<id> scope")
        if not self._data_available():
            raise AdapterError("AI-Verse Data is unavailable")
        if not isinstance(operation, str) or not operation.startswith("data."):
            raise AdapterError("Data owner operation is invalid")
        if not isinstance(payload, Mapping):
            raise AdapterError("Data owner payload must be an object")
        request: Dict[str, Any] = {
            "protocol": "ai-verse-os-data-host/1.0",
            "request_id": f"os-data-{uuid4()}",
            "operation": "request",
            "scope": scope,
            "data": {
                "operation": operation,
                "payload": dict(payload),
            },
            "reason": reason,
        }
        if actor is not None:
            request["actor"] = dict(actor)
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

    @staticmethod
    def _data_owner_result(host_result: Mapping[str, Any], operation: str) -> Dict[str, Any]:
        if host_result.get("status") == "approval_required":
            return {
                "approval_required": True,
                "permission": host_result.get("permission"),
            }
        if host_result.get("status") != "succeeded":
            raise AdapterError(f"OS Data host did not succeed for {operation}")
        owner = host_result.get("result")
        if not isinstance(owner, Mapping) or owner.get("ok") is not True:
            raise AdapterError(f"Data owner returned an invalid success envelope for {operation}")
        result = owner.get("result")
        if not isinstance(result, (dict, list)):
            raise AdapterError(f"Data owner returned invalid result data for {operation}")
        return dict(owner)

    def _data_orientation(self, scope: str) -> Dict[str, Any]:
        try:
            listed_host = self._run_data_host_request(
                scope,
                "data.space.list",
                {},
                "Read bounded structured-data orientation for runtime context.",
            )
            listed = self._data_owner_result(listed_host, "data.space.list")
            spaces = listed.get("result")
            if not isinstance(spaces, list):
                raise AdapterError("Data space list result is invalid")
            output = []
            total_schemas = 0
            for space in spaces[:16]:
                if not isinstance(space, Mapping) or not isinstance(space.get("spaceId"), str):
                    continue
                schemas_host = self._run_data_host_request(
                    scope,
                    "data.schema.list",
                    {"spaceId": space["spaceId"]},
                    "Read bounded structured-data schema orientation for runtime context.",
                )
                schemas_owner = self._data_owner_result(schemas_host, "data.schema.list")
                schemas = schemas_owner.get("result")
                if not isinstance(schemas, list):
                    continue
                remaining = max(0, 64 - total_schemas)
                selected = [
                    {
                        "spaceId": row.get("spaceId"),
                        "entity": row.get("entity"),
                        "name": row.get("name"),
                        "schemaVersion": row.get("schemaVersion"),
                        "fieldCount": row.get("fieldCount"),
                    }
                    for row in schemas[:remaining]
                    if isinstance(row, Mapping)
                ]
                total_schemas += len(selected)
                output.append(
                    {
                        "spaceId": space.get("spaceId"),
                        "name": space.get("name"),
                        "schemas": selected,
                    }
                )
                if total_schemas >= 64:
                    break
            return {"state": "available", "spaces": output}
        except Exception as exc:
            return {
                "state": "unavailable",
                "spaces": [],
                "reason": str(exc)[:500],
            }

    @staticmethod
    def _auto_data_key(candidate_id: str, suffix: str) -> str:
        digest = hashlib.sha256(f"{candidate_id}:{suffix}".encode("utf-8")).hexdigest()
        return f"auto-data:{digest}"

    def _request_data_read(
        self,
        request: Mapping[str, Any],
        scope: str,
        operation: str,
        parameters: Any,
    ) -> Dict[str, Any]:
        if operation not in _DATA_READ_OPERATIONS:
            raise AdapterError(f"unsupported Data read operation: {operation}")
        if not isinstance(parameters, Mapping):
            raise AdapterError(f"{operation} parameters must be an object")
        host_result = self._run_data_host_request(
            scope,
            operation,
            parameters,
            "Read canonical structured current truth through the Data owner.",
        )
        owner = self._data_owner_result(host_result, operation)
        if owner.get("approval_required") is True:
            return {
                "status": "blocked",
                "effect_occurred": False,
                "result": {"reason": "Data read unexpectedly requires approval"},
            }
        return {
            "status": "succeeded",
            "effect_occurred": False,
            "result": {"data": owner.get("result")},
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "read_local",
                "operation": operation,
            },
        }

    def _request_data_structured_truth(
        self,
        request: Mapping[str, Any],
        scope: str,
        parameters: Any,
        *,
        actor_id: str = "ai-verse-gateway",
    ) -> Dict[str, Any]:
        if not scope.startswith("workspace:"):
            raise AdapterError("data.structured-truth requires workspace scope")
        if not isinstance(parameters, Mapping):
            raise AdapterError("data.structured-truth parameters must be an object")
        if set(parameters) != {"candidate", "task_evidence"}:
            raise AdapterError(
                "data.structured-truth parameters must contain exactly candidate and task_evidence"
            )
        candidate = parameters.get("candidate")
        task_evidence = parameters.get("task_evidence")
        if not isinstance(candidate, Mapping):
            raise AdapterError("data.structured-truth candidate must be an object")
        if (
            not isinstance(task_evidence, Mapping)
            or set(task_evidence) != {"substantial_task"}
            or not isinstance(task_evidence.get("substantial_task"), bool)
        ):
            raise AdapterError("data.structured-truth task_evidence must contain exactly substantial_task:boolean")

        if self._extension_entry("ai-verse-brain") is None:
            raise AdapterError("AI-Verse Brain is unavailable")
        try:
            from aiverse_brain.learning import admit_data_structure_candidate
        except Exception as exc:
            raise AdapterError(f"AI-Verse Brain Data-candidate gate is unavailable: {exc}") from exc

        admission = admit_data_structure_candidate(
            dict(candidate),
            bound_scope=scope,
            substantial_task=task_evidence["substantial_task"],
        )
        if not isinstance(admission, dict) or admission.get("state") not in {"admitted", "ignored"}:
            raise AdapterError("Brain Data-candidate gate returned an invalid result")
        if admission["state"] == "ignored":
            return {
                "status": "succeeded",
                "effect_occurred": False,
                "result": {"data_candidate": admission},
                "execution_binding": {
                    "request_fingerprint": _fingerprint(request),
                    "scope": scope,
                    "action_class": "write_local_reversible",
                    "operation": "data.structured-truth",
                },
            }

        envelope = admission.get("envelope")
        if not isinstance(envelope, Mapping):
            raise AdapterError("Brain admitted Data candidate without an envelope")
        candidate_id = envelope.get("candidate_id")
        structure = envelope.get("structure")
        match = envelope.get("match")
        record = envelope.get("record")
        if (
            not isinstance(candidate_id, str)
            or not isinstance(structure, Mapping)
            or not isinstance(match, Mapping)
            or not isinstance(record, Mapping)
        ):
            raise AdapterError("Brain admitted Data envelope is incomplete")
        space = structure.get("space")
        schema = structure.get("schema")
        record_data = record.get("data")
        if not isinstance(space, Mapping) or not isinstance(schema, Mapping) or not isinstance(record_data, Mapping):
            raise AdapterError("Brain admitted Data structure/record is invalid")
        space_id = schema.get("spaceId")
        entity = schema.get("entity")
        match_field = match.get("field")
        if not all(isinstance(value, str) and value for value in (space_id, entity, match_field)):
            raise AdapterError("Brain admitted Data identifiers are invalid")

        if not isinstance(actor_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._:-]{0,127}", actor_id):
            raise AdapterError("Data structured-truth actor id is invalid")
        actor = {"kind": "system", "id": actor_id}
        structure_payload = {
            "idempotencyKey": self._auto_data_key(candidate_id, "structure"),
            "space": dict(space),
            "schema": dict(schema),
            "reason": envelope.get("summary"),
        }
        try:
            structure_host = self._run_data_host_request(
                scope,
                "data.structure.ensure",
                structure_payload,
                "Safely ensure the Data structure admitted by Brain.",
                actor=actor,
            )
            structure_owner = self._data_owner_result(structure_host, "data.structure.ensure")
        except AdapterError as exc:
            return {
                "status": "blocked",
                "effect_occurred": False,
                "result": {
                    "data_candidate": admission,
                    "record": {
                        "state": "not_mutated",
                        "reason": str(exc)[:1000],
                    },
                },
                "execution_binding": {
                    "request_fingerprint": _fingerprint(request),
                    "scope": scope,
                    "action_class": "write_local_reversible",
                    "operation": "data.structured-truth",
                },
            }
        if structure_owner.get("approval_required") is True:
            return {
                "status": "blocked",
                "effect_occurred": False,
                "result": {
                    "data_candidate": admission,
                    "reason": "Data structure owner requires approval",
                },
            }
        structure_result = structure_owner.get("result")
        structure_changed = bool(
            isinstance(structure_result, Mapping)
            and isinstance(structure_result.get("result"), Mapping)
            and structure_result["result"].get("changed") is True
        )

        try:
            query_host = self._run_data_host_request(
                scope,
                "data.query",
                {
                    "spaceId": space_id,
                    "entity": entity,
                    "where": {
                        "field": match_field,
                        "op": "eq",
                        "value": match.get("value"),
                    },
                    "limit": 2,
                },
                "Check the Data owner for an existing natural-key match before mutation.",
            )
            query_owner = self._data_owner_result(query_host, "data.query")
        except AdapterError as exc:
            return {
                "status": "blocked",
                "effect_occurred": bool(
                    isinstance(structure_owner.get("result"), Mapping)
                    and isinstance(structure_owner["result"].get("result"), Mapping)
                    and structure_owner["result"]["result"].get("changed") is True
                ),
                "result": {
                    "data_candidate": admission,
                    "structure": structure_owner.get("result"),
                    "record": {"state": "not_mutated", "reason": str(exc)[:1000]},
                },
            }
        query_result = query_owner.get("result")
        if not isinstance(query_result, Mapping) or not isinstance(query_result.get("items"), list):
            raise AdapterError("Data duplicate-check query returned invalid result")
        rows = query_result["items"]
        if query_result.get("hasMore") is True or len(rows) > 1:
            return {
                "status": "blocked",
                "effect_occurred": bool(
                    isinstance(structure_owner.get("result"), Mapping)
                    and structure_owner["result"].get("result", {}).get("changed")
                ),
                "result": {
                    "data_candidate": admission,
                    "structure": structure_owner.get("result"),
                    "record": {
                        "state": "ambiguous",
                        "reason": "multiple canonical records match the admitted natural key",
                    },
                },
            }

        record_state = "existing"
        record_owner: Optional[Dict[str, Any]] = None
        changed = False
        if len(rows) == 0:
            try:
                create_host = self._run_data_host_request(
                    scope,
                    "data.record.create",
                    {
                        "spaceId": space_id,
                        "entity": entity,
                        "idempotencyKey": self._auto_data_key(candidate_id, "record-create"),
                        "data": dict(record_data),
                    },
                    "Create the admitted canonical structured current record.",
                    actor=actor,
                )
                record_owner = self._data_owner_result(create_host, "data.record.create")
            except AdapterError as exc:
                return {
                    "status": "blocked",
                    "effect_occurred": structure_changed,
                    "result": {
                        "data_candidate": admission,
                        "structure": structure_owner.get("result"),
                        "record": {"state": "not_mutated", "reason": str(exc)[:1000]},
                    },
                }
            if record_owner.get("approval_required") is True:
                return {
                    "status": "blocked",
                    "effect_occurred": False,
                    "result": {"data_candidate": admission, "reason": "Data record create requires approval"},
                }
            record_state = "created"
            changed = True
        else:
            existing = rows[0]
            if not isinstance(existing, Mapping) or not isinstance(existing.get("data"), Mapping):
                raise AdapterError("Data duplicate-check row is invalid")
            patch = {
                key: value
                for key, value in record_data.items()
                if existing["data"].get(key) != value
            }
            if patch:
                record_id = existing.get("recordId")
                version = existing.get("version")
                if not isinstance(record_id, str) or not isinstance(version, int):
                    raise AdapterError("Data existing record identity/version is invalid")
                try:
                    update_host = self._run_data_host_request(
                        scope,
                        "data.record.update",
                        {
                            "spaceId": space_id,
                            "entity": entity,
                            "recordId": record_id,
                            "expectedVersion": version,
                            "idempotencyKey": self._auto_data_key(candidate_id, f"record-update:{record_id}:{version}"),
                            "patch": patch,
                        },
                        "Update the exact existing structured record admitted by Brain.",
                        actor=actor,
                    )
                    record_owner = self._data_owner_result(update_host, "data.record.update")
                except AdapterError as exc:
                    return {
                        "status": "blocked",
                        "effect_occurred": structure_changed,
                        "result": {
                            "data_candidate": admission,
                            "structure": structure_owner.get("result"),
                            "record": {"state": "not_mutated", "reason": str(exc)[:1000]},
                        },
                    }
                if record_owner.get("approval_required") is True:
                    return {
                        "status": "blocked",
                        "effect_occurred": False,
                        "result": {"data_candidate": admission, "reason": "Data record update requires approval"},
                    }
                record_state = "updated"
                changed = True

        return {
            "status": "succeeded",
            "effect_occurred": bool(changed or structure_changed),
            "result": {
                "data_candidate": admission,
                "structure": structure_result,
                "record": {
                    "state": record_state,
                    "owner_result": None if record_owner is None else record_owner.get("result"),
                },
            },
            "execution_binding": {
                "request_fingerprint": _fingerprint(request),
                "scope": scope,
                "action_class": "write_local_reversible",
                "operation": "data.structured-truth",
                "space_id": space_id,
                "entity": entity,
                "match_field": match_field,
            },
        }

    def query_data(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise AdapterError("query_data payload must be an object")
        scope = self._validate_scope(payload.get("scope"))
        operation = payload.get("operation")
        data_payload = payload.get("payload")
        if operation not in _DATA_READ_OPERATIONS:
            raise AdapterError(f"query_data operation is not read-only/supported: {operation!r}")
        if not isinstance(data_payload, Mapping):
            raise AdapterError("query_data payload.payload must be an object")
        return self._run_data_host_request(
            scope,
            operation,
            data_payload,
            "Read-only structured-data query requested through the AI-Verse OS Brain host.",
        )


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
    sys.stdout.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n")


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
        elif operation == PROGRESSIVE_HISTORY_OPERATION:
            result = host.retrieve_history_progressive(payload)
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
