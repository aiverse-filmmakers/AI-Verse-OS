# Connections v1 Compatibility Pointer

Architecture v2 uses `connections/registry.yaml` as the canonical user-owned registry and `connections/README.md` for the connection contract.

This file is retained so existing AI-Verse OS installations that already use `connections.md` are not broken or silently migrated.

For an existing installation:

- preserve any real entries already recorded here
- do not maintain two editable copies indefinitely
- migrate deliberately into `connections/registry.yaml`
- record which registry is canonical during the transition

New installations should use the v2 connection layer.
