# 3D Brain Config

Generated apps use `brain.config.json`.

Example:

```json
{
  "name": "AI-Verse Brain",
  "port": 4640,
  "categories": [
    {
      "id": "context",
      "label": "Context",
      "paths": ["../../context"]
    },
    {
      "id": "skills",
      "label": "Skills",
      "paths": ["../../.claude/skills"]
    },
    {
      "id": "references",
      "label": "References",
      "paths": ["../../references"]
    }
  ]
}
```

## Rules

- `name` is the exact UI display name.
- `port` defaults to `4640`.
- category `id` values must be unique and URL-safe.
- category `label` values are user-facing.
- `paths` is an array of approved folders or files.
- Prefer paths relative to the generated app when the source lives inside AI-Verse OS.
- Absolute paths are allowed only when the user explicitly selected that external source.
- The default builder reads `.md`, `.markdown`, and `.txt` files.
- Missing paths are reported as warnings. They must not be silently replaced with synthetic data.

Generated `graph.json`, private local configs, and source note contents should not be committed when they contain personal knowledge.
