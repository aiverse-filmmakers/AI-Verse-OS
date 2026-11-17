import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { evaluateActionPermission } from './action-permission.mjs';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-os-permission-'));
  fs.mkdirSync(path.join(root, 'operator'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(root, 'automations', 'policies'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n', 'utf8');
  return root;
}

function request(actionClass, scope = 'operator', tag = '') {
  return {
    request_id: `request-${tag || actionClass}`,
    action_class: actionClass,
    scope,
    operation: 'test',
    parameters: {},
    idempotency_key: `idem-${tag || actionClass}`,
    in_scope: true,
    within_budget: true,
    reversible: true,
    reason: 'permission acceptance test',
    created_at: '2026-09-10T00:00:00Z',
    request_fingerprint: crypto.createHash('sha256').update(`${actionClass}|${scope}|${tag}`).digest('hex'),
  };
}

function writeOperatorPolicy(root, values) {
  const lines = ['schema_version: "1.0"', 'approval:'];
  for (const [key, value] of Object.entries(values)) lines.push(`  ${key}: "${value}"`);
  fs.writeFileSync(path.join(root, 'automations', 'policies', 'action-permissions.yaml'), `${lines.join('\n')}\n`, 'utf8');
}

function writeWorkspace(root, id, { status = 'active', approval = {}, manifestId = id } = {}) {
  const dir = path.join(root, 'workspaces', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    'schema_version: "2.0"',
    `id: "${manifestId}"`,
    `name: "${id}"`,
    'type: "test"',
    `status: "${status}"`,
    'purpose: "permission test"',
    'approval:',
  ];
  for (const [key, value] of Object.entries(approval)) lines.push(`  ${key}: "${value}"`);
  fs.writeFileSync(path.join(dir, 'WORKSPACE.yaml'), `${lines.join('\n')}\n`, 'utf8');
}

function evaluate(root, actionClass, scope = 'operator', tag = '') {
  return evaluateActionPermission({ osRoot: root, request: request(actionClass, scope, tag) });
}

{
  const root = tempRoot();
  const result = evaluate(root, 'send_message');
  assert.equal(result.decision, 'approval_required');
  assert.equal(result.source, 'ai-verse-os/action-permission-v1');
  assert.equal(result.action_class, 'send_message');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'allow',
    destructive_actions: 'confirm',
    high_stakes_decisions: 'human-review',
  });
  assert.equal(evaluate(root, 'send_message').decision, 'allow');
  assert.equal(evaluate(root, 'read_connected').decision, 'allow');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'deny',
    destructive_actions: 'confirm',
    high_stakes_decisions: 'human-review',
  });
  writeWorkspace(root, 'project-one', { approval: { external_actions: 'allow' } });
  assert.equal(evaluate(root, 'send_message', 'workspace:project-one').decision, 'deny');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'allow',
    destructive_actions: 'allow',
    high_stakes_decisions: 'allow',
  });
  writeWorkspace(root, 'project-two', { approval: { external_actions: 'deny' } });
  assert.equal(evaluate(root, 'send_message', 'workspace:project-two').decision, 'deny');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'allow',
    destructive_actions: 'allow',
    high_stakes_decisions: 'allow',
  });
  writeWorkspace(root, 'project-three', { approval: { external_actions: 'confirm' } });
  assert.equal(evaluate(root, 'create_commit_or_pr', 'workspace:project-three').decision, 'approval_required');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'allow',
    destructive_actions: 'allow',
    high_stakes_decisions: 'human-review',
  });
  assert.equal(evaluate(root, 'spend_money').decision, 'approval_required');
  assert.equal(evaluate(root, 'security_sensitive').decision, 'approval_required');
}

for (const status of ['paused', 'archived']) {
  const root = tempRoot();
  writeWorkspace(root, `workspace-${status}`, { status });
  assert.equal(evaluate(root, 'read_local', `workspace:workspace-${status}`).decision, 'deny');
}

{
  const root = tempRoot();
  assert.equal(evaluate(root, 'send_message', 'workspace:missing').decision, 'deny');
}

{
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, 'automations', 'policies', 'action-permissions.yaml'),
    'schema_version: "1.0"\napproval:\n  external_actions: "magic"\n',
    'utf8',
  );
  const result = evaluate(root, 'send_message');
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /failed closed/);
}

{
  const root = tempRoot();
  writeWorkspace(root, 'expected-id', { manifestId: 'different-id' });
  assert.equal(evaluate(root, 'send_message', 'workspace:expected-id').decision, 'deny');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'deny',
    destructive_actions: 'deny',
    high_stakes_decisions: 'deny',
  });
  assert.equal(evaluate(root, 'write_local_reversible').decision, 'allow');
  assert.equal(evaluate(root, 'modify_canonical_state').decision, 'allow');
}

{
  const root = tempRoot();
  writeOperatorPolicy(root, {
    external_actions: 'allow',
    destructive_actions: 'allow',
    high_stakes_decisions: 'allow',
  });
  writeWorkspace(root, 'safe-defaults', { approval: { external_actions: 'allow' } });
  // A permissive operator policy cannot erase a missing workspace destructive/high-stakes floor.
  assert.equal(evaluate(root, 'delete_data', 'workspace:safe-defaults').decision, 'approval_required');
  assert.equal(evaluate(root, 'high_stakes_domain_action', 'workspace:safe-defaults').decision, 'approval_required');
}


{
  const root = tempRoot();
  const payload = request('read_local', 'operator', 'cli-entrypoint');
  const invoked = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'action-permission.mjs'), '--root', root],
    { input: JSON.stringify(payload), encoding: 'utf8', shell: false },
  );
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.ok(invoked.stdout.trim(), 'CLI invocation must emit a JSON response');
  const result = JSON.parse(invoked.stdout);
  assert.equal(result.decision, 'allow');
  assert.equal(result.request_fingerprint, payload.request_fingerprint);
}

{
  // Pins the by-design behaviour: the OS does not gate local work (the agent host
  // does), and gates only outside actions, Data writes and deletions.
  const root = tempRoot();
  for (const cls of ['read_local', 'write_local_reversible', 'modify_canonical_state']) {
    assert.equal(evaluate(root, cls, 'operator', `pin-${cls}`).decision, 'allow', `${cls} must be allowed by design`);
  }
  for (const cls of ['external_write_reversible', 'send_message', 'delete_data']) {
    assert.notEqual(evaluate(root, cls, 'operator', `pin-${cls}`).decision, 'allow', `${cls} must stay gated`);
  }
}

{
  // Fail closed: local classes are open by design, but invalid state still denies them.
  const localClasses = ['read_local', 'write_local_reversible', 'modify_canonical_state'];
  const bad = tempRoot();
  fs.writeFileSync(path.join(bad, 'automations', 'policies', 'action-permissions.yaml'), 'approval: [not valid\n  : :', 'utf8');
  for (const cls of localClasses) assert.equal(evaluate(bad, cls, 'operator', `bad-${cls}`).decision, 'deny', `${cls} must fail closed on a malformed policy`);
  const badWs = tempRoot();
  writeWorkspace(badWs, 'ws-x', { manifestId: 'other' });
  for (const cls of localClasses) assert.equal(evaluate(badWs, cls, 'workspace:ws-x', `ws-${cls}`).decision, 'deny', `${cls} must fail closed on an invalid manifest`);
}

console.log('Action permission acceptance tests: PASS');
