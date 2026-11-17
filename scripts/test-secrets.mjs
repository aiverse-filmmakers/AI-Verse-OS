#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const realScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'secrets.mjs');
const script = realScript;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-secrets-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);

function makeRoot(gitignore = '.env\n.env.*\n!.env.example\n') {
  const root = fs.mkdtempSync(path.join(tmp, 'os-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'probe.mjs'), 'eval(process.argv[2])');
  fs.copyFileSync(realScript, path.join(root, 'scripts', 'secrets.mjs'));
  if (gitignore !== null) fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
  return root;
}
function allow(root, ...lines) { fs.writeFileSync(path.join(root, '.env.allow'), lines.join('\n') + '\n'); }
function run(root, args, input) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'secrets.mjs'), ...args], {
    input, encoding: 'utf8', cwd: root,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp },
  });
}
function allFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

const SECRET = 'sk-test-SECRET-value-12345';

// set writes .env with 0600 and the right content, prints no value
{
  const root = makeRoot();
  const r = run(root, ['set', 'MY_KEY'], `${SECRET}\n`);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'MY_KEY is set.');
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  const f = path.join(root, '.env');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, 'utf8'), `MY_KEY="${SECRET}"\n`);
  // status shows names only
  const s = run(root, ['status']);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /MY_KEY: set/);
  assert.ok(!s.stdout.includes(SECRET) && !s.stderr.includes(SECRET));
  // value is nowhere else
  for (const file of allFiles(tmp)) {
    if (file === f) continue;
    assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), `value leaked into ${file}`);
  }
  // overwrite works, other keys kept, no duplicates
  run(root, ['set', 'OTHER'], 'keep-me-value\n');
  assert.equal(run(root, ['set', 'MY_KEY'], 'second-value\n').status, 0);
  const text = fs.readFileSync(f, 'utf8');
  assert.equal(text, 'MY_KEY="second-value"\nOTHER="keep-me-value"\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
}

// status lists example names as missing, never values
{
  const root = makeRoot();
  fs.writeFileSync(path.join(root, '.env.example'), '# OPENAI_API_KEY=\nFOO_KEY=\n');
  run(root, ['set', 'FOO_KEY'], 'abcdefgh\n');
  const s = run(root, ['status']);
  assert.match(s.stdout, /FOO_KEY: set/);
  assert.match(s.stdout, /OPENAI_API_KEY: missing/);
  assert.ok(!s.stdout.includes('abcdefgh'));
}

// invalid names refused, nothing written, value not echoed
for (const bad of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'GIT_SSH_COMMAND', 'HOME', 'BASH_ENV', 'PYTHONPATH', '1BAD', 'has space', 'A=B', 'a-b', '', '../x', 'X;rm']) {
  const root = makeRoot();
  const r = run(root, ['set', bad], 'topsecretvalue\n');
  assert.notEqual(r.status, 0, `name ${JSON.stringify(bad)} should be refused`);
  assert.ok(!fs.existsSync(path.join(root, '.env')));
  assert.ok(!(r.stdout + r.stderr).includes('topsecretvalue'));
}
// a value passed as an argument is refused
{
  const root = makeRoot();
  const r = run(root, ['set', 'NAME', 'argvalue123'], '');
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(root, '.env')));
}

// refuses when .gitignore does not cover .env
for (const gi of [null, '*.log\n', '.env.*\n', '.env\n!.env\n']) {
  const root = makeRoot(gi);
  const r = run(root, ['set', 'K'], 'v-value-1234\n');
  assert.notEqual(r.status, 0, `gitignore ${JSON.stringify(gi)} should refuse`);
  assert.match(r.stderr, /gitignore/i);
  assert.ok(!fs.existsSync(path.join(root, '.env')));
}

// empty value refused
{
  const root = makeRoot();
  assert.notEqual(run(root, ['set', 'K'], '\n').status, 0);
  assert.notEqual(run(root, ['set', 'K'], 'abc\n').status, 0, 'values under 4 characters are refused');
  assert.ok(!fs.existsSync(path.join(root, '.env')));
}

