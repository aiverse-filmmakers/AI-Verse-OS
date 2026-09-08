# Codex Skills

AI-Verse OS keeps Codex-compatible skill packages in `.agents/skills/`. The canonical authoring source lives in `.claude/skills/`.

After editing canonical skills, run:

```bash
bash scripts/sync-codex-skills.sh
```

Runtime-specific metadata may differ when required, but core execution logic should stay aligned.
