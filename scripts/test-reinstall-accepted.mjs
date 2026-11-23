#!/usr/bin/env node
// Reinstall must land on the accepted release (not the tip of main), take it from the installer's own
// source, keep every edit the member made, and never print credentials. Uses scratch folders only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve('.');
const cli = path.join(repo, 'bin', 'ai-verse-os.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-verse-reinstall-'));
const home = path.join(temp, 'home');
fs.mkdirSync(home, { recursive: true });
const gitEnv = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function git(cwd, args, allowFailure = false) {
  const g = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv });
  if (!allowFailure) assert.equal(g.status, 0, g.stderr);
  return g.stdout;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const read = (file) => fs.readFileSync(file, 'utf8');

// Throwaway source: commit A is the accepted code, B marks A accepted (release/ only), C is a newer tip of main that is not accepted.
const source = path.join(temp, 'source');
fs.mkdirSync(source, { recursive: true });
const files = git(repo, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter((f) => f && fs.existsSync(path.join(repo, f)) && fs.lstatSync(path.join(repo, f)).isFile());
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(source, f)), { recursive: true });
  fs.copyFileSync(path.join(repo, f), path.join(source, f));
}
git(source, ['init', '-q', '-b', 'main']);
git(source, ['add', '-A']);
git(source, ['commit', '-q', '-m', 'accepted code']);
const acceptedSha = git(source, ['rev-parse', 'HEAD']).trim();
const releaseFile = path.join(source, 'release', 'component-release.json');
const release = JSON.parse(read(releaseFile));
release.release_status = 'accepted';
release.revision = acceptedSha;
write(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
git(source, ['commit', '-q', '-am', 'accept release']);
write(path.join(source, 'README.md'), `${read(path.join(source, 'README.md'))}\nNEWER UNACCEPTED LINE\n`);
write(path.join(source, 'NEWER-ONLY.txt'), 'only on the tip of main\n');
git(source, ['add', '-A']);
git(source, ['commit', '-q', '-m', 'unaccepted newer work']);
const mainTip = git(source, ['rev-parse', 'HEAD']).trim();
assert.notEqual(mainTip, acceptedSha);

function cliRun(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: temp,
    encoding: 'utf8',
    env: { ...gitEnv, AI_VERSE_OS_REPO_URL: source, AI_VERSE_PRIVATE_TOOLCHAIN: 'off', ...env },
  });
}
let counter = 0;
function freshInstall() {
  const target = path.join(temp, `install-${counter += 1}`);
  const r = cliRun(['install', target]);
  assert.equal(r.status, 0, r.stderr);
  return target;
}
const head = (dir) => git(dir, ['rev-parse', 'HEAD']).trim();

try {
  // 1. Install uses the accepted release, not the tip of main.
  const a = freshInstall();
  assert.equal(head(a), acceptedSha);
  assert.ok(!fs.existsSync(path.join(a, 'NEWER-ONLY.txt')));

  // 2. An edited tracked file is backed up, then restored; reinstall lands on the accepted release, not main's tip.
  const readme = path.join(a, 'README.md');
  const original = read(readme);
  write(readme, 'MY OWN EDIT\n');
  write(path.join(a, 'docs', 'note-that-is-new.txt'), 'untracked user file\n');
  let r = cliRun(['reinstall', '--force', '--dir', a, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(read(readme), original);
  assert.equal(head(a), acceptedSha);
  assert.ok(!fs.existsSync(path.join(a, 'NEWER-ONLY.txt')), 'reinstall must not use the tip of main');
  assert.ok(result.backup_dir && result.backup_dir.includes('.aiverse-backups'));
  assert.equal(read(path.join(result.backup_dir, 'README.md')), 'MY OWN EDIT\n');
  assert.deepEqual(result.backed_up_files, ['README.md']);
  assert.equal(read(path.join(a, 'docs', 'note-that-is-new.txt')), 'untracked user file\n');
  assert.match(path.basename(result.backup_dir), /^reinstall-\d{8}T\d{6}Z/);
  // The backup folder is kept out of git.
  assert.equal(git(a, ['status', '--porcelain']).includes('.aiverse-backups'), false);
  assert.match(read(path.join(a, '.git', 'info', 'exclude')), /\.aiverse-backups/);

  // 3. A local commit is saved to the backup ref before it is dropped.
  write(readme, 'COMMITTED LOCAL WORK\n');
  git(a, ['commit', '-q', '-am', 'my own commit']);
  const mine = head(a);
  r = cliRun(['reinstall', '--force', '--dir', a, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const second = JSON.parse(r.stdout);
  assert.match(second.backup_ref, /^refs\/aiverse-backups\/reinstall-/);
  assert.equal(git(a, ['rev-parse', second.backup_ref]).trim(), mine);
  assert.equal(head(a), acceptedSha);
  assert.equal(read(readme), original);

  // 4. The source comes from AI_VERSE_OS_REPO_URL, not from the folder's own origin; a disconnected folder still reinstalls.
  git(a, ['remote', 'remove', 'origin'], true);
  git(a, ['remote', 'add', 'origin', path.join(temp, 'does-not-exist')]);
  write(readme, 'EDIT AFTER DISCONNECT\n');
  r = cliRun(['reinstall', '--force', '--dir', a]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(readme), original);
  assert.equal(head(a), acceptedSha);
  // Update also uses the installer's source.
  r = cliRun(['update', '--dir', a]);
  assert.equal(r.status, 0, r.stderr);

  // 5. Deleted AGENTS.md or AI-VERSE.yaml: reinstall still finds the folder and restores both.
  for (const name of ['AGENTS.md', 'AI-VERSE.yaml']) {
    fs.rmSync(path.join(a, name));
    r = cliRun(['reinstall', '--force', '--dir', a, '--json']);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(a, name)), `${name} restored`);
    assert.ok(JSON.parse(r.stdout).deleted_files_restored.includes(name));
  }
  fs.rmSync(path.join(a, 'AGENTS.md'));
  fs.rmSync(path.join(a, 'AI-VERSE.yaml'));
  r = spawnSync(process.execPath, [cli, 'reinstall', '--force'], { cwd: a, encoding: 'utf8', env: { ...gitEnv, AI_VERSE_OS_REPO_URL: source, AI_VERSE_PRIVATE_TOOLCHAIN: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(a, 'AGENTS.md')) && fs.existsSync(path.join(a, 'AI-VERSE.yaml')));

  // 6. Without --force nothing changes.
  write(readme, 'KEEP ME\n');
  r = cliRun(['reinstall', '--dir', a]);
  assert.notEqual(r.status, 0);
  assert.equal(read(readme), 'KEEP ME\n');
  git(a, ['checkout', '--', 'README.md']);

  // 7. A broken source with credentials in its address: plain error, nothing changed, no credentials shown.
  const secret = 'sekrit-token-12345';
  write(readme, 'EDIT BEFORE BAD SOURCE\n');
  const badUrl = `https://someone:${secret}@127.0.0.1:1/none.git`;
  for (const command of [['reinstall', '--force', '--dir', a], ['reinstall', '--force', '--dir', a, '--json'], ['update', '--dir', a]]) {
    r = cliRun(command, { AI_VERSE_OS_REPO_URL: badUrl });
    assert.notEqual(r.status, 0);
    assert.ok(!(r.stdout + r.stderr).includes(secret), `credentials leaked for ${command.join(' ')}`);
  }
  assert.equal(read(readme), 'EDIT BEFORE BAD SOURCE\n');
  assert.ok(!fs.existsSync(path.join(a, '.aiverse-backups', 'none')));

  console.log('Reinstall accepted release tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
