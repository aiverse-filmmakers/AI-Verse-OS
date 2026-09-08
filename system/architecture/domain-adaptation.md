# Domain Adaptation

AI-Verse OS is universal because the core is domain-neutral, not because every domain is treated the same.

The system should become more specialized as it learns the operator's real work while preserving the universal architecture underneath.

## Adaptation sequence

When a new domain appears:

1. **Observe:** identify terminology, entities, goals, constraints, sources, outputs, and quality standards from evidence.
2. **Scope:** decide which workspace owns the domain-specific state.
3. **Model:** create workspace-local knowledge, vocabulary, policies, schemas, or templates only when useful.
4. **Connect:** document authoritative systems and sources without storing secrets.
5. **Operationalize:** turn repeated reliable work into local skills, scripts, or automations.
6. **Validate:** add domain-appropriate quality gates and approval rules.
7. **Promote:** move knowledge or capabilities to shared layers only when reuse justifies it.

## Do not pre-bake professions

The public template should not assume folders such as:

```text
medicine/
software/
filmmaking/
marketing/
legal/
finance/
```

Those may become valid user-created knowledge namespaces later. They are not universal core layers.

## Vocabulary

A workspace may maintain its own glossary, ontology, entity definitions, file conventions, schemas, and source hierarchy.

Do not force unfamiliar work into generic business language. Learn the operator's own terms and the domain's accepted terms from authoritative sources.

## Local-first specialization

New domain-specific structure should begin inside the workspace that needs it.

Example pattern:

```text
workspaces/<id>/
  knowledge/
  assets/
  skills/
  automations/
```

Only promote upward after real reuse.

## High-stakes domains

Some domains require stricter behavior. When work can materially affect health, safety, finances, legal rights, security, regulated records, or other high-consequence outcomes:

- increase evidence requirements
- preserve provenance
- use authoritative/current sources
- narrow permissions
- add human review
- avoid unsupported autonomous actions
- record important decisions and uncertainty

The architecture is universal. The approval and verification policy should adapt to consequence.

## Evolution without fragmentation

Specialization should not produce a new operating system for every domain. The same routing, source-of-truth, lifecycle, and workspace contracts remain in force.

That is the central rule: **specialize the content and policies, not the fundamental architecture.**
