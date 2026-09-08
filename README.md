# AI-Verse OS

**AI-Verse OS** is a practical AI operating system for creators, filmmakers, operators, consultants, and teams. It gives Claude Code and Codex a persistent structure for context, connections, reusable skills, decisions, and recurring AI workflows.

The long-term goal is simple: turn useful knowledge into executable AI skills instead of leaving it trapped inside lessons, notes, videos, and documents.

**AI-Verse Community:** https://www.skool.com/bogdans-ai-verse-4398

## The litmus test

> While you are not at your desk, your AI-Verse OS can observe or receive a real-world event, find the right context, and produce a useful output faster and more consistently than rebuilding the process manually.

Every layer, skill, connection, and workflow should contribute to that outcome.

## How you know it is working

1. **Knowledge leaves your head.** Important context, decisions, workflows, and lessons become findable by your AI.
2. **Context switching drops.** You increasingly start with AI-Verse OS instead of manually opening six different apps and reconstructing context.
3. **Repeatable work becomes a skill.** A short request can trigger a reliable multi-step workflow instead of a fresh prompting session every time.
4. **Useful work can run on cadence.** Mature workflows can eventually execute on a schedule or from an event trigger.

## Two operating frameworks

AI-Verse OS uses two complementary frameworks.

### The Three Ms

| M | Purpose |
|---|---|
| **Mindset** | Look at work through an AI-first lens. Ask where AI can assist, accelerate, or remove repetitive effort. |
| **Method** | Find the constraint, eliminate unnecessary work, map the process, choose the right autonomy level, and connect it to a measurable outcome. |
| **Machine** | Build small reliable blocks, validate each step, use the least complexity required, supervise rollout, and keep a kill switch. |

Full breakdown: `references/3ms-framework.md`

### The Four Cs

| Layer | Purpose | Test |
|---|---|---|
| **Context** | Knows you and the work | A fresh session can answer important questions from saved context without making things up. |
| **Connections** | Reaches your systems | The AI can retrieve live or exported information from the tools you actually use. |
| **Capabilities** | Knows how to do the work | A short instruction can invoke a documented multi-step skill or workflow. |
| **Cadence** | Runs without repeated prompting | A mature workflow can operate on a schedule or event trigger with suitable controls. |

Full breakdown: `references/4cs-framework.md`

## Included skills

| Skill | Purpose |
|---|---|
| `/onboard` | Build the initial AI-Verse OS context from a seven-question intake. |
| `/grill-me` | Deepen context through focused interviews and preserve the answers. |
| `/link` | Make a project, file, folder, or source findable from the operating manual. |
| `/audit` | Check the Four Cs, routing, freshness, compatibility, and evidence of real operation. |
| `/level-up` | Use the Three Ms to find and ship one useful improvement at a time. |
| `/3d-brain` | Build a local visual explorer for selected knowledge sources. |

This is the foundation. AI-Verse lessons can be converted into additional skills over time, including filmmaking, image generation, video workflows, storyboards, continuity, prompting, editing, automation, and distribution.

## Quick start

1. Clone this repository.
2. Open it in Claude Code or Codex.
3. Run `/onboard` in Claude Code or select the `onboard` skill in Codex.
4. Answer the seven intake questions.
5. Use the system for real work.
6. Run `/audit` after setup and after meaningful changes.
7. Use `/grill-me` whenever important knowledge is still only in your head.
8. Use `/link` when adding new sources.
9. Run `/level-up` regularly to turn repeated work into stronger workflows and skills.

## Repository layout

```text
AI-Verse-OS/
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── EXPANSIONS.md
├── SKILL-AUTHORING.md
├── LICENSE
├── .gitignore
├── ai-verse-os-intake.md
├── connections.md
├── context/
├── references/
│   ├── 3ms-framework.md
│   └── 4cs-framework.md
├── decisions/
│   └── log.md
├── archives/
├── brainstorms/               # created by /grill-me, gitignored
├── audits/                    # created by /audit, gitignored
├── scripts/
│   └── sync-codex-skills.sh
├── .claude/skills/            # authoring source
└── .agents/skills/            # Codex-compatible copies
```

## Building the AI-Verse skill library

A lesson becomes much more valuable when it is transformed from information into an executable workflow. New AI-Verse skills should contain:

- a clear trigger and purpose
- required inputs
- step-by-step execution logic
- decision rules and guardrails
- expected outputs
- verification or quality-control checks
- references and reusable assets when needed

See `SKILL-AUTHORING.md` for the full lesson-to-skill conversion standard, including filmmaking handoffs, continuity locks, quality gates, and when material should remain a reference, SOP, template, or script instead of becoming a skill.

The goal is not to create hundreds of vague prompts. The goal is to build a growing library of focused skills that reliably perform real work.

## License

This repository is distributed under the MIT terms in `LICENSE`. AI-Verse OS-specific modifications and additions are maintained by AI-VERSE.
