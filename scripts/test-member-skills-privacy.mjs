#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-skill-privacy-'));
function git(...args) {
  return spawnSync('git', ['-C', root, '-c', `core.excludesFile=${path.join(root, '.empty-excludes')}`, ...args], { encoding: 'utf8' });
}
try {
  fs.copyFileSync(path.join(source, '.gitignore'), path.join(root, '.gitignore'));
  fs.writeFileSync(path.join(root, '.empty-excludes'), '');
  assert.equal(git('init').status, 0);
  const privatePaths = [
    '.aiverse/capability-providers.json', '.aiverse/capability-providers.json.lock',
    '.aiverse/capability-providers.json.123.tmp', '.aiverse/capability-sources.json',
    'operator/context/skill-bindings.json', 'operator/context/skill-bindings.json.lock',
    'operator/context/skill-bindings.json.123.tmp', 'workspaces/alpha/context/skill-bindings.json',
  ];
  for (const item of privatePaths) assert.equal(git('check-ignore', '--no-index', item).status, 0, `private settings are not ignored: ${item}`);
  for (const item of ['AI-VERSE.yaml', 'AGENTS.md', 'scripts/capability-resolver.mjs', 'system/capabilities/audit/SKILL.md', 'operator/context/README.md']) {
    assert.equal(git('check-ignore', '--no-index', item).status, 1, `canonical source unexpectedly ignored: ${item}`);
  }
  console.log('Member Skills private settings and canonical source boundaries: PASS (13 paths)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
