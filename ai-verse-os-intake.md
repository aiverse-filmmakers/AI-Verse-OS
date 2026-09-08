# AI-Verse OS Intake

This is the source-of-truth intake for your AI-Verse OS. Fill it in directly or run `/onboard` for a guided conversation. The onboarding skill reads this file and uses it to build the initial context files.

**Hard cap: 7 questions.** Keep answers practical. You can edit this file and re-run `/onboard` later.

## Q1 - Who are you, what do you do or sell, and who is it for?

```text
[Your answer here]
```

## Q2 - Paste 1 or 2 real examples of how you write

Use unedited examples from real emails, posts, messages, documents, or scripts. Do not manufacture a sample just for the intake.

```text
[Sample 1]
```

```text
[Sample 2]
```

## Q3 - What are your 2 or 3 biggest priorities for the next 90 days?

```text
1. [Priority 1]
2. [Priority 2]
3. [Priority 3]
```

## Q4 - Where does revenue land and where is it tracked?

Examples: Stripe, Skool, bank account, Shopify, QuickBooks, spreadsheet, CRM.

```text
[Your answer here]
```

## Q5 - Where do you communicate with customers, your team, and the outside world?

Examples: Gmail, Outlook, Slack, Teams, Discord, Skool, WhatsApp, DMs.

```text
[Your answer here]
```

## Q6 - Where do recordings, notes, files, lessons, and important documents live?

Examples: Google Drive, Notion, Dropbox, GitHub, Skool, local folders, meeting-recording tools.

```text
[Your answer here]
```

## Q7 - What recurring task consumes the most time, and where do you track work?

```text
[Your answer here]
```

When the file is filled, run `/onboard`. It should create or refresh `context/`, `references/voice.md`, `connections.md`, and the personalized sections of `CLAUDE.md` and `AGENTS.md`.
