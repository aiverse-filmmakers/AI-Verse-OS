# Agents

Agents are orchestration definitions. They coordinate context, skills, scripts, connections, and approvals to pursue a larger objective.

They should not duplicate large knowledge bases or become the only place a workflow is documented.

Prefer a focused skill when one capability is enough. Use an agent when coordination across multiple capabilities, scopes, or decision loops is genuinely necessary.

User-defined global agents may be registered in `agents/registry.yaml` from `registry.example.yaml`. Workspace-specific orchestration can remain inside the workspace.
