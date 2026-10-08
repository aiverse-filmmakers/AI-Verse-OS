#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { composeProfiledPurposeContext } from './purpose-context-profile.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const cli = path.join(scriptsDir, 'purpose-context.mjs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-security-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- OPERATOR ONLY PRIORITY', '',
    '## Current state', '', '- OPERATOR ONLY STATE', '',
  ].join('\n'), 'utf8');
  return root;
}

function addWorkspace(root, id, secret) {
  const dir = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(dir, 'context'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKSPACE.yaml'), `schema_version: "2.0"\nid: ${id}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'context', 'CURRENT.md'), [
    '## Objective', '', `${secret} OBJECTIVE`, '',
    '## Current state', '', `- ${secret} STATE`, '',
  ].join('\n'), 'utf8');
}

function writeOwnership(root, value, raw = false) {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, raw ? String(value) : JSON.stringify(value), 'utf8');
  return marker;
}

function run(root, scope) {
  const result = spawnSync(process.execPath, [cli, 'read', '--root', root, '--scope', scope], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

// Slice 11.2 Test 1: operator scope cannot descend into workspace-owned context.
{
  const root = makeRoot();
  try {
    addWorkspace(root, 'alpha', 'ALPHA PRIVATE');
    addWorkspace(root, 'beta', 'BETA PRIVATE');

    const operator = run(root, 'operator');
    const serialized = JSON.stringify(operator);
    assert.equal(operator.scope, 'operator');
    assert.match(serialized, /OPERATOR ONLY STATE/);
    assert.match(serialized, /OPERATOR ONLY PRIORITY/);
    assert.doesNotMatch(serialized, /ALPHA PRIVATE|BETA PRIVATE/);
    for (const read of operator.provenance.owner_reads ?? []) {
      for (const ref of read.canonical_refs ?? []) {
        assert.doesNotMatch(String(ref), /workspace:alpha|workspace:beta|workspaces\/alpha|workspaces\/beta/);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Slice 11.2 Test 2: workspace A cannot leak workspace B and vice versa.
{
  const root = makeRoot();
  try {
    addWorkspace(root, 'alpha', 'ALPHA PRIVATE');
    addWorkspace(root, 'beta', 'BETA PRIVATE');

    const alpha = run(root, 'workspace:alpha');
    const beta = run(root, 'workspace:beta');
    const alphaJson = JSON.stringify(alpha);
    const betaJson = JSON.stringify(beta);

    assert.equal(alpha.scope, 'workspace:alpha');
    assert.equal(beta.scope, 'workspace:beta');
    assert.match(alphaJson, /ALPHA PRIVATE OBJECTIVE|ALPHA PRIVATE STATE/);
    assert.match(betaJson, /BETA PRIVATE OBJECTIVE|BETA PRIVATE STATE/);
    assert.doesNotMatch(alphaJson, /BETA PRIVATE/);
    assert.doesNotMatch(betaJson, /ALPHA PRIVATE/);
    assert.doesNotMatch(alphaJson, /OPERATOR ONLY/);
    assert.doesNotMatch(betaJson, /OPERATOR ONLY/);

    for (const read of alpha.provenance.owner_reads ?? []) {
      for (const ref of read.canonical_refs ?? []) assert.doesNotMatch(String(ref), /workspace:beta|workspaces\/beta/);
    }
    for (const read of beta.provenance.owner_reads ?? []) {
      for (const ref of read.canonical_refs ?? []) assert.doesNotMatch(String(ref), /workspace:alpha|workspaces\/alpha/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Slice 11.2 Test 3: path traversal and workspace symlink redirects fail closed before outside data can be projected.
{
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-security-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });

    assert.throws(
      () => composeProfiledPurposeContext(root, 'workspace:../escape', { now: '2026-10-09T00:00:00Z' }),
      /invalid scope/,
    );

    fs.mkdirSync(path.join(outside, 'context'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: evil\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'context', 'CURRENT.md'), [
      '## Objective', '', 'OUTSIDE SECRET OBJECTIVE', '',
      '## Current state', '', '- OUTSIDE SECRET STATE', '',
    ].join('\n'), 'utf8');

    const link = path.join(root, 'workspaces', 'evil');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.throws(
      () => composeProfiledPurposeContext(root, 'workspace:evil', { now: '2026-10-09T00:00:00Z' }),
      /workspace evil must not be a symlink/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

// Slice 11.2 Test 4: malformed direction ownership records fail closed instead of defaulting to OS ownership.
{
  const root = makeRoot();
  try {
    writeOwnership(root, '{not-json', true);
    assert.throws(
      () => composeProfiledPurposeContext(root, 'operator', { now: '2026-10-09T00:00:00Z' }),
      /invalid direction ownership registry/,
    );

    writeOwnership(root, { schema_version: 999, scopes: {} });
    assert.throws(
      () => composeProfiledPurposeContext(root, 'operator', { now: '2026-10-09T00:00:00Z' }),
      /unsupported or malformed direction ownership registry/,
    );

    writeOwnership(root, { schema_version: 1, scopes: { operator: { owner: 'memory' } } });
    assert.throws(
      () => composeProfiledPurposeContext(root, 'operator', { now: '2026-10-09T00:00:00Z' }),
      /invalid direction ownership record for operator/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context security hardening through Test 11.2.4: PASS\n');