// newline, quote, backslash, dollar and hash handling round trips
{
  const root = makeRoot();
  const tricky = 'a"b\'c\\d\ne$HOME#f g\r\nh';
  allow(root, `${process.execPath} probe.mjs`);
  assert.equal(run(root, ['set', 'TRICKY'], `${tricky}\n`).status, 0);
  const r = run(root, ['run', '--', process.execPath, 'probe.mjs', 'process.stdout.write(String(process.env.TRICKY === ' + JSON.stringify(tricky) + '))']);
  assert.equal(r.stdout, 'true', r.stderr);
  // file stays one line per key
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').length, 2);
}

// run injects variables, returns the exit code, hides values in output
{
  const root = makeRoot();
  allow(root, `${process.execPath} probe.mjs`);
  run(root, ['set', 'MY_KEY'], `${SECRET}\n`);
  const ok = run(root, ['run', '--', process.execPath, 'probe.mjs', 'process.stdout.write(process.env.MY_KEY.length + ":" + (process.env.MY_KEY === ' + JSON.stringify(SECRET) + '))']);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, `${SECRET.length}:true`);
  const code = run(root, ['run', '--', process.execPath, 'probe.mjs', 'process.exit(7)']);
  assert.equal(code.status, 7);
  const leak = run(root, ['run', '--', process.execPath, 'probe.mjs', 'console.log("key=" + process.env.MY_KEY); console.error("err " + process.env.MY_KEY)']);
  assert.ok(!leak.stdout.includes(SECRET) && !leak.stderr.includes(SECRET));
  assert.match(leak.stdout, /key=\[hidden\]/);
  assert.match(leak.stderr, /err \[hidden\]/);
  // a value split across output chunks is still hidden
  const split = run(root, ['run', '--', process.execPath, 'probe.mjs',
    `const v=process.env.MY_KEY;process.stdout.write("x"+v.slice(0,9));setTimeout(()=>process.stdout.write(v.slice(9)+"y"),100)`]);
  assert.ok(!split.stdout.includes(SECRET));
  assert.equal(split.stdout, 'x[hidden]y');
  allow(root, 'definitely-not-a-command-xyz');
  const missing = run(root, ['run', '--', 'definitely-not-a-command-xyz']);
  assert.equal(missing.status, 127);
  assert.notEqual(run(root, ['run']).status, 0);
}

// run refuses without a member owned allow list, and for unlisted commands
{
  const root = makeRoot();
  run(root, ['set', 'MY_KEY'], `${SECRET}\n`);
  const probe = ['run', '--', process.execPath, 'probe.mjs', 'process.stdout.write("RAN")'];
  let r = run(root, probe);
  assert.notEqual(r.status, 0); assert.ok(!r.stdout.includes('RAN'));
  assert.match(r.stderr, /\.env\.allow/);
  allow(root, 'some-other-command');
  r = run(root, probe);
  assert.notEqual(r.status, 0); assert.ok(!r.stdout.includes('RAN'));
  allow(root, '# comment', `${process.execPath} probe.mjs`);
  r = run(root, probe);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'RAN');
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  allow(root, `${process.execPath} -e`);
  r = run(root, ['run', '--', process.execPath, '-e', '1']);
  assert.notEqual(r.status, 0, 'interpreter with only flags is refused');
  assert.match(r.stderr, /exact command/);
  for (const bare of ['node', 'python3', 'sh', 'bash', 'env', 'git', 'npx', 'curl', 'wget', 'python', 'zsh', 'git -C']) {
    allow(root, bare);
    r = run(root, ['run', '--', ...bare.split(' ')]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /exact command/, bare);
  }
  allow(root, `${process.execPath} ./tool.mjs`);
  fs.writeFileSync(path.join(root, 'tool.mjs'), 'process.stdout.write("RAN")');
  r = run(root, ['run', '--', process.execPath, './tool.mjs']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'RAN');
  allow(root, `${process.execPath} probe.mjs`);
  // a forbidden name already in .env is never injected
  fs.appendFileSync(path.join(root, '.env'), 'NODE_OPTIONS="--no-warnings"\n');
  r = run(root, ['run', '--', process.execPath, 'probe.mjs', 'process.stdout.write(String(process.env.NODE_OPTIONS))']);
  assert.equal(r.stdout, 'undefined');
}

