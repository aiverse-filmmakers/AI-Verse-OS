# Distribution Whole-Install Lifecycle Handoff

**Status:** OWNER BOUNDARY CONFIRMED  
**OS owner:** `aiverse-filmmakers/AI-Verse-OS`  
**Whole-install orchestrator:** `aiverse-filmmakers/ai-verse-distribution`

This document records the Safe Infrastructure closeout boundary. It changes no OS runtime behavior, state ownership or lifecycle semantics.

## OS remains authoritative for

AI-Verse OS continues to own:

- Workspace scope and host structure;
- OS current operating context and routing;
- OS permission floors and component composition;
- OS-local install/setup/status/doctor/update/reinstall behavior;
- Workspace infrastructure generation detection;
- Workspace structural conformance findings;
- capability provider resolution and placement planning;
- explicit Workspace-to-personal capability promotion;
- promotion provenance/history, compatibility repair and owner-native stale-plan/idempotency rules;
- OS canonical files and OS-local user-owned state boundaries.

Distribution does not reimplement or replace those semantics.

## Distribution owns only the whole-install layer

For an installed AI-Verse product, Distribution owns:

- compatible release-set selection and exact admitted software transitions;
- whole-install update orchestration;
- aggregate whole-install doctor over owner-native health checks;
- collection/classification of owner-published structural state;
- explicit structural-upgrade orchestration;
- the rotating whole-install Last-Known-Good recovery point;
- whole-install restore preview/apply;
- supported runtime lifecycle adapters;
- cross-repository lifecycle qualification.

The member-facing lifecycle therefore routes through:

```text
aiverse update
aiverse update --plan
aiverse doctor
aiverse upgrade
aiverse upgrade --apply
aiverse restore
aiverse restore --apply
```

These commands do not transfer Workspace or OS semantic ownership into Distribution.

## Structural authority remains owner-defined

OS structural detection and migration authority stay separate.

Current supported Workspace storage remains the direct `workspaces/<id>` slot under the canonical identity/storage contract. Historical nested/domain-first Workspace layout is not automatically relocated. When OS publishes no admitted relocation recipe, Distribution must classify that state truthfully and must not invent one.

Likewise, Workspace-to-personal capability promotion is the OS-owned transaction. The current provider-qualified identity contract treats a cross-provider promotion as identity-changing. Distribution may orchestrate around the resulting owner receipt/compatibility evidence, but it must not redefine the identity rule.

## Doctor boundary

`ai-verse-os doctor` remains the OS owner health surface.

`aiverse doctor` is a Distribution aggregate. It may invoke OS doctor and combine the result with other owners, but it must preserve OS failure truth and must not turn an OS failure into an aggregate false PASS.

## Recovery boundary

Distribution's whole-install Last-Known-Good/restore contract does not make OS a backup owner and does not authorize Distribution to rewrite arbitrary OS user state.

Recovery coverage is explicit. OS-owned/user-owned material is captured, reconstructed, rebuilt or excluded according to the canonical recovery contract. Credential-shaped/external state is not falsely rewound.

## Qualification handoff

At Safe Infrastructure Slice 5.3 start, the frozen OS ref is:

`470ad89e6b96d898161dee36d4e4fa8064dd6a8d`

Owner-native supporting evidence at that ref:

- Capability Placement Contract `38306623956`: SUCCESS;
- Repository QC `38306623950`: SUCCESS.

Slice 5.3 changes documentation only in this repository. Final qualification must keep OS owner-native CI green and Distribution's permanent Safe Infrastructure Regression/Convergence gates green.

## Maintenance rule

Future whole-install lifecycle changes belong in Distribution unless they require a real OS semantic change. Future OS semantic changes remain owner changes here and must be published through the existing machine-readable owner contracts before Distribution can orchestrate them.

No second Workspace migrator, OS doctor, capability-promotion engine or OS state owner may be created in Distribution.
