#!/usr/bin/env python3
"""WSA-2026-053: prove OS routes Brain natural-key admission into Data owner atomic create."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types


def load_adapter(path: Path):
    spec = importlib.util.spec_from_file_location("aiverse_os_natural_key_route", path)
    if spec is None or spec.loader is None:
        raise AssertionError("cannot load OS host adapter")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def succeeded(result):
    return {"status": "succeeded", "result": {"ok": True, "result": result}}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    adapter = load_adapter(root / "scripts" / "ai_verse_host_adapter.py")

    brain_package = types.ModuleType("aiverse_brain")
    brain_package.__path__ = []
    learning = types.ModuleType("aiverse_brain.learning")

    def admit_data_structure_candidate(candidate, *, bound_scope, substantial_task):
        assert candidate["candidate_id"] == "candidate-client-alpha"
        assert bound_scope == "workspace:client-alpha"
        assert substantial_task is True
        return {
            "state": "admitted",
            "envelope": {
                "candidate_id": "candidate-client-alpha",
                "summary": "Track canonical Client Alpha delivery state.",
                "structure": {
                    "space": {"spaceId": "client-alpha", "name": "Client Alpha"},
                    "schema": {
                        "spaceId": "client-alpha",
                        "entity": "delivery",
                        "name": "Delivery",
                        "fields": {
                            "external_id": {"type": "string", "required": True},
                            "status": {"type": "string", "required": True},
                        },
                    },
                },
                "match": {"field": "external_id", "value": "DEL-001"},
                "record": {
                    "data": {"external_id": "DEL-001", "status": "ready"}
                },
            },
        }

    learning.admit_data_structure_candidate = admit_data_structure_candidate
    brain_package.learning = learning
    prior_brain = sys.modules.get("aiverse_brain")
    prior_learning = sys.modules.get("aiverse_brain.learning")
    sys.modules["aiverse_brain"] = brain_package
    sys.modules["aiverse_brain.learning"] = learning

    try:
        with tempfile.TemporaryDirectory() as temp_name:
            fake_root = Path(temp_name)
            (fake_root / "AI-VERSE.yaml").write_text('schema_version: "1.0"\n', encoding="utf-8")
            host = adapter.AIverseOSHost(fake_root)
            host._extension_entry = lambda extension_id: {"id": extension_id}
            calls = []

            def fake_data_host(scope, operation, payload, reason, *, actor=None):
                calls.append(
                    {
                        "scope": scope,
                        "operation": operation,
                        "payload": dict(payload),
                        "reason": reason,
                        "actor": None if actor is None else dict(actor),
                    }
                )
                if operation == "data.structure.ensure":
                    return succeeded({"result": {"changed": False}})
                if operation == "data.query":
                    return succeeded({"items": [], "hasMore": False})
                if operation == "data.record.create":
                    return succeeded(
                        {
                            "recordId": "rec-1",
                            "version": 1,
                            "data": {"external_id": "DEL-001", "status": "ready"},
                        }
                    )
                raise AssertionError(f"unexpected Data operation: {operation}")

            host._run_data_host_request = fake_data_host
            request = {
                "action_class": "write_local_reversible",
                "scope": "workspace:client-alpha",
                "operation": "data.structured-truth",
                "parameters": {},
                "idempotency_key": "route-natural-key",
                "in_scope": True,
                "within_budget": True,
                "reversible": True,
                "reason": "natural-key route acceptance",
            }
            parameters = {
                "candidate": {
                    "candidate_id": "candidate-client-alpha",
                    "scope": "workspace:client-alpha",
                },
                "task_evidence": {"substantial_task": True},
            }

            result = host._request_data_structured_truth(
                request,
                "workspace:client-alpha",
                parameters,
            )
            assert result["status"] == "succeeded"

            creates = [call for call in calls if call["operation"] == "data.record.create"]
            assert len(creates) == 1, creates
            create = creates[0]
            assert create["actor"] == {"kind": "system", "id": "ai-verse-gateway"}
            assert create["payload"]["data"] == {
                "external_id": "DEL-001",
                "status": "ready",
            }
            assert create["payload"]["naturalKey"] == {
                "field": "external_id",
                "value": "DEL-001",
            }
            assert create["payload"]["naturalKey"]["field"] in create["payload"]["data"]
            assert (
                create["payload"]["data"][create["payload"]["naturalKey"]["field"]]
                == create["payload"]["naturalKey"]["value"]
            )
    finally:
        if prior_brain is None:
            sys.modules.pop("aiverse_brain", None)
        else:
            sys.modules["aiverse_brain"] = prior_brain
        if prior_learning is None:
            sys.modules.pop("aiverse_brain.learning", None)
        else:
            sys.modules["aiverse_brain.learning"] = prior_learning

    print("WSA-2026-053 OS natural-key routing: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
