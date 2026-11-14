---
name: skill
description: Make a new skill, bring in an outside skill, show how a skill is set up, or change one, following the AI-Verse skill build standard. Use when the operator invokes /skill or asks to create, import, install, inspect, edit or adjust a skill for a project.
---

# Skill

One command for anything done on purpose with skills. Follow
[the build standard](references/build-standard.md) for every rule about format,
testing, ownership and saving. `/learn` uses the same standard when it turns
finished work into a skill, so both paths produce the same result.

## Work out which job

| The operator wants to | Do |
|---|---|
| Make a new skill | Standard sections 1 to 9, in order |
| Bring one in from elsewhere | Run the read only skill check on it, show anything flagged, then sections 3, 4, 7 and 9 |
| See how a skill is set up | Find it, then explain in plain words: what it does, who owns it (shipped or theirs), what it needs, and the current project's adjustments |
| Change a skill | Ask one question: "just this project" or "change the skill itself". Then follow section 6 or 7 |

Ask only when the answer changes what gets built.

## Talking to the operator

- Plain words. Say "just this project" and "change the skill itself". Never say "globally".
- When a change is saved for one project, say so in one line: "Saved for this
  project only. Want this in the skill itself too?"
- If the answer is yes for a shipped skill, save the same note with the
  `operator` scope (`adjustments-save` in `scripts/capability-resolver-cli.mjs`).
  Every project then gets it, and a project's own note still wins. Say: "Saved
  for every project." For the operator's own skill, change the skill itself.
- Hide internal files and JSON. The operator never writes them by hand.
- Say plainly what is untested or only proposed.

## Must not

- Edit a shipped skill, the managed library folder or `system/capabilities/`.
- Put secrets, credentials or one project's private details into a shared skill.
- Claim a skill is active when it is only proposed.
