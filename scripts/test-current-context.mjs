#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const reader = path.join(repo, 'scripts', 'current-context.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-current-context-'));
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  return root;
}

function run(root, scope = 'operator', expected = 0) {
  const result = spawnSync(process.execPath, [reader, 'read', '--root', root, '--scope', scope], { encoding: 'utf8' });
  assert.equal(result.status, expected, `expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  return expected === 0 ? JSON.parse(result.stdout) : result;
}

function brainOwner(root, scope, refs = ['brain:intent:goal-1']) {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: { [scope]: { owner: 'brain', state: 'active', handover_id: 'handover-test', brain_refs: refs } },
  }, null, 2));
}

{
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), '# Current Operator Context\n\n## Current priorities\n\n- OLD OS STRATEGY\n\n## Pending decisions\n\n- operational decision\n');
    const data = run(root);
    assert.equal(data.direction_owner, 'os');
    assert.match(data.current_context, /OLD OS STRATEGY/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
      '# Current Operator Context', 'arbitrary preamble must not pass', 'Last reviewed: today', '',
      '## Current priorities', '', '- OLD OS STRATEGY', '',
      '## Active workspaces', '', '- alpha', '',
      '## Pending decisions', '', '- operational decision', '',
      '## Surprise strategy', '', '- UNKNOWN STRATEGY', '',
    ].join('\n'));
    brainOwner(root, 'operator');
    const views = path.join(root, '.aiverse', 'direction', 'views');
    fs.mkdirSync(views, { recursive: true });
    fs.writeFileSync(path.join(views, 'operator.md'), '# generated view\n');
    const data = run(root);
    assert.equal(data.direction_owner, 'brain');
    assert.equal(data.strategy_status, 'brain-canonical');
    assert.doesNotMatch(data.current_context, /OLD OS STRATEGY/);
    assert.doesNotMatch(data.current_context, /UNKNOWN STRATEGY/);
    assert.doesNotMatch(data.current_context, /arbitrary preamble/);
    assert.match(data.current_context, /operational decision/);
    assert.match(data.current_context, /brain:intent:goal-1/);
    assert.deepEqual(data.omitted_sections.sort(), ['Current priorities', 'Surprise strategy'].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), '## Current priorities\n\n- OLD OS STRATEGY\n\n## Current state\n\n- operational fact\n');
    brainOwner(root, 'operator', []);
    const data = run(root);
    assert.equal(data.strategy_status, 'unavailable');
    assert.equal(data.direction_view_status, 'missing');
    assert.doesNotMatch(data.current_context, /OLD OS STRATEGY/);
    assert.match(data.current_context, /operational fact/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const root = fixture();
  try {
    const workspace = path.join(root, 'workspaces', 'film');
    fs.mkdirSync(path.join(workspace, 'context'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), 'schema_version: "1.0"\nid: film\n');
    fs.writeFileSync(path.join(workspace, 'context', 'CURRENT.md'), '## Objective\n\nOLD WORKSPACE OBJECTIVE\n\n## Current state\n\noperational workspace fact\n\n## Next useful actions\n\n- inspect footage\n');
    brainOwner(root, 'workspace:film', ['brain:intent:film-goal']);
    const views = path.join(root, '.aiverse', 'direction', 'views');
    fs.mkdirSync(views, { recursive: true });
    fs.writeFileSync(path.join(views, 'workspace_film.md'), '# generated view\n');
    const data = run(root, 'workspace:film');
    assert.doesNotMatch(data.current_context, /OLD WORKSPACE OBJECTIVE/);
    assert.match(data.current_context, /operational workspace fact/);
    assert.match(data.current_context, /inspect footage/);
    assert.equal(data.direction_view, '.aiverse/direction/views/workspace_film.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

{
  const root = fixture();
  try {
    const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '{not-json');
    run(root, 'operator', 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.platform !== 'win32') {
  const root = fixture();
  try {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    fs.writeFileSync(outside, 'OUTSIDE SECRET');
    fs.symlinkSync(outside, path.join(root, 'operator', 'context', 'CURRENT.md'));
    run(root, 'operator', 4);
    fs.rmSync(outside, { force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('Ownership-aware current context acceptance OK');
