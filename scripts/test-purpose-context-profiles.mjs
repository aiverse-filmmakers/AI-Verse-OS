#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPurposeProfile,
  composeProfiledPurposeContext,
  resolvePurposeProfile,
  sanitizeOwnerBackedOptionalDomains,
} from './purpose-context-profile.mjs';

function writeWorkspace(root, id, currentLines, extraManifest = []) {
  fs.mkdirSync(path.join(root, 'workspaces', id, 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), [
    'schema_version: "2.0"',
    `id: "${id}"`,
    `name: "${id}"`,
    'type: "product"',
    'status: "active"',
    `purpose: "Purpose for ${id}"`,
    ...extraManifest,
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'workspaces', id, 'context', 'CURRENT.md'), currentLines.join('\n'), 'utf8');
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-profiles-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });

  writeWorkspace(root, 'client-a', [
    '# Current Workspace Context', '',
    '## Objective', '', '- Ship the product', '',
    '## Current facts', '', '- Owner-backed current fact', '',
    '## Next useful actions', '', '- Finish the release', '',
  ], [
    'purpose_context:',
    '  profile: rich',
    '  enabled: true',
  ]);

  writeWorkspace(root, 'client-b', [
    '# Current Workspace Context', '',
    '## Objective', '', '- NEVER_LEAK_CLIENT_B_OBJECTIVE', '',
    '## Current facts', '', '- NEVER_LEAK_CLIENT_B_FACT', '',
    '## Next useful actions', '', '- NEVER_LEAK_CLIENT_B_ACTION', '',
  ]);

  return root;
}

const shell = {
  schema_version: '1.0',
  scope: 'workspace:client-a',
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'client-a' },
  goals: [{ id: 'goal-1' }],
  narratives: [{ id: 'narrative-1' }],
  kpis: [{ id: 'kpi-1' }],
  risks: [{
    id: 'risk-1',
    statement: 'Owner-backed risk',
    canonical_ref: { owner: 'ai-verse-brain', scope: 'workspace:client-a', kind: 'risk', id: 'risk-1', version: '7' },
  }],
  team_resources: [{
    id: 'resource-1',
    statement: 'Owner-backed team/resource fact',
    canonical_ref: { owner: 'ai-verse-data', scope: 'workspace:client-a', kind: 'resource', id: 'resource-1', version: '3' },
  }],
  customers: [{
    id: 'customer-1',
    statement: 'Owner-backed customer fact',
    canonical_ref: { owner: 'ai-verse-data', scope: 'workspace:client-a', kind: 'customer', id: 'customer-1', version: '2' },
  }],
  current_state: [{ id: 'state-1' }],
  provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-07T00:00:00Z', owner_reads: [] },
};

assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, []), {
  requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, ['kpis']), {
  requested: 'auto', resolved: 'workspace_rich', reasons: ['relevant_kpi_binding_present'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, ['risks']), {
  requested: 'auto', resolved: 'workspace_rich', reasons: ['relevant_risk_domain_present'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, ['team_resources']), {
  requested: 'auto', resolved: 'workspace_rich', reasons: ['relevant_team_resource_domain_present'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, ['customers']), {
  requested: 'auto', resolved: 'workspace_rich', reasons: ['relevant_customer_domain_present'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'basic', shell, ['kpis']), {
  requested: 'basic', resolved: 'workspace_basic', reasons: ['explicit_profile_request'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'rich', shell, []), {
  requested: 'rich', resolved: 'workspace_rich', reasons: ['explicit_profile_request'],
});
assert.deepEqual(resolvePurposeProfile('operator', 'auto', { scope_kind: 'operator' }, []), {
  requested: 'auto', resolved: 'operator_default', reasons: ['operator_scope'],
});
assert.throws(() => resolvePurposeProfile('workspace', 'enterprise', shell, []), /unsupported Purpose Context profile/);
assert.throws(() => resolvePurposeProfile('operator', 'rich', { scope_kind: 'operator' }, []), /apply only to workspace scopes/);

const unbackedRisks = structuredClone(shell);
unbackedRisks.risks = [{ id: 'invented-risk', statement: 'No canonical backing' }];
assert.equal('risks' in sanitizeOwnerBackedOptionalDomains(unbackedRisks), false);
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', unbackedRisks, ['risks']), {
  requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'],
});
const crossScopeRisks = structuredClone(shell);
crossScopeRisks.risks = [{
  id: 'cross-scope-risk',
  source_refs: [{ owner: 'ai-verse-brain', scope: 'workspace:client-b', kind: 'risk', id: 'risk-b' }],
}];
assert.equal('risks' in sanitizeOwnerBackedOptionalDomains(crossScopeRisks), false);
const malformedRiskRefs = structuredClone(shell);
malformedRiskRefs.risks = [{ id: 'bad-risk', source_refs: [{ owner: 'ai-verse-brain', scope: 'workspace:client-a' }] }];
assert.equal('risks' in sanitizeOwnerBackedOptionalDomains(malformedRiskRefs), false);

const unbackedResources = structuredClone(shell);
unbackedResources.team_resources = [{ id: 'invented-person', role: 'designer' }];
assert.equal('team_resources' in sanitizeOwnerBackedOptionalDomains(unbackedResources), false);
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', unbackedResources, ['team_resources']), {
  requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'],
});
const crossScopeResources = structuredClone(shell);
crossScopeResources.team_resources = [{
  id: 'other-workspace-resource',
  source_refs: [{ owner: 'ai-verse-data', scope: 'workspace:client-b', kind: 'resource', id: 'resource-b' }],
}];
assert.equal('team_resources' in sanitizeOwnerBackedOptionalDomains(crossScopeResources), false);
const oversizedResources = structuredClone(shell);
oversizedResources.team_resources = Array.from({ length: 80 }, (_, index) => ({
  id: `resource-${index}`,
  canonical_ref: { owner: 'ai-verse-data', scope: 'workspace:client-a', kind: 'resource', id: `resource-${index}` },
}));
assert.equal(sanitizeOwnerBackedOptionalDomains(oversizedResources).team_resources.length, 64);

