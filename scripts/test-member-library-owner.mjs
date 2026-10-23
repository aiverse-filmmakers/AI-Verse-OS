import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverCapabilities, selectCapability, planCapabilityBinding, applyCapabilityBinding, packageDigestV1 } from './capability-resolver.mjs';

// Explicit checkout and interpreter: never invoke the operator's launcher or writable roots.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--skills-source' || args[2] !== '--python') throw new Error('usage: --skills-source <checkout> --python <interpreter>');
const source = path.resolve(args[1]), python = args[3];
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-real-owner-check-')));
try {
  const root = path.join(base, 'os'), personal = path.join(base, 'personal'), managed = path.join(base, 'managed');
  fs.mkdirSync(path.join(root, 'system/capabilities'), { recursive: true });
  fs.mkdirSync(path.join(root, '.aiverse'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.writeFileSync(path.join(root, '.aiverse/capability-providers.json'), JSON.stringify({ schema_version: 1, skills_root: managed, local_skills_root: personal }));
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, 'workspaces', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), `id: ${id}\n`);
  }
  const packageDir = path.join(base, 'authored'); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, 'SKILL.md'), '---\nname: youtube-scraper\ndescription: Retrieve public channel information\n---\nUse explicit channel inputs.\n');
  fs.writeFileSync(path.join(packageDir, 'helper.txt'), 'revision one');
  const admission = path.join(base, 'admission.json');
  fs.writeFileSync(admission, JSON.stringify({ reusable: true, contains_workspace_data: false, contains_credentials: false, has_workspace_dependencies: false }));
  const environment = { ...process.env, PYTHONPATH: '', AI_VERSE_SKILLS_ROOT: managed, AI_VERSE_LOCAL_SKILLS_ROOT: personal };
  const cli = (...extra) => {
    const result = spawnSync(python, [path.join(source, 'installer/aiverse_skills.py'), '--root', managed, 'library', '--library-root', personal, ...extra],
      { cwd: source, env: environment, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const importPackage = (extra = []) => {
    const params = ['import', '--source', packageDir, '--source-scope', 'workspace:alpha', '--admission-json', admission, ...extra];
    const preview = cli(...params), file = path.join(base, 'preview.json');
    fs.writeFileSync(file, JSON.stringify(preview)); return cli(...params, '--apply-plan', file);
  };
  const originalDigest = packageDigestV1(packageDir);
  const first = importPackage();
  const beta = { osRoot: root, scope: 'workspace:beta' };
  assert.equal(selectCapability({ ...beta, query: 'youtube-scraper' }).selection.id, first.qualified_id);
  assert.equal(selectCapability({ ...beta, qualifiedId: first.qualified_id }).selection.digest.value, first.revision);
  assert.equal(packageDigestV1(packageDir), originalDigest);
  fs.writeFileSync(path.join(packageDir, 'helper.txt'), 'revision two');
  const second = importPackage(['--id', first.id]);
  assert.notEqual(first.revision, second.revision);
  const plan = planCapabilityBinding({ ...beta, qualifiedId: first.qualified_id, alias: 'youtube-scraper', binding: { revision: first.revision, inputs: { channel: 'beta' } } });
  applyCapabilityBinding({ ...beta, plan });
  const pinned = selectCapability({ ...beta, query: 'youtube-scraper' });
  assert.equal(pinned.selection.digest.value, first.revision);
  assert.equal(pinned.workspace_binding.inputs.channel, 'beta');
  assert.equal(selectCapability({ osRoot: root, scope: 'workspace:alpha', qualifiedId: first.qualified_id }).selection.digest.value, second.revision);
  fs.writeFileSync(admission, '{}');
  const privateImport = importPackage(['--visibility', 'workspace:alpha']);
  assert(discoverCapabilities({ osRoot: root, scope: 'workspace:alpha' }).candidates.some(x => x.id === privateImport.qualified_id));
  assert(!discoverCapabilities(beta).candidates.some(x => x.id === privateImport.qualified_id));
  assert.throws(() => planCapabilityBinding({ ...beta, qualifiedId: privateImport.qualified_id }), /unavailable/);
  const unknownRevision = '0'.repeat(64);
  assert.throws(() => planCapabilityBinding({ ...beta, qualifiedId: first.qualified_id, binding: { revision: unknownRevision } }), /unavailable/);
  cli('doctor');
  const index = JSON.parse(fs.readFileSync(path.join(personal, '.aiverse/member-library/index.json')));
  const firstPath = path.join(personal, index.skills[first.id].revisions[first.revision].path);
  fs.appendFileSync(path.join(firstPath, 'helper.txt'), 'damaged');
  assert.equal(selectCapability({ ...beta, qualifiedId: first.qualified_id }).status, 'unavailable');
  console.log('Actual Skills owner -> OS discovery, scoped inputs and retained-revision acceptance: PASS');
} finally { fs.rmSync(base, { recursive: true, force: true }); }
