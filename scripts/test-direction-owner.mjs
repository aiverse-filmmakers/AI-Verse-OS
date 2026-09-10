#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const checker = path.join(repo, 'scripts', 'direction-owner.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-direction-owner-'));

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expected, `expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  return result;
}

try {
  fs.writeFileSync(path.join(temp, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n');

  let result = run(['status', '--root', temp, '--scope', 'operator']);
  let data = JSON.parse(result.stdout);
  assert.equal(data.owner, 'os');
  run(['assert-strategic-write', '--root', temp, '--scope', 'operator']);

  const marker = path.join(temp, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: {
      operator: {
        owner: 'brain',
        state: 'active',
        handover_id: 'handover-test',
        brain_refs: ['brain:intent:test'],
      },
    },
  }, null, 2));

  result = run(['status', '--root', temp, '--scope', 'operator']);
  data = JSON.parse(result.stdout);
  assert.equal(data.owner, 'brain');
  run(['assert-strategic-write', '--root', temp, '--scope', 'operator'], 3);

  // Brain process/state availability is deliberately irrelevant to OS ownership.
  const fakeBrain = path.join(temp, 'operator', 'brain');
  fs.mkdirSync(fakeBrain, { recursive: true });
  fs.writeFileSync(path.join(fakeBrain, 'installation.json'), '{}');
  fs.rmSync(fakeBrain, { recursive: true, force: true });
  run(['assert-strategic-write', '--root', temp, '--scope', 'operator'], 3);

  // Ownership is per scope; a workspace without handover remains OS-owned.
  result = run(['status', '--root', temp, '--scope', 'workspace:film']);
  data = JSON.parse(result.stdout);
  assert.equal(data.owner, 'os');
  run(['assert-strategic-write', '--root', temp, '--scope', 'workspace:film']);

  // Malformed ownership state must fail closed rather than default to OS.
  fs.writeFileSync(marker, JSON.stringify({ schema_version: 1, scopes: { operator: { owner: 'maybe' } } }));
  run(['status', '--root', temp, '--scope', 'operator'], 4);
  run(['assert-strategic-write', '--root', temp, '--scope', 'operator'], 4);

  console.log('Direction ownership acceptance OK');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
