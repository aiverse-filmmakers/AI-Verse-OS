#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composeProfiledPurposeContext } from './purpose-context-profile.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-boundary-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  return root;
}

function addWorkspace(root, id, fact = 'safe fact') {
  const workspace = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'context'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), `schema_version: "2.0"\nid: "${id}"\n`, 'utf8');
  fs.writeFileSync(path.join(workspace, 'context', 'CURRENT.md'), [
    '# Current Workspace Context', '',
    '## Objective', '', `- objective ${id}`, '',
    '## Current facts', '', `- ${fact}`, '',
  ].join('\n'), 'utf8');
  return workspace;
}

const now = '2026-10-07T00:00:00Z';

// Missing scope and path traversal fail before any scan/read.
{
  const root = makeRoot();
  try {
    assert.throws(() => composeProfiledPurposeContext(root, 'workspace:missing', { now }), /workspace missing does not exist/);
    assert.throws(() => composeProfiledPurposeContext(root, 'workspace:\.\.\/escape', { now }), /invalid scope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A previously readable workspace disappears immediately after deletion: no cache.
{
  const root = makeRoot();
  try {
    const workspace = addWorkspace(root, 'client-a', 'delete-me fact');
    const before = composeProfiledPurposeContext(root, 'workspace:client-a', { now });
    assert.equal(JSON.stringify(before).includes('delete-me fact'), true);
    fs.rmSync(workspace, { recursive: true, force: true });
    assert.throws(() => composeProfiledPurposeContext(root, 'workspace:client-a', { now }), /workspace client-a does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Workspace directory symlink cannot redirect reads outside the canonical slot.
{
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-outside-workspace-'));
  try {
    fs.mkdirSync(path.join(outside, 'context'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: evil\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'context', 'CURRENT.md'), '## Current facts\n\n- OUTSIDE_SECRET\n', 'utf8');
    fs.symlinkSync(outside, path.join(root, 'workspaces', 'evil'), 'dir');
    assert.throws(() => composeProfiledPurposeContext(root, 'workspace:evil', { now }), /workspace evil must not be a symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// Canonical manifest cannot itself be a symlink.
{
  const root = makeRoot();
  const externalManifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-outside-manifest-'));
  try {
    const workspace = addWorkspace(root, 'client-a');
    fs.rmSync(path.join(workspace, 'WORKSPACE.yaml'));
    const outsideManifest = path.join(externalManifestDir, 'WORKSPACE.yaml');
    fs.writeFileSync(outsideManifest, 'schema_version: "2.0"\nid: client-a\n', 'utf8');
    fs.symlinkSync(outsideManifest, path.join(workspace, 'WORKSPACE.yaml'), 'file');
    assert.throws(() => composeProfiledPurposeContext(root, 'workspace:client-a', { now }), /missing canonical WORKSPACE\.yaml/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalManifestDir, { recursive: true, force: true });
  }
}

// CURRENT.md cannot escape its workspace through a symlink.
{
  const root = makeRoot();
  const externalCurrentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-outside-current-'));
  try {
    const workspace = addWorkspace(root, 'client-a');
    fs.rmSync(path.join(workspace, 'context', 'CURRENT.md'));
    const outsideCurrent = path.join(externalCurrentDir, 'CURRENT.md');
    fs.writeFileSync(outsideCurrent, '## Current facts\n\n- OUTSIDE_CONTEXT_SECRET\n', 'utf8');
    fs.symlinkSync(outsideCurrent, path.join(workspace, 'context', 'CURRENT.md'), 'file');
    assert.throws(() => composeProfiledPurposeContext(root, 'workspace:client-a', { now }), /current context must not be a symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalCurrentDir, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context workspace boundary attacks: PASS\n');
