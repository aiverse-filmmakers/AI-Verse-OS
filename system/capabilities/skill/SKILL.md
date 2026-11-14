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
| List skills | Run `node scripts/skills-list.mjs` (add `--scope workspace:<id>` inside a project) and show its two groups: "Skills" and "My skills" |

After a skill of the operator's own is saved, changed or removed, run
`node scripts/sync-my-skills.mjs` so Claude and Codex in this OS folder see it
(or stop seeing it) in the next chat.

Ask only when the answer changes what gets built.

## Talking to the operator

- Plain words. Say "just this project" and "change the skill itself". Never say "globally".
- When a change is saved for one project, say so in one line: "Saved for this
  project only. Want this in the skill itself too?"
- Hide internal files and JSON. The operator never writes them by hand.
- Say plainly what is untested or only proposed.

## Must not

- Edit a shipped skill, the managed library folder or `system/capabilities/`.
- Put secrets, credentials or one project's private details into a shared skill.
- Claim a skill is active when it is only proposed.
