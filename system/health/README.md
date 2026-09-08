# System Health

Architecture health should be proven with deterministic checks where practical rather than relying on an AI to remember every invariant.

The initial v2 check is `scripts/check-architecture.sh`.

Health checks should increasingly cover:

- required architecture files
- workspace manifest validity
- skill adapter drift
- source-of-truth conflicts
- stale current context
- accidental tracked secrets or user state
- broken source routes
- automation evidence
- workspace isolation leaks
- derived indexes being mistaken for truth

`/audit` should combine deterministic evidence with higher-level Four Cs inspection.
