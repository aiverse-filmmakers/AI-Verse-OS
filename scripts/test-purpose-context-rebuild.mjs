#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const cli = path.join(scriptsDir, 'purpose-context.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-rebuild-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- ship purpose context', '',
    '## Current state', '', '- initial owner state', '',
  ].join('\n'));
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, 'workspaces', id, 'context'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), `schema_version: "2.0"\nid: ${id}\n`);
    fs.writeFileSync(path.join(root, 'workspaces', id, 'context', 'CURRENT.md'), [
      '## Objective', '', `${id} objective`, '',
      '## Current state', '', `- ${id} state`, '',
    ].join('\n'));
  }
  return root;
}

function run(root, scope = 'operator', extra = []) {
  const result = spawnSync(process.execPath, [cli, 'read', '--root', root, '--scope', scope, ...extra], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function normalized(value) {
  const copy = structuredClone(value);
  if (copy.provenance) {
    copy.provenance.generated_at = '<volatile>';
    for (const read of copy.provenance.owner_reads ?? []) {
      read.observed_at = '<volatile>';
      if (read.freshness?.as_of) read.freshness.as_of = '<volatile>';
    }
  }
  return copy;
}

function listPurposeArtifacts(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/purpose/i.test(entry.name) && entry.name !== '.temporary-purpose-output.json') found.push(path.relative(root, absolute));
    }
  };
  walk(root);
  return found.sort();
}

const root = fixture();
try {
  const first = run(root);
  const secondFreshProcess = run(root);
  assert.deepEqual(normalized(secondFreshProcess), normalized(first));
  assert.equal(first.current_state[0].statement, 'initial owner state');
  assert.deepEqual(listPurposeArtifacts(root), []);

  const disposable = path.join(root, '.temporary-purpose-output.json');
  fs.writeFileSync(disposable, JSON.stringify(first, null, 2));
  fs.rmSync(disposable);
  const rebuiltAfterDelete = run(root);
  assert.deepEqual(normalized(rebuiltAfterDelete), normalized(first));
  assert.deepEqual(listPurposeArtifacts(root), []);

  const alpha = run(root, 'workspace:alpha');
  const beta = run(root, 'workspace:beta');
  assert.equal(alpha.goals[0].statement, 'alpha objective');
  assert.equal(beta.goals[0].statement, 'beta objective');
  assert.doesNotMatch(JSON.stringify(alpha), /beta objective|beta state/);
  assert.doesNotMatch(JSON.stringify(beta), /alpha objective|alpha state/);

  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- ship purpose context', '',
    '## Current state', '', '- owner state after restart', '',
  ].join('\n'));
  const afterMutation = run(root);
  assert.equal(afterMutation.current_state[0].statement, 'owner state after restart');
  assert.doesNotMatch(JSON.stringify(afterMutation), /initial owner state/);

  const manyStateLines = Array.from({ length: 120 }, (_, index) => `- state ${String(index).padStart(3, '0')} ${'x'.repeat(80)}`);
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- bounded rebuild', '',
    '## Current state', '', ...manyStateLines,
  ].join('\n'));
  const boundedA = run(root, 'operator', ['--max-bytes', '4096']);
  const boundedB = run(root, 'operator', ['--max-bytes', '4096']);
  assert.deepEqual(normalized(boundedB), normalized(boundedA));
  assert.equal(boundedA.provenance.budget.max_bytes, 4096);
  assert.equal(boundedA.provenance.budget.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(boundedA), 'utf8') <= 4096);

  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- STALE OS STRATEGY', '',
    '## Current state', '', '- operational owner context', '',
  ].join('\n'));
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: {
      operator: {
        owner: 'brain',
        state: 'active',
        handover_id: 'rebuild-test',
        brain_refs: ['brain:intent:mission-1'],
      },
    },
  }));
  const brainUnavailable = run(root);
  assert.equal(brainUnavailable.section_states.strategic_direction.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(brainUnavailable), /STALE OS STRATEGY/);

  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'system', 'schemas', 'purpose-context.schema.json'), 'utf8'));
  assert.equal(schema.properties.schema_version.const, '1.0');
  assert.equal(schema.properties.provenance.properties.projection_owner.const, 'ai-verse-os');
  assert.equal(fs.existsSync(path.join(repoRoot, 'system', 'architecture', 'purpose-context.md')), true);

  process.stdout.write('Purpose Context v1 delete/rebuild/restart stability: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
