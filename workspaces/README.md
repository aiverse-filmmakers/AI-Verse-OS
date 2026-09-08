# Workspaces

A workspace is AI-Verse OS's universal isolation primitive.

It can represent any substantial scope of work without changing the core architecture. Examples include a project, role, case, client, practice, product, research area, team, study, personal area, or a completely custom type.

## Create a workspace

Use `/workspace` or copy `workspaces/_template/` to a unique slug.

Every workspace must have `WORKSPACE.yaml`.

Recommended structure:

```text
workspaces/<id>/
├── WORKSPACE.yaml
├── README.md
├── context/
├── memory/
├── inbox/
├── knowledge/
├── assets/
├── decisions/
├── outputs/
├── automations/
└── skills/
```

Do not create every optional subfolder merely to make the tree look complete. The template documents the full contract; active workspaces may keep only the parts they use.

## Isolation

Workspace-specific facts, memories, knowledge, assets, decisions, and local capabilities stay inside the workspace by default.

Cross-workspace reuse should happen through deliberate promotion to shared knowledge or shared skills, not by silently reading every workspace.

User-created workspaces are gitignored by default in the public template.
