# 3D Brain Acceptance Checklist

A generated 3D Brain is complete only when the checks that can be performed in the current environment have been performed honestly.

## Data

- requested display name is loaded from config
- configured category IDs are unique
- configured paths resolve or are reported missing
- node counts come from real scanned files
- no synthetic notes are mixed with real knowledge unless explicitly labeled as demo data
- original source files are unchanged

## Relationships

- explicit Markdown links and wikilinks can create edges
- unresolved links remain unresolved
- disconnected nodes are allowed
- inferred relationships, if later added, must be distinguishable from explicit links

## UI

- page loads without fatal JavaScript errors
- brain name is visible
- search works
- category filtering works and can be reset
- node selection shows useful source information
- drag rotates the scene
- scroll changes zoom
- Cinema mode hides nonessential controls
- replay/growth reaches the final node count and can reset
- narrow viewport remains usable

## Server

- binds to `127.0.0.1` by default
- uses the configured port
- does not stop unrelated processes when a port is occupied
- serves only the generated app directory

## Reporting

If browser or visual verification is unavailable, state which checks remain unverified instead of claiming a complete visual pass.