const unbackedCustomers = structuredClone(shell);
unbackedCustomers.customers = [{ id: 'guessed-customer', name: 'Unverified account' }];
assert.equal('customers' in sanitizeOwnerBackedOptionalDomains(unbackedCustomers), false);
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', unbackedCustomers, ['customers']), {
  requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'],
});
const crossScopeCustomers = structuredClone(shell);
crossScopeCustomers.customers = [{
  id: 'other-workspace-customer',
  source_refs: [{ owner: 'ai-verse-data', scope: 'workspace:client-b', kind: 'customer', id: 'customer-b' }],
}];
assert.equal('customers' in sanitizeOwnerBackedOptionalDomains(crossScopeCustomers), false);
const oversizedCustomers = structuredClone(shell);
oversizedCustomers.customers = Array.from({ length: 80 }, (_, index) => ({
  id: `customer-${index}`,
  canonical_ref: { owner: 'ai-verse-data', scope: 'workspace:client-a', kind: 'customer', id: `customer-${index}` },
}));
assert.equal(sanitizeOwnerBackedOptionalDomains(oversizedCustomers).customers.length, 64);

const basic = applyPurposeProfile(shell, { profile: 'basic' });
assert.equal(basic.provenance.profile.resolved, 'workspace_basic');
assert.equal('narratives' in basic, false);
assert.equal('kpis' in basic, false);
assert.equal('risks' in basic, false);
assert.equal('team_resources' in basic, false);
assert.equal('customers' in basic, false);
assert.deepEqual(basic.goals, shell.goals);
assert.deepEqual(basic.current_state, shell.current_state);

const rich = applyPurposeProfile(shell, { profile: 'rich' });
assert.equal(rich.provenance.profile.resolved, 'workspace_rich');
assert.deepEqual(rich.kpis, shell.kpis);
assert.deepEqual(rich.risks, shell.risks);
assert.deepEqual(rich.team_resources, shell.team_resources);
assert.deepEqual(rich.customers, shell.customers);
const explicitRichUnbacked = applyPurposeProfile(unbackedCustomers, { profile: 'rich' });
assert.equal(explicitRichUnbacked.provenance.profile.resolved, 'workspace_rich');
assert.equal('customers' in explicitRichUnbacked, false);

const root = makeRoot();
try {
  const projection = composeProfiledPurposeContext(root, 'workspace:client-a', {
    profile: 'auto',
    now: '2026-10-07T00:00:00Z',
  });
  assert.equal(projection.scope, 'workspace:client-a');
  assert.equal(projection.provenance.profile.requested, 'auto');
  assert.equal(projection.provenance.profile.resolved, 'workspace_basic');
  assert.deepEqual(projection.provenance.profile.reasons, ['workspace_default_basic']);

  // Slice 2.3 explicitly froze no persisted Purpose config in WORKSPACE.yaml.
  // Even a misleading unknown block cannot opt the workspace into rich mode.
  assert.equal('narratives' in projection, false);
  assert.equal('kpis' in projection, false);
  assert.equal('risks' in projection, false);
  assert.equal('team_resources' in projection, false);
  assert.equal('customers' in projection, false);

  const explicitRich = composeProfiledPurposeContext(root, 'workspace:client-a', {
    profile: 'rich',
    now: '2026-10-07T00:00:00Z',
  });
  assert.equal(explicitRich.provenance.profile.resolved, 'workspace_rich');
  // No current canonical owner exposes these optional domains, so rich mode omits them cleanly.
  assert.equal('risks' in explicitRich, false);
  assert.equal('team_resources' in explicitRich, false);
  assert.equal('customers' in explicitRich, false);

  // Reading client-a must never enumerate or ingest sibling client-b state.
  const serializedA = JSON.stringify(explicitRich);
  assert.equal(serializedA.includes('NEVER_LEAK_CLIENT_B'), false);
  assert.equal(serializedA.includes('workspace:client-b'), false);
  assert.equal(serializedA.includes('client-b'), false);

  const projectionB = composeProfiledPurposeContext(root, 'workspace:client-b', {
    profile: 'rich',
    now: '2026-10-07T00:00:00Z',
  });
  assert.equal(JSON.stringify(projectionB).includes('NEVER_LEAK_CLIENT_B_FACT'), true);
  assert.equal(JSON.stringify(projectionB).includes('Ship the product'), false);

  process.stdout.write('Purpose Context workspace profiles: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
