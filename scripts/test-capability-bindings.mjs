import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCapabilityJson } from './capability-json.mjs';
import { bindingPath } from './capability-bindings.mjs';
import { discoverCapabilities, selectCapability, planCapabilityBinding, applyCapabilityBinding, packageDigestV1 } from './capability-resolver.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-binding-check-')));
let checks = 0;
function test(name, run) { run(); checks++; }
try {
  const root = path.join(base, 'os'), local = path.join(base, 'personal');
  const skill = (dir, name, description = 'Retrieve public information') => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nUse explicit inputs.\n`);
  };
  skill(path.join(root, 'system/capabilities/audit'), 'audit');
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, 'workspaces', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), `id: ${id}\n`);
  }
  skill(path.join(local, 'one'), 'scraper');
  skill(path.join(local, 'two'), 'scraper');
  const options = { osRoot: root, localSkillsRoot: local, skillsRoot: path.join(base, 'managed'), scope: 'workspace:alpha' };
  const plan = values => planCapabilityBinding({ ...options, qualifiedId: 'local:one', alias: 'scraper', binding: { inputs: { channel: 'alpha' } }, ...values });
  test('preview is read only', () => { plan(); assert(!fs.existsSync(bindingPath(root, options.scope))); });
  test('duplicate names require choice', () => assert.equal(selectCapability({ ...options, query: 'scraper' }).status, 'ambiguous'));
  test('apply preserves scoped values without permissions', () => {
    assert.equal(applyCapabilityBinding({ ...options, plan: plan() }).permission_granted, false);
    const selected = selectCapability({ ...options, query: 'scraper' });
    assert.equal(selected.selection.id, 'local:one');
    assert.equal(selected.workspace_binding.inputs.channel, 'alpha');
  });
  test('workspace beta gets neither choice nor inputs', () => assert.equal(selectCapability({ ...options, scope: 'workspace:beta', query: 'scraper' }).status, 'ambiguous'));
  test('operator preference inherits identity but not inputs', () => {
    const operator = { ...options, scope: 'operator' };
    applyCapabilityBinding({ ...operator, plan: planCapabilityBinding({ ...operator, qualifiedId: 'local:two', alias: 'scraper', binding: { inputs: { private_operator: 'operator only' } } }) });
    const beta = selectCapability({ ...options, scope: 'workspace:beta', query: 'scraper' });
    assert.equal(beta.selection.id, 'local:two'); assert(!beta.workspace_binding);
    assert.equal(selectCapability({ ...options, query: 'scraper' }).selection.id, 'local:one');
  });
  test('stale binding file refuses apply', () => {
    const old = plan(); applyCapabilityBinding({ ...options, plan: plan({ binding: { inputs: { channel: 'new' } } }) });
    assert.throws(() => applyCapabilityBinding({ ...options, plan: old }), /changed/);
  });
  test('stale package refuses apply', () => {
    const old = plan(); fs.appendFileSync(path.join(local, 'one/SKILL.md'), 'changed');
    assert.throws(() => applyCapabilityBinding({ ...options, plan: old }), /changed/);
  });
  test('wrong scope cannot reuse preview', () => assert.throws(() => applyCapabilityBinding({ ...options, scope: 'workspace:beta', plan: plan() }), /scope/));
  test('missing and sibling workspace selections refuse', () => {
    assert.throws(() => plan({ qualifiedId: 'workspace:beta:secret' }), /unavailable/);
    assert.throws(() => plan({ scope: 'workspace:missing' }), /workspace/);
  });
  test('protected aliases cannot be redirected', () => assert.throws(() => plan({ alias: 'Audit' }), /protected/));
  test('secret and unsafe inputs refuse', () => {
    assert.throws(() => plan({ binding: { inputs: { api_key: 'do-not-store' } } }), /credentials/);
    assert.throws(() => plan({ binding: { inputs: { count: NaN } } }), /finite/);
    assert.throws(() => plan({ alias: '__proto__' }), /unsafe/);
    assert.throws(() => plan({ binding: { inputs: JSON.parse('{"constructor":"bad"}') } }), /unsafe/);
  });
  test('missing saved choice does not silently replace', () => {
    fs.renameSync(path.join(local, 'one'), path.join(base, 'retired'));
    assert.equal(selectCapability({ ...options, query: 'scraper' }).status, 'unavailable');
    fs.renameSync(path.join(base, 'retired'), path.join(local, 'one'));
  });
  test('invalid workspace never returns operator inputs', () => {
    fs.writeFileSync(path.join(root, 'workspaces/beta/WORKSPACE.yaml'), 'id: wrong\n');
    const result = selectCapability({ ...options, scope: 'workspace:beta', query: 'scraper' });
    assert.equal(result.status, 'unavailable'); assert(!result.workspace_binding);
    fs.writeFileSync(path.join(root, 'workspaces/beta/WORKSPACE.yaml'), 'id: beta\n');
  });
  test('duplicate JSON and invalid numbers refuse', () => {
    assert.throws(() => parseCapabilityJson('{"a":1,"a":2}'), /duplicate/);
    assert.throws(() => parseCapabilityJson('{"a":1e999}'), /finite/);
    assert.deepEqual(parseCapabilityJson('{"a":[1,true,null,{"b":"escaped \\" quote"}]}'), { a: [1, true, null, { b: 'escaped " quote' }] });
  });
  test('broken binding symlink refuses without target writes', () => {
    const file = bindingPath(root, 'workspace:beta'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const target = path.join(base, 'never-write');
    fs.symlinkSync(target, file);
    assert.equal(selectCapability({ ...options, scope: 'workspace:beta', query: 'scraper' }).status, 'unavailable');
    assert.throws(() => plan({ scope: 'workspace:beta' })); assert(!fs.existsSync(target)); fs.unlinkSync(file);
  });
  test('public CLI preview and apply', () => {
    const cli = fileURLToPath(new URL('./capability-resolver-cli.mjs', import.meta.url));
    const request = { scope: 'workspace:beta', skills_root: options.skillsRoot, local_skills_root: local };
    const call = payload => spawnSync(process.execPath, [cli, '--root', root], { input: JSON.stringify({ ...request, ...payload }), encoding: 'utf8' });
    const preview = call({ operation: 'plan-binding', qualified_id: 'local:two', alias: 'scraper', binding: { inputs: { channel: 'beta' } } });
    assert.equal(preview.status, 0, preview.stderr);
    const applied = call({ operation: 'apply-binding', plan: JSON.parse(preview.stdout) });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(call({ operation: 'select', query: 'scraper' }).stdout).workspace_binding.inputs.channel, 'beta');
    assert.equal(call({ operation: 'plan-binding', qualified_id: 'local:two', alias: 'audit' }).status, 2);
  });
  test('registered sources are read only, scoped and pinned', () => {
    const external = path.join(base, 'external'); skill(path.join(external, 'tool'), 'scraper');
    fs.mkdirSync(path.join(root, '.aiverse'), { recursive: true });
    const file = path.join(root, '.aiverse/capability-sources.json');
    const data = { contract: 'aiverse-external-capability-sources-v1', sources: [{ id: 'publisher', kind: 'directory-packages-v1', root: external,
      supported: true, installed: true, enabled: true, visibility: 'workspace:alpha', packages: [{ id: 'tool', path: 'tool', digest: packageDigestV1(path.join(external, 'tool')) }] }] };
    fs.writeFileSync(file, JSON.stringify(data));
    let alpha = discoverCapabilities({ ...options, query: 'scraper' });
    assert(alpha.candidates.some(x => x.id === 'external:publisher:tool' && x.read_only));
    assert(!discoverCapabilities({ ...options, scope: 'workspace:beta', query: 'scraper' }).candidates.some(x => x.id.startsWith('external:')));
    const before = fs.readFileSync(path.join(external, 'tool/SKILL.md'));
    applyCapabilityBinding({ ...options, plan: plan({ qualifiedId: 'external:publisher:tool', alias: 'external scraper' }) });
    assert.equal(selectCapability({ ...options, query: 'external scraper' }).selection.id, 'external:publisher:tool');
    assert.deepEqual(fs.readFileSync(path.join(external, 'tool/SKILL.md')), before);
    fs.appendFileSync(path.join(external, 'tool/SKILL.md'), 'modified');
    alpha = discoverCapabilities({ ...options });
    assert.equal(alpha.providers.find(x => x.provider === 'external:publisher').state, 'degraded');
    assert.equal(selectCapability({ ...options, qualifiedId: 'external:publisher:tool' }).status, 'unavailable');
    data.sources[0].enabled = false; fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(discoverCapabilities(options).providers.find(x => x.provider === 'external:publisher').state, 'disabled');
    data.sources[0].enabled = true; data.sources[0].root = path.join(root, 'workspaces/alpha'); fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(discoverCapabilities(options).providers.find(x => x.provider === 'external:publisher').state, 'degraded');
  });
  test('configured roots cannot overlap or silently fall back', () => {
    const config = path.join(root, '.aiverse/capability-providers.json');
    fs.writeFileSync(config, JSON.stringify({ schema_version: 1, skills_root: local, local_skills_root: local }));
    assert.throws(() => discoverCapabilities({ osRoot: root }), /separate/);
    fs.writeFileSync(config, JSON.stringify({ schema_version: 1, skills_root: options.skillsRoot, local_skills_root: local }));
    assert.throws(() => discoverCapabilities({ ...options, localSkillsRoot: path.join(base, 'other') }), /configured provider/);
    fs.unlinkSync(config); fs.symlinkSync(path.join(base, 'missing-config'), config);
    assert.throws(() => discoverCapabilities(options));
  });
  console.log(`Capability bindings and registered-source acceptance: PASS (${checks} cases)`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
