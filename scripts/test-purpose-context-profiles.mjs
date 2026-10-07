#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPurposeProfile,
  composeProfiledPurposeContext,
  resolvePurposeProfile,
} from './purpose-context-profile.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-profiles-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'client-a', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'client-a', 'WORKSPACE.yaml'), [
    'schema_version: "2.0"',
    'id: "client-a"',
    'name: "Client A"',
    'type: "product"',
    'status: "active"',
    'purpose: "Ship the product"',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'workspaces', 'client-a', 'context', 'CURRENT.md'), [
    '# Current Workspace Context', '',
    '## Objective', '', '- Ship the product', '',
    '## Current facts', '', '- Owner-backed current fact', '',
    '## Next useful actions', '', '- Finish the release', '',
  ].join('\n'), 'utf8');
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
  risks: [{ id: 'risk-1' }],
  current_state: [{ id: 'state-1' }],
  provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-07T00:00:00Z', owner_reads: [] },
};

assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, []), {
  requested: 'auto', resolved: 'workspace_basic', reasons: ['workspace_default_basic'],
});
assert.deepEqual(resolvePurposeProfile('workspace', 'auto', shell, ['kpis']), {
  requested: 'auto', resolved: 'workspace_rich', reasons: ['relevant_kpi_binding_present'],
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

const basic = applyPurposeProfile(shell, { profile: 'basic' });
assert.equal(basic.provenance.profile.resolved, 'workspace_basic');
assert.equal('narratives' in basic, false);
assert.equal('kpis' in basic, false);
assert.equal('risks' in basic, false);
assert.deepEqual(basic.goals, shell.goals);
assert.deepEqual(basic.current_state, shell.current_state);

const rich = applyPurposeProfile(shell, { profile: 'rich' });
assert.equal(rich.provenance.profile.resolved, 'workspace_rich');
assert.deepEqual(rich.kpis, shell.kpis);
assert.deepEqual(rich.risks, shell.risks);

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

  const explicitRich = composeProfiledPurposeContext(root, 'workspace:client-a', {
    profile: 'rich',
    now: '2026-10-07T00:00:00Z',
  });
  assert.equal(explicitRich.provenance.profile.resolved, 'workspace_rich');

  process.stdout.write('Purpose Context workspace profiles: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
