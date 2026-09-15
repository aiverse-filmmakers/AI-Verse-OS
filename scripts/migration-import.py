#!/usr/bin/env python3
"""Direct Codex/Claude transport for AI-Verse migration drops.

This script deliberately exposes only the bounded migration.import action.
It does not create a second owner or bypass OS authorization. The exact same
AI-Verse host action is used by Gateway mode.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any, Dict


def fail(message: str, code: int = 2) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stdout)
    raise SystemExit(code)


def load_host_module(root: Path):
    path = root / "scripts" / "ai_verse_host_adapter.py"
    if not path.is_file() or path.is_symlink():
        fail(f"AI-Verse host adapter is missing or unsafe: {path}")
    spec = importlib.util.spec_from_file_location("_aiverse_direct_migration_host", path)
    if spec is None or spec.loader is None:
        fail("Unable to load the AI-Verse host adapter")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="migration-import")
    parser.add_argument("--root", default=".")
    return parser.parse_args()


def read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("Migration payload JSON is required on stdin")
    if len(raw.encode("utf-8")) > 2 * 1024 * 1024:
        fail("Migration payload exceeds the direct-runtime transport limit")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"Migration payload is invalid JSON: {exc}")
    if not isinstance(payload, dict) or set(payload) != {"source", "plan"}:
        fail("Migration payload must contain exactly source and plan")
    return payload


def main() -> int:
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    if not (root / "AI-VERSE.yaml").is_file():
        fail(f"AI-Verse OS root not found: {root}")

    payload = read_payload()
    module = load_host_module(root)
    host = module.AIverseOSHost(root)

    semantic = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    digest = hashlib.sha256(semantic).hexdigest()

    request: Dict[str, Any] = {
        "action_class": "write_local_reversible",
        "scope": "operator",
        "operation": "migration.import",
        "parameters": payload,
        "idempotency_key": f"direct-migration:{digest[:48]}",
        "in_scope": True,
        "within_budget": True,
        "reversible": True,
        "reason": "Safely organize an accumulated prior-assistant context or memory migration drop through canonical AI-Verse owners.",
    }
    request["request_fingerprint"] = module._fingerprint(request)

    authorization = host.authorize_action(request)
    if not isinstance(authorization, dict) or authorization.get("decision") != "allow":
        output = {
            "ok": False,
            "status": "blocked",
            "authorization": {
                "decision": authorization.get("decision") if isinstance(authorization, dict) else None,
                "reason": authorization.get("reason") if isinstance(authorization, dict) else None,
            },
        }
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
        return 3

    result = host.request_action(request)
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, separators=(",", ":")))
    return 0 if result.get("status") == "succeeded" else 4


if __name__ == "__main__":
    raise SystemExit(main())
