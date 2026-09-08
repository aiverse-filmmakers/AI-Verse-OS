# Operator Memory

Memory stores history that may matter later but should not all be loaded at startup.

Recommended shape:

```text
memory/
├── MEMORY.md       compact durable cross-workspace reminders and pointers
├── learnings.md    reusable operator-level learnings when useful
└── daily/          dated session/event notes when the runtime supports them
```

Keep current state in `operator/context/CURRENT.md`. Keep workspace history inside the workspace.

Semantic indexes, when added, belong under `runtime/indexes/` and remain derived from these inspectable sources.
