#!/usr/bin/env python3
"""Cross-repo runtime assertions used by the Four-Repo Acceptance workflow.

This file deliberately imports Brain at runtime while reading live artifacts produced
by OS, Memory, and Skills. It is not a mock of their contracts: the workflow builds
the real host bridge and generation selection before invoking these assertions.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _load_json(path: Path) -> Dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise AssertionError(f"expected JSON object at {path}")
    return data


def _fail(label: str, value: Any) -> None:
    rendered = json.dumps(value, indent=2, sort_keys=True, default=str)
    raise AssertionError(f"{label}\nObserved:\n{rendered}")


def runtime_composition() -> None:
    from aiverse_brain.cadence import Trigger
    from aiverse_brain.host_selection import select_host
    from aiverse_brain.models import Scope
    from aiverse_brain.runtime import BrainRuntime

    runner_temp = Path(os.environ["RUNNER_TEMP"])
    root = os.environ["GITHUB_WORKSPACE"]
    pin = _load_json(runner_temp / "skills-pin.json")
    config = runner_temp / "four-repo-host.json"

    selection = select_host(root, host_adapter_config=str(config))
    if selection.real_host is not True or selection.adapter_id != "four-repo-acceptance-host":
        _fail("Brain did not retain the explicitly selected real host", selection.to_dict())

    class CaptureReasoner:
        model_id = "four-repo-capture-reasoner"

        def __init__(self) -> None:
            self.calls: List[Tuple[str, Dict[str, Any]]] = []

        def reason(self, request: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
            self.calls.append((request["purpose"], context))
            return {"proposals": []}

    reasoner = CaptureReasoner()
    runtime = BrainRuntime(root)
    result = runtime.run_tick(
        Trigger("scheduled_orientation", Scope("operator"), "four-repo-acceptance-orientation"),
        host=selection.host,
        reasoner=reasoner,
    )
    if not result.ok:
        _fail("Brain scheduled orientation returned runtime errors", [item.__dict__ for item in result.errors])
    if result.reasoner_calls != 2:
        _fail("Brain scheduled orientation did not execute the expected bounded cognition stages", {
            "reasoner_calls": result.reasoner_calls,
            "purposes": [purpose for purpose, _ in reasoner.calls],
        })

    contexts = {purpose: context for purpose, context in reasoner.calls}
    if set(contexts) != {"gap_analysis", "opportunity_discovery"}:
        _fail("Brain reasoner received unexpected cognition purposes", sorted(contexts))

    gap = contexts["gap_analysis"]
    history = gap.get("history", [])
    if not any("acceptance-memory-evidence" in str(item.get("text", "")) for item in history):
        _fail("Brain gap analysis did not receive the Memory acceptance record", {
            "retrieval_query": gap.get("retrieval_queries", {}).get("history"),
            "history": history,
        })

    opportunity = contexts["opportunity_discovery"]
    capabilities = opportunity.get("capabilities", [])
    generation_id = pin.get("generation_id")
    if not any(
        item.get("provider") == "aiverse-skills" and item.get("generation_id") == generation_id
        for item in capabilities
    ):
        _fail("Brain opportunity discovery did not receive a capability from the live Skills generation", {
            "expected_generation_id": generation_id,
            "capability_query": opportunity.get("retrieval_queries", {}).get("capabilities"),
            "capabilities": [
                {
                    "id": item.get("id"),
                    "provider": item.get("provider"),
                    "generation_id": item.get("generation_id"),
                }
                for item in capabilities
            ],
        })

    connections = opportunity.get("connections", [])
    if not any(item.get("id") == "acceptance-local" for item in connections):
        _fail("Brain opportunity discovery did not receive the configured OS connection", connections)

    current_context = opportunity.get("current_context", {})
    if "acceptance-freshness-19" not in str(current_context.get("text", "")):
        _fail("Brain opportunity discovery did not receive fresh OS current context", current_context)

    print("Brain consumed live OS context + Memory history + Skills capabilities through explicit real host bridge")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("check", choices=["runtime-composition"])
    args = parser.parse_args()
    if args.check == "runtime-composition":
        runtime_composition()
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
