#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'workspace-owner.mjs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-workspace-owner-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'workspaces', '_template'), { recursive: true });
  return root;
}

function request(overrides = {}) {
  return {
    workspace: {
      id: 'client-a',
      name: 'Client A',
      type: 'client',
      purpose: 'Keep Client A work isolated.',
      domains: ['video'],
      canonical_sources: ['source://client-a'],
      ...(overrides.workspace ?? {}),
    },
    evidence: {
      substantial_scope: true,
      boundary_clear: true,
      reason: 'Repeated meaningful work for Client A has established a clear durable scope.',
      ...(overrides.evidence ?? {}),
    },
    authority: {
      permission_expansion: false,
      privacy_ambiguous: false,
      new_connection: false,
      new_credential: false,
      ...(overrides.authority ?? {}),
    },
    provenance: {
      trigger_ref: 'run:test-1',
      classifier: 'test-classifier',
      source: 'gateway-post-task',
      ...(overrides.provenance ?? {}),
    },
  };
}

function run(root, payload) {
  const out = spawnSync(process.execPath, [script, 'ensure', '--root', root], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  let json = null;
  if (out.stdout.trim()) {
    try { json = JSON.parse(out.stdout); } catch {}
  }
  return { ...out, json };
}

const root = makeRoot();
try {
  const other = path.join(root, 'workspaces', 'other');
  fs.mkdirSync(path.join(other, 'context'), { recursive: true });
  const otherManifest = [
    'schema_version: "2.0"',
    'id: "other"',
    'name: "Other"',
    'type: "project"',
    'status: "active"',
    'domains: []',
    'purpose: "Unrelated"',
    'owners: []',
    'success_criteria: []',
    'current_context: "context/CURRENT.md"',
    'canonical_sources: []',
    'connections: []',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(other, 'WORKSPACE.yaml'), otherManifest, 'utf8');
  fs.writeFileSync(path.join(other, 'context', 'CURRENT.md'), '# Other\n', 'utf8');

  let r = run(root, request());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'created');
  assert.equal(r.json.changed, true);
  assert.equal(r.json.user_confirmation_required, false);
  assert.equal(r.json.permission_expanded, false);
  assert.equal(r.json.connection_created, false);
  assert.equal(r.json.automation_created, false);
  assert.equal(r.json.permanent_bot_created, false);

  const clientRoot = path.join(root, 'workspaces', 'client-a');
  assert.equal(fs.existsSync(path.join(clientRoot, 'WORKSPACE.yaml')), true);
  assert.equal(fs.existsSync(path.join(clientRoot, 'context', 'CURRENT.md')), true);
  assert.equal(fs.existsSync(path.join(clientRoot, 'context', 'AUTO-ORGANIZATION.json')), true);
  let manifest = fs.readFileSync(path.join(clientRoot, 'WORKSPACE.yaml'), 'utf8');
  assert.match(manifest, /connections: \[\]/);
  assert.match(manifest, /external_actions: "confirm"/);
  assert.match(manifest, /destructive_actions: "confirm"/);
  assert.match(manifest, /high_stakes_decisions: "human-review"/);
  assert.match(manifest, /automations: \[\]/);
  assert.equal(fs.readFileSync(path.join(other, 'WORKSPACE.yaml'), 'utf8'), otherManifest);

  let provenance = JSON.parse(fs.readFileSync(path.join(clientRoot, 'context', 'AUTO-ORGANIZATION.json'), 'utf8'));
  assert.equal(provenance.history.length, 1);
  assert.match(provenance.history[0].reason, /Repeated meaningful work/);

  r = run(root, request());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'existing');
  assert.equal(r.json.changed, false);
  provenance = JSON.parse(fs.readFileSync(path.join(clientRoot, 'context', 'AUTO-ORGANIZATION.json'), 'utf8'));
  assert.equal(provenance.history.length, 1, 'idempotent replay must not duplicate provenance');

  r = run(root, request({ workspace: { id: 'client-a-duplicate' } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.workspace.id, 'client-a');
  assert.equal(r.json.state, 'existing');
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'client-a-duplicate')), false);

  r = run(root, request({
    workspace: { domains: ['video', 'marketing'], canonical_sources: ['source://client-a', 'source://client-a-briefs'] },
    evidence: { reason: 'Client A now has a stable briefs source and marketing work.' },
    provenance: { trigger_ref: 'run:test-2' },
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'evolved');
  assert.equal(r.json.changed, true);
  manifest = fs.readFileSync(path.join(clientRoot, 'WORKSPACE.yaml'), 'utf8');
  assert.match(manifest, /"marketing"/);
  assert.match(manifest, /"source:\/\/client-a-briefs"/);
  provenance = JSON.parse(fs.readFileSync(path.join(clientRoot, 'context', 'AUTO-ORGANIZATION.json'), 'utf8'));
  assert.equal(provenance.history.length, 2);

  // Simulated restart: a fresh process re-discovers the same canonical workspace.
  r = run(root, request({
    workspace: { domains: ['video', 'marketing'], canonical_sources: ['source://client-a', 'source://client-a-briefs'] },
    evidence: { reason: 'Client A now has a stable briefs source and marketing work.' },
    provenance: { trigger_ref: 'run:test-2' },
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'existing');
  assert.equal(r.json.changed, false);

  r = run(root, request({ workspace: { id: 'tiny-task', name: 'Tiny Task' }, evidence: { substantial_scope: false } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'ignored-trivial');
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'tiny-task')), false);

  r = run(root, request({ workspace: { id: 'ambiguous', name: 'Ambiguous Scope' }, authority: { privacy_ambiguous: true } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'needs-clarification');
  assert.equal(r.json.user_confirmation_required, true);
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'ambiguous')), false);

  r = run(root, request({ workspace: { id: 'widened', name: 'Widened' }, authority: { permission_expansion: true } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'blocked-authority');
  assert.equal(r.json.permission_expanded, false);
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'widened')), false);

  r = run(root, request({ workspace: { id: 'connection', name: 'Connection' }, authority: { new_connection: true } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'blocked-authority');
  assert.equal(r.json.connection_created, false);
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'connection')), false);

  r = run(root, request({ workspace: { id: '../escape', name: 'Escape' } }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /workspace\.id cannot be derived safely|workspace\.id/);
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);

  r = run(root, request({
    workspace: { id: 'secret', name: 'Secret', canonical_sources: ['api_key=super-secret-value'] }
  }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /credential\/secret material/);
  assert.equal(fs.existsSync(path.join(root, 'workspaces', 'secret')), false);

  // Existing manually-created workspace can evolve additively without losing unrelated fields.
  const manualRoot = path.join(root, 'workspaces', 'manual-client');
  fs.mkdirSync(manualRoot, { recursive: true });
  const manualManifest = [
    'schema_version: "2.0"',
    'id: "manual-client"',
    'name: "Manual Client"',
    'type: "client"',
    'status: "active"',
    'domains:',
    '  - "legacy"',
    'purpose: "Manual workspace"',
    'owners: []',
    'success_criteria: []',
    'current_context: "context/CURRENT.md"',
    'canonical_sources: []',
    'connections: []',
    'custom_field: "preserve-me"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(manualRoot, 'WORKSPACE.yaml'), manualManifest, 'utf8');

  r = run(root, request({
    workspace: {
      id: 'manual-client',
      name: 'Manual Client',
      domains: ['legacy', 'new-domain'],
      canonical_sources: ['source://manual'],
    },
    evidence: { reason: 'Existing manual workspace gained stable new scope evidence.' },
    provenance: { trigger_ref: 'run:manual' },
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.state, 'evolved');
  const evolvedManual = fs.readFileSync(path.join(manualRoot, 'WORKSPACE.yaml'), 'utf8');
  assert.match(evolvedManual, /custom_field: "preserve-me"/);
  assert.match(evolvedManual, /"new-domain"/);
  assert.match(evolvedManual, /"source:\/\/manual"/);
  assert.equal(fs.existsSync(path.join(manualRoot, 'context', 'CURRENT.md')), true);

  process.stdout.write('Automatic workspace owner acceptance: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
