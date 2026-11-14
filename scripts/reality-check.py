"""Reality check: is my AI-Verse OS actually doing what it is supposed to do?

Local only. It reads the OS folder and writes nothing except its own small
score file in .aiverse/reality-check/. Run: python3 scripts/reality-check.py
Optional settings in .aiverse/reality-check/settings.json, for example
{"chat_archive_path": "path/to/saved/chats"}. Add --json for machine output.
"""
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / ".aiverse" / "reality-check"
EXT = ROOT / ".aiverse/extensions/ai-verse-codex-learning"
MEMORY = ROOT / "scripts/ai-verse-memory/memory.py"
SETTINGS = json.loads((HERE / "settings.json").read_text()) if (HERE / "settings.json").exists() else {}
NOW = datetime.now(timezone.utc)
results = []


def check(ok, title, detail, fix=""):
    results.append((ok, title, detail, fix))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def events(days):
    path = ROOT / "runtime/codex-learning/events.jsonl"
    since = (NOW - timedelta(days=days)).isoformat()
    rows = []
    if path.exists():
        for line in path.read_text(errors="ignore").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("at", "") >= since:
                rows.append(row)
    return rows


# 1. Helpers can run: their safety stamp matches the helper file.
bridge = EXT / "bridge.py"
if bridge.exists():
    build = sha(bridge)
    for app, file in (("Claude Code", ROOT / ".claude/settings.local.json"), ("Codex", ROOT / ".codex/hooks.json")):
        if not file.exists():
            continue
        stamps = set(re.findall(r"--build['\"]?\s+['\"]?([0-9a-f]{64})", file.read_text()))
        check(stamps == {build}, f"{app} helpers can run",
              "the safety stamp matches" if stamps == {build} else "the safety stamp does not match, so the helpers refuse to run",
              "" if stamps == {build} else "Ask your assistant to reinstall the AI-Verse helpers for this project.")

# 2. Helpers actually ran recently.
recent = events(2)
for harness, app in (("claude", "Claude Code"), ("codex", "Codex")):
    seen = [r for r in recent if r.get("harness", "codex") == harness and r.get("event") == "UserPromptSubmit"]
    if seen or any(r.get("harness", "codex") == harness for r in events(30)):
        check(bool(seen), f"{app} helpers ran in the last 2 days",
              f"{len(seen)} messages handled" if seen else "no messages handled",
              "" if seen else "If you used it, the helpers are off. In Codex check Settings, then Hooks.")

# 3. Chat summaries and memories are being written.
week = events(7)
reviews = len([r for r in week if r.get("event") == "review"])
digests = [p for p in ROOT.glob("*/memory/session-digests/*/*.md")] + list(ROOT.glob("workspaces/*/memory/session-digests/*/*.md"))
cutoff = time.time() - 7 * 86400
new_digests = len([p for p in digests if p.stat().st_mtime >= cutoff])
check(reviews == 0 or new_digests * 4 >= reviews, "Chat summaries are being written",
      f"{new_digests} summaries for {reviews} finished messages in the last 7 days",
      "" if reviews == 0 or new_digests * 4 >= reviews else "Most chats leave no summary. This needs a change in how summaries are saved.")
atomics = list(ROOT.glob("operator/memory/atomic/**/*.md")) + list(ROOT.glob("workspaces/*/memory/atomic/**/*.md"))
new_atomics = len([p for p in atomics if p.stat().st_mtime >= cutoff])
check(new_atomics > 0 or reviews < 10, "Memories are being saved",
      f"{new_atomics} memories saved or updated in the last 7 days", "")

# 4. The original chats exist (the source layer for chats).
archive = Path(SETTINGS.get("chat_archive_path") or "archives/private-chat-history/v1")
archive_dir = archive if archive.is_absolute() else ROOT / archive
archive_ok = archive_dir.is_dir() and any(archive_dir.iterdir())
check(archive_ok, "Original chats are saved locally",
      "found" if archive_ok else "private chat saving is off, so summaries and memories cannot point back to the full chat",
      "" if archive_ok else "If you want it, ask your assistant to turn on private chat saving for this OS.")

# 5. Every memory has search words.
out = subprocess.run([sys.executable, str(MEMORY), "search-hooks", "--list"], capture_output=True, text=True, cwd=ROOT)
if out.returncode == 0:
    missing = len([line for line in out.stdout.splitlines() if line.strip()])
    check(missing == 0, "Every memory has search words", f"{missing} without",
          "" if missing == 0 else "Ask your assistant: add search words to my memories.")

# 6. Memory search has not got worse.
run = ROOT / "scripts/ai-verse-memory/recall-eval/run.py"
if run.exists():
    out = subprocess.run([sys.executable, str(run), "--quiet"], capture_output=True, text=True, cwd=ROOT)
    found = re.search(r"hit@5: (\d+)/(\d+)", out.stdout)
    if found:
        score = int(found.group(1))
        base_file = HERE / "baseline.json"
        best = json.loads(base_file.read_text()).get("recall", score) if base_file.exists() else score
        check(score >= best - 1, "Memory search is as good as before", f"{score}/{found.group(2)} (best so far {best})",
              "" if score >= best - 1 else "Something made memory search worse. Ask your assistant to look into it.")
        HERE.mkdir(parents=True, exist_ok=True)
        base_file.write_text(json.dumps({"recall": max(score, best)}))

# 7. Changes a reinstall or update would not keep.
package = ROOT / "system/extensions/packages/ai-verse-codex-learning"
if package.exists() and EXT.exists():
    differ = [f.name for f in package.iterdir() if f.is_file() and (EXT / f.name).exists() and sha(f) != sha(EXT / f.name)]
    check(not differ, "Helper files match the OS version",
          "they match" if not differ else "differ: " + ", ".join(sorted(differ)),
          "" if not differ else "Normal after an OS update until the helpers are refreshed; otherwise these are local edits.")
status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True, cwd=ROOT)
edited = [line[3:] for line in status.stdout.splitlines() if line.strip()]
check(not edited, "No unsaved edits to AI-Verse's own files",
      "none" if not edited else f"{len(edited)} edited: " + ", ".join(edited[:5]),
      "" if not edited else "An update will pause on these. Ask your assistant to help keep or move them safely.")

if "--json" in sys.argv[1:]:
    print(json.dumps({"checked_at": NOW.isoformat(), "problems": len([r for r in results if not r[0]]),
                      "results": [{"ok": ok, "title": t, "detail": d, "fix": f} for ok, t, d, f in results]}, indent=2))
    sys.exit(0)

print("AI-Verse reality check\n")
for ok, title, detail, fix in results:
    print(f"{'OK  ' if ok else 'FIX '} {title}: {detail}")
    if fix:
        print(f"      {fix}")
problems = len([r for r in results if not r[0]])
print(f"\n{problems} thing(s) to fix." if problems else "\nEverything checked is working.")
