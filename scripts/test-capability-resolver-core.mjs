import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverCapabilities,
  selectCapability,
  PROVIDER_CONTRACT,
  PACKAGE_DIGEST_ALGORITHM,
} from './capability-resolver.mjs';

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function skill(dir, name, description = `${name} capability`, version = '1.0.0') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\nversion: ${version}\n---\n\n# ${name}\n`, 'utf8');
}

function setupOs(base) {
  const root = path.join(base, 'os');
  fs.mkdirSync(path.join(root, 'system', 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n', 'utf8');
  skill(path.join(root, 'system', 'capabilities', 'onboard'), 'onboard', 'Protected system onboarding');
  skill(path.join(root, 'system', 'capabilities', 'audit'), 'audit', 'System audit');
  return root;
}

function setupWorkspace(root, id) {
  const workspace = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), `schema_version: "1.0"\nid: ${id}\n`, 'utf8');
  return workspace;
}

function distributedRecord(id, description = `${id} distributed capability`) {
  return {
    id: `aiverse-skills:${id}`,
    name: id,
    description,
    visibility: 'shared',
    version: '1.0.0',
    path: `imported/test/${id}`,
    package_state: 'valid',
    digest: {
      algorithm: PACKAGE_DIGEST_ALGORITHM,
      value: crypto.createHash('sha256').update(id).digest('hex'),
    },
    operators: [],
    dependencies: [],
  };
}

function setupDistributed(root, ids) {
  const generationId = 'gen-test-v1';
  const generation = path.join(root, '.aiverse', 'generations', generationId);
  const packages = [];
  const capabilities = [];
  for (const id of ids) {
    const description = id === 'needle-capability'
      ? 'Unique needle workflow for deep catalog selection'
      : `${id} general capability`;
    const record = distributedRecord(id, description);
    skill(path.join(generation, record.path), id, record.description);
    packages.push({
      kind: 'employee',
      id,
      qualified_id: record.id,
      name: record.name,
      description: record.description,
      version: record.version,
      path: record.path,
      digest: record.digest,
      operators: [],
      dependencies: [],
    });
    capabilities.push(record);
  }
  const manifest = {
    schema_version: 3,
    generation_schema_version: 1,
    provider_contract: PROVIDER_CONTRACT,
    provider_id: 'aiverse-skills',
    distribution: 'AI-Verse-Skills',
    profile: 'test',
    generation_id: generationId,
    generation_digest_sha256: '0'.repeat(64),
    packages,
  };
  const manifestFile = path.join(generation, '.aiverse', 'installed.json');
  writeJson(manifestFile, manifest);
  writeJson(path.join(generation, '.aiverse', 'capability-index.json'), {
    contract: PROVIDER_CONTRACT,
    provider_id: 'aiverse-skills',
    generation_id: generationId,
    manifest_sha256: crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex'),
    capabilities,
  });
  writeJson(path.join(root, '.aiverse', 'active.json'), {
    schema_version: 1,
    state: 'active',
    generation_id: generationId,
    history: [],
  });
  return { generation, manifestFile };
}

function provider(result, id) {
  return result.providers.find((item) => item.provider === id);
}

