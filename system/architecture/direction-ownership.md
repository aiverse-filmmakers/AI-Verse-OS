# Strategic Direction Ownership

AI-Verse OS and AI-Verse Brain must never maintain two editable strategic direction stores for the same scope.

## One owner per scope

Each scope resolves to exactly one `direction_owner`:

- `os` — AI-Verse OS owns editable strategic direction.
- `brain` — AI-Verse Brain owns editable strategic intent.

Scopes use the same identifiers as Brain: `operator` or `workspace:<id>`.

The durable local coordination record is:

```text
.aiverse/direction/ownership.json
```

It is local/user-owned state and is ignored by Git. Absence of the file or a scope record means `os` **only for a compatible OS that has never been handed over**. A malformed/incompatible ownership record fails closed; it must never be interpreted as OS ownership.

Use:

```bash
node scripts/direction-owner.mjs status --scope operator
node scripts/direction-owner.mjs assert-strategic-write --scope operator
node scripts/current-context.mjs read --scope operator
```

Every OS workflow that may change goals, priorities, objectives, success definitions or other strategic direction must run the strategic-write assertion first. Every runtime path that loads active current context must use the ownership-aware current-context resolver rather than reading raw current files directly.

## OS-owned mode

While `direction_owner = os`:

- OS onboarding may create or refresh `operator/profile/goals.md` and strategic sections of current context.
- workspace setup may establish the current objective/outcome.
- `/level-up` may use and update OS-owned strategic direction when the user explicitly changes it.
- Brain must not create or confirm a parallel strategic intent store for that scope.
- `scripts/current-context.mjs` returns the scope's current OS context unchanged.

Brain may still own Brain-specific practices and non-strategic machinery that do not duplicate OS direction.

## Explicit handover to Brain

Ownership never changes merely because Brain is installed, available, newer, or selected as a reasoner.

The user must explicitly request the handover. Brain exposes a dry-run plan first:

```bash
ai-verse-brain direction-owner . --scope operator --handover-to-brain
```

Application additionally requires explicit import confirmation:

```bash
ai-verse-brain direction-owner . --scope operator --handover-to-brain --apply --confirm-import
```

The handover contract is:

1. discover existing OS strategic sources for that scope;
2. preserve their exact paths and SHA-256 provenance;
3. stage imported Brain intent without activating a second owner;
4. atomically persist `direction_owner = brain` in the OS-local coordination record;
5. confirm the imported Brain intents;
6. emit `.aiverse/direction/views/<scope>.md` as the OS-side generated reference view.

If interruption occurs before step 4, OS remains the owner and imported Brain candidates remain non-active. If interruption occurs after step 4, Brain remains the owner and the handover is resumable. There is no failure path that silently returns strategic ownership to OS.

## Brain-owned mode

Once `direction_owner = brain`:

- Brain intent is canonical for strategic direction.
- OS must not edit `operator/profile/goals.md`, workspace Objective sections, or equivalent OS strategic sources.
- Existing OS goal/objective files become frozen provenance, not canonical editable direction.
- OS reads Brain refs and the generated `.aiverse/direction/views/<scope>.md` for strategic display/routing.
- Active current-context reads go through `scripts/current-context.mjs`; raw strategic sections are never treated as current merely because they remain in `CURRENT.md`.
- The resolver uses an allowlist for OS operational sections. Operator `Current priorities`, workspace `Objective`, unknown headings and arbitrary preamble are omitted after handover; operational/current-state fields such as current facts, active workspaces, next useful actions, pending decisions, source pointers, connection state and execution state may remain visible.
- Missing or invalid generated direction views are reported as unavailable/invalid and never cause fallback to frozen OS strategy.

A Brain outage does **not** transfer ownership. The ownership marker is independent of Brain process availability, so OS strategic writes remain blocked and active-context reads remain filtered until an explicit future ownership-transfer protocol changes the marker.

## Migration rule

Existing OS goals must survive handover. Brain imports supported goal/objective statements with:

- original OS path;
- SHA-256 of the source bytes;
- explicit handover ID;
- explicit import confirmation;
- Brain object refs recorded back into the ownership record.

The original OS files are not deleted during handover. They are frozen as provenance after Brain ownership becomes active. Preserving the files does not grant them current-direction authority.

## Non-goals

This contract does not change:

- Memory ownership;
- capability/provider selection;
- action permissions;
- scheduler ownership.

Those remain separate architecture contracts.
