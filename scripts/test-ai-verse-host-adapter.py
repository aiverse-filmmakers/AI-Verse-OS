#!/usr/bin/env python3
"""Acceptance for the maintained AI-Verse OS four-component host adapter."""

from __future__ import annotations

import argparse
import hashlib
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
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise AssertionError(
            f"command failed ({result.returncode}): {command!r}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result


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

    workspace_request = {
        "request_id": "automatic-workspace-client-alpha",
        "action_class": "write_local_reversible",
        "scope": "operator",
        "operation": "workspace.ensure",
        "parameters": {
            "workspace": {
                "id": "client-alpha",
                "name": "Client Alpha",
                "type": "client",
                "purpose": "Keep repeated Client Alpha work isolated.",
                "domains": ["delivery"],
                "canonical_sources": ["source://client-alpha"],
            },
            "evidence": {
                "substantial_scope": True,
                "boundary_clear": True,
                "reason": "Repeated meaningful Client Alpha work established a clear durable scope.",
            },
            "authority": {
                "permission_expansion": False,
                "privacy_ambiguous": False,
                "new_connection": False,
                "new_credential": False,
            },
            "provenance": {
                "trigger_ref": "run:host-acceptance",
                "classifier": "gateway-runtime",
                "source": "gateway",
            },
        },
        "idempotency_key": "automatic-workspace-client-alpha",
        "in_scope": True,
        "within_budget": True,
        "reversible": True,
        "reason": "Safe internal workspace organization requested through Gateway-compatible host action.",
        "request_fingerprint": hashlib.sha256(
            b"automatic-workspace-client-alpha"
        ).hexdigest(),
    }
    workspace_auth = direct_host.authorize_action(workspace_request)
    assert workspace_auth["decision"] == "allow"
    workspace_result = direct_host.request_action(workspace_request)
    assert workspace_result["status"] == "succeeded"
    organization = workspace_result["result"]["workspace_organization"]
    assert organization["state"] == "created"
    assert organization["workspace"]["id"] == "client-alpha"
    assert organization["user_confirmation_required"] is False
    assert (root / "workspaces" / "client-alpha" / "WORKSPACE.yaml").is_file()

    workspace_replay = direct_host.request_action(workspace_request)
    replay_organization = workspace_replay["result"]["workspace_organization"]
    assert replay_organization["state"] == "existing"
    assert replay_organization["changed"] is False

    memory_request = {
        "request_id": "automatic-memory-client-alpha",
        "action_class": "write_local_reversible",
        "scope": "workspace:client-alpha",
        "operation": "memory.capture",
        "parameters": {
            "text": "Client Alpha delivery reviews were more effective when the notes stayed concise.",
            "type": "lesson",
            "importance": 4,
            "confidence": 0.95,
            "source": "gateway-run",
            "why": "This historical pattern is likely to matter on later Client Alpha delivery work.",
            "tags": "delivery,review",
            "effect_id": "run:host-acceptance:memory-1",
            "evidence_refs": ["run:host-acceptance", "workspace:client-alpha"],
            "admission": {
                "durable": True,
                "historical": True,
                "current_truth": False,
                "contains_secret": False,
                "strategic": False,
                "permission_expansion": False,
                "privacy_ambiguous": False,
                "external_authority": False,
            },
        },
        "idempotency_key": "automatic-memory-client-alpha",
        "in_scope": True,
        "within_budget": True,
        "reversible": True,
        "reason": "Capture high-confidence durable historical evidence through the Memory owner.",
        "request_fingerprint": hashlib.sha256(
            b"automatic-memory-client-alpha"
        ).hexdigest(),
    }
    memory_auth = direct_host.authorize_action(memory_request)
    assert memory_auth["decision"] == "allow"
    memory_result = direct_host.request_action(memory_request)
    assert memory_result["status"] == "succeeded"
    capture = memory_result["result"]["memory_capture"]
    assert capture["state"] == "captured"
    assert capture["scope"] == "workspace:client-alpha"
    assert memory_result["effect_occurred"] is True

    memory_replay = direct_host.request_action(memory_request)
    assert memory_replay["status"] == "succeeded"
    assert memory_replay["result"]["memory_capture"]["state"] == "existing"
    assert memory_replay["effect_occurred"] is False

    digest_request = {
        "request_id": "completed-session-digest-client-alpha",
        "action_class": "write_local_reversible",
        "scope": "workspace:client-alpha",
        "operation": "memory.session_digest",
        "parameters": {
            "session_id": "sess-host-acceptance",
            "run_id": "run-host-acceptance",
            "topic": "Client Alpha delivery review",
            "summary": (
                "Request: Review Client Alpha delivery.\n"
                "Outcome: The concise checkpoint workflow was validated and the run completed."
            ),
            "significant_outcomes": ["Concise checkpoint workflow validated"],
            "unresolved_items": [],
            "source_coverage": [
                "gateway:run:run-host-acceptance:messages:0-5"
            ],
            "source_fingerprint": "sha256:" + hashlib.sha256(
                b"gateway-run-host-acceptance"
            ).hexdigest(),
            "completed_at": "2026-09-14T14:00:00+00:00",
        },
        "idempotency_key": "gateway:run-host-acceptance:session-digest",
        "in_scope": True,
        "within_budget": True,
        "reversible": True,
        "reason": "Persist compact completed-session history through the Memory owner.",
        "request_fingerprint": hashlib.sha256(
            b"completed-session-digest-client-alpha"
        ).hexdigest(),
    }
    digest_auth = direct_host.authorize_action(digest_request)
    assert digest_auth["decision"] == "allow"
    digest_result = direct_host.request_action(digest_request)
    assert digest_result["status"] == "succeeded"
    assert digest_result["effect_occurred"] is True
    digest = digest_result["result"]["memory_session_digest"]
    assert digest["state"] == "captured"
    assert digest["scope"] == "workspace:client-alpha"
    assert digest["session_id"] == "sess-host-acceptance"
    assert digest["run_id"] == "run-host-acceptance"
    assert digest["digest_id"].startswith("sdg-")

    digest_replay = direct_host.request_action(digest_request)
    replay_digest = digest_replay["result"]["memory_session_digest"]
    assert replay_digest["state"] == "existing"
    assert replay_digest["changed"] is False
    assert replay_digest["digest_id"] == digest["digest_id"]
    assert digest_replay["effect_occurred"] is False

    memory_engine_path = root / "scripts" / "ai-verse-memory" / "memory.py"
    memory_module = load_adapter(memory_engine_path)
    stored_digest = memory_module.read_session_digest(
        digest["digest_id"],
        scope="workspace:client-alpha",
        root=root,
        mode=memory_module.MODE_NATIVE,
    )
    assert stored_digest["source_refs"] == [
        "gateway:session:sess-host-acceptance",
        "gateway:run:run-host-acceptance",
    ]
    assert stored_digest["source_version"] == "gateway-run-v1"
    assert stored_digest["provenance"]["owner"] == "ai-verse-gateway"
    assert stored_digest["source_coverage"] == [
        "gateway:run:run-host-acceptance:messages:0-5"
    ]

    raw_digest = {
        **digest_request,
        "request_id": "completed-session-digest-raw-transcript",
        "idempotency_key": "completed-session-digest-raw-transcript",
        "parameters": {
            **digest_request["parameters"],
            "transcript": "User: raw transcript must never be accepted",
        },
    }
    raw_digest["request_fingerprint"] = hashlib.sha256(
        b"completed-session-digest-raw-transcript"
    ).hexdigest()
    try:
        direct_host.request_action(raw_digest)
    except adapter_module.AdapterError:
        pass
    else:
        raise AssertionError("memory.session_digest accepted a raw transcript field")

    cross_run_coverage = {
        **digest_request,
        "request_id": "completed-session-digest-cross-run",
        "idempotency_key": "completed-session-digest-cross-run",
        "parameters": {
            **digest_request["parameters"],
            "source_coverage": ["gateway:run:other-run:messages:0-5"],
        },
    }
    cross_run_coverage["request_fingerprint"] = hashlib.sha256(
        b"completed-session-digest-cross-run"
    ).hexdigest()
    try:
        direct_host.request_action(cross_run_coverage)
    except adapter_module.AdapterError:
        pass
    else:
        raise AssertionError("memory.session_digest accepted coverage from another Gateway run")

    unsafe_memory = {
        **memory_request,
        "request_id": "automatic-memory-secret",
        "idempotency_key": "automatic-memory-secret",
        "parameters": {
            **memory_request["parameters"],
            "text": "API key = sk-abcdefghijklmnopqrstuvwxyz1234567890",
            "effect_id": "run:host-acceptance:memory-secret",
        },
    }
    unsafe_memory["request_fingerprint"] = hashlib.sha256(
        b"automatic-memory-secret"
    ).hexdigest()
    unsafe_result = direct_host.request_action(unsafe_memory)
    assert unsafe_result["status"] == "blocked"
    assert unsafe_result["effect_occurred"] is False
    assert unsafe_result["result"]["memory_capture"]["state"] == "blocked"

    learning_request = {
        "request_id": "automatic-skill-learning-client-alpha",
        "action_class": "write_local_reversible",
        "scope": "workspace:client-alpha",
        "operation": "skills.learning-candidate",
        "parameters": {
            "candidate": {
                "candidate_id": "learn-host-client-alpha-review",
                "scope": "workspace:client-alpha",
                "suggested_owner": "skills",
                "kind": "create",
                "summary": "Reusable concise Client Alpha delivery review procedure.",
                "skill_id": "client-alpha-review",
                "evidence_refs": ["run:host-learning", "session:host-learning"],
                "success_signal": ["delivery review completed successfully"],
                "failure_signal": [],
                "risk": "low",
                "confidence": 0.95,
                "created_at": "2026-09-14T14:00:00Z",
                "requested_capabilities": [],
                "requested_dependencies": [],
                "requires_connection": False,
                "requires_credential": False,
                "source_ownership": "agent_learned",
            },
            "skill_md": (
                "---\n"
                "name: client-alpha-review\n"
                "description: Reusable concise Client Alpha delivery review procedure\n"
                "version: 1.0.0\n"
                "---\n\n"
                "Review the delivery against the brief, keep notes concise, and verify completion.\n"
            ),
            "task_evidence": {"substantial_task": True},
        },
        "idempotency_key": "automatic-skill-learning-client-alpha",
        "in_scope": True,
        "within_budget": True,
        "reversible": True,
        "reason": "Route substantial reusable-procedure evidence through Brain and Skills owners.",
        "request_fingerprint": hashlib.sha256(
            b"automatic-skill-learning-client-alpha"
        ).hexdigest(),
    }
    learning_auth = direct_host.authorize_action(learning_request)
    assert learning_auth["decision"] == "allow"
    learning_result = direct_host.request_action(learning_request)
    assert learning_result["status"] == "succeeded"
    assert learning_result["effect_occurred"] is True
    assert learning_result["result"]["learning_candidate"]["state"] == "admitted"
    assert learning_result["result"]["skills_result"]["state"] == "pending_approval"
    proposal_id = learning_result["execution_binding"]["proposal_id"]
    assert proposal_id == "learn-host-client-alpha-review"

    learning_replay = direct_host.request_action(learning_request)
    assert learning_replay["status"] == "succeeded"
    assert learning_replay["effect_occurred"] is False
    assert learning_replay["result"]["idempotent_replay"] is True
    assert learning_replay["execution_binding"]["proposal_id"] == proposal_id

    trivial_learning = {
        **learning_request,
        "request_id": "trivial-skill-learning",
        "idempotency_key": "trivial-skill-learning",
        "parameters": {
            **learning_request["parameters"],
            "candidate": {
                **learning_request["parameters"]["candidate"],
                "candidate_id": "learn-trivial-client-alpha-review",
                "skill_id": "trivial-client-alpha-review",
            },
            "task_evidence": {"substantial_task": False},
        },
    }
    trivial_learning["request_fingerprint"] = hashlib.sha256(
        b"trivial-skill-learning"
    ).hexdigest()
    trivial_result = direct_host.request_action(trivial_learning)
    assert trivial_result["status"] == "succeeded"
    assert trivial_result["effect_occurred"] is False
    assert trivial_result["result"]["learning_candidate"]["state"] == "ignored"

    unsafe_learning = {
        **learning_request,
        "request_id": "unsafe-skill-learning",
        "idempotency_key": "unsafe-skill-learning",
        "parameters": {
            **learning_request["parameters"],
            "candidate": {
                **learning_request["parameters"]["candidate"],
                "candidate_id": "learn-unsafe-client-alpha-review",
                "skill_id": "../escape",
            },
        },
    }
    unsafe_learning["request_fingerprint"] = hashlib.sha256(
        b"unsafe-skill-learning"
    ).hexdigest()
    try:
        direct_host.request_action(unsafe_learning)
    except Exception as exc:
        assert "safe skill_id" in str(exc)
    else:
        raise AssertionError("unsafe learned Skill id was not rejected by Brain before Skills mutation")

    cross_scope = dict(workspace_request)
    cross_scope["scope"] = "workspace:client-alpha"
    cross_scope["parameters"] = {
        **workspace_request["parameters"],
        "workspace": {
            **workspace_request["parameters"]["workspace"],
            "id": "other-client",
            "name": "Other Client",
        },
    }
    try:
        direct_host.request_action(cross_scope)
    except adapter_module.AdapterError:
        pass
    else:
        raise AssertionError("workspace-scoped ensure escaped its bound workspace")
    for invalid_scope in ("workspace:film_team", "workspace:film.team"):
        try:
            direct_host.list_capabilities(invalid_scope)
        except adapter_module.AdapterError:
            pass
        else:
            raise AssertionError(f"noncanonical workspace scope was accepted: {invalid_scope}")

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

    # Prove the full later-use path with the real Skills owner:
    # auto-promote -> restart host -> rediscover -> execute -> quarantine -> rollback.
    learning_mode = json.loads(run([
        sys.executable,
        str(skills_entrypoint),
        "--root",
        str(skills_root),
        "learning",
        "mode",
        "auto",
        "--json",
    ]).stdout)
    assert learning_mode["mode"] == "auto"

    later_host = adapter_module.OSFourComponentHost(
        root,
        skills_root,
        skills_entrypoint,
        root.parent / "no-local-skills",
    )
    later_request = {
        **learning_request,
        "request_id": "automatic-skill-learning-later-use",
        "idempotency_key": "automatic-skill-learning-later-use",
        "parameters": {
            **learning_request["parameters"],
            "candidate": {
                **learning_request["parameters"]["candidate"],
                "candidate_id": "learn-host-client-alpha-later-use",
                "skill_id": "client-alpha-later-use",
                "summary": "Reusable verified Client Alpha later-use review procedure.",
                "created_at": "2026-09-14T14:30:00Z",
            },
            "skill_md": (
                "---\n"
                "name: client-alpha-later-use\n"
                "description: Reusable verified Client Alpha later-use review procedure\n"
                "version: 1.0.0\n"
                "---\n\n"
                "Review the delivery against the brief, keep notes concise, verify completion, "
                "and preserve a short evidence-backed handoff.\n"
            ),
        },
    }
    later_request["request_fingerprint"] = adapter_module._fingerprint(later_request)
    assert later_host.authorize_action(later_request)["decision"] == "allow"
    later_result = later_host.request_action(later_request)
    assert later_result["status"] == "succeeded"
    assert later_result["result"]["learning_candidate"]["state"] == "admitted"
    applied = later_result["result"]["skills_result"]
    assert applied["state"] == "applied"
    assert applied["approved_by"] == "policy:auto"
    learned_proposal_id = applied["proposal_id"]
    learned_generation_id = applied["applied_generation_id"]
    backup_generation_id = applied["backup_generation_id"]
    assert skills_pin(skills_entrypoint, skills_root)["generation_id"] == learned_generation_id

    # Recreate the host object to prove discovery comes from persisted owner state,
    # not an in-process cache or the learning response.
    restarted_host = adapter_module.OSFourComponentHost(
        root,
        skills_root,
        skills_entrypoint,
        root.parent / "no-local-skills",
    )
    restarted_capabilities = restarted_host.list_capabilities("workspace:client-alpha")
    learned_capability = next(
        row for row in restarted_capabilities
        if row.get("id") == "aiverse-skills:client-alpha-later-use"
    )
    assert learned_capability["generation_id"] == learned_generation_id

    use_request = {
        "request_id": "later-task-use-learned-skill",
        "action_class": "read_local",
        "scope": "workspace:client-alpha",
        "operation": "capability.read_instructions",
        "parameters": {
            "capability_id": learned_capability["id"],
            "expected_generation_id": learned_capability["generation_id"],
            "expected_package_digest": learned_capability["digest"],
        },
        "idempotency_key": "later-task-use-learned-skill",
        "in_scope": True,
        "within_budget": True,
        "reversible": False,
        "reason": "Use the persisted learned Skill on a later Client Alpha task.",
    }
    use_request["request_fingerprint"] = adapter_module._fingerprint(use_request)
    assert restarted_host.authorize_action(use_request)["decision"] == "allow"
    used = restarted_host.request_action(use_request)
    assert used["status"] == "succeeded"
    assert used["execution_binding"]["generation_id"] == learned_generation_id
    assert "keep notes concise" in used["result"]["instructions"]
    assert used["result"]["receipt"]["binding"]["capability_id"] == learned_capability["id"]

    unsafe_later = {
        **later_request,
        "request_id": "automatic-skill-learning-quarantine",
        "idempotency_key": "automatic-skill-learning-quarantine",
        "parameters": {
            **later_request["parameters"],
            "candidate": {
                **later_request["parameters"]["candidate"],
                "candidate_id": "learn-host-client-alpha-quarantine",
                "skill_id": "client-alpha-quarantine",
                "summary": "Unsafe candidate must remain quarantined.",
                "created_at": "2026-09-14T14:31:00Z",
            },
            "skill_md": (
                "---\n"
                "name: client-alpha-quarantine\n"
                "description: Unsafe quarantine fixture\n"
                "version: 1.0.0\n"
                "---\n\n"
                "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n"
            ),
        },
    }
    unsafe_later["request_fingerprint"] = adapter_module._fingerprint(unsafe_later)
    unsafe_later_result = restarted_host.request_action(unsafe_later)
    assert unsafe_later_result["status"] == "succeeded"
    assert unsafe_later_result["result"]["skills_result"]["state"] == "quarantined"
    after_quarantine = adapter_module.OSFourComponentHost(
        root,
        skills_root,
        skills_entrypoint,
        root.parent / "no-local-skills",
    ).list_capabilities("workspace:client-alpha")
    assert not any(
        row.get("id") == "aiverse-skills:client-alpha-quarantine"
        for row in after_quarantine
    )

    rolled_back = json.loads(run([
        sys.executable,
        str(skills_entrypoint),
        "--root",
        str(skills_root),
        "proposals",
        "rollback",
        learned_proposal_id,
        "--json",
    ]).stdout)
    assert rolled_back["rollback_generation_id"] == backup_generation_id
    assert skills_pin(skills_entrypoint, skills_root)["generation_id"] == backup_generation_id

    post_rollback_host = adapter_module.OSFourComponentHost(
        root,
        skills_root,
        skills_entrypoint,
        root.parent / "no-local-skills",
    )
    post_rollback_capabilities = post_rollback_host.list_capabilities("workspace:client-alpha")
    assert not any(
        row.get("id") == "aiverse-skills:client-alpha-later-use"
        for row in post_rollback_capabilities
    )

    print("Supported dynamic OS host adapter acceptance: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
