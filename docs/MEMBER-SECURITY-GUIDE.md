# Staying safe with AI-Verse OS

AI-Verse OS lowers your risk. It cannot remove it. Any AI that reads outside content can be tricked by that content, with or without this OS.

## What can go wrong

A web page, PDF, email or skill can contain hidden instructions for your AI. If the AI obeys them, it could leak private information or run something harmful. Skills, repos and plugins deserve extra care, because your AI follows them with your access.

## What the OS does for you

- Treats outside content as information, never as orders.
- Keeps `.env` secret files off limits and runs shell commands inside a sandbox on Claude Code.
- Reads the web through a helper that cannot open your private files.
- Shows you a plain report before an outside skill or repo is added.
- Labels anything remembered from the web as unconfirmed.

## Your ten habits

- [ ] Update Claude Code and Codex at least weekly.
- [ ] Keep passwords and API keys out of your AI-Verse OS folder.
- [ ] Only add skills from the AI-Verse library unless you have read the report.
- [ ] Never paste an install command just because a skill or page told you to.
- [ ] Download unknown projects into a separate folder, and do not open them with your AI until you trust them.
- [ ] Turn on only the connectors you use, and remove the rest.
- [ ] Use a separate browser profile for AI browsing.
- [ ] Never approve something you do not understand. Ask the AI to explain it first.
- [ ] Be suspicious if the AI suddenly wants to send, upload or install something you did not ask for.
- [ ] Never use bypass or "skip permissions" mode in your AI-Verse OS folder.

To review an outside skill or repo yourself, ask your AI to run this on its folder:

```bash
node scripts/skill-check.mjs path/to/folder
```

An empty report does not mean something is safe. It only means the simple checks found nothing.

## If something looks wrong

1. Stop the chat and disconnect from the internet.
2. Change any password or API key the AI could have reached, starting with GitHub, email and AI providers.
3. Remove the skill, repo or connector you added most recently.
4. Check for changes to `.claude/`, `.mcp.json`, `AGENTS.md` and what the OS remembers.
5. Restore from backup if files were altered, then tell the community so others can check.
