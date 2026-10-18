#!/usr/bin/env python3
"""Content-free review metrics and an owner-scoped maintenance entrypoint."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from bridge import Bridge, DEFAULT_ROOT, SCOPE, SAFE_ID, atomic_json, safe, utc


def report(root, scope="operator", grace_seconds=60):
    bridge = Bridge(root)
    if not SCOPE.fullmatch(scope):
        raise ValueError("invalid scope")
    if scope.startswith("workspace:"):
        bridge.manifest(scope[10:])
    rows = []
    malformed = 0
    for name in ("events.previous.jsonl", "events.jsonl"):
        file = safe(bridge.runtime / name, bridge.root)
        if not file.exists():
            continue
        if file.stat().st_size > 4_000_000:
            raise ValueError("diagnostic log exceeds maintenance budget")
        for line in file.read_text().splitlines()[-5000:]:
            try:
                item = json.loads(line)
                if isinstance(item, dict):
                    rows.append(item)
            except ValueError:
                malformed += 1
    turns = {}
    for row in rows:
        if row.get("scope") != scope or not row.get("turn"):
            continue
        key = (row.get("session_hash"), row["turn"])
        turn = turns.setdefault(key, {"tool": False, "review": None, "stop": None, "interrupted": False})
        turn["tool"] |= row.get("event") == "PostToolUse"
        if row.get("event") == "review":
            turn["review"] = row
        if row.get("event") == "Stop":
            turn["stop"] = row
        if row.get("state") in {"interrupted", "cancellation_recorded", "skipped_plan"}:
            turn["interrupted"] = True
    eligible = reviewed = missing = 0
    totals = {key: 0 for key in ("candidates", "owner_writes", "memory_captured", "duplicates", "refused", "deferred")}
    for turn in turns.values():
        stop = turn["stop"]
        complete = bool(turn["review"])
        try:
            aged = stop and time.time() - datetime.fromisoformat(stop["at"]).timestamp() >= grace_seconds
        except (ValueError, KeyError):
            aged = False
        if turn["tool"] and (aged or complete) and not turn["interrupted"]:
            eligible += 1
            reviewed += complete
            missing += not complete
        if complete:
            for key in totals:
                value = turn["review"].get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    totals[key] += value
    labels = {name: 0 for name in ("useful", "incorrect", "unnecessary")}
    feedback = safe(bridge.runtime / "quality-feedback.jsonl", bridge.root)
    if feedback.exists():
        if feedback.stat().st_size > 1_000_000:
            raise ValueError("feedback exceeds maintenance budget")
        seen = {}
        for line in feedback.read_text().splitlines():
            item = json.loads(line)
            if item.get("scope") == scope:
                seen[item["memory_id"]] = item["rating"]
        for rating in seen.values():
            if rating in labels:
                labels[rating] += 1
    total_labels = sum(labels.values())
    return {"schema_version": 1, "scope": scope, "generated_at": utc(),
            "enabled": bridge.registered(), "review_mode": bridge.config["review_mode"],
            "observed_turns": len(turns), "eligible_tool_turns": eligible,
            "reviewed_eligible_turns": reviewed, "unreviewed_eligible_turns": missing,
            "review_coverage": reviewed / eligible if eligible else None,
            "owner_metrics": totals, "quality_labels": labels,
            "metrics_population": "hook review events only; direct owner calls are not included",
            "labelled_incorrect_rate": labels["incorrect"] / total_labels if total_labels else None,
            "quality_status": "operator-labelled sample only" if total_labels else "unmeasured; no operator labels",
            "malformed_diagnostic_rows": malformed,
            "rejected_review_attempts": sum(r.get("event") == "review_rejected" and r.get("scope") == scope for r in rows),
            "scaffold_items_excluded": sum(r.get("scaffold_excluded", 0) for r in rows
                                           if r.get("event") == "UserPromptSubmit" and r.get("scope") == scope),
            "limits": ["Tool use is an eligibility heuristic, not proof a lesson was missed.",
                       "Legacy events omit typed owner counts; zero is not a historical quality estimate.",
                       "No semantic memory correctness is inferred from a successful write."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--scope", default="operator")
    parser.add_argument("command", choices=["report", "feedback"])
    parser.add_argument("--memory-id")
    parser.add_argument("--rating", choices=["useful", "incorrect", "unnecessary"])
    parser.add_argument("--evidence-ref")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if args.command == "feedback":
        if not args.memory_id or not args.memory_id.startswith("mem-") or not SAFE_ID.fullmatch(args.memory_id):
            parser.error("feedback requires a Memory ID")
        if not args.rating or not args.evidence_ref:
            parser.error("feedback requires an explicit operator rating and evidence reference")
        # This is a disposable evaluation label, never a correction of canonical truth.
        bridge = Bridge(root)
        source = safe(root / args.evidence_ref, root, file=True)
        if not SCOPE.fullmatch(args.scope):
            raise ValueError("invalid feedback scope")
        bridge.owner("inspect_history", {"scope": args.scope, "target": args.memory_id})
        import hashlib
        row = {"scope": args.scope, "memory_id": args.memory_id, "rating": args.rating,
               "at": utc(), "evidence_ref": str(source.relative_to(root)),
               "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
        with bridge.lock("quality-feedback"):
            file = safe(bridge.runtime / "quality-feedback.jsonl", root)
            with file.open("a") as stream:
                stream.write(json.dumps(row) + "\n")
    result = report(root, args.scope)
    target = root / "runtime/reports/codex-learning" / ("maintenance-" + args.scope.replace(":", "-") + ".json")
    atomic_json(target, result, root)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
