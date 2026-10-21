#!/usr/bin/env python3
"""Actual owner composition in disposable roots, no native callbacks or personal launcher."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

parser = argparse.ArgumentParser()
parser.add_argument("--skills-source", type=Path, required=True)
parser.add_argument("--brain-source", type=Path, required=True)
parser.add_argument("--distribution-source", type=Path, required=True)
args = parser.parse_args()
for value in [args.skills_source, args.brain_source / "engine", args.distribution_source / "src"]:
    sys.path.insert(0, str(value.resolve()))
from tests.test_public_beta_learning import PublicBetaLearningTests
from installer import aiverse_skills as skills, member_library as library
from aiverse_distribution.member_skills import configure_member_skills, provider_configuration
from aiverse_brain.learning import admit_skills_learning_candidate

source = Path(__file__).resolve().parents[1]
fixture = PublicBetaLearningTests("test_setup_status_and_lifecycle_separation")
fixture.setUp()
checks = 0
try:
    root = fixture.base / "os"
    root.mkdir()
    (root / "operator/context").mkdir(parents=True)
    shutil.copytree(source / "scripts", root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(source / "system/capabilities/audit", root / "system/capabilities/audit")
    shutil.copyfile(source / "AI-VERSE.yaml", root / "AI-VERSE.yaml")
    shutil.copyfile(source / "AGENTS.md", root / "AGENTS.md")
    for workspace in ["alpha", "beta"]:
        directory = root / "workspaces" / workspace
        directory.mkdir(parents=True)
        (directory / "WORKSPACE.yaml").write_text('schema_version: "2.0"\nid: ' + workspace + '\nstatus: active\n')
    entry = args.skills_source.resolve() / "installer/aiverse_skills.py"
    command = [sys.executable, str(entry), "--root", str(fixture.root)]
    configured = configure_member_skills(root, args.skills_source.resolve(), command, [*command, "status", "--json"])
    assert len(configured) == 2
    config = provider_configuration(root)
    assert config["configured"] and Path(config["localSkillsRoot"]) == (fixture.root.parent / "member-skills").resolve()
    personal = Path(config["localSkillsRoot"])
    assert not personal.exists()
    configure_member_skills(root, args.skills_source.resolve(), command, [*command, "status", "--json"])
    checks += 1
    module_spec = importlib.util.spec_from_file_location("shared_runtime_host", root / "scripts/ai_verse_host_adapter.py")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    host = module.AIverseOSHost(root)
    assert host.skills_root == fixture.root.resolve() and host.local_skills_root == personal
    assert host.skills_entrypoint == entry
    try:
        module.AIverseOSHost(root, skills_root=fixture.base / "wrong")
        raise AssertionError("conflicting runtime root accepted")
    except module.AdapterError:
        pass
    checks += 1
    def request(operation, parameters, scope="workspace:alpha", action="write_local_reversible"):
        payload = {"request_id": "fixture-" + operation, "scope": scope, "action_class": action, "operation": operation,
                   "parameters": parameters, "in_scope": True, "within_budget": True, "reversible": True,
                   "reason": "Isolated owner integration check"}
        return host.request_action(payload)
    package = root / "workspaces/alpha/inbox/method"
    package.mkdir(parents=True)
    (package / "SKILL.md").write_text('---\nname: reusable-method\ndescription: Verify a portable procedure\n---\nUse explicit inputs and verify the result.\n')
    parameters = {"source_relative": "workspaces/alpha/inbox/method", "admission": library.PORTABILITY}
    preview = request("skills.library-import", parameters)
    assert preview["status"] == "succeeded" and not preview["effect_occurred"], preview
    applied = request("skills.library-import", {**parameters, "plan": preview["result"]})
    assert applied["status"] == "succeeded" and applied["effect_occurred"]
    identity = applied["result"]["qualified_id"]
    candidate = next(x for x in host.list_capabilities("workspace:beta") if x["id"] == identity)
    checks += 1
    binding = request("skills.binding-plan", {"qualified_id": identity, "alias": "reusable-method", "binding": {"inputs": {"channel": "beta"}}}, scope="workspace:beta", action="read_local")
    assert request("skills.binding-save", {"plan": binding["result"]}, scope="workspace:beta")["status"] == "succeeded"
    read = request("capability.read_instructions", {"capability_id": identity, "expected_generation_id": candidate["generation_id"], "expected_package_digest": candidate["digest"]}, scope="workspace:beta", action="read_local")
    assert read["status"] == "succeeded" and read["result"]["skill_inputs"] == {"channel": "beta"}
    assert read["result"]["permission_granted"] is False and read["result"]["receipt"]["contract"] == "aiverse-capability-read-v1"
    read_alpha = request("capability.read_instructions", {"capability_id": identity, "expected_generation_id": candidate["generation_id"], "expected_package_digest": candidate["digest"]}, action="read_local")
    assert read_alpha["result"]["skill_inputs"] == {}
    checks += 1
    try:
        request("skills.library-import", {**parameters, "source_relative": "workspaces/alpha/inbox/method"}, scope="workspace:beta")
        raise AssertionError("sibling source accepted")
    except module.AdapterError:
        pass
    checks += 1
    registry = root / ".aiverse/extensions/registry.json"
    registry.parent.mkdir(parents=True)
    registry.write_text(json.dumps({"schema_version": "1.0", "extensions": {"ai-verse-brain": {"id": "ai-verse-brain", "supported": True, "installed": True, "enabled": True}}}))
    candidate_data = {"candidate_id": "runtime-shared-method", "scope": "workspace:alpha", "suggested_owner": "skills", "kind": "create", "summary": "Verified repeatable method", "skill_id": "learned-method",
                      "evidence_refs": ["run:fixture-success"], "success_signal": ["method succeeded"], "failure_signal": [], "risk": "low", "confidence": .95, "created_at": "2026-10-21T00:00:00Z",
                      "requested_capabilities": [], "requested_dependencies": [], "requires_connection": False, "requires_credential": False, "source_ownership": "agent_learned", "portability": library.PORTABILITY}
    admitted = admit_skills_learning_candidate(candidate_data, bound_scope="workspace:alpha", substantial_task=True)
    assert admitted["envelope"]["portability"] == library.PORTABILITY
    before = skills.pin_active_generation(fixture.root, skills.digest).generation_id
    learned = request("skills.learning-candidate", {"candidate": candidate_data, "skill_md": '---\nname: learned-method\ndescription: A different verified learned method\n---\nReview and verify an outcome.\n', "task_evidence": {"substantial_task": True}})
    assert learned["status"] == "succeeded", learned
    result = learned["result"]
    assert result["skills_result"]["state"] == "pending_approval", result
    assert len(library.read_index(personal)["skills"]) == 1
    proposal_id = result["skills_submission"]["proposal_id"]
    promoted = subprocess.run([*command, "proposals", "apply", proposal_id, "--approved-by", "fixture-user", "--json"], capture_output=True, text=True, check=True)
    promoted = json.loads(promoted.stdout)
    learned_id = promoted["member_import"]["qualified_id"]
    assert any(x["id"] == learned_id for x in host.list_capabilities("workspace:beta"))
    assert skills.pin_active_generation(fixture.root, skills.digest).generation_id == before
    checks += 1
    # Configured personal root is the recovery source, not a global fallback.
    from aiverse_distribution.recovery import LastKnownGoodStore
    class FakeState:
        def load(self): return {"root": str(root)}
    recovery = object.__new__(LastKnownGoodStore)
    recovery.state = FakeState()
    assert recovery._personal_skills_root() == personal
    checks += 1
    from aiverse_distribution.preservation import snapshot_member_state, require_member_state_preserved, PreservationMismatch
    snapshot = snapshot_member_state(root)
    assert snapshot["provider_roots"]["personal"] == str(personal)
    require_member_state_preserved(snapshot, snapshot_member_state(root))
    config_file = root / ".aiverse/capability-providers.json"
    original = config_file.read_bytes()
    moved = json.loads(original)
    moved["local_skills_root"] = str(fixture.base / "different-library")
    config_file.write_text(json.dumps(moved))
    try:
        require_member_state_preserved(snapshot, snapshot_member_state(root))
        raise AssertionError("provider-root drift was accepted")
    except PreservationMismatch:
        pass
    finally:
        config_file.write_bytes(original)
    checks += 1
    package = source / "system/extensions/packages/ai-verse-codex-learning"
    sys.path.insert(0, str(package))
    spec = importlib.util.spec_from_file_location("shared_package_install", package / "install.py")
    install = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(install)
    runtime = install.discover(root, {"python": sys.executable, "node": shutil.which("node")})
    assert Path(runtime["skills_root"]) == fixture.root.resolve()
    assert Path(runtime["skills_entrypoint"]) == entry
    try:
        install.discover(root, {"python": sys.executable, "node": shutil.which("node"), "skills_root": str(fixture.base / "wrong")})
        raise AssertionError("conflicting native helper root accepted")
    except ValueError:
        pass
    checks += 1
    print(f"Shared Skills Distribution -> OS host -> Brain/learning integration: PASS ({checks} groups)")
finally:
    fixture.tearDown()
