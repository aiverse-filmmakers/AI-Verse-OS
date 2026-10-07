#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composePurposeContext } from './purpose-context-core.mjs';

function listFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
}

const now = '2026-10-07T08:05:00.000Z';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-no-cache-'));
try {
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  const currentPath = path.join(root, 'operator', 'context', 'CURRENT.md');
  fs.writeFileSync(currentPath, '## Current state\n\n- first owner value\n');

  const filesBefore = listFiles(root);
  const first = composePurposeContext(root, 'operator', { now });
  const second = composePurposeContext(root, 'operator', { now });
  const filesAfterRepeatedReads = listFiles(root);

  assert.deepEqual(second, first);
  assert.deepEqual(filesAfterRepeatedReads, filesBefore);
  assert.equal(first.current_state[0].statement, 'first owner value');
  assert.equal(fs.existsSync(path.join(root, '.aiverse', 'purpose')), false);
  assert.equal(fs.existsSync(path.join(root, 'purpose')), false);

  fs.writeFileSync(currentPath, '## Current state\n\n- second owner value\n');
  const changed = composePurposeContext(root, 'operator', { now });
  assert.equal(changed.current_state[0].statement, 'second owner value');
  assert.doesNotMatch(JSON.stringify(changed), /first owner value/);
  assert.equal(fs.existsSync(path.join(root, '.aiverse', 'purpose')), false);
  assert.equal(fs.existsSync(path.join(root, 'purpose')), false);

  process.stdout.write('Purpose Context v1 no-cache behavior: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
