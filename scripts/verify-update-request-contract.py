from pathlib import Path


root = Path(__file__).resolve().parents[1]
agents = (root / "AGENTS.md").read_text(encoding="utf-8")
claude = (root / "CLAUDE.md").read_text(encoding="utf-8")

required_agents = [
    '### Core update request rule',
    '"Update AI-Verse"',
    '`aiverse update`',
    'Do not ask the operator for a release ID',
    'Do not substitute `git pull`',
    'delete/reclone',
    'reinstall-from-scratch',
    'stop and surface that conflict',
    'Claude adapters, Codex-compatible agents',
]
missing = [item for item in required_agents if item not in agents]
if missing:
    raise SystemExit("AGENTS.md update-request contract is incomplete: " + ", ".join(missing))

if "Read `AGENTS.md` for the canonical runtime contract." not in claude:
    raise SystemExit("CLAUDE.md no longer delegates runtime behavior to AGENTS.md")

print("AI-Verse natural update request contract: PASS")
