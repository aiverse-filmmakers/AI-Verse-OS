#!/usr/bin/env node
// Runs the real install command in scratch folders with a fake HOME. The local repo is the source, so nothing is downloaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve('.');
const cli = path.join(repo, 'bin', 'ai-verse-os.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-verse-cli-install-'));
const home = path.join(temp, 'home');
fs.mkdirSync(home, { recursive: true });

// Throwaway source repo built from the working tree, so the test does not depend on which branch (or detached HEAD) the checkout is on.
const source = path.join(temp, 'source');
fs.mkdirSync(source, { recursive: true });
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd, args) {
  const g = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(g.status, 0, g.stderr);
  return g.stdout;
}
const files = git(repo, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter((f) => f && fs.existsSync(path.join(repo, f)) && fs.lstatSync(path.join(repo, f)).isFile());
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(source, f)), { recursive: true });
  fs.copyFileSync(path.join(repo, f), path.join(source, f));
}
git(source, ['init', '-q', '-b', 'main']);
git(source, ['add', '-A']);
git(source, ['commit', '-q', '-m', 'test source']);
// The installer only takes an accepted release: a second commit that touches only release/ points at the first.
const releaseFile = path.join(source, 'release', 'component-release.json');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
release.release_status = 'accepted';
release.revision = git(source, ['rev-parse', 'HEAD']).trim();
fs.writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
git(source, ['commit', '-q', '-am', 'accept release']);

function install(cwd, args = []) {
  return spawnSync(process.execPath, [cli, 'install', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, AI_VERSE_OS_REPO_URL: source, AI_VERSE_PRIVATE_TOOLCHAIN: 'off' },
  });
}
const snapshot = (dir) => fs.readdirSync(dir).sort().join(',');
const fresh = (name) => { const d = path.join(temp, name); fs.mkdirSync(d, { recursive: true }); return d; };

try {
  // 1. The documented line, run in an empty folder, works with no separate clone step.
  const empty = fresh('empty');
  let r = install(empty);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(empty, 'AI-Verse-OS', 'AI-VERSE.yaml')));

  // 2. Same line inside a project that already has files: works, and leaves the member's files alone.
  const project = fresh('project');
  fs.writeFileSync(path.join(project, 'mine.txt'), 'keep');
  r = install(project);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(project, 'mine.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(project, 'AI-Verse-OS', 'AGENTS.md')));

  // 3. Naming a non empty folder: plain message, nothing changed.
  const busy = fresh('busy');
  fs.writeFileSync(path.join(busy, 'mine.txt'), 'keep');
  r = install(temp, ['busy']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing was installed and nothing was changed/);
  assert.match(r.stderr, /npx --yes github:aiverse-filmmakers\/AI-Verse-OS install <new-folder-name>/);
  assert.equal(snapshot(busy), 'mine.txt');

  // 4. Run from inside an installation: already installed, no nested copy.
  const installed = path.join(project, 'AI-Verse-OS');
  const before = snapshot(installed);
  r = install(path.join(installed, 'docs'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already installed/);
  assert.equal(snapshot(installed), before);
  assert.ok(!fs.existsSync(path.join(installed, 'docs', 'AI-Verse-OS')));

  // 5. Naming a new folder inside an installation: plain message, nothing created.
  r = install(installed, ['inner']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside an existing AI-Verse OS/);
  assert.ok(!fs.existsSync(path.join(installed, 'inner')));
  assert.equal(snapshot(installed), before);

  // 6. A file as the target: plain message, nothing changed.
  const fileHome = fresh('filecase');
  fs.writeFileSync(path.join(fileHome, 'file1'), 'keep');
  r = install(fileHome, ['file1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is a file, not a folder/);
  assert.doesNotMatch(r.stderr, /ENOTDIR|\n\s+at /);
  assert.equal(snapshot(fileHome), 'file1');
  assert.equal(fs.readFileSync(path.join(fileHome, 'file1'), 'utf8'), 'keep');

  // 7. An existing EMPTY target works.
  const emptyTarget = path.join(fresh('emptycase'), 'ready');
  fs.mkdirSync(emptyTarget);
  r = install(temp, [emptyTarget]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(emptyTarget, 'AI-VERSE.yaml')));

  // 8. A path with spaces works.
  const spaced = fresh('my project');
  r = install(spaced, ['New Folder']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(spaced, 'New Folder', 'AI-VERSE.yaml')));

  // 9. --json from inside an installation reports no change.
  r = install(path.join(installed, 'docs'), ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.changed, false);
  assert.equal(json.state, 'installed');
  assert.equal(fs.realpathSync(json.root), fs.realpathSync(installed));
  assert.equal(snapshot(installed), before);

  // 10. A symlink pointing into an installation cannot be used to nest a copy.
  const links = fresh('links');
  fs.symlinkSync(path.join(installed, 'docs'), path.join(links, 'sneaky'));
  r = install(links, [path.join('sneaky', 'inner')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside an existing AI-Verse OS/);
  assert.ok(!fs.existsSync(path.join(installed, 'docs', 'inner')));
  fs.symlinkSync(installed, path.join(links, 'direct'));
  r = install(links, ['direct']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already installed/);
  assert.equal(snapshot(installed), before);

  console.log('CLI install tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
