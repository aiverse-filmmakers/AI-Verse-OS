# AI-Verse OS Skill Authoring Guide

Use this guide when converting AI-Verse lessons, workflows, tutorials, or production methods into reusable AI skills.

## First decide what the lesson really is

Not every lesson should become a skill.

| Material | Best home |
|---|---|
| Facts, theory, model notes, filmmaking principles | `references/` |
| A repeatable human procedure | SOP under `references/sops/` |
| A reusable document or prompt structure | `templates/` |
| Deterministic file/API/data work | `scripts/` |
| Repeatable AI-guided work with decisions, guardrails, and verification | `.claude/skills/<skill-name>/` |

A lesson can produce more than one artifact. For example, a filmmaking lesson might become a short skill plus a deeper reference file the skill reads when needed.

## Skill folder

Canonical skill source:

```text
.claude/skills/<skill-name>/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── references/        # only when the skill needs supporting knowledge
├── assets/            # templates or files the skill copies/uses
└── scripts/           # deterministic helpers when useful
```

After editing canonical skills, synchronize Codex copies with:

```bash
bash scripts/sync-codex-skills.sh <skill-name>
```

## Required skill anatomy

Every production skill should answer these questions clearly.

### 1. Trigger

When should the AI use this skill?

Use recognizable user intent rather than obscure command-only triggers.

### 2. Outcome

What concrete result should exist when the skill finishes?

Avoid goals such as "help with storyboards." Prefer outcomes such as "produce a sequential shot plan and the exact still-image assets required for generation."

### 3. Inputs

State what the skill needs before execution:

- user answers
- files
- images
- video references
- brand assets
- project context
- connected data
- aspect ratio
- target platform or model

Reuse known context instead of asking the user for information already available.

### 4. Execution

Write the workflow in the order it should actually happen. Separate deterministic operations from AI judgment.

For complex production workflows, make handoffs explicit so one stage produces exactly what the next stage needs.

### 5. Decision rules

Explain how the AI chooses between valid paths.

Examples:

- crop versus extend an image
- one reference image versus multiple references
- storyboard first versus direct generation
- when a shot requires continuity assets
- when a model-specific prompt adaptation is needed

### 6. Locks and guardrails

State what must remain unchanged.

For visual workflows this may include:

- identity
- character design
- wardrobe
- product geometry
- location architecture
- lighting continuity
- camera side / screen direction
- aspect ratio
- readable real text
- shot order

Also state what the AI must never invent or silently replace.

### 7. Outputs

Define exactly what the user receives and how it is named.

When later stages depend on files, specify filenames and tell the user when those files will be needed again.

### 8. Verification

A skill is incomplete without quality control.

Verify the things that would make the output unusable, such as:

- missing shots
- duplicated frames
- continuity drift
- wrong aspect ratio
- incorrect character identity
- broken text
- unsupported model instructions
- missing source assets
- mismatched filenames
- unverified external connections

## Keep timeless logic separate from changing model knowledge

Fast-changing information should not be hardcoded throughout a skill.

Example structure:

```text
.claude/skills/image-to-video/
├── SKILL.md
└── references/
    ├── model-selection.md
    ├── kling.md
    ├── seedance.md
    └── wan.md
```

The skill contains the stable filmmaking workflow. Reference files contain current model-specific prompting, limitations, and tested behavior.

This makes it possible to update a model reference without rewriting the whole skill.

## AI filmmaking quality gate

Before shipping a filmmaking skill, check that it handles the relevant parts of this chain:

```text
Idea
→ Story / objective
→ Script or beat structure
→ Asset requirements
→ Character / product / location locks
→ Shot design
→ Storyboard / keyframes
→ Image generation
→ Image QC
→ Video prompt adaptation
→ Video generation
→ Video QC
→ Edit / sound / delivery
```

A skill does not need to own every stage, but it must clearly state what it receives from the previous stage and what it hands to the next one.

## Beginner rule

AI-Verse skills should perform as much expert reasoning as they reliably can. Do not force a beginner to learn terminology or manually perform a filmmaking/planning task when the skill can make that decision safely from the available context.

Ask a question only when the answer materially changes the output.

## Final test before adding a new skill

A skill is ready when a fresh AI session can answer all of these:

1. Why should I invoke this skill?
2. What do I need before I start?
3. What steps do I follow?
4. What decisions am I allowed to make?
5. What must remain locked?
6. What do I deliver?
7. How do I know the result is correct?
8. What do I do when something is missing or fails?

If those answers are vague, refine the skill before adding more features.
