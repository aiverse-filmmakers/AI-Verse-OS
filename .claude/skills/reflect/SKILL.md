---
name: reflect
description: Tidy what AI-Verse OS knows about the operator. Use when the operator says "reflect", "tidy up", "tidy what you know about me", or when AI-Verse OS says tidying is due. Looks back over recent saves, fixes what sits in the wrong place, and tells the operator what changed, with a way to undo.
---

# Reflect (tidy what AI-Verse OS knows)

This capability runs one bounded tidy pass through the learning helpers. It never invents facts, never changes what a goal means, never deletes anything, and never touches secrets or permissions. If the helpers are not running, say so in everyday words and follow the missing helpers rule in `AGENTS.md`.

## When to use

- The operator says "reflect", "tidy up" or similar.
- The start of a chat says AI-Verse OS tidying is due. Then run the three commands it prints, after finishing the operator's request and before the final answer.
- The operator asks to tidy everything ("reflect all", "tidy everything you know"), or the start of a chat says tidying of everything saved is due. Then run the one `reflect all` command it prints.

## Inputs

- The current chat's learning commands (printed at the start of the chat): the same `--session`, `--turn` and `--token` as the review command, with `reflect` instead of `review`. No JSON is ever typed into these commands, in either app.
- Only the projects the operator named this turn, or the project folder the chat runs in, are tidied. Other projects stay untouched.
- `reflect all` is the exception: it reads everything saved, in every project, so it only runs in a plain chat with the operator, never in a project chat or when a project is named. If it is refused, skip it and say nothing.

## Method

1. Run `reflect plan`. It is read only. It lists what it would tidy: facts saved in the general place that belong to a project, project notes that are out of date, and projects missing from what AI-Verse OS knows about what the operator runs. Each item says whether it traces to the operator's own words or is a guess.
2. Run `reflect apply`. It applies at most five changes through the normal owners and records how to reverse each one. Guesses are applied too, but they are marked as guesses everywhere they are stored.
3. Run `reflect done`. It closes the pass and queues the tidy note.
4. Do not mention the tidy to the operator until the note is delivered. The note is shown once, at the start of a later reply, never in the middle of an answer. Copy it exactly as it is given.
5. `reflect all` does plan, apply and done in one command, on one batch of saved things (about 100) from a saved place, so a big store is finished over repeated passes (`more_to_check` says whether to run it again; do it only if the operator asked). It acts only on real problems: a saved thing that repeats an earlier one, a detail kept in the wrong place, out-of-date project notes. It never shortens, rewrites or splits anything, and skips what it already checked and that has not changed. If nothing needs fixing, change nothing and say nothing. Goals that look the same are only suggested in the tidy note; goals are never joined.
6. If the operator says "undo N", run `reflect undo` with the note id and item number. If they correct an item in words, save the right fact in the usual way and run `reflect undo` with `--mode corrected` so the tidy is not repeated.

## Validation

- `reflect plan` reports what it inspected and whether it was cut short by its limits (20 saves looked at, 40 records read, 5 changes, about 45 seconds).
- A second pass straight after the first changes nothing.
- A change the operator undid is not applied again while what it relied on is unchanged.

## Failure behavior

- If a command is refused (for example another pass is already running, or the helpers are switched off), skip tidying for this turn and say nothing about it.
- If an undo cannot be done cleanly because the operator edited that line since, leave it as it is and tell the operator.
- Never claim a change was made unless the command's result shows it.

## Friendly words

Say "what I know about you" instead of profile or Core, "projects" instead of workspaces, "what I remember" instead of memory, "your goals", and "AI-Verse OS helpers" instead of hooks. Never mention owners, scopes, routing or the bridge to a member.
