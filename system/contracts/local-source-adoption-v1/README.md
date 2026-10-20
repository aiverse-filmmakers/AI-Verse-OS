# Local source adoption v1

This OS-owned data contract authorizes a bounded preparation operation in the canonical Distribution updater. It is not permission for an agent to reset, stash, delete, reclone, or manually replace a member installation after an update refusal.

## Intent and ownership

Normal `aiverse update` preserves unknown source edits. It may prepare edits whose exact bytes/mode already match the admitted target. A member can explicitly choose official software, retaining old software edits in private recovery storage rather than keeping them active. This choice does not authorize replacement of personal state, unknown files, extension configuration or hook trust.

Distribution packages this exact contract with an immutable OS source reference and digest. It must not load mutation authority from a locally edited contract in the member project. OS contract publication does not itself change a Core release pointer or admit a release transition.

## Eligible preparation

- Prove the project, installed receipt, installed revision, admitted target and physical path containment first. Refuse staged changes, type conflicts, symlinks, traversals and unsupported paths.
- Listed software paths can return to exact installed release bytes only after durable verified capture. Unknown software differences require explicit `official` source policy. Default `preserve` admits only target-identical source changes.
- Generated adapters require target equality and known release membership; arbitrary modified or unknown adapters remain conflicts even under official software policy.
- Additions to `.gitignore` may move to project-local Git exclusions only when the original lines remain in order, no original rule is removed, and no added negation changes privacy behavior. Capture the previous exclusion file and verify preservation before and after update.
- An append-only change to `knowledge/README.md` may move its exact appended material into the declared local knowledge file. Preserve an existing destination unchanged unless it is the exact output from this operation. Non-append-only document edits require review. The route and linked local documents remain accessible; they are not software patches to discard.
- Preserve all other user/owner state. Examine untracked target collisions individually: equal regular-file content may be admitted by the transition; different content or unsafe types stop before mutation. Never recursively clean untracked or ignored content.

## Transaction and recovery

Use the existing lifecycle lock. Bind all planned changes to current bytes, modes, Git HEAD/index, target and destination state. Validate these again immediately before mutation. Write a durable preparation journal and verify exact originals before any change. A capture of a customized installation is a recovery snapshot, not a verified healthy Last-Known-Good release.

Preparation precedes normal healthy-source qualification and the existing update transaction. Do not disable source verification or owner health. Preserve exclusions and local document routes across activation and failure. Record each write intent durably, recover interrupted preparation before accepting another operation, and refuse rollback when observed bytes differ from both the planned original and the operation's own output. Do not overwrite subsequent member edits during recovery.

Once the installed release is verified at the target, keep source-edit recovery evidence and finalize preparation. If the update rolls back before activation, restore the captured local source state. If an owner migration or update recovery is uncertain, retain both journals and require the existing owner recovery path; do not invent a database downgrade.

## Qualification

Cover target-identical edits, explicit official adoption, default refusal of unique code, append-only knowledge routes, ignore privacy behavior, untracked target collisions, staged changes, symlinks, modes, concurrent edits, capture failure, interruption at every preparation write, successful update and update rollback. Verify populated member preservation on Linux, macOS and Windows. No completion claim is valid without the canonical updater's final aggregate checks.
