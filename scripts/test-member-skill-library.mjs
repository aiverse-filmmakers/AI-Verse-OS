import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveBinding, bindingDigest } from './capability-bindings.mjs';
import { discoverCapabilities, selectCapability, packageDigestV1 } from './capability-resolver.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-member-library-'));
try {
  const root = path.join(base, 'os');
  const local = path.join(base, 'personal');
  fs.mkdirSync(path.join(root, 'system', 'capabilities', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.writeFileSync(path.join(root, 'system/capabilities/audit/SKILL.md'), '---\nname: audit\ndescription: OS audit\n---\n');
  for (const id of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, 'workspaces', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), `id: ${id}\n`);
  }
  const index = { contract: 'aiverse-member-skill-library-v1', sequence: 1, skills: {}, events: [] };
  function packageEntry(id, name, visibility = 'shared') {
    const stage = path.join(base, `stage-${id}`);
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'SKILL.md'), `---\nname: ${name}\ndescription: Retrieve video information\n---\nMethod ${id}\n`);
    const revision = packageDigestV1(stage);
    const rel = `.aiverse/member-library/packages/${id}/${revision}`;
    fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true });
    fs.renameSync(stage, path.join(local, rel));
    const metadata = { path: rel, name, description: 'Retrieve video information', source_scope: 'workspace:alpha', visibility,
      admission: visibility === 'shared' ? { reusable: true, contains_workspace_data: false, contains_credentials: false, has_workspace_dependencies: false } : {} };
    index.skills[id] = { id, name, description: metadata.description, visibility, active_revision: revision, revisions: { [revision]: metadata } };
    return revision;
  }
  const revision = packageEntry('skill-one', 'youtube-scraper');
  packageEntry('skill-private', 'private-method', 'workspace:alpha');
  const file = path.join(local, '.aiverse/member-library/index.json');
  fs.writeFileSync(file, JSON.stringify(index));
  const options = { osRoot: root, localSkillsRoot: local, skillsRoot: path.join(base, 'absent'), limit: 200 };
  const beta = discoverCapabilities({ ...options, scope: 'workspace:beta' });
  assert(beta.candidates.some(x => x.id === 'local:skill-one'));
  assert(!beta.candidates.some(x => x.name === 'private-method'));
  const alpha = discoverCapabilities({ ...options, scope: 'workspace:alpha' });
  assert(alpha.candidates.some(x => x.name === 'private-method'));
  assert.equal(selectCapability({ ...options, scope: 'workspace:beta', query: 'youtube-scraper' }).selection.id, 'local:skill-one');
  packageEntry('skill-two', 'youtube-scraper');
  packageEntry('skill-audit', 'audit');
  fs.writeFileSync(file, JSON.stringify(index));
  const collision = selectCapability({ ...options, scope: 'workspace:beta', query: 'youtube-scraper' });
  assert.equal(collision.status, 'ambiguous');
  assert.equal(collision.alternatives.length, 2);
  assert.equal(selectCapability({ ...options, scope: 'workspace:beta', qualifiedId: 'local:skill-two' }).selection.id, 'local:skill-two');
  const audit = selectCapability({ ...options, scope: 'workspace:beta', query: 'audit' });
  assert.equal(audit.selection.id, 'os:audit');
  assert(audit.alternatives.some(x => x.id === 'local:skill-audit'));
  saveBinding({ osRoot: root, scope: 'workspace:beta', id: 'local:skill-two', alias: 'youtube-scraper',
    binding: { inputs: { channels: ['education'] } }, expectedDigest: bindingDigest(root, 'workspace:beta') });
  const preferred = selectCapability({ ...options, scope: 'workspace:beta', query: 'youtube-scraper' });
  assert.equal(preferred.selection.id, 'local:skill-two');
  assert.deepEqual(preferred.workspace_binding.inputs, { channels: ['education'] });
  assert.equal(preferred.workspace_binding.permission_granted, false);
  assert.equal(selectCapability({ ...options, scope: 'workspace:alpha', query: 'youtube-scraper' }).status, 'ambiguous');
  assert.throws(() => saveBinding({ osRoot: root, scope: 'workspace:beta', id: 'local:skill-two',
    binding: { inputs: { password: 'unsafe' } }, expectedDigest: bindingDigest(root, 'workspace:beta') }), /credentials/);
  fs.mkdirSync(path.join(root, '.aiverse'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiverse/capability-providers.json'), JSON.stringify({
    schema_version: 1, skills_root: options.skillsRoot, local_skills_root: local,
  }));
  assert.equal(discoverCapabilities({ osRoot: root, scope: 'workspace:beta' }).providers.find(x => x.provider === 'local').candidate_count, 3);
  assert.throws(() => discoverCapabilities({ ...options, skillsRoot: path.join(base, 'different') }), /configured provider/);
  fs.appendFileSync(path.join(local, index.skills['skill-one'].revisions[revision].path, 'SKILL.md'), 'tampered');
  const damaged = discoverCapabilities({ ...options, scope: 'workspace:beta' });
  assert.equal(damaged.providers.find(x => x.provider === 'local').state, 'degraded');
  assert(!damaged.candidates.some(x => x.id === 'local:skill-one'));
  console.log('Member library discovery, scope, identity and collision acceptance: PASS');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
