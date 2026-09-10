#!/usr/bin/env python3
"""Supported AI-Verse OS host adapter for AI-Verse Brain.

This adapter is intentionally thin. It owns no canonical state. It delegates:
- current context to AI-Verse OS current-context resolution;
- history recall to the installed AI-Verse Memory runtime;
- capability discovery/selection to the OS capability resolver;
- action permission to the OS action-permission gate;
- immutable generation pinning to the AI-Verse Skills lifecycle CLI;
- receipt semantics to AI-Verse Skills execution_receipt_v2.py.

The bridge protocol is AI-Verse Brain's ai-verse-brain-bridge/1.0.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable, Dict, Iterable, Mapping, Optional
from uuid import uuid4

PROTOCOL = "ai-verse-brain-bridge/1.0"
ADAPTER_ID = "ai-verse-os:four-component-host"
OPERATIONS = [
    "read_context",
    "retrieve_history",
    "list_capabilities",
    "list_connections",
    "authorize_action",
    "request_action",
]
_SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9._-]{0,127})$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_MAX_SKILL_BYTES = 256 * 1024


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
    if not path.is_file():
        raise AdapterError(f"required component is missing: {path}")
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


class OSFourComponentHost:
    def __init__(
        self,
        root: Path,
        skills_root: Path,
        skills_entrypoint: Path,
        local_skills_root: Optional[Path] = None,
        after_pin: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.skills_root = Path(skills_root).expanduser().resolve()
        self.skills_entrypoint = Path(skills_entrypoint).expanduser().resolve()
        self.local_skills_root = (
            Path(local_skills_root).expanduser().resolve()
            if local_skills_root is not None
            else Path.home() / ".aiverse" / "local-skills"
        )
        self.after_pin = after_pin
        if not (self.root / "AI-VERSE.yaml").is_file():
            raise AdapterError(f"AI-Verse OS root not found: {self.root}")
        if not self.skills_entrypoint.is_file():
            raise AdapterError(f"AI-Verse Skills entrypoint not found: {self.skills_entrypoint}")

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
    def memory_entrypoint(self) -> Path:
        return self.root / "scripts" / "ai-verse-memory" / "memory.py"

    @property
    def skills_validator(self) -> Path:
        return self.skills_entrypoint.parent / "execution_receipt_v2.py"

    def describe(self) -> Dict[str, Any]:
        return {
            "adapter_id": ADAPTER_ID,
            "protocol_version": "1.0",
            "operations": OPERATIONS,
            "idempotency_supported": False,
            "metadata": {
                "host": "ai-verse-os",
                "memory": "installed-native",
                "skills": "external-immutable-generation",
                "canonical_state_owned": False,
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
        memory = _load_module(self.memory_entrypoint, "_aiverse_os_host_memory")
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
                "limit": 1000,
            }
        )
        candidates = result.get("candidates")
        if not isinstance(candidates, list) or any(not isinstance(item, dict) for item in candidates):
            raise AdapterError("OS capability resolver returned an invalid candidate list")
        return [dict(item) for item in candidates]

    def list_connections(self, scope: str) -> list[Dict[str, Any]]:
        self._validate_scope(scope)
        return []

    def authorize_action(self, request: Mapping[str, Any]) -> Dict[str, Any]:
        if not isinstance(request, Mapping):
            raise AdapterError("action permission request must be an object")
        return _run_json(
            ["node", str(self.permission_cli), "--root", str(self.root)],
            request,
            "OS action permission",
        )

    def _pin_package(self, bare_id: str) -> Dict[str, Any]:
        proc = subprocess.run(
            [
                sys.executable,
                str(self.skills_entrypoint),
                "--root",
                str(self.skills_root),
                "pin",
                "--package",
                bare_id,
                "--json",
            ],
            text=True,
            capture_output=True,
            shell=False,
        )
        if proc.returncode != 0:
            raise AdapterError(
                "Skills generation pin failed: "
                + (proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
            )
        return _json_object(proc.stdout, "Skills generation pin")

    def _validate_receipt(self, receipt: Mapping[str, Any], expected: Mapping[str, Any]) -> Dict[str, Any]:
        validator = _load_module(self.skills_validator, "_aiverse_os_host_receipt_v2")
        try:
            validated = validator.validate_receipt(receipt, expected_binding=expected)
        except Exception as exc:
            raise AdapterError(f"Skills receipt validation failed: {exc}") from exc
        if not isinstance(validated, dict):
            raise AdapterError("Skills receipt validator returned an invalid result")
        return validated

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

        selected = self._resolver(
            {
                "operation": "select",
                "scope": scope,
                "qualified_id": capability_id,
            }
        )
        if selected.get("status") != "selected" or not isinstance(selected.get("selection"), dict):
            raise AdapterError(f"requested capability is unavailable: {capability_id}")
        selection = selected["selection"]
        if selection.get("generation_id") != expected_generation:
            raise AdapterError("capability generation changed before execution pin")
        if selection.get("digest") != dict(expected_digest):
            raise AdapterError("capability package digest changed before execution pin")

        bare_id = capability_id.split(":", 1)[1]
        pin = self._pin_package(bare_id)
        if pin.get("generation_id") != expected_generation:
            raise AdapterError("active Skills generation changed before execution could be pinned")
        package_path = Path(str(pin.get("package_path", ""))).resolve()
        generation_path = Path(str(pin.get("generation_path", ""))).resolve()
        try:
            package_path.relative_to(generation_path)
        except ValueError as exc:
            raise AdapterError("pinned package path escapes its immutable generation") from exc

        if self.after_pin is not None:
            self.after_pin(dict(pin))

        skill_md = package_path / "SKILL.md"
        if not skill_md.is_file() or skill_md.is_symlink():
            raise AdapterError("pinned capability is missing a regular SKILL.md")
        data = skill_md.read_bytes()
        if len(data) > _MAX_SKILL_BYTES:
            raise AdapterError("pinned capability SKILL.md exceeds the safe read limit")
        instructions = data.decode("utf-8")
        request_fingerprint = _fingerprint(request)

        binding = {
            "request_fingerprint": request_fingerprint,
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
        validated = self._validate_receipt(receipt, binding)
        return {
            "status": "succeeded",
            "effect_occurred": False,
            "result": {
                "receipt": validated,
                "instructions": instructions,
                "instruction_sha256": hashlib.sha256(data).hexdigest(),
            },
            "execution_binding": binding,
        }


def _write_config(
    target: Path,
    root: Path,
    skills_root: Path,
    skills_entrypoint: Path,
    local_skills_root: Optional[Path],
) -> None:
    adapter_path = Path(__file__).resolve()
    command = [
        sys.executable,
        str(adapter_path),
        "--root",
        str(root.resolve()),
        "--skills-root",
        str(skills_root.resolve()),
        "--skills-entrypoint",
        str(skills_entrypoint.resolve()),
    ]
    if local_skills_root is not None:
        command.extend(["--local-skills-root", str(local_skills_root.resolve())])
    payload = {
        "schema_version": "1.0",
        "name": "ai-verse-os-four-component-host",
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
    parser.add_argument("--skills-root", required=True)
    parser.add_argument("--skills-entrypoint", required=True)
    parser.add_argument("--local-skills-root")
    parser.add_argument("--write-config")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = Path(args.root).expanduser().resolve()
    skills_root = Path(args.skills_root).expanduser().resolve()
    skills_entrypoint = Path(args.skills_entrypoint).expanduser().resolve()
    local = Path(args.local_skills_root).expanduser().resolve() if args.local_skills_root else None

    if args.write_config:
        _write_config(Path(args.write_config), root, skills_root, skills_entrypoint, local)
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
        host = OSFourComponentHost(root, skills_root, skills_entrypoint, local)
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
        else:
            raise AdapterError(f"operation is not implemented by this adapter: {operation}")
    except Exception as exc:
        _respond(request, error=str(exc))
        return 1

    _respond(request, result=result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
