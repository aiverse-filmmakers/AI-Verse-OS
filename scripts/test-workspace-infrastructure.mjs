#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'workspace-infrastructure.mjs');
const CURRENT_GENERATION = 'workspace-id-slot-v1';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-workspace-infrastructure-'));
  fs.mkdirSync(path.join(root, 'workspaces', '_template'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', '_template', 'WORKSPACE.yaml'), 'id: "replace-with-id"\n', 'utf8');
  return root;
}

function manifest(id, domains = []) {
  return [
    'schema_version: "2.0"',
    `id: "${id}"`,
    `name: "${id}"`,
    'type: "custom"',
    'status: "active"',
    `domains: [${domains.map((item) => `"${item}"`).join(', ')}]`,
    `purpose: "Purpose for ${id}"`,
    'custom_field: "preserve-me"',
    '',
  ].join('\n');
}

function createWorkspace(root, slot, id = slot, domains = []) {
  const workspace = path.join(root, 'workspaces', slot);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), manifest(id, domains), 'utf8');
  return workspace;
}

function run(root) {
  const out = spawnSync(process.execPath, [script, 'detect', '--root', root], { encoding: 'utf8' });
  let json = null;
  if (out.stdout.trim()) {
    try { json = JSON.parse(out.stdout); } catch {}
  }
  return { ...out, json };
}

function snapshot(root) {
  const rows = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const rel = path.relative(root, target).split(path.sep).join('/');
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        rows.push(['symlink', rel, fs.readlinkSync(target)]);
      } else if (stat.isDirectory()) {
        rows.push(['dir', rel]);
        visit(target);
      } else if (stat.isFile()) {
        rows.push(['file', rel, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')]);
      } else {
        rows.push(['other', rel]);
      }
    }
  };
  visit(root);
  return JSON.stringify(rows);
}

function assertReadOnly(root, operation) {
  const before = snapshot(root);
  const result = operation();
  const after = snapshot(root);
  assert.equal(after, before, 'Workspace infrastructure detection must be read-only');
  return result;
}

// Empty installs are structurally current and the template is not a real Workspace.
{
  const root = makeRoot();
  try {
    const r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.state, 'current');
    assert.equal(r.json.disposition, 'CURRENT');
    assert.equal(r.json.current_generation, CURRENT_GENERATION);
    assert.equal(r.json.workspace_count, 0);
    assert.deepEqual(r.json.findings, []);
    assert.equal(r.json.mutated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A direct ID-derived slot is current even when optional template folders are absent
// and arbitrary user-owned/custom content exists.
{
  const root = makeRoot();
  try {
    const workspace = createWorkspace(root, 'client-a', 'client-a', ['video']);
    fs.mkdirSync(path.join(workspace, 'custom-notes'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'custom-notes', 'KEEP.txt'), 'user-owned custom content\n', 'utf8');
    fs.mkdirSync(path.join(workspace, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'outputs', 'final.mov.txt'), 'placeholder user output\n', 'utf8');

    let r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.state, 'current');
    assert.equal(r.json.workspaces[0].id, 'client-a');
    assert.equal(r.json.workspaces[0].generation, CURRENT_GENERATION);

    // Domain/category metadata is semantic. Changing it does not move or reclassify the slot.
    fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), manifest('client-a', ['video', 'youtube']), 'utf8');
    r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.state, 'current');
    assert.equal(r.json.workspaces[0].slot, 'workspaces/client-a');
    assert.equal(fs.readFileSync(path.join(workspace, 'custom-notes', 'KEEP.txt'), 'utf8'), 'user-owned custom content\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Manifest identity must match the supported ID-derived storage slot.
{
  const root = makeRoot();
  try {
    createWorkspace(root, 'slot-a', 'other-id');
    const r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 2);
    assert.equal(r.json.state, 'blocked-review');
    assert.equal(r.json.disposition, 'BLOCKED/REVIEW');
    assert.ok(r.json.findings.some((item) => item.code === 'workspace-id-slot-mismatch'));
    assert.equal(r.json.mutated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Duplicate/conflicting identity evidence fails closed.
{
  const root = makeRoot();
  try {
    createWorkspace(root, 'client-a', 'client-a');
    createWorkspace(root, 'client-b', 'client-a');
    const r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 2);
    assert.ok(r.json.findings.some((item) => item.code === 'duplicate-workspace-id'));
    assert.equal(r.json.workspaces.find((item) => item.slot === 'workspaces/client-a').state, 'blocked-review');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Old domain-first/nested storage is not silently treated as current or relocated.
{
  const root = makeRoot();
  try {
    const nested = path.join(root, 'workspaces', 'YouTube', 'channel-a');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'WORKSPACE.yaml'), manifest('channel-a', ['youtube']), 'utf8');
    const r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 2);
    assert.ok(r.json.findings.some((item) => item.code === 'invalid-workspace-slot-id'));
    assert.ok(r.json.findings.some((item) => item.code === 'workspace-manifest-missing'));
    assert.ok(r.json.findings.some((item) => item.code === 'nested-workspace-manifest'));
    assert.equal(fs.existsSync(path.join(root, 'workspaces', 'channel-a')), false, 'detect must not relocate nested Workspace state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Direct Workspace symlinks are never accepted as canonical storage.
{
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-workspace-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'WORKSPACE.yaml'), manifest('linked'), 'utf8');
    fs.symlinkSync(outside, path.join(root, 'workspaces', 'linked'), 'dir');
    const r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 2);
    assert.ok(r.json.findings.some((item) => item.code === 'workspace-slot-symlink'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// Missing/invalid manifest identity is reviewable, never guessed from similar content.
{
  const root = makeRoot();
  try {
    const missing = path.join(root, 'workspaces', 'missing-manifest');
    fs.mkdirSync(missing, { recursive: true });
    const invalid = path.join(root, 'workspaces', 'invalid-id');
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, 'WORKSPACE.yaml'), manifest('../escape'), 'utf8');
    const r = assertReadOnly(root, () => run(root));
    assert.equal(r.status, 2);
    assert.ok(r.json.findings.some((item) => item.code === 'workspace-manifest-missing'));
    assert.ok(r.json.findings.some((item) => item.code === 'invalid-workspace-manifest-id'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Workspace infrastructure generation acceptance: PASS\n');
