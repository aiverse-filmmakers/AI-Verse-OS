import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getVersionReport, resolveLocalVersion } from './os-version.mjs';

// The release descriptor is the only OS version authority. These tests build real
// git histories to prove the CLI, the setup marker and /version never contradict
// each other, even when a launcher and its target are different versions.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-version-truth-'));
const GIT = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

function git(cwd, ...args) {
  const result = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeDescriptor(dir, version, revision) {
  const file = path.join(dir, 'release', 'component-release.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...data, version, revision }, null, 2)}\n`);
}

function cli(bin, args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { out: result.stdout.trim(), json: () => JSON.parse(result.stdout) };
}

try {
  const base = git(repo, 'rev-parse', 'HEAD');
  const origin = path.join(temp, 'origin.git');
  const work = path.join(temp, 'work');
  git(temp, 'clone', '--bare', '--no-local', repo, origin);
  git(temp, 'clone', origin, work);
  git(work, 'checkout', '-B', 'main');
  const overlay = (dir) => {
    for (const rel of ['bin/ai-verse-os.mjs', 'scripts/os-version.mjs']) fs.copyFileSync(path.join(repo, rel), path.join(dir, rel));
  };

  // 1. Source S carries the PREVIOUS descriptor (0.3.10 describes base, not S).
  overlay(work);
  writeDescriptor(work, '0.3.10', base);
  git(work, 'commit', '-qam', 'accepted source carrying previous descriptor');
  const source = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const target = path.join(temp, 'target');
  git(temp, 'clone', '-q', '--branch', 'main', origin, target);
  const bin = path.join(target, 'bin', 'ai-verse-os.mjs');

  assert.equal(resolveLocalVersion(target).status, 'unverified');
  const unverified = cli(bin, ['setup', '--dir', target, '--profile', 'detected', '--json']).json();
  assert.equal(unverified.version, 'unknown', 'CLI must not print the previous descriptor label for the accepted source');
  assert.equal(unverified.version_status, 'unverified');
  assert.equal(unverified.release_descriptor_version, '0.3.10');
  const marker = path.join(target, '.aiverse', 'os', 'setup.json');
  assert.notEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).version, '0.3.10');
  assert.equal(cli(bin, ['--version']).out, 'unknown');

  // /version resolves the same source to the accepted label 0.3.11 and the CLI never contradicts it.
  const accepted = { component_id: 'ai-verse-os', version: '0.3.11', revision: source, release_status: 'accepted' };
  const fetchImpl = async (url) => {
    let body = accepted;
    if (url.endsWith('/core_promotions.json')) body = { current_release: 'core-x', release_sets: [{ id: 'core-x', profile: 'core', status: 'released', components: [{ id: 'ai-verse-os', revision: source }] }] };
    else if (url.endsWith('/core_lineage.json')) body = { current_release: 'core-x', release_sets: [] };
    else if (url.endsWith('/release_sets.json')) body = { channels: { core: 'core-x' }, release_sets: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const run = (command, args) => (args[0] === 'status'
    ? { release_set_id: 'core-x', root: target, components: { 'ai-verse-os': { revision: source, state: 'ready' } } }
    : { to: 'core-x', changes: [] });
  const report = await getVersionReport({ root: target, fetchImpl, run });
  assert.equal(report.installed.version, '0.3.11');
  assert.notEqual(unverified.version, '0.3.10');

  // 2. Acceptance commit R touches only release/: the label becomes verified everywhere.
  writeDescriptor(work, '0.3.11', source);
  git(work, 'commit', '-qam', 'accept source');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const update1 = cli(bin, ['update', '--dir', target, '--json']).json();
  assert.equal(update1.version, '0.3.11', 'update output carries the version after the update');
  assert.equal(update1.version_status, 'verified');
  cli(bin, ['setup', '--dir', target, '--profile', 'detected', '--json']);
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).version, '0.3.11');

  // 3. An update that really changes the version: new source plus its acceptance.
  fs.appendFileSync(path.join(work, 'README.md'), '\n');
  git(work, 'commit', '-qam', 'next source');
  const next = git(work, 'rev-parse', 'HEAD');
  writeDescriptor(work, '0.3.12', next);
  git(work, 'commit', '-qam', 'accept next source');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const update2 = cli(bin, ['update', '--dir', target, '--json']).json();
  assert.equal(update2.version, '0.3.12', 'update reports the new version, not the launcher startup label');

  // 4. Launcher and target on different versions: the target's label wins.
  const other = path.join(temp, 'other');
  git(temp, 'clone', '-q', '--branch', 'main', origin, other);
  git(other, 'reset', '-q', '--hard', next + '~0');
  git(other, 'checkout', '-q', '--detach', next);
  writeDescriptor(other, '0.9.9', next);
  git(other, 'commit', '-qam', 'older release label on target');
  const launched = cli(bin, ['setup', '--dir', other, '--profile', 'detected', '--json']).json();
  assert.equal(launched.version, '0.9.9', 'a 0.3.12 launcher must not stamp its own version on another install');
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, '.aiverse', 'os', 'setup.json'), 'utf8')).version, '0.9.9');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write('OS version truth checks passed.\n');
