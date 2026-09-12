#!/usr/bin/env python3
"""Acceptance for the maintained AI-Verse OS four-component host adapter."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

from aiverse_brain import BrainRuntime, Scope
from aiverse_brain.action_boundary import ActionExecutor, ActionRequest
from aiverse_brain.cadence import Trigger
from aiverse_brain.direction_ownership import DirectionOwnershipService
from aiverse_brain.errors import PermissionDenied
from aiverse_brain.host_selection import select_host
from aiverse_brain.policy import BrainPolicy
from aiverse_brain.skills_receipt import (
    SkillsExecutionIdentity,
    translate_action_receipt,
)
from aiverse_brain.tick_output import build_tick_summary


def run(command):
    return subprocess.run(command, text=True, capture_output=True, check=True)


def load_adapter(path: Path):
    spec = importlib.util.spec_from_file_location("aiverse_os_supported_host", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["aiverse_os_supported_host"] = module
    spec.loader.exec_module(module)
    return module


def skills_pin(skills_entrypoint: Path, skills_root: Path):
    result = run([
        sys.executable,
        str(skills_entrypoint),
        "--root",
        str(skills_root),
        "pin",
        "--json",
    ])
    return json.loads(result.stdout)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--skills-root", required=True)
    parser.add_argument("--skills-entrypoint", required=True)
    parser.add_argument("--skills-cache", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    skills_root = Path(args.skills_root).resolve()
    skills_entrypoint = Path(args.skills_entrypoint).resolve()
    skills_cache = Path(args.skills_cache).resolve()
    config = Path(args.config).resolve()
    adapter_path = root / "scripts" / "ai_verse_host_adapter.py"

    run([
        sys.executable,
        str(adapter_path),
        "--root",
        str(root),
        "--skills-root",
        str(skills_root),
        "--local-skills-root",
        str(root.parent / "no-local-skills"),
        "--write-config",
        str(config),
    ])

    selection = select_host(str(root), host_adapter_config=str(config))
    assert selection.real_host is True
    assert selection.adapter_id == "ai-verse-os:host"
    assert {
        "read_context",
        "retrieve_history",
        "list_capabilities",
        "list_connections",
        "authorize_action",
        "request_action",
    }.issubset(set(selection.operations))
    host = selection.host

    current = root / "operator" / "context" / "CURRENT.md"
    current.parent.mkdir(parents=True, exist_ok=True)
    current.write_text(
        "# Current Context\n\n"
        "## Current priorities\n\n"
        "- Ship the Aurora release after whisper dialogue transcription and transcode validation.\n\n"
        "## Current state\n\n"
        "- Aurora assets are staged locally.\n",
        encoding="utf-8",
    )
    run([
        sys.executable,
        str(root / "scripts" / "ai-verse-memory" / "memory.py"),
        "--root",
        str(root),
        "remember",
        "--type",
        "experience",
        "--scope",
        "operator",
        "--source",
        "supported-host-acceptance",
        "--text",
        "Aurora release prerequisite: transcode dialogue with whisper before delivery",
    ])

    runtime = BrainRuntime(str(root))
    ownership = DirectionOwnershipService(runtime.controller)
    assert ownership.owner("operator") == "os"
    handover = ownership.handover("operator", confirm_import=True)
    assert handover.owner == "brain"
    assert handover.state == "active"
    assert handover.brain_refs

    resolved = host.read_context("operator")
    assert resolved["direction_owner"] == "brain"
    assert "Ship the Aurora release" not in resolved["current_context"]
    assert "Aurora assets are staged locally" in resolved["current_context"]

    history = list(host.retrieve_history("Aurora release prerequisite whisper", "operator"))
    assert any("Aurora release prerequisite" in str(row.get("text", "")) for row in history)

    connection_registry = root / "connections" / "registry.yaml"
    connection_registry.parent.mkdir(parents=True, exist_ok=True)
    connection_registry.write_text(
        'schema_version: "2.0"\n'
        'connections:\n'
        '  - id: acceptance-local\n'
        '    name: Acceptance Local\n'
        '    mechanism: local\n'
        '    status: configured\n'
        '    scope:\n'
        '      operator: true\n'
        '      workspaces: []\n',
        encoding="utf-8",
    )
    connections = list(host.list_connections("operator"))
    assert connections == [{
        "id": "acceptance-local",
        "name": "Acceptance Local",
        "mechanism": "local",
        "status": "configured",
        "authoritative_for": [],
    }]

    capabilities = list(host.list_capabilities("operator"))
    whisper = next(row for row in capabilities if row.get("id") == "aiverse-skills:whisper")
    assert whisper.get("generation_id")
    assert whisper.get("digest", {}).get("algorithm") == "aiverse-package-sha256-v1"

    class CaptureReasoner:
        model_id = "supported-host-capture"

        def __init__(self):
            self.contexts = []

        def reason(self, request, context):
            self.contexts.append((request, context))
            return {"proposals": []}

    reasoner = CaptureReasoner()
    tick = runtime.run_tick(
        Trigger("scheduled_orientation", Scope("operator"), "supported-four-component-host"),
        host=host,
        reasoner=reasoner,
        session_id="supported-four-component-host",
    )
    assert tick.ok, tick.errors
    assert reasoner.contexts
    summary = build_tick_summary(tick, selection, runtime)
    assert summary["orientation"]["direction_owner"] == "brain"
    assert any(
        "Aurora release prerequisite" in str(row.get("text", ""))
        for _, context in reasoner.contexts
        for row in context.get("history", [])
    )

    read_policy = BrainPolicy()
    read_policy.action_policy["read_local"] = "allow_within_scope"
    request = ActionRequest(
        action_class="read_local",
        scope=Scope("operator"),
        operation="capability.read_instructions",
        parameters={
            "capability_id": whisper["id"],
            "expected_generation_id": whisper["generation_id"],
            "expected_package_digest": whisper["digest"],
        },
        idempotency_key="supported-host-read-whisper",
        in_scope=True,
        within_budget=True,
        reversible=False,
        reason="Astra harmless local capability acceptance",
    )
    outcome = ActionExecutor(root, read_policy).execute(request, host)
    assert outcome.status == "succeeded"
    receipt = outcome.result["receipt"]
    assert outcome.result["instructions"]
    identity = SkillsExecutionIdentity(
        capability_id=whisper["id"],
        generation_id=whisper["generation_id"],
        package_digest_sha256=whisper["digest"]["value"],
    )
    translated = translate_action_receipt(receipt, request, identity)
    assert translated["status"] == "succeeded"
    assert translated["effect_occurred"] is False
    assert translated["execution_binding"]["generation_id"] == whisper["generation_id"]

    policy_file = root / "automations" / "policies" / "action-permissions.yaml"
    policy_file.parent.mkdir(parents=True, exist_ok=True)
    policy_file.write_text(
        'schema_version: "1.0"\n'
        "approval:\n"
        '  external_actions: "deny"\n'
        '  destructive_actions: "deny"\n'
        '  high_stakes_decisions: "deny"\n',
        encoding="utf-8",
    )
    deny_policy = BrainPolicy()
    deny_policy.action_policy["send_message"] = "allow_within_scope"
    denied = ActionRequest(
        action_class="send_message",
        scope=Scope("operator"),
        operation="send",
        parameters={"to": "nobody@example.test", "body": "must not dispatch"},
        idempotency_key="supported-host-policy-denial",
        in_scope=True,
        within_budget=True,
        reversible=True,
        reason="Astra policy denial acceptance",
    )
    try:
        ActionExecutor(root, deny_policy).execute(denied, host, host_idempotency_supported=True)
    except PermissionDenied:
        pass
    else:
        raise AssertionError("OS policy denial did not block the Brain action boundary")
    policy_file.unlink()

    # Build a second valid immutable generation from the existing cache, then
    # restore the first generation so an execution can pin it before the pointer
    # changes during the read.
    first_pin = skills_pin(skills_entrypoint, skills_root)
    run([
        sys.executable,
        str(skills_entrypoint),
        "--root",
        str(skills_root),
        "--cache",
        str(skills_cache),
        "update",
        "--offline",
    ])
    second_pin = skills_pin(skills_entrypoint, skills_root)
    assert second_pin["generation_id"] != first_pin["generation_id"]
    run([
        sys.executable,
        str(skills_entrypoint),
        "--root",
        str(skills_root),
        "rollback",
    ])
    restored = skills_pin(skills_entrypoint, skills_root)
    assert restored["generation_id"] == first_pin["generation_id"]

    adapter_module = load_adapter(adapter_path)
    switched = {"done": False}

    def switch_generation(_pin):
        run([
            sys.executable,
            str(skills_entrypoint),
            "--root",
            str(skills_root),
            "rollback",
        ])
        switched["done"] = True

    direct_host = adapter_module.OSFourComponentHost(
        root,
        skills_root,
        skills_entrypoint,
        root.parent / "no-local-skills",
        after_pin=switch_generation,
    )
    first_capabilities = direct_host.list_capabilities("operator")
    pinned_whisper = next(row for row in first_capabilities if row.get("id") == "aiverse-skills:whisper")
    assert pinned_whisper["generation_id"] == first_pin["generation_id"]
    race_request = {
        "request_id": "update-during-execution",
        "action_class": "read_local",
        "scope": "operator",
        "operation": "capability.read_instructions",
        "parameters": {
            "capability_id": pinned_whisper["id"],
            "expected_generation_id": pinned_whisper["generation_id"],
            "expected_package_digest": pinned_whisper["digest"],
        },
        "idempotency_key": "supported-host-update-during-execution",
        "in_scope": True,
        "within_budget": True,
        "reversible": False,
        "reason": "Astra generation pin race acceptance",
        "created_at": "2026-09-10T00:00:00+00:00",
    }
    race_result = direct_host.request_action(race_request)
    assert switched["done"] is True
    active_after = skills_pin(skills_entrypoint, skills_root)
    assert active_after["generation_id"] == second_pin["generation_id"]
    assert race_result["status"] == "succeeded"
    assert race_result["execution_binding"]["generation_id"] == first_pin["generation_id"]
    assert race_result["result"]["receipt"]["binding"]["generation_id"] == first_pin["generation_id"]

    print("Supported dynamic OS host adapter acceptance: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
