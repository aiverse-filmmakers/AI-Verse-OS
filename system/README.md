# System Layer

`system/` contains the domain-neutral architecture supplied by AI-Verse OS itself.

It should explain how the OS works without containing operator-specific facts or assuming a profession.

- `architecture/` explains design intent and operating boundaries.
- `schemas/` defines machine-readable contracts.
- `templates/` provides universal scaffolds.
- `health/` documents deterministic architecture checks.

System updates may evolve these files. User-owned state belongs elsewhere and must not be overwritten as collateral damage.