// temp file and .env safety
{
  const root = makeRoot();
  // .env as a symlink is refused, target untouched
  const target = path.join(tmp, 'elsewhere.txt');
  fs.writeFileSync(target, 'original\n');
  fs.symlinkSync(target, path.join(root, '.env'));
  assert.notEqual(run(root, ['set', 'K'], 'value-1234\n').status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
  fs.unlinkSync(path.join(root, '.env'));
  // .env as a folder is refused and leaves no temp file
  fs.mkdirSync(path.join(root, '.env'));
  assert.notEqual(run(root, ['set', 'K'], 'value-1234\n').status, 0);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.env.tmp')), []);
  fs.rmdirSync(path.join(root, '.env'));
  // a link pre-created at a guessable temp name is not followed
  fs.symlinkSync(target, path.join(root, `.env.tmp-${process.pid}`));
  assert.equal(run(root, ['set', 'K'], 'value-1234\n').status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.env.tmp') && n !== `.env.tmp-${process.pid}`), []);
}

// AI_VERSE_OS_ROOT cannot point the helper at another folder, and the cwd is ignored
{
  const own = makeRoot();
  const other = makeRoot();
  const r = spawnSync(process.execPath, [path.join(own, 'scripts', 'secrets.mjs'), 'set', 'K'], {
    input: 'value-1234\n', encoding: 'utf8', cwd: other,
    env: { PATH: process.env.PATH, HOME: home, AI_VERSE_OS_ROOT: other },
  });
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(other, '.env')) && !fs.existsSync(path.join(own, '.env')));
  const r2 = spawnSync(process.execPath, [path.join(own, 'scripts', 'secrets.mjs'), 'set', 'K'], {
    input: 'value-1234\n', encoding: 'utf8', cwd: other, env: { PATH: process.env.PATH, HOME: home },
  });
  assert.equal(r2.status, 0);
  assert.ok(fs.existsSync(path.join(own, '.env')) && !fs.existsSync(path.join(other, '.env')));
}

// the shipped settings keep the agent out of the helper and its own permissions
{
  const settings = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '..', '.claude', 'settings.json'), 'utf8'));
  const { allow, deny, ask } = settings.permissions;
  for (const rule of ['Edit(./scripts/secrets.mjs)', 'Write(./scripts/secrets.mjs)', 'Edit(./.claude/settings.json)', 'Write(./.claude/settings.json)', 'Edit(./.env.allow)', 'Write(./.env.allow)', 'Read(**/.env)']) {
    assert.ok(deny.includes(rule), `deny rule missing: ${rule}`);
  }
  assert.ok(ask.includes('Bash(node scripts/secrets.mjs run *)'));
      assert.ok(!(settings.sandbox.excludedCommands || []).length, 'no helper command may skip the sandbox');
  assert.ok(!(allow || []).some((r) => /secrets\.mjs/.test(r)), 'set, status and run must all ask');
  assert.ok(ask.includes('Bash(node scripts/secrets.mjs set *)') && ask.includes('Bash(node scripts/secrets.mjs status)'));
  assert.ok(!settings.sandbox.filesystem.denyWrite.includes('scripts'), 'the whole scripts folder must stay writable');
  for (const p of ['scripts/secrets.mjs', '.env', '.env.allow', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks']) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(p), `denyWrite missing ${p}`);
  }
  assert.ok(!deny.includes('Edit(**/.env.*)') && !deny.includes('Write(**/.env.*)'), 'example files must stay editable');
}

// the value never appears in a process argument (set reads stdin only)
{
  const src = fs.readFileSync(script, 'utf8');
  assert.ok(!/process\.argv\.slice\(2\)\[1\]/.test(src));
}

console.log('secrets helper tests passed');
