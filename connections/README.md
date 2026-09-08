# Connections

Connections describe how AI-Verse OS can reach external systems, people, tools, records, repositories, data, services, devices, or other sources.

`registry.yaml` is user-owned and gitignored by default. Start from `registry.example.yaml`.

## A registry entry is not proof

A connection can be:

- planned
- configured
- verified
- degraded
- unavailable
- retired

Do not claim live access merely because a tool is named in the registry.

## Secrets

Never write credentials, API keys, passwords, private keys, recovery codes, or session tokens into the registry.

Store only a safe description of the authentication mechanism or where the credential is managed.

## Scope

A connection may be operator-wide or limited to specific workspaces. Respect those boundaries during retrieval and action.
