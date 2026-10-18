---
name: version
description: Use when someone asks which AI-Verse OS/Core version is installed, whether it is current, or what the latest accepted member release is. Run the read-only OS version reporter and explain its result simply.
version: 1.0.0
---

# AI-Verse OS version

Use `/version` for requests such as “what version am I on?”, “is AI-Verse up to date?”, or “what is the latest accepted release?”.

Run the reporter from the AI-Verse OS root:

```bash
node scripts/os-version.mjs
```

Use `node scripts/os-version.mjs --json` only when a structured result is needed. Summarize the installed OS version, latest accepted OS version, and status in plain language. The check is read-only and never runs an update.

The reporter reads the installed Core receipt and non-mutating update plan from Distribution, then checks Distribution's public GitHub release catalog and the exact OS descriptor pinned by its current accepted Core release. “Latest” means the latest accepted member Core release. GitHub `main`, tags, unreleased candidates, and stale local refs are not substitutes.

If Distribution status is missing, report the installed version as unverified. If GitHub's release catalog is unavailable or malformed, report the latest version as unknown and retain any locally verified installed revision. If the accepted catalog is valid but its component descriptor disagrees, report the accepted source revision and mark only the friendly version label unverified. Never guess, request credentials, upload member data, or change files. When a newer accepted version exists, tell the member that the normal “Update AI-Verse” workflow is the way to preview/apply it; do not perform that action from `/version`.
