#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  applyPurposeProfile,
  resolvePurposeProfile,
  sanitizeOwnerBackedOptionalDomains,
} from './purpose-context-profile.mjs';
import {
  PURPOSE_OPTIONAL_OWNER_BACKED_DOMAINS,
  PURPOSE_OPTIONAL_OWNER_BACKED_DOMAIN_NAMES,
} from './purpose-context-rich-domains.mjs';

const scope = 'workspace:client-a';
const base = {
  schema_version: '1.0',
  scope,
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'client-a' },
  goals: [{ id: 'goal-1' }],
  provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-09T00:00:00Z', owner_reads: [] },
};

assert.ok(PURPOSE_OPTIONAL_OWNER_BACKED_DOMAIN_NAMES.includes('infrastructure'));
assert.equal(
  PURPOSE_OPTIONAL_OWNER_BACKED_DOMAINS.infrastructure,
  'relevant_infrastructure_domain_present',
);

for (const domain of PURPOSE_OPTIONAL_OWNER_BACKED_DOMAIN_NAMES) {
  const reason = PURPOSE_OPTIONAL_OWNER_BACKED_DOMAINS[domain];
  const backed = structuredClone(base);
  backed[domain] = [{
    id: `${domain}-1`,
    statement: `Owner-backed ${domain}`,
    canonical_ref: { owner: 'ai-verse-data', scope, kind: domain, id: `${domain}-1`, version: '1' },
  }];

  assert.equal(sanitizeOwnerBackedOptionalDomains(backed)[domain].length, 1);
  assert.deepEqual(resolvePurposeProfile('workspace', 'auto', backed, [domain]), {
    requested: 'auto', resolved: 'workspace_rich', reasons: [reason],
  });
  assert.equal(domain in applyPurposeProfile(backed, { profile: 'basic' }), false);
  assert.equal(applyPurposeProfile(backed, { profile: 'rich' })[domain].length, 1);

  const unbacked = structuredClone(base);
  unbacked[domain] = [{ id: `invented-${domain}`, statement: 'No canonical evidence' }];
  assert.equal(domain in sanitizeOwnerBackedOptionalDomains(unbacked), false);
  assert.deepEqual(resolvePurposeProfile('workspace', 'auto', unbacked, [domain]), {
    requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'],
  });

  const crossScope = structuredClone(base);
  crossScope[domain] = [{
    id: `cross-${domain}`,
    source_refs: [{ owner: 'ai-verse-data', scope: 'workspace:client-b', kind: domain, id: `cross-${domain}` }],
  }];
  assert.equal(domain in sanitizeOwnerBackedOptionalDomains(crossScope), false);

  const malformed = structuredClone(base);
  malformed[domain] = [{
    id: `bad-${domain}`,
    source_refs: [{ owner: 'ai-verse-data', scope }],
  }];
  assert.equal(domain in sanitizeOwnerBackedOptionalDomains(malformed), false);

  const oversized = structuredClone(base);
  oversized[domain] = Array.from({ length: 80 }, (_, index) => ({
    id: `${domain}-${index}`,
    canonical_ref: { owner: 'ai-verse-data', scope, kind: domain, id: `${domain}-${index}` },
  }));
  assert.equal(sanitizeOwnerBackedOptionalDomains(oversized)[domain].length, 64);
}

// Workspace identities accepted by the OS schema must retain their same-scope evidence.
for (const id of ['a', 'client-a-', 'a'.repeat(127) + '-']) {
  const scoped = 'workspace:' + id;
  const ref = (kind, refId) => ({ owner: 'ai-verse-brain', scope: scoped, kind, id: refId });
  const envelope = {
    ...base, scope: scoped, identity: { kind: 'workspace', id },
    risks: [{ canonical_ref: ref('risk', 'risk-1') }],
    trajectory: [{ relation: 'advances', from_ref: ref('intent', 'goal'), to_ref: ref('intent', 'mission'), source_refs: [ref('intent', 'goal')] }],
  };
  const projected = applyPurposeProfile(envelope, { profile: 'rich' });
  assert.equal(projected.risks?.length, 1, 'valid workspace ' + id + ' lost risk evidence');
  assert.equal(projected.trajectory.length, 1, 'valid workspace ' + id + ' lost a relationship');
}
for (const scoped of ['workspace:bad.name', 'workspace:bad_name', 'workspace:../bad', 'workspace:-bad', 'workspace:' + 'a'.repeat(129)]) {
  const envelope = { ...base, scope: scoped, risks: [{ canonical_ref: { owner: 'ai-verse-data', scope: scoped, kind: 'risk', id: 'bad' } }] };
  assert.equal(sanitizeOwnerBackedOptionalDomains(envelope).risks, undefined);
}

 // Workspace identities accepted by the OS schema must retain their same-scope evidence.
 for (const id of ['a', 'client-a-', 'a'.repeat(127) + '-']) {
   const scoped = 'workspace:' + id;
   const ref = (kind, refId) => ({ owner: 'ai-verse-brain', scope: scoped, kind, id: refId });
   const envelope = {
     ...base, scope: scoped, identity: { kind: 'workspace', id },
     risks: [{ canonical_ref: ref('risk', 'risk-1') }],
     trajectory: [{ relation: 'advances', from_ref: ref('intent', 'goal'), to_ref: ref('intent', 'mission'), source_refs: [ref('intent', 'goal')] }],
   };
   const projected = applyPurposeProfile(envelope, { profile: 'rich' });
   assert.equal(projected.risks?.length, 1, 'valid workspace ' + id + ' lost risk evidence');
   assert.equal(projected.trajectory.length, 1, 'valid workspace ' + id + ' lost a relationship');
 }
 for (const scoped of ['workspace:bad.name', 'workspace:bad_name', 'workspace:../bad', 'workspace:-bad', 'workspace:' + 'a'.repeat(129)]) {
   const envelope = { ...base, scope: scoped, risks: [{ canonical_ref: { owner: 'ai-verse-data', scope: scoped, kind: 'risk', id: 'bad' } }] };
   assert.equal(sanitizeOwnerBackedOptionalDomains(envelope).risks, undefined);
 }

process.stdout.write('Purpose Context optional owner-backed rich domains: PASS\n');
