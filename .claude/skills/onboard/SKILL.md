---
name: onboard
description: Use on Day 1 of an AI-Verse OS install, when someone says "set me up", "onboard me", "let's get started", or wants to refresh the system from ai-verse-os-intake.md. Runs a maximum seven-question intake and scaffolds the initial context files.
---

# Onboard

Create or refresh the operator's initial AI-Verse OS context without turning onboarding into a long consulting exercise.

## Canonical source

The source-of-truth intake is `ai-verse-os-intake.md`.

Read `AGENTS.md` and `CLAUDE.md` before modifying shared operating guidance. Preserve unrelated instructions and keep shared guidance synchronized.

If the intake file is missing, use `assets/ai-verse-os-intake.md` as the template.

## Step 1 - inspect the intake

Check Q1 through Q7.

- If all seven are filled, skip the interview and scaffold from the existing answers.
- If some are filled, ask whether to fill the missing answers now or scaffold from the available information.
- If none are filled, run the interview.

Do not treat placeholders as real answers.

## Step 2 - interview, seven questions maximum

Ask one question at a time. Save each answer to `ai-verse-os-intake.md` immediately so the session can be resumed.

1. **Who are you, what do you do or sell, and who is it for?**
2. **Paste 1 or 2 real examples of how you write.** Require real unedited writing rather than a sample invented for onboarding.
3. **What are your 2 or 3 biggest priorities for the next 90 days?** Push vague goals toward a deadline, deliverable, or measurable outcome.
4. **Where does revenue land and where is it tracked?**
5. **Where do you communicate with customers, your team, and the outside world?**
6. **Where do recordings, notes, files, lessons, and important documents live?**
7. **What recurring task consumes the most time, and where do you track work?**

Do not add an eighth onboarding question. Follow-up clarification is allowed only when an answer is unusably ambiguous.

## Step 3 - scaffold the Day 1 files

Create or refresh:

1. `context/about-me.md` from Q1 and the operator's role.
2. `context/about-business.md` from Q1 and Q4.
3. `context/priorities.md` from Q3.
4. `references/voice.md` from Q2. Preserve the samples verbatim and add a short note explaining how they should be used.
5. `connections.md` from Q4 through Q7. Mark mechanisms as `not yet connected` unless there is evidence of a working connection.
6. Personalized sections of `AGENTS.md` and `CLAUDE.md`, using only facts supported by the intake.

When refreshing existing files, preserve unrelated current information. If an update would overwrite meaningful prior content, copy the old version into a dated folder under `archives/` first.

## Step 4 - closing handoff

Keep the completion message compact:

```text
Day 1 complete. AI-Verse OS now has your initial identity, business context, priorities, voice samples, and connection map.

Ask: "What should I focus on this week?"
Then start wiring the highest-value missing connection and run /audit after setup.
```

When the user asks what to focus on, ground the answer in `context/priorities.md`, `context/about-business.md`, and other relevant saved context. Do not answer generically when specific saved information exists.

## Rules

- Seven intake questions maximum.
- Never ask for passwords, API secrets, recovery codes, or private keys.
- Do not claim a connection works merely because the user named the tool.
- Do not overwrite `references/3ms-framework.md` or `references/4cs-framework.md`.
- Do not create unrelated skills during onboarding.
- Keep `AGENTS.md` and `CLAUDE.md` synchronized where their standing guidance is shared.
- Re-running onboarding must be safe and should not erase unrelated context.

## Verification

Before finishing, verify that:

- Q1 through Q7 are either answered or clearly marked unknown.
- the three core context files exist
- voice samples were saved when supplied
- the connection registry reflects the intake without inventing integrations
- both operating manuals still contain the core AI-Verse OS rules
- no secrets were written to the repository
