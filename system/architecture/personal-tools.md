# Personal tool packages

Personal scripts, API clients and MCP servers need dependency boundaries even when they have no interface. The OS root is a software source package; it is not the dependency environment for members' tools.

## Supported path

```sh
node scripts/personal-tool.mjs init --scope operator --name my-tool --runtime node
node scripts/personal-tool.mjs init --scope operator --name my-tool --runtime node --apply
node scripts/personal-tool.mjs install --scope operator --name my-tool --runtime node --package dotenv
node scripts/personal-tool.mjs install --scope operator --name my-tool --runtime node --package dotenv --apply
```

For a workspace, replace scope with `workspace:<existing-id>`. Python uses `--runtime python`; install creates a private `.venv` and runs its pip with isolated settings. Use `check` with the same name/scope/runtime for an existing package. Preview never installs or creates. Operator paths are `apps/<name>/`; scoped paths are `workspaces/<id>/tools/<name>/`. Both are member-owned and preserved by Core updates.

Node tools require `private:true`, no package workspace redirects, and their own package.json. npm receives an explicit prefix, non-global mode, workspaces disabled and lifecycle scripts disabled. Packages requiring install scripts need a separately reviewed tool-local setup; the helper has no unsafe bypass switch. Python requires pyproject.toml and uses a tool-local virtual environment. Registry package names/versions only: flags, URLs and filesystem sources are rejected. Python install does not automatically edit pyproject.toml; keep declared dependencies current in that tool package. Version ranges are deliberately conservative; use repeated --package flags.

Init refuses any existing destination. Check/install refuse Core-root targets, invalid or inactive workspace scopes, traversal, symlinked controlled ancestors/manifests and redirected dependency roots. No files are automatically adopted, migrated, overwritten or deleted. Failed package installation can leave partial tool-local state; inspect package-manager output and retry after resolving it. Other tools and Core remain outside the dispatch destination.

## Enforcement boundary

All runtimes consuming AGENTS.md use this same helper for supported personal tool creation/install. This is not a filesystem sandbox or package trust checker. A malicious package, arbitrary editor/shell command, concurrent hostile path replacement or unsupported third-party installer can write beyond its directory using the host's permissions. Do not claim otherwise. Existing host approval policies still govern network access and untrusted code execution. Do not import credentials into a package, infer permission from discovery, or weaken the canonical updater when legacy root modifications exist.

Official Core source development and Distribution component installation keep their existing owners and environments. This helper does not change their lifecycle, nor install or update AI-Verse itself.
