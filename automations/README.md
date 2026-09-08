# Automations

`automations/` is the Cadence layer of AI-Verse OS.

An automation should run only after the underlying workflow is reliable enough to be triggered without rebuilding its logic every time.

```text
automations/
├── jobs/       scheduled/repeated execution definitions
├── triggers/   event conditions
└── policies/   approval, retry, failure, notification, and permission rules
```

Automation definitions are user-owned and gitignored by default in the public template.

Every automation should make clear:

- trigger or schedule
- scope/workspace
- inputs and authoritative sources
- capability/agent used
- permissions
- validation
- failure/retry behavior
- output destination
- approval or kill-switch rules
