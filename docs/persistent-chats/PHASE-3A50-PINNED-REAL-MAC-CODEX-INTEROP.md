# Phase 3A.50: pin OS/Dashboard compatibility to verified native real Codex host

**Exact tested OS code head**
`b9fd150aad4678b104320ff4a6f1bdc5da473cca`.

The previous OS cross-repository CI job pinned the Dashboard's
3A.44/45 `/bin/sleep` code head. The macOS host now runs the real,
pinned official Codex 0.167.0 App Server without reading events.
Retaining the older pin would make OS compatibility CI **stale**.

The OS `pinned-current-native-owner-no-capture` job now pins exact
Dashboard code commit
`0b1c67c7a3cae8bc0627cb77e2c41f13d73ae5b8`,
which had already passed all five Dashboard CI workflows,
including the real native macOS Codex/XPC test.

The job verifies exact Git blob hashes of the current native host,
native child .h/.m, physical scope fence, XPC owner,
official macOS Codex download/checksum fixture, XPC packaging script,
Apple CI workflow, browser local-session source and no-capture
release checker. A source drift makes acceptance fail.

The job then invokes the Dashboard no-capture contract **from the
pinned checkout** and the OS v2 prospective event and production
writer-denial suites. The existing, older pinned Dashboard real
localhost pairing/revocation job is left intact.

## Verified GitHub results

[Two-job OS/Dashboard native-session compatibility run](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42900241121):
**PASS on exact tested OS code head**. Both older localhost-host
acceptance and new real-native-Codex source pin / OS event gate passed.

Also on this exact OS code commit:
[Repository QC](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42900240907)
**PASS** and
[pinned real Codex runtime](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42900240817)
**PASS**. The broader Four Repo Acceptance run
[42900242087](https://github.com/aiverse-filmmakers/AI-Verse-OS/actions/runs/42900242087)
was still in progress when this report was written and is not
included in the targeted acceptance claim.

The pinned Dashboard code commit passed
[Apple native Codex/XPC test](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/actions/runs/42899963616),
[Dashboard CI](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/actions/runs/42899963879)
and the other three Dashboard workflows on that exact code SHA.

## GitHub-only stopping point and actual next gate

Three valuable changes in this cycle closed real proof gaps:
1. Mac kernel-reported child **cwd** now matches the physical scope.
2. Native XPC host retains the **real official Codex App Server**
   binary in a scrubbed, disconnected, no-turn lifecycle.
3. OS pins and checks the **same** exact verified Dashboard head.

This completes the current **offline, non-capture GitHub acceptance
slice**, not the production Persistent Chats feature.

Next meaningful release work needs a *real installed and appropriately
signed Dashboard native host*, actual local operator authentication,
and inspection of first-party Codex event coverage on a user-controlled
Mac. Only once the host's identity and per-event provenance are
verified should the team design and test a **separately affirmative
prospective-only** consent issuer and encrypted owner-scoped archive
storage with retention, deletion, audit and Memory opt-in policy.

Production recording, historical import, archives and Memory must
stay OFF. Both PRs remain draft and unmerged.

No Google/GitHub CI fixture proves real human approval or Developer ID
signing acceptance, and no previous CI percentage should be treated as
a formal release or security score. This documentation was added
after the exact tested code head.