function withFixture(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-resolver-'));
  try {
    fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

withFixture((base) => {
  const root = setupOs(base);
  const local = path.join(base, 'local-skills');
  const distributed = path.join(base, 'skills-dist');
  const alpha = setupWorkspace(root, 'alpha');
  const beta = setupWorkspace(root, 'beta');

  skill(path.join(local, 'shared-tool'), 'shared-tool', 'Personal shared tool');
  skill(path.join(local, 'onboard'), 'onboard', 'Attempted personal alias shadow');
  skill(path.join(alpha, 'skills', 'shared-tool'), 'shared-tool', 'Alpha workspace tool');
  skill(path.join(alpha, 'skills', 'onboard'), 'onboard', 'Attempted workspace alias shadow');
  skill(path.join(beta, 'skills', 'beta-secret'), 'beta-secret', 'Must never leak into alpha');

  const ids = Array.from({ length: 58 }, (_, i) => `catalog-${String(i).padStart(2, '0')}`);
  ids.push('shared-tool', 'onboard', 'needle-capability');
  setupDistributed(distributed, ids);

  const discovered = discoverCapabilities({
    osRoot: root,
    scope: 'workspace:alpha',
    skillsRoot: distributed,
    localSkillsRoot: local,
    limit: 200,
  });
  assert.equal(provider(discovered, 'os').state, 'healthy');
  assert.equal(provider(discovered, 'aiverse-skills').state, 'healthy');
  assert.equal(provider(discovered, 'local').state, 'healthy');
  assert.equal(provider(discovered, 'workspace:alpha').state, 'healthy');
  assert(discovered.candidates.some((item) => item.id === 'os:audit'));
  assert(discovered.candidates.some((item) => item.id === 'aiverse-skills:catalog-00'));
  assert(discovered.candidates.some((item) => item.id === 'local:shared-tool'));
  assert(discovered.candidates.some((item) => item.id === 'workspace:alpha:shared-tool'));
  assert(!discovered.candidates.some((item) => item.id.includes('beta-secret')));

  const workspaceChoice = selectCapability({
    osRoot: root,
    scope: 'workspace:alpha',
    query: 'shared-tool',
    skillsRoot: distributed,
    localSkillsRoot: local,
  });
  assert.equal(workspaceChoice.status, 'selected');
  assert.equal(workspaceChoice.selection.id, 'workspace:alpha:shared-tool');

  const operatorChoice = selectCapability({
    osRoot: root,
    scope: 'operator',
    query: 'shared-tool',
    skillsRoot: distributed,
    localSkillsRoot: local,
  });
  assert.equal(operatorChoice.selection.id, 'local:shared-tool');

  const explicitDistributed = selectCapability({
    osRoot: root,
    scope: 'workspace:alpha',
    qualifiedId: 'aiverse-skills:shared-tool',
    skillsRoot: distributed,
    localSkillsRoot: local,
  });
  assert.equal(explicitDistributed.selection.id, 'aiverse-skills:shared-tool');

  const protectedAlias = selectCapability({
    osRoot: root,
    scope: 'workspace:alpha',
    query: 'onboard',
    skillsRoot: distributed,
    localSkillsRoot: local,
  });
  assert.equal(protectedAlias.selection.id, 'os:onboard');

  const deepCatalog = discoverCapabilities({
    osRoot: root,
    scope: 'operator',
    query: 'needle',
    skillsRoot: distributed,
    localSkillsRoot: local,
    limit: 1,
  });
  assert.equal(deepCatalog.candidates.length, 1);
  assert.equal(deepCatalog.candidates[0].id, 'aiverse-skills:needle-capability');

  const wrongWorkspace = selectCapability({
    osRoot: root,
    scope: 'workspace:alpha',
    qualifiedId: 'workspace:beta:beta-secret',
    skillsRoot: distributed,
    localSkillsRoot: local,
  });
  assert.equal(wrongWorkspace.status, 'unavailable');
});

withFixture((base) => {
  const root = setupOs(base);
  setupWorkspace(root, 'alpha');
  const local = path.join(base, 'local-skills');
  fs.mkdirSync(local, { recursive: true });
  const outside = path.join(base, 'outside');
  skill(outside, 'escape', 'Escaping local symlink');
  fs.symlinkSync(outside, path.join(local, 'escape'), 'dir');
  skill(path.join(local, 'collection', 'nested'), 'nested', 'Should not be recursively discovered');

  const discovered = discoverCapabilities({
    osRoot: root,
    scope: 'workspace:alpha',
    skillsRoot: path.join(base, 'missing-dist'),
    localSkillsRoot: local,
    limit: 200,
  });
  assert.equal(provider(discovered, 'aiverse-skills').state, 'absent');
  assert.deepEqual(provider(discovered, 'aiverse-skills').diagnostics, []);
  assert.equal(provider(discovered, 'local').state, 'degraded');
  assert(!discovered.candidates.some((item) => item.id === 'local:escape'));
  assert(!discovered.candidates.some((item) => item.id === 'local:nested'));
});

withFixture((base) => {
  const root = setupOs(base);
  const distributed = path.join(base, 'skills-dist');
  const { manifestFile } = setupDistributed(distributed, ['good']);
  fs.appendFileSync(manifestFile, ' \n', 'utf8');
  const discovered = discoverCapabilities({
    osRoot: root,
    scope: 'operator',
    skillsRoot: distributed,
    localSkillsRoot: path.join(base, 'none'),
  });
  assert.equal(provider(discovered, 'aiverse-skills').state, 'degraded');
  assert.equal(provider(discovered, 'aiverse-skills').candidate_count, 0);
  assert(provider(discovered, 'aiverse-skills').diagnostics.some((line) => line.includes('manifest hash is stale')));
});

withFixture((base) => {
  const root = setupOs(base);
  const distributed = path.join(base, 'skills-dist');
  const { generation } = setupDistributed(distributed, ['good']);
  const indexFile = path.join(generation, '.aiverse', 'capability-index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  index.generation_id = 'gen-wrong';
  writeJson(indexFile, index);
  const discovered = discoverCapabilities({
    osRoot: root,
    scope: 'operator',
    skillsRoot: distributed,
    localSkillsRoot: path.join(base, 'none'),
  });
  assert.equal(provider(discovered, 'aiverse-skills').state, 'degraded');
  assert.equal(provider(discovered, 'aiverse-skills').candidate_count, 0);
  assert(provider(discovered, 'aiverse-skills').diagnostics.some((line) => line.includes('generation mismatch')));
});

withFixture((base) => {
  const root = setupOs(base);
  const distributed = path.join(base, 'legacy-skills');
  writeJson(path.join(distributed, '.aiverse', 'installed.json'), { schema_version: 2, packages: [] });
  const discovered = discoverCapabilities({
    osRoot: root,
    scope: 'operator',
    skillsRoot: distributed,
    localSkillsRoot: path.join(base, 'none'),
  });
  assert.equal(provider(discovered, 'aiverse-skills').state, 'unsupported');
  assert.equal(provider(discovered, 'aiverse-skills').candidate_count, 0);
});

console.log('Capability resolver acceptance: PASS');
