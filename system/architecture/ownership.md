# Ownership and Upgrade Boundaries

AI-Verse OS separates system-owned, user-owned, and derived state so the operating system can evolve without overwriting the person using it.

## System-owned

AI-Verse OS may update these deliberately:

- root runtime/architecture contracts
- `system/`
- shared packaged skills
- deterministic maintenance scripts
- system templates and schemas

System updates should preserve backward compatibility or provide explicit migration when contracts change.

## User-owned

The operator owns:

- operator profile, context, memory, inbox, and decisions
- shared personal/organizational knowledge
- workspaces and their state
- connection registries
- user-defined agents
- automation definitions and policies
- generated/custom apps

A system update must not overwrite these merely because a template changed.

## Derived

`runtime/` is derived state: caches, indexes, temporary reports, logs, generated catalogs, and other rebuildable artifacts.

Deleting it should not destroy irreplaceable truth.

## Public-template privacy

The public template gitignores user-owned state by default while tracking examples and workspace templates. This reduces accidental publication of personal, proprietary, or sensitive data.

A user who intentionally runs AI-Verse OS in a private repository may choose a different version-control policy. That is a user decision, not a reason for the public template to default to unsafe tracking.

## Migration rule

When architecture changes:

1. detect existing user-owned sources
2. preserve them
3. create the new structure
4. map old to new authority
5. migrate deliberately
6. avoid maintaining two editable canonical copies
7. archive superseded structure only after verification
