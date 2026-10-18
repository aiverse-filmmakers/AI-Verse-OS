# Finish connecting AI-Verse to Codex

Use this file when setup is requested, including before hooks have approval. The normal OS setup chat loads extension instructions through the registry; it must not depend on an unapproved hook running first.

## Explain the approval in plain English

Your AI-Verse helpers are installed. They load relevant notes when you send a message and let me save useful outcomes through your OS while working. These small programs can read and update local AI-Verse files, so Codex requires you to review them before allowing them to run.

No coding is needed:

1. Open Codex Settings. On Mac you can press ⌘ ,.
2. Select Hooks.
3. Find the six hooks for **[your AI-Verse project]**.
4. Review the items awaiting approval and choose the option to Trust them.
5. Return to the setup chat and say “Done.” The assistant will check the connection.

The labels are UserPromptSubmit (load context), SessionStart (restore context), PostToolUse (record limited evidence), Stop (finish checks), Interrupt (stop further writes), and SessionEnd (housekeeping).

If the screen differs, ask for a screenshot of Settings → Hooks and guide from the actual screen. Do not invent button labels. If the member skips approval, ordinary OS use can continue while automatic helpers remain unavailable. Do not nag on every message.

## Assistant checks after Done

Use the installed package's setup/doctor interface and the installation's admitted Python/runtime. Check actual discovery and trust, then genuine callbacks for the current build. Do not mark setup complete from the member's word or from file existence alone.

If trusted but not running, say: “The helpers are approved. Please start a new local chat in this same AI-Verse project and say ‘Check my AI-Verse setup.’ I will verify the connection there.” Preserve setup progress.

For recall verification, offer a harmless check whose actual tool result can be saved as setup history through Memory. In a separate fresh chat, retrieve and verify the exact canonical source. Do not fabricate lifecycle events, user preferences, history or owner receipts. Do not create/send to another chat without the member's authorization.

## Conversation behavior and updates

Automatic Stop follow-up messages are **off by default**. Review and useful writeback should happen in the original turn. A missed review is recorded for maintenance rather than forcing another message. There is no guarantee of an invisible review after every response.

An optional native scheduled review is a separate disclosed schedule. Explain its time, scope and how to disable it. Local reviews require the computer and app running. Keep notifications quiet unless there is a meaningful issue or a decision is needed.

If a member explicitly opts into Stop fallback, first explain: “Codex can add an automatic follow-up in this chat when a review is missed. It may look like a message from you, contains AI-Verse-generated instructions, and uses another Codex turn.” Never enable it silently.

After a code update, changed definitions may require trust again. Say: “AI-Verse updated its helpers. Open Settings → Hooks and review the changed items for this project, then say Done.” Do not edit trust records or use bypass flags in member setup.

## Installer integration

Distribution should verify the versioned package, invoke its install interface with the selected OS root and that project's admitted runtime metadata, then display this guidance and resume its existing setup flow. The package generates local paths; it ships no member state or trust. Public interface: install, setup, doctor, descriptor, remove. Package export is a maintainer action. The existing OS Distribution release must explicitly admit this component; the local package alone does not publish or change that release.
