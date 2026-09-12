# Five-Component First Member Beta Install

**Freeze date:** 2026-09-13  
**Status:** Frozen first-member beta  
**Rule:** Use the exact commit SHAs below. Do not substitute `main` if you want the tested release.

## Frozen component revisions

| Component | Repository | Immutable release ref |
|---|---|---|
| AI-Verse OS | `aiverse-filmmakers/AI-Verse-OS` | `89fb9043ec58c05931d477ef3e154df428a06c22` |
| AI-Verse Brain | `aiverse-filmmakers/AI-Verse-Brain` | `bef8261ad35d126d29aeff5d496f46904125b7b6` |
| AI-Verse Memory | `aiverse-filmmakers/AI-Verse-Memory` | `f5b417f9e7ce1b3f05bc80d10a483d10f6ad10ee` |
| AI-Verse Skills | `aiverse-filmmakers/AI-Verse-Skills` | `3ab838e6e64561bbb7cea8f85d0ebc75b9e84337` |
| AI-Verse Data | `aiverse-filmmakers/AI-Verse-Data` | `189b13264ab86115d2f21fee3ba8cd5a8dac6581` |

These full Git commit IDs are the release artifacts. Moving `main` branches are development channels.

## Requirements

- Git
- Node.js 22+ for the complete five-component beta
- Python 3.9+
- macOS, Linux, or Windows

Use an absolute path for `<OS_ROOT>` in the commands below.

## 1. Install the frozen OS

```bash
git clone https://github.com/aiverse-filmmakers/AI-Verse-OS.git
git -C AI-Verse-OS checkout --detach 89fb9043ec58c05931d477ef3e154df428a06c22
```

Set `<OS_ROOT>` to the absolute path of that `AI-Verse-OS` directory.

The OS can run by itself. Optional components may be added before or after host configuration.

## 2. Install and attach Brain

```bash
git clone https://github.com/aiverse-filmmakers/AI-Verse-Brain.git
git -C AI-Verse-Brain checkout --detach bef8261ad35d126d29aeff5d496f46904125b7b6
python -m pip install -e ./AI-Verse-Brain
ai-verse-brain attach <OS_ROOT> --apply
ai-verse-brain init <OS_ROOT> --apply
```

Attachment does not automatically transfer strategic ownership to Brain.

## 3. Install and attach Memory

```bash
git clone https://github.com/aiverse-filmmakers/AI-Verse-Memory.git
git -C AI-Verse-Memory checkout --detach f5b417f9e7ce1b3f05bc80d10a483d10f6ad10ee
python AI-Verse-Memory/scripts/install.py --target <OS_ROOT> --source-dir AI-Verse-Memory
```

If a standalone Memory project existed before OS, do not copy or overwrite it into the OS root. Attach native Memory first, then use the explicit `migrate-legacy --source-root <old-project>` path. The old standalone store remains untouched.

## 4. Install the frozen Skills provider

Clone and pin the distribution:

```bash
git clone https://github.com/aiverse-filmmakers/AI-Verse-Skills.git
git -C AI-Verse-Skills checkout --detach 3ab838e6e64561bbb7cea8f85d0ebc75b9e84337
```

macOS/Linux:

```bash
cd AI-Verse-Skills
./aiverse-skills install
./aiverse-skills doctor --readiness
cd ..
```

Windows PowerShell:

```powershell
Set-Location AI-Verse-Skills
.\aiverse-skills.ps1 install
.\aiverse-skills.ps1 doctor --readiness
Set-Location ..
```

Skills installs outside the OS repository under the canonical external provider root. The OS discovers the installed immutable generation and does not require the Skills source checkout during normal host execution.

## 5. Install and attach Data

```bash
git clone https://github.com/aiverse-filmmakers/AI-Verse-Data.git
git -C AI-Verse-Data checkout --detach 189b13264ab86115d2f21fee3ba8cd5a8dac6581
cd AI-Verse-Data
npm install --ignore-scripts
npm run build
node dist/src/cli.js install --root <OS_ROOT>
cd ..
```

Data installation attaches the runtime but does not silently initialize a workspace database. Workspace Data initialization remains explicit.

## 6. Create the generic host configuration

```bash
python <OS_ROOT>/scripts/ai_verse_host_adapter.py \
  --root <OS_ROOT> \
  --write-config <OS_ROOT>/.aiverse/brain-host.json
```

The same host configuration dynamically discovers optional Memory, Skills, Data, and Connections as they become available. It does not need to be regenerated merely because an optional component was installed later.

## 7. Run the release doctors

```bash
node <OS_ROOT>/scripts/components.mjs doctor --root <OS_ROOT>
ai-verse-brain doctor <OS_ROOT>
python <OS_ROOT>/scripts/ai-verse-memory/memory.py --root <OS_ROOT> doctor
node AI-Verse-Data/dist/src/cli.js doctor --root <OS_ROOT>
```

Run the Skills doctor from its pinned checkout if needed:

```bash
cd AI-Verse-Skills
./aiverse-skills doctor --readiness
cd ..
```

On Windows, use `.\aiverse-skills.ps1 doctor --readiness`.

## What this release has already proven

The final release gate passed all three tested optional-component installation orders:

1. Brain -> Memory -> Skills -> Data
2. Data -> Brain -> Skills -> Memory
3. Skills -> Data -> Memory -> Brain

It also proved:

- host configuration can exist before optional components and discover them later;
- Memory recall works through the composed host;
- Skills resolves from the immutable external provider;
- Data supports structured read-only host queries;
- Connections metadata is discovered without exposing credentials;
- Data disable, update, re-enable preserves canonical records;
- Brain cannot detach while it owns strategic direction;
- explicit Brain -> OS handback works;
- Brain, Memory, and Data detach/reinstall preserve canonical state;
- component doctors pass;
- optional-component lifecycle does not mutate tracked OS files.

## Verification evidence

Data final candidate:

- CI `34721678725`: success, 6/6 Node 22/24 x Linux/macOS/Windows
- Release Smoke `34721678727`: success
- Five-Component Release Acceptance `34721678782`: success, 3/3 install orders

Data post-merge main:

- CI `34721902478`: success, 6/6 matrix jobs

The other four frozen revisions and their verification runs are recorded in `docs/FIVE-COMPONENT-RELEASE-STATUS.md`.

## Beta distribution policy

This freeze does not create or modify software license rights. Existing repository and package license metadata remains authoritative.

For the controlled first-member beta, install only from the exact refs above. Do not redistribute components beyond the rights already granted by their existing licenses. Broader public/commercial distribution policy for components whose top-level license remains unresolved is a separate owner decision and does not change this tested technical freeze.
