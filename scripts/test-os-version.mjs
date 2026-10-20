import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVersionReport } from './os-version.mjs';

const CURRENT_RELEASE = 'core-current-test';
const OLD_RELEASE = 'core-old-test';
const CURRENT_REVISION = 'a'.repeat(40);
const OLD_REVISION = 'b'.repeat(40);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-os-version-'));
  fs.mkdirSync(path.join(root, 'release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  fs.writeFileSync(path.join(root, 'release', 'component-release.json'), JSON.stringify({
    component_id: 'ai-verse-os', version: '1.0.0', revision: CURRENT_REVISION, release_status: 'accepted',
  }));
  return root;
}

function remoteFetch({
  releaseSet = CURRENT_RELEASE,
  revision = CURRENT_REVISION,
  descriptorRevision = revision,
  releaseStatus = 'released',
  fail = false,
} = {}) {
  return async (url) => {
    if (fail) throw new Error('offline');
    let body;
    if (url.endsWith('/core_promotions.json')) {
      body = { current_release: releaseSet, release_sets: [{ id: releaseSet, profile: 'core', status: releaseStatus, components: [{ id: 'ai-verse-os', revision }] }] };
    } else if (url.endsWith('/core_lineage.json')) {
      body = { current_release: releaseSet, release_sets: [] };
    } else if (url.endsWith('/release_sets.json')) {
      body = { channels: { core: releaseSet }, release_sets: [] };
    } else {
      body = { component_id: 'ai-verse-os', version: '1.0.0', revision: descriptorRevision, release_status: 'accepted' };
    }
    return { ok: true, status: 200, json: async () => body };
  };
}

function commands(root, { releaseSet = CURRENT_RELEASE, revision = CURRENT_REVISION, updatePlan = null } = {}) {
  return (_command, args) => {
    if (args[0] === 'status') {
      return { release_set_id: releaseSet, root, components: { 'ai-verse-os': { state: 'ready', revision } } };
    }
    if (args[0] === 'update') return updatePlan;
    return null;
  };
}

const root = fixture();
try {
  const current = await getVersionReport({ root, fetchImpl: remoteFetch(), run: commands(root), now: () => new Date('2026-10-16T12:00:00Z') });
  assert.equal(current.installed.version, '1.0.0');
  assert.equal(current.latest.releaseSet, CURRENT_RELEASE);
  assert.equal(current.update, 'up-to-date');
  assert.match(current.message, /up to date/);

  const behind = await getVersionReport({
    root,
    fetchImpl: remoteFetch(),
    run: commands(root, { releaseSet: OLD_RELEASE, revision: OLD_REVISION, updatePlan: {
      from: OLD_RELEASE,
      to: CURRENT_RELEASE,
      changes: [{ component: 'ai-verse-os', from: OLD_REVISION, to: CURRENT_REVISION }],
    } }),
  });
  assert.equal(behind.update, 'update-available');

  const staleUpdater = await getVersionReport({
    root,
    fetchImpl: remoteFetch(),
    run: commands(root, { releaseSet: OLD_RELEASE, revision: OLD_REVISION, updatePlan: { to: OLD_RELEASE, changes: [] } }),
  });
  assert.equal(staleUpdater.update, 'unconfirmed');

  const offline = await getVersionReport({ root, fetchImpl: remoteFetch({ fail: true }), run: commands(root) });
  assert.equal(offline.installed.revision, CURRENT_REVISION);
  assert.equal(offline.latest, null);
  assert.equal(offline.update, 'unknown');

  const mismatch = await getVersionReport({
    root,
    fetchImpl: remoteFetch({ descriptorRevision: OLD_REVISION }),
    run: commands(root),
  });
  assert.equal(mismatch.latest.revision, CURRENT_REVISION);
  assert.equal(mismatch.latest.version, null);
  assert.equal(mismatch.update, 'up-to-date');

  const requests = [];
  const fallback = remoteFetch();
  const postCommitMetadata = await getVersionReport({ root, run: commands(root), fetchImpl: async (url) => {
    requests.push(url);
    if (url.includes(`/${CURRENT_REVISION}/release/`)) {
      return { ok: true, json: async () => ({ component_id: 'ai-verse-os', revision: OLD_REVISION, version: '0.9.0', release_status: 'accepted' }) };
    }
    return fallback(url);
  } });
  assert.equal(postCommitMetadata.latest.version, '1.0.0');
  assert.equal(postCommitMetadata.installed.version, '1.0.0');
  assert.equal(postCommitMetadata.latest.descriptorWarning, null);
  assert.ok(requests.some((url) => url.includes('/main/release/component-release.json')));

  const newerOwnerMetadata = await getVersionReport({ root, run: commands(root), fetchImpl: async (url) => {
    if (url.includes('/release/component-release.json')) return { ok: true, json: async () => ({
      component_id: 'ai-verse-os', revision: OLD_REVISION, version: '99.0.0', release_status: 'accepted',
    }) };
    return fallback(url);
  } });
  assert.equal(newerOwnerMetadata.latest.version, null);
  assert.ok(newerOwnerMetadata.latest.descriptorWarning);

  const blockedOwnerMetadata = await getVersionReport({ root, run: commands(root), fetchImpl: async (url) => {
    if (url.includes('/release/component-release.json')) return { ok: true, json: async () => ({
      component_id: 'ai-verse-os', revision: CURRENT_REVISION, version: '99.0.0', release_status: 'blocked',
    }) };
    return fallback(url);
  } });
  assert.equal(blockedOwnerMetadata.latest.version, null);

  const invalidCatalog = await getVersionReport({
    root,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }),
    run: commands(root),
  });
  assert.equal(invalidCatalog.latest, null);
  assert.equal(invalidCatalog.update, 'unknown');

  const noReceipt = await getVersionReport({ root, fetchImpl: remoteFetch(), run: () => null });
  assert.equal(noReceipt.installed, null);
  assert.equal(noReceipt.localMetadata.version, '1.0.0');
  assert.equal(noReceipt.update, 'unknown');

  const unreleased = await getVersionReport({
    root,
    fetchImpl: remoteFetch({ releaseStatus: 'blocked' }),
    run: commands(root),
  });
  assert.equal(unreleased.latest, null);
  assert.equal(unreleased.update, 'unknown');

  const otherInstall = await getVersionReport({
    root,
    fetchImpl: remoteFetch(),
    run: commands(path.join(root, 'different-project')),
  });
  assert.equal(otherInstall.installed, null);

  fs.writeFileSync(path.join(root, 'release', 'component-release.json'), JSON.stringify({
    component_id: 'ai-verse-os', version: '0.9.0', revision: OLD_REVISION, release_status: 'accepted',
  }));
  const staleLocalDescriptor = await getVersionReport({ root, fetchImpl: remoteFetch(), run: commands(root) });
  assert.equal(staleLocalDescriptor.installed.revision, CURRENT_REVISION);
  assert.equal(staleLocalDescriptor.installed.version, '1.0.0');
  assert.equal(staleLocalDescriptor.update, 'up-to-date');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write('OS version reporter checks passed.\n');
