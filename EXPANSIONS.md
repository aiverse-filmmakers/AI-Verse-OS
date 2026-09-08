# EXPANSIONS - what to add as AI-Verse OS grows

AI-Verse OS starts with a small operating core. Add structure when real work requires it, not just because another folder looks organized.

## Foundation that should remain stable

| Path | Purpose |
|---|---|
| `context/` | Current operator, business, priorities, and project context. |
| `references/` | Durable frameworks, voice samples, SOPs, API notes, lessons, and domain knowledge. |
| `decisions/log.md` | Meaningful decisions and the reasoning behind them. |
| `connections.md` | Systems and information sources the OS can reach. |
| `archives/` | Older material that should be preserved but not treated as current truth. |
| `.claude/skills/` | Canonical Claude Code skill packages. |
| `.agents/skills/` | Codex-compatible skill packages. |
| `ai-verse-os-intake.md` | Source-of-truth onboarding intake. |
| `CLAUDE.md` and `AGENTS.md` | Root operating manuals. |

## Useful additions as the system grows

| Path | Add when | Purpose |
|---|---|---|
| `projects/` | Multiple active workstreams need their own scoped context | Prevent project details from polluting evergreen context. |
| `skills/` documentation | The skill library becomes large | Human-facing catalog and contribution guidance. |
| `references/sops/` | A recurring process has been proven | Store the canonical procedure used by one or more skills. |
| `references/filmmaking/` | AI filmmaking knowledge starts accumulating | Directing, continuity, cinematography, story, prompting, and model-specific references. |
| `references/models/` | Model behavior matters to workflows | Keep tested model notes separate from timeless filmmaking principles. |
| `templates/` | The same artifact structure is reused repeatedly | Reusable outputs, prompt scaffolds, checklists, and production documents. |
| `brand-assets/` | Skills generate branded visual content | Logos, style guides, safe-zone references, palettes, and reusable assets. |
| `scripts/` | A deterministic helper is more reliable than prompting | API, conversion, validation, file, and automation helpers. |
| `apps/` | A skill creates a persistent local application | Keep generated tools and interfaces in one obvious place. |

## Turning AI-Verse lessons into skills

Do not convert every lesson automatically. Convert a lesson when it teaches repeatable work that an AI can execute or guide reliably.

A strong skill should define:

1. **Trigger:** when the skill should be used.
2. **Goal:** the concrete outcome.
3. **Inputs:** required files, references, answers, or connected data.
4. **Execution:** ordered steps and decision rules.
5. **Guardrails:** what must not change, hallucinate, overwrite, or skip.
6. **Output:** what the user receives and in what format.
7. **Verification:** how the skill checks that the result is usable.
8. **References:** durable knowledge the skill should read instead of reinventing.

For filmmaking skills, also consider continuity locks, aspect ratio, shot intent, camera language, asset filenames, reference-image requirements, model constraints, and handoff instructions between image and video stages.

## Anti-patterns

- Do not create vague skills that are only long prompts with no verification.
- Do not duplicate the same truth in several folders.
- Do not make a new top-level folder for every lesson.
- Do not store secrets, API keys, or passwords in the repository.
- Do not use AI for deterministic steps when a simple script is safer and more repeatable.
- Do not automate a broken manual process before understanding why it fails.
- Do not keep obsolete knowledge mixed with current instructions. Archive it.

## Expansion rule

Before adding structure, ask:

1. Is this genuinely a new category of information or work?
2. Will it be reused at least several times?
3. Can an AI skill route to it predictably?

If the answer is mostly no, keep the system simpler.
