# Shared Knowledge

`knowledge/` is user-owned durable knowledge that is genuinely reusable across multiple workspaces.

The public template intentionally does not pre-create profession folders. Real usage may later justify namespaces such as a discipline, technology, methodology, organization, subject, or custom ontology.

## What belongs here

- terminology or models used across workspaces
- reusable procedures and standards
- cross-workspace reference knowledge
- validated lessons and patterns
- reusable source notes that are broader than one workspace

## What does not belong here

- current task state -> workspace/operator `context/`
- history -> `memory/`
- one workspace's specialized knowledge -> that workspace's `knowledge/`
- secrets -> never in the repository
- generated search/vector data -> `runtime/indexes/`

Promote knowledge upward only when broader reuse is real, not hypothetical.
