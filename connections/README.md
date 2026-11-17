# Connections

Connections describe how AI-Verse OS can reach external systems, people, tools, records, repositories, data, services, devices, or other sources.

`registry.yaml` is user-owned and gitignored by default. Start from `registry.example.yaml`.

## A registry entry is not proof

A connection can be:

- planned
- configured
- verified
- degraded
- unavailable
- retired

Do not claim live access merely because a tool is named in the registry.

## Secrets

Never write credentials, API keys, passwords, private keys, recovery codes, or session tokens into the registry, notes, memory, chat archives, or commits.

API keys have one home: the `.env` file at the AI-Verse OS root. It is gitignored, and `.env.example` shows common names without values.

- Save a key: `node scripts/secrets.mjs set NAME`. Claude cannot show you a hidden prompt, so run this yourself: type `!` before it in Claude Code, or use your own terminal. Type the value into the hidden prompt, or pipe it in; never put it in the command itself.
- Check keys: `node scripts/secrets.mjs status` (names only, shown as set or missing).
- Use keys: `node scripts/secrets.mjs run -- <command>`. This only works for commands you have listed yourself, one per line, in a file named `.env.allow` in the OS folder (start from `.env.allow.example`). Your AI cannot edit that file, so you add the lines. Every use of the helper (`set`, `status` and `run`) asks you to approve it, one prompt each time, unless you add your own allow rule. The prompt shows only the command line, not what the program does, so approve only commands you recognise.

Edit `.env.allow` yourself in your own editor or a terminal outside Claude; the agent's sandbox cannot write to it. The same sandbox stops the agent from writing to `.env` (it can only be changed through the helper), `scripts/secrets.mjs`, `.env.allow` and Claude's own settings and hooks.

To check that this protection works in your Claude Code, ask Claude to run these two commands. Both must be refused with a permission or "operation not permitted" error, and neither file may change:

```
echo x >> scripts/secrets.mjs
echo x > .env
```

If either one succeeds, undo it (`git checkout scripts/secrets.mjs`, delete `.env`) and treat the protection as not working.

A line matches any command that starts with those words, so a line like `node tool.mjs` allows `node tool.mjs` with any arguments. Lines that are only a program (`node`, `python`, `sh`, `bash`, `env`, `git`, `npx`, `curl`, `wget` and similar) are refused. List exact commands such as `npm test`. Because `.env` is hidden from the sandbox, you may also be asked to approve running it outside the sandbox.

Be honest with yourself about what listing a command means: an approved command receives your keys and could send them anywhere. Only list commands you trust. The helper hides key values it spots in a command's output, but that only catches accidental printing; it is not a protection.

Names that change how programs start (PATH, HOME, NODE_OPTIONS, LD_*, DYLD_*, GIT_* and similar) are refused, and values shorter than 4 characters are refused.

In the registry, record only the variable name, for example `auth: env var OPENAI_API_KEY`. Claude and Codex never read `.env` or print a key; they can run these commands and report "set" or "missing". A key being set is still not proof that a connection works.

## Scope

A connection may be operator-wide or limited to specific workspaces. Respect those boundaries during retrieval and action.
