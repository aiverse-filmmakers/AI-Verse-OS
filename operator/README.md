# Operator Layer

`operator/` contains user-owned information about the person or team operating this AI-Verse OS across workspaces.

It is intentionally profession-neutral.

```text
operator/
├── profile/       stable identity, preferences, goals, communication style
├── context/       compact current cross-workspace state
├── memory/        historical events and learnings
├── inbox/         unclassified operator-level incoming material
└── decisions/     cross-workspace settled choices and reasoning
```

Operator state is gitignored by default in the public template. Tracked `.example.md` files show the expected shape.

Do not place workspace-specific detail here merely because the operator owns the workspace. Keep scoped detail with the workspace and add a pointer from operator context when cross-workspace awareness is useful.
