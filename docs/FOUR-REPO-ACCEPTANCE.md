# Final Four-Repo Acceptance Matrix

This document is the reproducible acceptance contract for audit item 19 / 19. It proves that the four independently owned repositories compose as one local-first system without merging their canonical responsibilities.

## Audited revision set

| Component | Repository | Audited commit | Role in the composition |
|---|---|---|---|
| AI-Verse OS | `aiverse-filmmakers/AI-Verse-OS` | host commit under test | canonical workspace, routing, provider discovery, permission floor |
| AI-Verse Memory | `aiverse-filmmakers/AI-Verse-Memory` | `65c4ad09cb29382aaebda47164440da321caf517` | scoped canonical-context indexing and semantic/historical recall |
| AI-Verse Brain | `aiverse-filmmakers/AI-Verse-Brain` | `2e960f2ef9cc169a0a8dd67a562edfeea75c8e7c` | intent, cognition, policy, planning and verified completion |
| AI-Verse Skills | `aiverse-filmmakers/AI-Verse-Skills` | `558bbcb05ce9f42bb5be30730ea205a7e791bf86` | external immutable capability provider and execution evidence |

The workflow checks out the OS commit being tested and explicitly detaches each external repository at the audited SHA above. A SHA mismatch fails the run before integration starts.

The Memory revision above includes both the semantic-recall interoperability repair and the ownership-aware canonical-context repair: Brain-owned scopes cannot reactivate frozen OS strategy through Memory recall, and ownership changes invalidate current-context indexing even when `CURRENT.md` bytes do not change.

## Acceptance matrix

| Row | Contract | Required proof |
|---:|---|---|
| 1 | Revision lock | Memory, Brain and Skills clones resolve to the exact audited commits; OS reports its exact checkout SHA. |
| 2 | Native Memory composition | Memory installs into an OS v2 host, registers locally, materializes its runtime adapters, and leaves tracked OS files clean. |
| 3 | Native Brain composition | Brain is explicitly registered as supported and enabled by the OS test host, then initializes only Brain-owned/native state. |
| 4 | External Skills composition | Skills installs outside the OS tree; OS discovers the real provider, selects a real capability, and preserves exact generation/digest identity. |
| 5 | Supported four-component host | Brain selects the maintained OS JSON-subprocess host adapter. Through that same public interface it reads ownership-aware OS context, retrieves real Memory history, receives OS-resolved Skills capabilities, executes one harmless generation-pinned local capability read, validates the Skills v2 receipt, and proves OS permission denial. |
| 6 | Memory isolation under composition | Workspace-scoped recall still excludes unrelated workspace memory after Brain and Skills are present. |
| 7 | Permission + generation race safety | An OS denial blocks an action even when Brain policy would allow it, and a Skills active-generation change after execution pinning cannot move the in-flight action to the newer generation. |
| 8 | Ownership / cleanliness | Skills remains external, Memory registration remains local, Brain state remains in its owned/native paths, and the OS tracked tree is clean after ephemeral fixtures are restored. |

## End-to-end scenario

The decisive row now exercises the same maintained host adapter supplied to users. It uses one ephemeral AI-Verse OS checkout and performs these operations in order:

1. install the audited Memory commit natively into the OS host;
2. register and initialize the audited Brain commit under the explicit OS extension contract;
3. install the audited Skills commit into an external immutable-generation root;
4. ask the OS capability resolver to discover and select `aiverse-skills:whisper` from that real external generation;
5. generate a Brain bridge configuration for `scripts/ai_verse_host_adapter.py` and select it through Brain's public `--host-adapter` path;
6. write a real operator Memory record and an OS-owned current-priority file, then hand strategic direction explicitly to Brain;
7. verify the adapter reads ownership-aware OS context, preserving operational state while excluding frozen OS strategy, and retrieves the real Memory record;
8. run one Brain orientation tick through the maintained adapter and verify Memory history reaches Brain without implicit action or notification;
9. execute the harmless `read_local / capability.read_instructions` path with the exact OS-selected capability ID, Skills generation, and package digest;
10. require the adapter to pin that immutable Skills generation, validate the resulting `aiverse-execution-receipt-v2` with Skills' semantic validator, and require Brain to verify and translate the exact receipt binding;
11. prove an OS policy denial blocks an otherwise Brain-allowed action through the same adapter;
12. switch the active Skills generation after an execution has pinned the old generation and verify the in-flight result and receipt remain bound to the pinned generation;
13. re-run Memory workspace-isolation and tracked-tree cleanliness assertions.

This remains composition rather than duplicated ownership. OS is the host, scope, resolver, and permission boundary; Memory owns scoped recall; Brain owns cognition, policy intersection, approvals, and objective verification; Skills owns immutable capability generations and receipt semantics.

The supported execution proof is deliberately harmless and local. It proves discover -> authorize -> pin -> invoke -> receipt verification through the public interface. It does not claim that every external capability is automatically executable without its own runtime support, live readiness, permissions, approvals, and effect verification.

## Running the proof

Maintained implementation and acceptance:

```text
scripts/ai_verse_host_adapter.py
scripts/test-ai-verse-host-adapter.py
.github/workflows/four-repo-acceptance.yml
```

See also [`FOUR-COMPONENT-HOST-ADAPTER.md`](FOUR-COMPONENT-HOST-ADAPTER.md) for end-user configuration and usage.

It runs on pull requests, pushes to `main`, and manual dispatch. A release or publishing decision should treat the matrix as passed only when the workflow succeeds on the exact merged `main` commit being published.
