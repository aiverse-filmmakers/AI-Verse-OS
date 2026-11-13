import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectCapability } from './capability-resolver.mjs';
import { readAdjustment, listAdjustments, saveAdjustment, removeAdjustment, SAVED_MESSAGE } from './skill-adjustments.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-adjustments-check-')));
let checks = 0;
function test(name, run) { run(); checks++; }
const hashTree = dir => {
  const h = crypto.createHash('sha256');
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(e.name).update(fs.readFileSync(p)); } };
  walk(dir); return h.digest('hex');
};
try {
  const root = path.join(base, 'os'), local = path.join(base, 'personal');
  fs.mkdirSync(path.join(root, 'system/capabilities/audit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system/capabilities/audit/SKILL.md'), '---\nname: audit\ndescription: Audit\n---\nAudit.\n');
  fs.mkdirSync(path.join(local, 'copywriting'), { recursive: true });
  fs.writeFileSync(path.join(local, 'copywriting/SKILL.md'), '---\nname: copywriting\ndescription: Write marketing copy\n---\nWrite clear copy.\n');
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, 'workspaces', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), `id: ${id}\n`);
  }
  const options = { osRoot: root, localSkillsRoot: local, skillsRoot: path.join(base, 'managed'), scope: 'workspace:alpha' };
  const skillHash = hashTree(path.join(local, 'copywriting'));

  test('save says it applies to this project only', () => {
    const saved = saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'local:copywriting', text: 'Voice: dry and direct. Offer: filmmaking course.' });
    assert.equal(saved.state, 'saved');
    assert.equal(saved.message, SAVED_MESSAGE);
    assert.equal(saved.applies_to, 'this project only');
  });
  test('the skill comes back with this project adjustments, marked with the precedence rule', () => {
    const selected = selectCapability({ ...options, qualifiedId: 'local:copywriting' });
    assert.equal(selected.status, 'selected');
    assert.match(selected.project_adjustments.text, /dry and direct/);
    assert.match(selected.project_adjustments.rule, /follow the project adjustments/);
  });
  test('another project sees nothing', () => {
    const selected = selectCapability({ ...options, scope: 'workspace:beta', qualifiedId: 'local:copywriting' });
    assert.equal(selected.status, 'selected');
    assert.equal(selected.project_adjustments, undefined);
    assert.equal(readAdjustment(root, 'workspace:beta', 'local:copywriting').text, null);
  });
  test('the same skill gives each project its own adjustments', () => {
    saveAdjustment({ osRoot: root, scope: 'workspace:beta', name: 'local:copywriting', text: 'Voice: warm and playful. Offer: bakery.' });
    assert.match(selectCapability({ ...options, qualifiedId: 'local:copywriting' }).project_adjustments.text, /filmmaking/);
    assert.match(selectCapability({ ...options, scope: 'workspace:beta', qualifiedId: 'local:copywriting' }).project_adjustments.text, /bakery/);
  });
  test('the skill files are byte for byte unchanged', () => assert.equal(hashTree(path.join(local, 'copywriting')), skillHash));
  test('operator scope has no project adjustments and cannot save any', () => {
    assert.equal(selectCapability({ ...options, scope: 'operator', qualifiedId: 'local:copywriting' }).project_adjustments, undefined);
    assert.throws(() => saveAdjustment({ osRoot: root, scope: 'operator', name: 'local:copywriting', text: 'x' }), /one project/);
  });
  test('a shared topic works for several skills', () => {
    saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'marketing', text: 'Audience: indie filmmakers.' });
    assert.deepEqual(listAdjustments(root, 'workspace:alpha').adjustments, ['local--copywriting', 'marketing']);
    assert.match(readAdjustment(root, 'workspace:alpha', 'marketing').text, /indie filmmakers/);
    assert.deepEqual(listAdjustments(root, 'workspace:beta').adjustments, ['local--copywriting']);
  });
  test('secrets and oversized text are refused', () => {
    assert.throws(() => saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'marketing', text: 'key ghp_' + 'a'.repeat(36) }), /secret/);
    assert.throws(() => saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'marketing', text: 'password: hunter2' }), /passwords/);
    assert.throws(() => saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'marketing', text: 'a'.repeat(20000) }), /too long/);
    assert.match(readAdjustment(root, 'workspace:alpha', 'marketing').text, /indie filmmakers/);
  });
  test('bad names and traversal are refused', () => {
    for (const name of ['../x', 'a/b', '', 'a b', '.hidden']) assert.throws(() => readAdjustment(root, 'workspace:alpha', name));
    assert.throws(() => readAdjustment(root, 'workspace:../beta', 'marketing'));
    assert.throws(() => readAdjustment(root, 'workspace:missing', 'marketing'), /untrusted/);
  });
  test('a redirected adjustments folder is refused', () => {
    const real = path.join(root, 'workspaces/alpha/context/skill-adjustments');
    fs.renameSync(real, `${real}-real`);
    fs.symlinkSync(path.join(root, 'workspaces/beta'), real);
    assert.throws(() => readAdjustment(root, 'workspace:alpha', 'marketing'), /redirected/);
    assert.equal(selectCapability({ ...options, qualifiedId: 'local:copywriting' }).project_adjustments.status, 'unreadable');
    fs.unlinkSync(real); fs.renameSync(`${real}-real`, real);
  });
  test('remove deletes only that project file', () => {
    assert.equal(removeAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'marketing' }).state, 'removed');
    assert.equal(removeAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'marketing' }).state, 'absent');
    assert.match(readAdjustment(root, 'workspace:beta', 'local:copywriting').text, /bakery/);
  });
  test('the command line saves, reads and lists', () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capability-resolver-cli.mjs');
    const run = request => { const r = spawnSync(process.execPath, [cli, '--root', root], { input: JSON.stringify(request), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    assert.equal(run({ operation: 'adjustments-save', scope: 'workspace:beta', name: 'marketing', text: 'Audience: neighbours.' }).message, SAVED_MESSAGE);
    assert.match(run({ operation: 'adjustments-read', scope: 'workspace:beta', name: 'marketing' }).text, /neighbours/);
    assert.deepEqual(run({ operation: 'adjustments-list', scope: 'workspace:beta' }).adjustments, ['local--copywriting', 'marketing']);
    assert.equal(run({ operation: 'adjustments-remove', scope: 'workspace:beta', name: 'marketing' }).state, 'removed');
  });
  console.log(`skill adjustment checks passed: ${checks}`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
