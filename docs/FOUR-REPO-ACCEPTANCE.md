# Final Four-Repo Acceptance Matrix

This document is the reproducible acceptance contract for audit item 19 / 19. It proves that the four independently owned repositories compose as one local-first system without merging their canonical responsibilities.

## Audited revision set

| Component | Repository | Audited commit | Role in the composition |
|---|---|---|---|
| AI-Verse OS | `aiverse-filmmakers/AI-Verse-OS` | host commit under test | canonical workspace, routing, provider discovery, permission floor |
| AI-Verse Memory | `aiverse-filmmakers/AI-Verse-Memory` | `b2a31fda9994af77788ecf16caa02912dcaf0598` | scoped canonical-context indexing and semantic/historical recall |
| AI-Verse Brain | `aiverse-filmmakers/AI-Verse-Brain` | `2a4a78dd5d0b08ffa2d1cd9a84cdfed697fa6de8` | intent, cognition, policy, planning and verified completion |
| AI-Verse Skills | `aiverse-filmmakers/AI-Verse-Skills` | `558bbcb05ce9f42bb5be30730ea205a7e791bf86` | external immutable capability provider and execution evidence |

The workflow checks out the OS commit being tested and explicitly detaches each external repository at the audited SHA above. A SHA mismatch fails the run before integration starts.

The Memory revision above includes the semantic-recall interoperability repair discovered by this matrix: bounded FTS candidate generation now preserves later task-specific signals from Brain-style semantic queries rather than considering only an early generic prefix.

## Acceptance matrix

| Row | Contract | Required proof |
|---:|---|---|
| 1 | Revision lock | Memory, Brain and Skills clones resolve to the exact audited commits; OS reports its exact checkout SHA. |
| 2 | Native Memory composition | Memory installs into an OS v2 host, registers locally, materializes its runtime adapters, and leaves tracked OS files clean. |
| 3 | Native Brain composition | Brain is explicitly registered as supported and enabled by the OS test host, then initializes only Brain-owned/native state. |
| 4 | External Skills composition | Skills installs outside the OS tree; OS discovers the real provider, selects a real capability, and preserves exact generation/digest identity. |
| 5 | Strategic ownership + all-four runtime data flow | OS starts as direction owner, explicitly hands its existing priority to Brain with confirmed provenance, then one Brain scheduled-orientation tick reads real OS current context, retrieves real Memory history through the installed public Memory surface, receives real OS-discovered Skills candidates, ranks them, and returns useful deterministic orientation without dispatching actions or notifications. |
| 6 | Memory isolation under composition | Workspace-scoped recall still excludes unrelated workspace memory after Brain and Skills are present. |
| 7 | OS + Brain permission intersection | An OS denial blocks an action even when Brain policy would allow it; no host effect occurs. |
| 8 | Ownership / cleanliness | Skills remains external, Memory registration remains local, Brain state remains in its owned/native paths, and the OS tracked tree is clean after ephemeral fixtures are restored. |

## End-to-end scenario

The decisive row is the strategic-ownership and all-four runtime data-flow test. It uses one ephemeral AI-Verse OS checkout and performs these operations in order:

1. install the audited Memory commit natively into the OS host;
2. register and initialize the audited Brain commit under the explicit OS extension contract;
3. install the audited Skills commit into an external immutable-generation root;
4. ask the OS capability resolver to discover and select `aiverse-skills:whisper` from that real external generation;
5. write a real operator Memory record about an `Aurora` release and a matching OS-owned current-priority file;
6. prove OS initially owns strategic direction, then explicitly hand that priority to Brain with confirmed import/provenance;
7. run Brain `scheduled_orientation` through a host adapter that reads OS context, calls the installed public Memory entrypoint for history, and supplies the OS-discovered Skills candidates;
8. assert Brain receives the Memory record with source identity/version metadata and the Skills capability with generation/digest identity;
9. assert Brain's generated retrieval queries contain the real task signals rather than internal labels such as `gap_analysis`;
10. assert the tick performs no external action and no implicit notification.

This is intentionally a composition test, not a duplicate implementation. OS remains the host/source-of-truth layer, Memory remains a scoped engine, Brain remains the intelligence/policy layer, and Skills remains an external capability provider.

## Running the proof

GitHub Actions workflow:

```text
.github/workflows/four-repo-acceptance.yml
```

It runs on pull requests, pushes to `main`, and manual dispatch. A release or publishing decision should treat the matrix as passed only when the workflow succeeds on the exact merged `main` commit being published.
