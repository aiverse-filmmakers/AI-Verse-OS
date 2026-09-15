#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "ai_verse_host_adapter.py"


def load_host_module():
    spec = importlib.util.spec_from_file_location("_aiverse_migration_test_host", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load host adapter")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


host_module = load_host_module()


class MigrationImportTests(unittest.TestCase):
    def make_host(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        (root / "AI-VERSE.yaml").write_text(
            'schema_version: "2.0"\narchitecture: unified-workspace\n',
            encoding="utf-8",
        )
        (root / "operator").mkdir()
        (root / "workspaces").mkdir()
        host = host_module.AIverseOSHost(root)
        return temp, root, host

    def request(self, payload, scope="operator"):
        req = {
            "action_class": "write_local_reversible",
            "scope": scope,
            "operation": "migration.import",
            "parameters": payload,
            "idempotency_key": "migration-test",
            "in_scope": True,
            "within_budget": True,
            "reversible": True,
            "reason": "test migration import",
        }
        req["request_fingerprint"] = host_module._fingerprint(req)
        return req

    def test_routes_bounded_items_through_existing_owner_actions_and_replays(self):
        temp, root, host = self.make_host()
        self.addCleanup(temp.cleanup)

        calls = {"workspace": [], "memory": [], "data": []}
        host.authorize_action = lambda request: {
            "decision": "allow",
            "scope": request["scope"],
            "request_fingerprint": request["request_fingerprint"],
        }

        def workspace_action(request, scope, parameters):
            calls["workspace"].append((scope, parameters))
            return {
                "status": "succeeded",
                "effect_occurred": True,
                "result": {
                    "workspace_organization": {
                        "state": "created",
                        "workspace": {"id": parameters["workspace"]["id"]},
                    }
                },
            }

        def memory_action(request, scope, parameters):
            calls["memory"].append((scope, parameters))
            return {
                "status": "succeeded",
                "effect_occurred": True,
                "result": {
                    "memory_capture": {
                        "state": "captured",
                        "memory_id": "mem-test",
                    }
                },
            }

        def data_action(request, scope, parameters, *, actor_id="ai-verse-gateway"):
            calls["data"].append((scope, parameters, actor_id))
            return {
                "status": "succeeded",
                "effect_occurred": True,
                "result": {
                    "data_candidate": {"state": "admitted"},
                    "record": {"state": "created"},
                },
            }

        host._request_workspace_ensure = workspace_action
        host._request_memory_capture = memory_action
        host._request_data_structured_truth = data_action

        source_text = (
            "Client Alpha is an active client. "
            "A prior delivery taught us to verify captions before export. "
            "Client Alpha status is active. "
            "Later notes again say Client Alpha status is active."
        )
        payload = {
            "source": {
                "kind": "hermes-memory",
                "text": source_text,
                "label": "Hermes migration",
            },
            "plan": {
                "workspaces": [
                    {
                        "workspace": {
                            "id": "client-alpha",
                            "name": "Client Alpha",
                            "type": "client",
                            "purpose": "Keep Client Alpha work isolated.",
                        },
                        "evidence": {
                            "substantial_scope": True,
                            "boundary_clear": True,
                            "reason": "Named durable client",
                        },
                        "authority": {
                            "permission_expansion": False,
                            "privacy_ambiguous": False,
                            "new_connection": False,
                            "new_credential": False,
                        },
                    }
                ],
                "memories": [
                    {
                        "scope": "workspace:client-alpha",
                        "type": "lesson",
                        "text": "Verify captions before export.",
                        "confidence": 0.95,
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
                    }
                ],
                "data": [
                    {
                        "scope": "workspace:client-alpha",
                        "evidence_spans": [
                            "Client Alpha status is active.",
                            "Later notes again say Client Alpha status is active.",
                        ],
                        "candidate": {
                            "suggested_owner": "data",
                            "summary": "Repeated current client status.",
                            "confidence": 0.95,
                            "repeated_evidence": True,
                            "current_truth": True,
                            "structured_operational": True,
                            "contains_secret": False,
                            "privacy_ambiguous": False,
                            "permission_expansion": False,
                            "destructive": False,
                            "structure": {
                                "space": {
                                    "spaceId": "crm",
                                    "name": "CRM",
                                    "authority": "local_canonical",
                                },
                                "schema": {
                                    "spaceId": "crm",
                                    "entity": "clients",
                                    "name": "Clients",
                                    "fields": {
                                        "name": {"type": "string", "required": True},
                                        "status": {"type": "string"},
                                    },
                                },
                            },
                            "match": {"field": "name", "value": "Client Alpha"},
                            "record": {"data": {"name": "Client Alpha", "status": "active"}},
                        },
                    }
                ],
            },
        }

        first = host.request_action(self.request(payload))
        self.assertEqual(first["status"], "succeeded")
        self.assertTrue(first["effect_occurred"])
        receipt = first["result"]["migration_import"]
        self.assertEqual(receipt["counts"]["workspace_items"], 1)
        self.assertEqual(receipt["counts"]["memory_items"], 1)
        self.assertEqual(receipt["counts"]["data_items"], 1)
        self.assertFalse(receipt["raw_source_persisted"])

        self.assertEqual(len(calls["workspace"]), 1)
        self.assertEqual(len(calls["memory"]), 1)
        self.assertEqual(len(calls["data"]), 1)

        workspace_params = calls["workspace"][0][1]
        self.assertEqual(workspace_params["provenance"]["source"], "hermes-memory")
        self.assertEqual(workspace_params["provenance"]["classifier"], "migration-runtime")

        memory_scope, memory_params = calls["memory"][0]
        self.assertEqual(memory_scope, "workspace:client-alpha")
        self.assertTrue(memory_params["source"].startswith("migration-drop:hermes-memory:sha256:"))
        self.assertTrue(memory_params["evidence_refs"][0].startswith("migration-source:sha256:"))
        self.assertTrue(memory_params["effect_id"].startswith("migration:"))

        data_scope, data_params, actor_id = calls["data"][0]
        self.assertEqual(data_scope, "workspace:client-alpha")
        self.assertEqual(actor_id, "ai-verse-migration-import")
        refs = data_params["candidate"]["evidence_refs"]
        self.assertEqual(len(refs), 2)
        self.assertNotEqual(refs[0], refs[1])
        self.assertTrue(all(":span:" in ref for ref in refs))

        receipts = list((root / "operator" / "inbox" / "migration-imports").glob("*.json"))
        self.assertEqual(len(receipts), 1)
        on_disk = receipts[0].read_text(encoding="utf-8")
        self.assertNotIn(source_text, on_disk)
        self.assertNotIn("verify captions before export", on_disk.lower())

        second = host.request_action(self.request(payload))
        self.assertEqual(second["status"], "succeeded")
        self.assertFalse(second["effect_occurred"])
        self.assertTrue(second["result"]["migration_import"]["replayed"])
        self.assertEqual(second["result"]["migration_import"]["replay_match"], "source-and-plan")
        self.assertEqual(len(calls["workspace"]), 1)
        self.assertEqual(len(calls["memory"]), 1)
        self.assertEqual(len(calls["data"]), 1)

        reclassified = json.loads(json.dumps(payload))
        reclassified["plan"]["memories"][0]["why"] = "Same source, harmless classifier-plan variation."
        third = host.request_action(self.request(reclassified))
        self.assertEqual(third["status"], "succeeded")
        self.assertFalse(third["effect_occurred"])
        replay = third["result"]["migration_import"]
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["replay_match"], "source")
        self.assertNotEqual(replay["reclassified_plan_sha256"], replay["plan_sha256"])
        self.assertEqual(len(calls["workspace"]), 1)
        self.assertEqual(len(calls["memory"]), 1)
        self.assertEqual(len(calls["data"]), 1)
        self.assertEqual(
            len(list((root / "operator" / "inbox" / "migration-imports").glob("*.json"))),
            1,
        )

    def test_rejects_untrusted_data_evidence_and_unknown_plan_sections(self):
        temp, _root, host = self.make_host()
        self.addCleanup(temp.cleanup)
        host.authorize_action = lambda request: {"decision": "allow"}

        base = {
            "source": {"kind": "chatgpt-memory", "text": "Client status active.", "label": "test"},
            "plan": {
                "workspaces": [],
                "memories": [],
                "data": [
                    {
                        "scope": "workspace:alpha",
                        "evidence_spans": ["This text is not in source."],
                        "candidate": {"suggested_owner": "data"},
                    }
                ],
            },
        }
        result = host.request_action(self.request(base))
        row = result["result"]["migration_import"]["data"][0]
        self.assertEqual(row["status"], "rejected")
        self.assertIn("not present", row["reason"])

        bad = {
            "source": {"kind": "chatgpt-memory", "text": "safe text"},
            "plan": {"workspaces": [], "memories": [], "data": [], "bots": []},
        }
        with self.assertRaisesRegex(host_module.AdapterError, "unsupported sections"):
            host.request_action(self.request(bad))

    def test_migration_must_start_from_operator_scope(self):
        temp, _root, host = self.make_host()
        self.addCleanup(temp.cleanup)
        payload = {
            "source": {"kind": "hermes-memory", "text": "Some durable history."},
            "plan": {"workspaces": [], "memories": [], "data": []},
        }
        with self.assertRaisesRegex(host_module.AdapterError, "operator scope"):
            host.request_action(self.request(payload, scope="workspace:alpha"))


if __name__ == "__main__":
    unittest.main()
