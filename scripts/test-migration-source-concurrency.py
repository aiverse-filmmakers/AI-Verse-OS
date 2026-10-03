#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parent / "ai_verse_host_adapter.py"
THIS = Path(__file__).resolve()
SOURCE_TEXT = "Client Alpha is an active client imported from prior assistant context."


def load_host_module():
    spec = importlib.util.spec_from_file_location(
        f"_aiverse_migration_concurrency_{os.getpid()}", SCRIPT
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load host adapter")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def request_for(module, plan):
    payload = {
        "source": {
            "kind": "prior-assistant-context",
            "text": SOURCE_TEXT,
            "label": "Concurrency regression source",
        },
        "plan": plan,
    }
    request = {
        "action_class": "write_local_reversible",
        "scope": "operator",
        "operation": "migration.import",
        "parameters": payload,
        "idempotency_key": "migration-source-concurrency-test",
        "in_scope": True,
        "within_budget": True,
        "reversible": True,
        "reason": "WSA-2026-052 regression",
    }
    request["request_fingerprint"] = module._fingerprint(request)
    return request


def atomic_owner_effect(effects_root: Path, request, parameters, crash_after_effect: bool, delay: float):
    key = request["idempotency_key"]
    effect_path = effects_root / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json")
    created = False
    try:
        fd = os.open(str(effect_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fd = None
    if fd is not None:
        created = True
        payload = json.dumps(
            {
                "idempotency_key": key,
                "workspace_id": parameters.get("workspace", {}).get("id"),
                "pid": os.getpid(),
            },
            sort_keys=True,
        ).encode("utf-8")
        try:
            os.write(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        if crash_after_effect:
            os._exit(86)
        if delay:
            time.sleep(delay)
    return {
        "status": "succeeded",
        "effect_occurred": created,
        "result": {
            "workspace_organization": {
                "state": "created" if created else "existing",
                "workspace": {"id": parameters.get("workspace", {}).get("id")},
            }
        },
    }


def worker_main(argv: list[str]) -> int:
    if len(argv) != 7:
        raise SystemExit(
            "worker requires ROOT EFFECTS PLAN RESULT START MODE DELAY"
        )
    root = Path(argv[0])
    effects_root = Path(argv[1])
    plan_path = Path(argv[2])
    result_path = Path(argv[3])
    start_path = Path(argv[4])
    mode = argv[5]
    delay = float(argv[6])
    deadline = time.monotonic() + 15.0
    while not start_path.exists():
        if time.monotonic() >= deadline:
            result_path.write_text(
                json.dumps({"ok": False, "error": "start barrier timed out"}),
                encoding="utf-8",
            )
            return 0
        time.sleep(0.01)

    module = load_host_module()
    host = module.AIverseOSHost(root)
    host.authorize_action = lambda request: {
        "decision": "allow",
        "scope": request.get("scope"),
        "request_fingerprint": request.get("request_fingerprint"),
    }

    def workspace_action(request, scope, parameters):
        return atomic_owner_effect(
            effects_root,
            request,
            parameters,
            crash_after_effect=mode == "crash-after-effect",
            delay=delay,
        )

    host._request_workspace_ensure = workspace_action
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    try:
        response = host.request_action(request_for(module, plan))
        payload = {"ok": True, "response": response}
    except Exception as exc:
        payload = {"ok": False, "error": str(exc), "type": type(exc).__name__}
    result_path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    return 0


def workspace_plan(workspace_id: str) -> dict:
    return {
        "workspaces": [
            {
                "workspace": {
                    "id": workspace_id,
                    "name": workspace_id.replace("-", " ").title(),
                    "type": "client",
                    "purpose": "Concurrency regression workspace.",
                },
                "evidence": {
                    "substantial_scope": True,
                    "boundary_clear": True,
                    "reason": "Named durable client scope",
                },
                "authority": {
                    "permission_expansion": False,
                    "privacy_ambiguous": False,
                    "new_connection": False,
                    "new_credential": False,
                },
            }
        ]
    }


def plan_digest(plan: dict) -> str:
    raw = json.dumps(
        plan,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


class MigrationSourceConcurrencyTests(unittest.TestCase):
    def make_case(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        root = base / "os"
        root.mkdir()
        (root / "AI-VERSE.yaml").write_text(
            'schema_version: "2.0"\narchitecture: unified-workspace\n',
            encoding="utf-8",
        )
        (root / "operator").mkdir()
        (root / "workspaces").mkdir()
        effects = base / "effects"
        effects.mkdir()
        return base, root, effects

    def write_plan(self, base: Path, name: str, plan: dict) -> Path:
        path = base / f"{name}.json"
        path.write_text(json.dumps(plan, sort_keys=True), encoding="utf-8")
        return path

    def launch(
        self,
        *,
        root: Path,
        effects: Path,
        plan_path: Path,
        result_path: Path,
        start_path: Path,
        mode: str = "normal",
        delay: float = 0.35,
    ) -> subprocess.Popen:
        return subprocess.Popen(
            [
                sys.executable,
                str(THIS),
                "--worker",
                str(root),
                str(effects),
                str(plan_path),
                str(result_path),
                str(start_path),
                mode,
                str(delay),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def result(self, proc: subprocess.Popen, result_path: Path, *, expected_code: int = 0) -> dict:
        stdout, stderr = proc.communicate(timeout=30)
        self.assertEqual(
            proc.returncode,
            expected_code,
            msg=f"worker rc={proc.returncode}\nstdout={stdout}\nstderr={stderr}",
        )
        self.assertTrue(result_path.is_file(), msg=f"worker produced no result\nstdout={stdout}\nstderr={stderr}")
        return json.loads(result_path.read_text(encoding="utf-8"))

    @staticmethod
    def migration_rows(root: Path) -> list[Path]:
        receipts_root = root / "operator" / "inbox" / "migration-imports"
        return sorted(receipts_root.glob("*.json")) if receipts_root.is_dir() else []

    @staticmethod
    def source_state(root: Path) -> dict:
        source_digest = hashlib.sha256(SOURCE_TEXT.encode("utf-8")).hexdigest()
        path = (
            root
            / "operator"
            / "inbox"
            / "migration-imports"
            / ".source-state"
            / f"{source_digest}.json"
        )
        return json.loads(path.read_text(encoding="utf-8"))

    def test_concurrent_same_source_same_plan_executes_owner_once(self):
        base, root, effects = self.make_case()
        plan = workspace_plan("client-alpha")
        plan_path = self.write_plan(base, "same-plan", plan)
        start = base / "start"
        result_a = base / "result-a.json"
        result_b = base / "result-b.json"
        proc_a = self.launch(root=root, effects=effects, plan_path=plan_path, result_path=result_a, start_path=start)
        proc_b = self.launch(root=root, effects=effects, plan_path=plan_path, result_path=result_b, start_path=start)
        start.write_text("go", encoding="utf-8")
        a = self.result(proc_a, result_a)
        b = self.result(proc_b, result_b)

        self.assertTrue(a["ok"])
        self.assertTrue(b["ok"])
        imports = [a["response"]["result"]["migration_import"], b["response"]["result"]["migration_import"]]
        self.assertEqual(len(list(effects.glob("*.json"))), 1)
        self.assertEqual(len(self.migration_rows(root)), 1)
        self.assertEqual(len({row["import_key"] for row in imports}), 1)
        self.assertEqual(sum(row.get("replayed") is True for row in imports), 1)
        self.assertEqual(self.source_state(root)["state"], "committed")

    def test_concurrent_same_source_different_plans_replays_winner(self):
        base, root, effects = self.make_case()
        plan_a = workspace_plan("client-alpha-a")
        plan_b = workspace_plan("client-alpha-b")
        path_a = self.write_plan(base, "plan-a", plan_a)
        path_b = self.write_plan(base, "plan-b", plan_b)
        start = base / "start"
        result_a = base / "result-a.json"
        result_b = base / "result-b.json"
        proc_a = self.launch(root=root, effects=effects, plan_path=path_a, result_path=result_a, start_path=start)
        proc_b = self.launch(root=root, effects=effects, plan_path=path_b, result_path=result_b, start_path=start)
        start.write_text("go", encoding="utf-8")
        a = self.result(proc_a, result_a)
        b = self.result(proc_b, result_b)

        self.assertTrue(a["ok"])
        self.assertTrue(b["ok"])
        imports = [a["response"]["result"]["migration_import"], b["response"]["result"]["migration_import"]]
        self.assertEqual(len(list(effects.glob("*.json"))), 1)
        self.assertEqual(len(self.migration_rows(root)), 1)
        self.assertEqual(len({row["import_key"] for row in imports}), 1)
        replays = [row for row in imports if row.get("replayed") is True]
        self.assertEqual(len(replays), 1)
        self.assertEqual(replays[0].get("replay_match"), "source")
        state = self.source_state(root)
        self.assertEqual(state["state"], "committed")
        self.assertIn(state["plan_sha256"], {plan_digest(plan_a), plan_digest(plan_b)})

    def test_crashed_source_reservation_requires_bound_plan_recovery_then_replays(self):
        base, root, effects = self.make_case()
        plan_a = workspace_plan("client-alpha-a")
        plan_b = workspace_plan("client-alpha-b")
        path_a = self.write_plan(base, "plan-a", plan_a)
        path_b = self.write_plan(base, "plan-b", plan_b)
        start = base / "start"
        start.write_text("go", encoding="utf-8")

        crashed_result = base / "crashed.json"
        crashed = self.launch(
            root=root,
            effects=effects,
            plan_path=path_a,
            result_path=crashed_result,
            start_path=start,
            mode="crash-after-effect",
            delay=0,
        )
        stdout, stderr = crashed.communicate(timeout=30)
        self.assertEqual(crashed.returncode, 86, msg=f"stdout={stdout}\nstderr={stderr}")
        self.assertFalse(crashed_result.exists())
        self.assertEqual(len(list(effects.glob("*.json"))), 1)
        self.assertEqual(len(self.migration_rows(root)), 0)
        interrupted = self.source_state(root)
        self.assertEqual(interrupted["state"], "in-progress")
        self.assertEqual(interrupted["plan_sha256"], plan_digest(plan_a))

        blocked_result = base / "blocked.json"
        blocked_proc = self.launch(
            root=root,
            effects=effects,
            plan_path=path_b,
            result_path=blocked_result,
            start_path=start,
            delay=0,
        )
        blocked = self.result(blocked_proc, blocked_result)
        self.assertFalse(blocked["ok"])
        self.assertIn("interrupted import bound to another classifier plan", blocked["error"])
        self.assertEqual(len(list(effects.glob("*.json"))), 1)

        recovery_result = base / "recovery.json"
        recovery_proc = self.launch(
            root=root,
            effects=effects,
            plan_path=path_a,
            result_path=recovery_result,
            start_path=start,
            delay=0,
        )
        recovery = self.result(recovery_proc, recovery_result)
        self.assertTrue(recovery["ok"])
        self.assertEqual(len(list(effects.glob("*.json"))), 1)
        self.assertEqual(len(self.migration_rows(root)), 1)
        recovered_state = self.source_state(root)
        self.assertEqual(recovered_state["state"], "committed")
        self.assertEqual(recovered_state["recovery_count"], 1)

        replay_result = base / "replay.json"
        replay_proc = self.launch(
            root=root,
            effects=effects,
            plan_path=path_b,
            result_path=replay_result,
            start_path=start,
            delay=0,
        )
        replay = self.result(replay_proc, replay_result)
        self.assertTrue(replay["ok"])
        replay_import = replay["response"]["result"]["migration_import"]
        self.assertTrue(replay_import["replayed"])
        self.assertEqual(replay_import["replay_match"], "source")
        self.assertEqual(len(list(effects.glob("*.json"))), 1)
        self.assertEqual(len(self.migration_rows(root)), 1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        raise SystemExit(worker_main(sys.argv[2:]))
    unittest.main()
