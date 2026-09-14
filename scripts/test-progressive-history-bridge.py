#!/usr/bin/env python3
"""Focused C3 acceptance for the OS progressive-history host bridge."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
ADAPTER_PATH = ROOT / "scripts" / "ai_verse_host_adapter.py"


def load_adapter():
    spec = importlib.util.spec_from_file_location("c3_progressive_host_adapter", ADAPTER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["c3_progressive_host_adapter"] = module
    spec.loader.exec_module(module)
    return module


adapter = load_adapter()


def make_root(base: Path) -> Path:
    root = base / "os"
    root.mkdir()
    (root / "AI-VERSE.yaml").write_text(
        'schema_version: "2.0"\narchitecture: unified-workspace\n',
        encoding="utf-8",
    )
    (root / "scripts").mkdir()
    return root


def write_registry(root: Path, engine: str = "scripts/ai-verse-memory/memory.py") -> None:
    registry = root / ".aiverse" / "extensions"
    registry.mkdir(parents=True, exist_ok=True)
    (registry / "registry.json").write_text(
        json.dumps(
            {
                "schema_version": "1.0",
                "extensions": {
                    "ai-verse-memory": {
                        "id": "ai-verse-memory",
                        "supported": True,
                        "installed": True,
                        "enabled": True,
                        "engine": engine,
                    }
                },
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def write_compatible_memory(root: Path) -> None:
    engine = root / "scripts" / "ai-verse-memory"
    engine.mkdir(parents=True, exist_ok=True)
    (engine / "memory.py").write_text(
        '''
PROGRESSIVE_RECALL_VERSION = "memory.progressive-recall.v1"

def detect_mode(root):
    return "native"

def recall(query, *, scope, limit, root, mode):
    return [{"id": "legacy-1", "scope": scope, "text": "legacy:" + query, "limit": limit}]

def progressive_recall(
    query="",
    *,
    version,
    depth,
    scope,
    limit,
    max_bytes,
    evidence_ref=None,
    root,
    mode,
):
    result = {
        "schema_version": 1,
        "api_version": version,
        "depth": depth,
        "scope": scope,
        "budget_bytes": max_bytes,
        "query": query,
        "limit": limit,
    }
    if depth == "catalog":
        result.update({
            "catalog": {"scope": scope, "counts": {"atomic_memory": 1}},
            "source_depth_available": False,
        })
    elif depth == "summary":
        result.update({
            "items": [{
                "record_type": "indexed_record",
                "id": "mem-1",
                "scope": scope,
                "excerpt": "bounded summary",
                "evidence": {
                    "path": "operator/memory/atomic/2026/09/mem-1.md",
                    "source_identity": "sha256:identity",
                    "source_version": "sha256:version",
                },
                "deeper_evidence_available": True,
            }],
            "source_depth_available": False,
        })
    elif depth == "detail":
        result.update({
            "items": [{
                "record_type": "indexed_record",
                "id": "mem-1",
                "scope": scope,
                "text": "bounded detail",
                "evidence": {
                    "path": "operator/memory/atomic/2026/09/mem-1.md",
                    "source_identity": "sha256:identity",
                    "source_version": "sha256:version",
                },
                "deeper_evidence_available": True,
            }],
            "source_depth_available": True,
        })
    elif depth == "source":
        result.update({
            "status": "ok",
            "exact_evidence": True,
            "record_type": evidence_ref.get("record_type"),
            "id": evidence_ref.get("id"),
            "source": {"content": "exact canonical bytes"},
            "source_depth_available": True,
        })
    return result
'''.lstrip(),
        encoding="utf-8",
    )


def write_incompatible_memory(root: Path) -> None:
    engine = root / "scripts" / "ai-verse-memory"
    engine.mkdir(parents=True, exist_ok=True)
    (engine / "memory.py").write_text(
        '''
def detect_mode(root):
    return "native"

def recall(query, *, scope, limit, root, mode):
    return [{"id": "legacy-old", "scope": scope, "text": query}]
'''.lstrip(),
        encoding="utf-8",
    )


def progressive_payload(**overrides):
    payload = {
        "version": "memory.progressive-recall.v1",
        "depth": "summary",
        "scope": "operator",
        "query": "exact deployment evidence",
        "limit": 8,
        "max_bytes": 8192,
    }
    payload.update(overrides)
    return payload


def test_missing_memory_is_explicit_and_legacy_remains_empty(root: Path) -> None:
    host = adapter.AIverseOSHost(root)
    assert host.retrieve_history("legacy query", "operator") == []
    assert adapter.PROGRESSIVE_HISTORY_OPERATION not in host.describe()["operations"]
    assert host.describe()["metadata"]["memory_progressive_recall"] == "absent"
    try:
        host.retrieve_history_progressive(progressive_payload())
    except adapter.AdapterError as exc:
        assert "Memory is unavailable" in str(exc)
    else:
        raise AssertionError("progressive history silently succeeded without Memory")


def test_incompatible_memory_is_not_advertised(root: Path) -> None:
    write_incompatible_memory(root)
    write_registry(root)
    host = adapter.AIverseOSHost(root)
    description = host.describe()
    assert adapter.PROGRESSIVE_HISTORY_OPERATION not in description["operations"]
    assert description["metadata"]["memory_progressive_recall"] == "incompatible"
    legacy = host.retrieve_history("old memory still works", "operator")
    assert legacy and legacy[0]["id"] == "legacy-old"
    try:
        host.retrieve_history_progressive(progressive_payload())
    except adapter.AdapterError as exc:
        assert "does not support memory.progressive-recall.v1" in str(exc)
    else:
        raise AssertionError("incompatible Memory was accepted for progressive history")


def test_compatible_memory_is_bounded_scoped_and_versioned(root: Path) -> None:
    write_compatible_memory(root)
    write_registry(root)
    host = adapter.AIverseOSHost(root)
    description = host.describe()
    assert adapter.PROGRESSIVE_HISTORY_OPERATION in description["operations"]
    assert description["metadata"]["memory_progressive_recall"] == "available"

    legacy = host.retrieve_history("legacy remains stable", "operator")
    assert legacy == [{
        "id": "legacy-1",
        "scope": "operator",
        "text": "legacy:legacy remains stable",
        "limit": 12,
    }]

    catalog = host.retrieve_history_progressive(
        progressive_payload(depth="catalog", query="", max_bytes=4096)
    )
    assert catalog["api_version"] == adapter.PROGRESSIVE_RECALL_VERSION
    assert catalog["depth"] == "catalog"
    assert catalog["scope"] == "operator"

    summary = host.retrieve_history_progressive(progressive_payload(depth="summary"))
    assert summary["depth"] == "summary"
    assert summary["items"][0]["scope"] == "operator"

    detail = host.retrieve_history_progressive(progressive_payload(depth="detail"))
    evidence = detail["items"][0]
    assert detail["source_depth_available"] is True

    source = host.retrieve_history_progressive(
        progressive_payload(
            depth="source",
            query="canonical bytes",
            evidence_ref=evidence,
        )
    )
    assert source["status"] == "ok"
    assert source["exact_evidence"] is True
    assert source["scope"] == "operator"
    assert source["source"]["content"] == "exact canonical bytes"

    workspace_evidence = {
        **evidence,
        "scope": "workspace:alpha",
    }
    try:
        host.retrieve_history_progressive(
            progressive_payload(
                depth="source",
                scope="operator",
                evidence_ref=workspace_evidence,
            )
        )
    except adapter.AdapterError as exc:
        assert "not visible" in str(exc)
    else:
        raise AssertionError("operator scope accepted workspace evidence")

    operator_from_workspace = host.retrieve_history_progressive(
        progressive_payload(
            depth="source",
            scope="workspace:alpha",
            evidence_ref=evidence,
        )
    )
    assert operator_from_workspace["scope"] == "workspace:alpha"

    invalid_cases = [
        progressive_payload(version="memory.progressive-recall.v0"),
        progressive_payload(depth="neighbors"),
        progressive_payload(scope="workspace:Alpha"),
        progressive_payload(limit=21),
        progressive_payload(max_bytes=1024),
        progressive_payload(query="x" * 4097),
        progressive_payload(depth="source", evidence_ref=None),
        progressive_payload(depth="summary", evidence_ref=evidence),
    ]
    for payload in invalid_cases:
        try:
            host.retrieve_history_progressive(payload)
        except adapter.AdapterError:
            pass
        else:
            raise AssertionError(f"invalid progressive payload was accepted: {payload}")


def test_json_subprocess_dispatch(root: Path) -> None:
    request = {
        "protocol": adapter.PROTOCOL,
        "request_id": "c3-subprocess",
        "operation": adapter.PROGRESSIVE_HISTORY_OPERATION,
        "payload": progressive_payload(depth="catalog", query="", max_bytes=4096),
    }
    proc = subprocess.run(
        [sys.executable, str(ADAPTER_PATH), "--root", str(root)],
        input=json.dumps(request),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    response = json.loads(proc.stdout)
    assert response["ok"] is True
    assert response["request_id"] == "c3-subprocess"
    assert response["result"]["depth"] == "catalog"
    assert response["result"]["scope"] == "operator"


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        missing = make_root(Path(tmp) / "missing")
        test_missing_memory_is_explicit_and_legacy_remains_empty(missing)

        incompatible = make_root(Path(tmp) / "incompatible")
        test_incompatible_memory_is_not_advertised(incompatible)

        compatible = make_root(Path(tmp) / "compatible")
        test_compatible_memory_is_bounded_scoped_and_versioned(compatible)
        test_json_subprocess_dispatch(compatible)

    print("OS progressive-history bridge contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
