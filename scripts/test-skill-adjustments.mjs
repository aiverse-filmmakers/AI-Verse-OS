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
  test('operator scope has nothing until a note is saved for every project', () => {
    assert.equal(selectCapability({ ...options, scope: 'operator', qualifiedId: 'local:copywriting' }).project_adjustments, undefined);
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
  test('a note saved under the plain skill name reaches the qualified skill', () => {
    removeAdjustment({ osRoot: root, scope: 'workspace:beta', name: 'local:copywriting' });
    saveAdjustment({ osRoot: root, scope: 'workspace:beta', name: 'copywriting', text: 'Plain name note.' });
    const picked = selectCapability({ ...options, scope: 'workspace:beta', qualifiedId: 'local:copywriting' });
    assert.equal(picked.project_adjustments?.text, 'Plain name note.\n');
    saveAdjustment({ osRoot: root, scope: 'workspace:beta', name: 'local:copywriting', text: 'Full name note.' });
    assert.equal(selectCapability({ ...options, scope: 'workspace:beta', qualifiedId: 'local:copywriting' }).project_adjustments?.text, 'Full name note.\n', 'the full name note wins');
    removeAdjustment({ osRoot: root, scope: 'workspace:beta', name: 'copywriting' });
  });
  test('a lock left by a crashed save is cleared after a minute, a fresh one still blocks', () => {
    const dir = path.join(root, 'workspaces/alpha/context/skill-adjustments');
    const lock = path.join(dir, 'seo-audit.md.lock');
    fs.writeFileSync(lock, '');
    assert.throws(() => saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'seo-audit', text: 'x' }), /being saved elsewhere/);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    assert.equal(saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'seo-audit', text: 'x' }).state, 'saved');
    assert.equal(fs.existsSync(lock), false);
  });
  test('ordinary words like token are allowed, a real looking key is not', () => {
    assert.equal(saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'ad-creative', text: 'Design token: brand-red for buttons.' }).state, 'saved');
    assert.throws(() => saveAdjustment({ osRoot: root, scope: 'workspace:alpha', name: 'ad-creative', text: 'api key: a8f3k29dk3mz71q' }), /never store/);
  });
  test('yes to everywhere saves one note that every project gets, and a project note still wins', () => {
    fs.mkdirSync(path.join(root, 'operator'), { recursive: true });
    const saved = saveAdjustment({ osRoot: root, scope: 'operator', name: 'copywriting', text: 'Never use exclamation marks.' });
    assert.equal(saved.applies_to, 'every project');
    assert.match(saved.message, /every project/);
    assert.ok(fs.existsSync(path.join(root, 'operator/context/skill-adjustments/copywriting.md')));
    assert.equal(selectCapability({ ...options, scope: 'operator', qualifiedId: 'local:copywriting' }).project_adjustments.text, 'Never use exclamation marks.\n');
    const alpha = selectCapability({ ...options, scope: 'workspace:alpha', qualifiedId: 'local:copywriting' }).project_adjustments;
    assert.match(alpha.text, /For every project:\nNever use exclamation marks\./);
    assert.match(alpha.text, /For this project \(wins where they differ\):/);
    assert.equal(alpha.everywhere, true);
    removeAdjustment({ osRoot: root, scope: 'operator', name: 'copywriting' });
    assert.equal(selectCapability({ ...options, scope: 'operator', qualifiedId: 'local:copywriting' }).project_adjustments, undefined);
  });
  console.log(`skill adjustment checks passed: ${checks}`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
