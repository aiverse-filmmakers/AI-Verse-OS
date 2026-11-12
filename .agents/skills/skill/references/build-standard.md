# Skill build standard

The one set of rules for making, bringing in or changing a skill in AI-Verse OS.
`/skill` and `/learn` both follow this file. Nothing else defines how a skill is built.

Based on the open Agent Skills specification (agentskills.io/specification),
Anthropic's skill authoring best practices, OpenAI's "Build skills" guide and the
Claude Code skills documentation, all read on 11 November 2026. All four agree on
the format, so one skill built this way works in Claude, Codex and ChatGPT.

## 1. Is it really a skill?

A skill is repeatable AI guided work with judgment, guardrails and a way to check
the result. If it is not that, route it elsewhere and stop:

| Material | Home |
|---|---|
| Current state | scoped `context/` |
| A past event or lesson | scoped `memory/` |
| Reference information | scoped `knowledge/` |
| A settled choice | scoped `decisions/` |
| Exact file, API or data work with no judgment | a script |
| One project's brand, tone, audience, names | that project's adjustments (section 6) |

One skill, one job. If the material covers two jobs, make two skills.

## 2. Collect before writing

1. The job, in one sentence, in the member's words.
2. Three realistic requests that should trigger it. Use real ones from the chat when they exist.
3. Check for an existing skill that already does the job (capability resolver, or
   `capability.read_instructions` for a candidate). If one fits, propose a change to
   it instead of a new skill.
4. What it needs: software, accounts, connections, files. Never assume they exist.

## 3. Folder and header

```text
skill-name/
  SKILL.md        required
  references/     optional: long material, read only when needed
  scripts/        optional: exact repeatable steps
  assets/         optional: templates, images, data
```

Header, and only these lines:

```yaml
---
name: skill-name
description: What it does. Use when <the words a member would say>.
license: <optional>
compatibility: <optional: what it needs installed or connected>
metadata: <optional: simple text values only>
---
```

- `name`: lowercase letters, numbers and hyphens, at most 64 characters, identical
  to the folder name, says what it does. No vague names like `helper` or `tools`.
- `description`: at most 1,024 characters. Main use first, because long skill
  lists get descriptions cut short. Then "Use when ...". This sentence decides
  whether the skill is ever picked, so make it specific.
- Do not add `version`, `author`, `triggers`, `platforms` or other extra lines.
  They are not part of the standard and are ignored or rejected by some tools.

## 4. Instructions

- Under 500 lines in `SKILL.md`. Write only what the AI would not already know.
- Long material goes in `references/`, linked straight from `SKILL.md`. One hop
  only: a reference never sends the AI to a third file.
- Match strictness to risk: loose guidance where many approaches work, exact
  steps or a script where a mistake is costly.
- Cover, briefly: outcome, inputs, ordered steps, decision rules, what it must not
  do without approval, where outputs go, how success is checked, and what to do
  when something is missing or fails.
- No secrets, credentials, private client facts or one project's details in a
  shared skill.

## 5. General or exact

Before saving, split what was collected into:

- **General method:** steps that would work in any project.
- **Project details:** brand, client names, fonts, colours, tone, audience, steps
  that only make sense in one project.

If there are no project details, skip the question. If there are, ask one plain question:

> This includes details specific to <project>. Keep it exactly as is, for this
> project only? Or make a general version that works anywhere, and keep the
> <project> details with this project?

- **General:** the general method becomes the skill on the member's shelf. The
  project details become that project's adjustments (section 6).
- **Exact:** the whole skill is saved for that project only.

## 6. Project adjustments

A skill that accepts adjustments says so in its instructions, in one short
section, for example:

```markdown
## Project adjustments
If the current project has adjustments for this skill (brand, audience, tone,
sign off), apply them. Where they disagree with these instructions, the
project's adjustments win.
```

Adjustments live inside the project, never inside the skill. Never store secrets
in them. One project never reads another project's adjustments. Sharing a skill
leaves adjustments behind unless the member explicitly asks to include them.

## 7. Who owns it, and how changes happen

- **Shipped skills** (built in, or from the AI-Verse library) are never edited.
  When a member wants one changed, make the member their own version on their
  shelf and select it from then on.
- **The member's own skills** (made or brought in by them) are edited directly.
  The Skills owner keeps the previous version in history.
- **Bringing one in:** one copy on the member's shelf, tidied to this standard,
  theirs from then on. No untouched original kept beside it. Record where it came
  from and its licence. Run the read only skill check on it first and show the
  member anything it flags.
- Never write into the managed library folder or `system/capabilities/`.

## 8. Test

1. Run the three requests from section 2 in a fresh chat without the skill. Note
   where the result falls short.
2. Run them again with the skill. Compare.
3. A skill that does not clearly beat "no skill" is not saved.
4. When fresh chats cannot be run from here, say so plainly and mark the skill untested.

## 9. Save and report

Save only through the existing owners, never by writing library files directly:

| Case | Action |
|---|---|
| New skill or change from finished work | `skills.learning-candidate` |
| Bring in an outside skill | `skills.library-import` |
| Project adjustments (small values) | `skills.binding-plan`, then `skills.binding-save` |

Report in plain words what was created, where it applies (every project, or one
named project), and its state. A proposal is not an active skill: never call it
active until the owner says so.

## Final check

- [ ] One job, and it is really a skill
- [ ] Folder name equals `name`; lowercase with hyphens
- [ ] Description says what it does and "Use when ..."
- [ ] Header has only standard lines
- [ ] `SKILL.md` under 500 lines; references one hop
- [ ] Needs stated; nothing assumed installed
- [ ] No project details in a shared skill; adjustments section present if it takes them
- [ ] Tested with and without, or marked untested
- [ ] Source and licence recorded for anything brought in
