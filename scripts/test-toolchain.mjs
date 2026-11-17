#!/usr/bin/env node
// Prerequisite tests: private toolchain by default, one shared resolver, plain-English
// failures at install, and no script calling bare node, python or git.
// Nothing here downloads anything; the downloader is replaced by a local fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { privateToolchainEnabled, resolveTool, prepareToolchain, loadManifest, atLeast, parseVersion, makeDownloader, unsafeEntries, unsafeListing, withToolLock, plainProblem, toolEnv, toolPath, clearToolCache, TOOLS } from './toolchain.mjs';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = resolveTool('python').path;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-toolchain-'));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

const manifest = { minimum: { node: '22.0.0', python: '3.9.0', git: '2.25.0' }, sources: {} };
function fakeTool(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
}
// A fake runner that answers --version from a table, so no real tool is started.
const versions = new Map();
const run = file => versions.has(file) ? { status: 0, stdout: `tool ${versions.get(file)}\n`, stderr: '' } : { status: 1, error: new Error('no') };
function base(name) {
  const dir = path.join(scratch, name);
  return { dir: path.join(dir, 'private'), bin: path.join(dir, 'bin'), env: (bin) => ({ PATH: bin, AI_VERSE_TOOLCHAIN_DIR: path.join(dir, 'private') }) };
}

// 1. Default provisioning is on; only an explicit off value turns it off.
ok(privateToolchainEnabled({}), 'private toolchain is on by default');
ok(privateToolchainEnabled({ AI_VERSE_PRIVATE_TOOLCHAIN: 'on' }));
ok(!privateToolchainEnabled({ AI_VERSE_PRIVATE_TOOLCHAIN: 'off' }));
ok(Object.keys(loadManifest()).includes('minimum') && loadManifest().minimum.node, 'manifest names minimum versions');
ok(atLeast('22.1.0', '22.0.0') && !atLeast('3.8.9', '3.9.0') && parseVersion('git version 2.39.5 (Apple Git-154)')[1] === 39);

// 2. Resolver order: private first, then a recent enough system tool, never an old one.
{
  const b = base('order');
  const priv = path.join(b.dir, 'git', 'bin', 'git'); const sys = path.join(b.bin, 'git');
  fakeTool(priv, 'x'); fakeTool(sys, 'x');
  versions.set(priv, '2.47.0'); versions.set(sys, '2.50.0');
  let found = resolveTool('git', { manifest, env: b.env(b.bin), platform: 'linux', run });
  eq([found.source, found.path], ['private', priv], 'private beats a newer system copy');
  fs.rmSync(priv);
  found = resolveTool('git', { manifest, env: b.env(b.bin), platform: 'linux', run });
  eq([found.source, found.path], ['system', sys], 'system used when private is absent');
  versions.set(sys, '2.10.0');
  found = resolveTool('git', { manifest, env: b.env(b.bin), platform: 'linux', run });
  eq([found.path, found.problem], [null, 'too-old'], 'old system copy is refused');
  const python = resolveTool('python', { manifest, env: b.env(b.bin), platform: 'linux', run });
  eq(python.problem, 'missing');
}

// 3. Downloader seam: a local fixture stands in for the network, and private wins afterwards.
{
  const b = base('seam'); fakeTool(path.join(b.bin, 'git'), 'x');
  const sources = { 'linux-x64': { node: { url: 'https://example.invalid/n', sha256: 'a'.repeat(64) }, python: { url: 'https://example.invalid/p', sha256: 'b'.repeat(64) }, git: { url: 'https://example.invalid/g', sha256: 'c'.repeat(64) } } };
  const installed = [];
  const downloader = { async install(tool, source, dest) {
    installed.push(tool); ok(source.url.startsWith('https://')); 
    const file = path.join(dest, tool === 'node' ? 'bin/node' : tool === 'python' ? 'bin/python3' : 'bin/git');
    fakeTool(file, 'x'); versions.set(file, tool === 'node' ? '22.5.0' : tool === 'python' ? '3.12.1' : '2.47.0');
  } };
  const withPaths = { ...manifest, sources };
  versions.set(path.join(b.bin, 'git'), '2.40.0');
  const report = await prepareToolchain({ manifest: withPaths, env: b.env(b.bin), platform: 'linux', arch: 'x64', run, downloader, runningNode: null });
  eq(installed.sort(), ['node', 'python'], 'missing tools are prepared by default; a recent enough system Git is left alone');
  ok(report.ok && report.tools.node.source === 'private' && report.tools.python.source === 'private' && report.tools.git.source === 'system');
  // Switched off: nothing is downloaded.
  const b2 = base('seam-off'); installed.length = 0;
  const off = await prepareToolchain({ manifest: withPaths, env: { ...b2.env(b2.bin), AI_VERSE_PRIVATE_TOOLCHAIN: 'off' }, platform: 'linux', arch: 'x64', run, downloader, runningNode: null });
  eq(installed, []); ok(!off.ok);
}

// 3a. The manifest lists pinned, checksummed sources, and Git is only downloadable on Windows.
{
  const real = loadManifest();
  for (const [platform, tools] of Object.entries(real.sources)) for (const [tool, src] of Object.entries(tools)) {
    ok(/^https:\/\//.test(src.url) && /^[a-f0-9]{64}$/.test(src.sha256) && src.version && ['tar.gz', 'zip'].includes(src.archive), `${platform} ${tool} source is complete`);
    ok(atLeast(src.version, real.minimum[tool]), `${platform} ${tool} source meets the minimum`);
  }
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    ok(real.sources[platform].node && real.sources[platform].python, `${platform} has private Node and Python`);
  }
  ok(real.sources['win32-x64'].git && !real.sources['darwin-arm64'].git && !real.sources['linux-x64'].git, 'private Git only where a portable build exists');
}

const local = bytes => async () => ({ length: bytes.length, chunks: (async function* () { for (let i = 0; i < bytes.length; i += 4096) yield bytes.subarray(i, i + 4096); })() });

// 3c. The real downloader, fed local bytes: verifies, unpacks safely, swaps in atomically, refuses bad input.
{
  const dir = path.join(scratch, 'dl'); fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'src', 'node-vX', 'bin'); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'node'), 'fixture'); fs.symlinkSync('node', path.join(src, 'alias'));
  const tgz = path.join(dir, 'a.tar.gz');
  eq(spawnSync('tar', ['-czf', tgz, '-C', path.join(dir, 'src'), 'node-vX']).status, 0);
  const bytes = fs.readFileSync(tgz);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const dl = makeDownloader(local(bytes));
  const dest = path.join(dir, 'tc', 'node');
  await dl.install('node', { url: 'https://example.invalid/a', sha256, strip: 1 }, dest);
  ok(fs.existsSync(path.join(dest, 'bin', 'node')), 'unpacked with the top folder stripped');
  eq(fs.readdirSync(path.join(dir, 'tc')), ['node'], 'no temporary folders left behind');
  // replacing an existing copy keeps exactly one folder
  await dl.install('node', { url: 'https://example.invalid/a', sha256, strip: 1 }, dest);
  eq(fs.readdirSync(path.join(dir, 'tc')), ['node']);
  await assert.rejects(() => dl.install('node', { url: 'https://example.invalid/a', sha256: '0'.repeat(64) }, path.join(dir, 'tc', 'bad')), /checksum/);
  await assert.rejects(() => dl.install('node', { url: 'http://example.invalid/a', sha256 }, path.join(dir, 'tc', 'bad')), /not secure/);
  ok(!fs.existsSync(path.join(dir, 'tc', 'bad')) && fs.readdirSync(path.join(dir, 'tc')).length === 1, 'a refused download leaves nothing behind'); checks += 2;
  // a link that points outside is refused
  fs.symlinkSync('/etc', path.join(src, 'escape'));
  eq(spawnSync('tar', ['-czf', tgz, '-C', path.join(dir, 'src'), 'node-vX']).status, 0);
  const evil = fs.readFileSync(tgz);
  await assert.rejects(() => makeDownloader(local(evil)).install('node', { url: 'https://example.invalid/a', sha256: crypto.createHash('sha256').update(evil).digest('hex'), strip: 1 }, path.join(dir, 'tc', 'evil')), /unsafe files/);
  ok(!fs.existsSync(path.join(dir, 'tc', 'evil')));
  // too big, hard links and escaping links are refused before or while unpacking
  await assert.rejects(() => makeDownloader(local(bytes), 10).install('node', { url: 'https://example.invalid/a', sha256 }, path.join(dir, 'tc', 'big')), /larger than expected/);
  eq(unsafeListing(['a/b', 'n/bin/npm'], ['-rw-r--r--  0 u g 5 Nov 10 12:00 a/b', 'lrwxr-xr-x  0 u g 0 Nov 10 12:00 n/bin/npm -> ../lib/x/npm-cli.js']), [], 'normal files and inside links pass');
  eq(unsafeListing(['a/b'], ['hrw-r--r--  0 u g 0 Nov 10 12:00 a/b link to a/c']).length, 1, 'hard links refused');
  eq(unsafeListing(['n/x', 'n/y'], ['lrwxr-xr-x  0 u g 0 Nov 10 12:00 n/x -> ../../etc/passwd', 'lrwxr-xr-x  0 u g 0 Nov 10 12:00 n/y -> /etc/passwd']).length, 2, 'links leaving the folder refused');
  eq(unsafeListing(['../../etc/evil'], ['-rw-r--r--  0 u g 5 Jan  1  2010 ../../etc/evil']).length, 1, 'old dated entry cannot hide a bad name');
  eq(unsafeListing(['a'], ['-rw-r--r-- 0 u g 5 Jan 1 2010 a', 'extra']).length, 1, 'unmatched listings fail closed');
  // setuid bits are cleared on unpack
  fs.chmodSync(path.join(src, 'node'), 0o4755); fs.rmSync(path.join(src, 'escape'), { force: true });
  eq(spawnSync('tar', ['-czf', tgz, '-C', path.join(dir, 'src'), 'node-vX']).status, 0);
  const suid = fs.readFileSync(tgz);
  await makeDownloader(local(suid)).install('node', { url: 'https://example.invalid/a', sha256: crypto.createHash('sha256').update(suid).digest('hex'), strip: 1 }, path.join(dir, 'tc', 'suid'));
  eq(fs.statSync(path.join(dir, 'tc', 'suid', 'bin', 'node')).mode & 0o7000, 0, 'setuid bit cleared');
  eq(unsafeEntries(['a/b', '../x', '/etc/passwd', 'a/../../b', 'C:/x']).length, 4, 'path escapes are detected');
}

// 3f. Locks: second caller waits, stale locks are broken, leftovers are cleaned.
{
  const dir = path.join(scratch, 'lock'); fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.node-incoming-x')); fs.mkdirSync(path.join(dir, 'node.old-1'));
  const order = [];
  const first = withToolLock(dir, 'node', async () => { order.push('a1'); await new Promise(r => setTimeout(r, 150)); order.push('a2'); }, { pollMs: 20 });
  await new Promise(r => setTimeout(r, 30));
  const second = withToolLock(dir, 'node', async () => { order.push('b'); }, { pollMs: 20 });
  await Promise.all([first, second]);
  eq(order, ['a1', 'a2', 'b'], 'two installs never overlap');
  eq(fs.readdirSync(dir), [], 'lock and leftovers cleaned up');
  // an old lock whose owner is gone is broken; an old lock whose owner is alive is respected
  const lockDir = path.join(dir, '.node.lock');
  fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'x' })); fs.utimesSync(lockDir, 1, 1);
  await withToolLock(dir, 'node', async () => order.push('stale-broken'), { pollMs: 20 });
  ok(order.includes('stale-broken'), 'a stale lock with a dead owner is broken');
  fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'x' })); fs.utimesSync(lockDir, 1, 1);
  await assert.rejects(() => withToolLock(dir, 'node', async () => {}, { waitMs: 60, pollMs: 20 }), /still preparing/);
  fs.rmSync(lockDir, { recursive: true });
  // heartbeat keeps the lock fresh, and a run never removes a lock it no longer owns
  await withToolLock(dir, 'node', async () => {
    const before = fs.statSync(lockDir).mtimeMs; fs.utimesSync(lockDir, 1, 1);
    await new Promise(r => setTimeout(r, 120));
    ok(fs.statSync(lockDir).mtimeMs > 1000 && before > 0, 'heartbeat touches the lock');
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'someone-else' }));
  }, { heartbeatMs: 30 });
  ok(fs.existsSync(lockDir), 'a lock owned by someone else is left alone');
  fs.rmSync(lockDir, { recursive: true });
}

// 3g. Git cannot be downloaded on macOS or Linux: the message tells the member how, in plain words.
{
  const missing = { tool: 'git', path: null, problem: 'missing' };
  const mac = plainProblem(missing, manifest, [], 'darwin'); const linux = plainProblem(missing, manifest, [], 'linux');
  ok(/xcode-select --install/.test(mac) && /Nothing on your computer was changed/.test(mac) && !/brew/i.test(mac), mac);
  ok(/package manager/.test(linux) && /Nothing on your computer was changed/.test(linux) && !/brew/i.test(linux), linux);
  ok(/by you/.test(mac) && /version 2\.1\.0/.test(plainProblem({ ...missing, problem: 'too-old', version: '2.1.0' }, manifest, [], 'linux')));
  ok(/community/.test(plainProblem({ tool: 'python', path: null, problem: 'missing' }, manifest, [], 'darwin')), 'other tools keep the generic message');
}

// 3d. macOS: Apple's /usr/bin shims are never started unless the developer tools are installed.
{
  const started = [];
  const mk = hasTools => (file, args) => { started.push(file); return file === '/usr/bin/xcode-select' ? (hasTools ? { status: 0, stdout: '/Library/Developer/CommandLineTools\n' } : { status: 2, stdout: '' }) : { status: 0, stdout: 'git version 2.39.5' }; };
  const fsStat = fs.statSync; // /usr/bin/git exists on a Mac; elsewhere the shim path is simply absent
  if (fs.existsSync('/usr/bin/git')) {
    const without = resolveTool('git', { manifest, env: { PATH: '/usr/bin', AI_VERSE_TOOLCHAIN_DIR: path.join(scratch, 'none') }, platform: 'darwin', run: mk(false) });
    ok(!without.path && !started.includes('/usr/bin/git'), 'shim never started without developer tools');
    const withTools = resolveTool('git', { manifest, env: { PATH: '/usr/bin', AI_VERSE_TOOLCHAIN_DIR: path.join(scratch, 'none') }, platform: 'darwin', run: mk(true) });
    eq(withTools.path, '/usr/bin/git');
  }
  void fsStat;
}

// 3e. Child environment: the existing PATH key is reused, only private folders go first, cache is cleared after install.
{
  const report = { tools: { node: { path: '/p/node/node.exe', source: 'private' }, git: { path: 'C:\\Git\\git.exe', source: 'system' } } };
  const env = toolEnv(report, { Path: 'C:\\Windows', Other: '1' }, 'win32');
  eq(Object.keys(env).filter(k => k.toUpperCase() === 'PATH'), ['Path'], 'no second PATH key on Windows');
  ok(env.Path.startsWith(path.dirname('/p/node/node.exe')) && env.Path.endsWith('C:\\Windows') && !env.Path.includes('Git'), 'private first, system tools not reordered');
  const b = base('cache'); const priv = path.join(b.dir, 'node', 'bin', 'node');
  const e = { PATH: b.bin, AI_VERSE_TOOLCHAIN_DIR: b.dir }; clearToolCache();
  eq(toolPath('node', { env: e, runningNode: null, manifest }), null, 'missing at first');
  const sources = { [`${process.platform}-x64`]: { node: { url: 'https://example.invalid/n', sha256: 'a'.repeat(64) } } };
  const report2 = await prepareToolchain({ manifest: { ...manifest, sources }, env: e, platform: process.platform, arch: 'x64', run, runningNode: null,
    downloader: { async install() { fakeTool(priv, '22.1.0'); versions.set(priv, '22.1.0'); } } });
  ok(report2.ok === false || report2.tools.node.path, 'prepared');
  eq(toolPath('node', { env: e, runningNode: null, manifest }), priv, 'the cached missing answer is cleared after a tool is installed');
}

// 3b. The Python twin gives the same answer as the JavaScript resolver for the same folders.
{
  const b = base('parity');
  const priv = path.join(b.dir, 'git', 'bin', 'git'); fakeTool(priv, 'git version 2.47.0');
  fakeTool(path.join(b.bin, 'git'), 'git version 2.30.0');
  const env = { ...b.env(b.bin), PATH: b.bin };
  const js = resolveTool('git', { manifest, env, platform: process.platform });
  const py = spawnSync(PYTHON, ['-I', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);import toolchain;print(toolchain.resolve_tool("git"))', path.join(ROOT, 'scripts')], { encoding: 'utf8', env: { ...env, PATH: `${b.bin}` } });
  eq(py.stdout.trim(), js.path, py.stderr);
  fs.rmSync(priv);
  const js2 = resolveTool('git', { manifest, env, platform: process.platform });
  const py2 = spawnSync(PYTHON, ['-I', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);import toolchain;print(toolchain.resolve_tool("git"))', path.join(ROOT, 'scripts')], { encoding: 'utf8', env });
  eq(py2.stdout.trim(), js2.path);
}

// 4. A missing prerequisite is caught at install, in plain words, with a non zero exit and nothing created.
{
  const home = path.join(scratch, 'home'); const empty = path.join(scratch, 'empty-bin'); const target = path.join(scratch, 'inst', 'OS');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(empty, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ai-verse-os.mjs'), 'install', target], {
    encoding: 'utf8', env: { HOME: home, USERPROFILE: home, PATH: empty, TMPDIR: scratch, AI_VERSE_PRIVATE_TOOLCHAIN: 'off' }, shell: false,
  });
  ok(result.status !== 0, 'install exits non zero');
  ok(/Git/.test(result.stderr) && /Python/.test(result.stderr), result.stderr);
  ok(/Nothing on your computer was changed/.test(result.stderr) && !/brew/i.test(result.stderr), 'plain message, no Homebrew');
  ok(!fs.existsSync(target), 'nothing created');
  ok(!fs.existsSync(path.join(home, '.aiverse')), 'nothing written to home when nothing could be prepared');
}

// 4b. A refused install (folder not empty) changes and downloads nothing, even with no tools at all.
{
  const home = path.join(scratch, 'home2'); const empty = path.join(scratch, 'empty-bin2'); const full = path.join(scratch, 'full');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(empty, { recursive: true }); fs.mkdirSync(full, { recursive: true }); fs.writeFileSync(path.join(full, 'x'), '1');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'ai-verse-os.mjs'), 'install', full], { encoding: 'utf8', env: { HOME: home, USERPROFILE: home, PATH: empty, TMPDIR: scratch } });
  ok(result.status !== 0 && /already has files/.test(result.stderr), result.stderr);
  eq(fs.readdirSync(home), [], 'nothing written or downloaded for a refused install');
}

// 5. Lint: no script starts node, python, git or npm by bare name. Everything goes through scripts/toolchain.
{
  // Each entry says why a bare name is acceptable. Keep this list short.
  const allow = {
    'scripts/toolchain.mjs': 'the resolver itself (tar and xcode-select are system programs)',
    'scripts/toolchain.py': 'the resolver itself',
    'scripts/test-toolchain.mjs': 'this test',
    'scripts/ai-verse': 'launcher: finds Node first, then asks the resolver for everything else',
    'scripts/ai-verse.cmd': 'launcher: finds Node first, then asks the resolver for everything else',
    'scripts/check-architecture.sh': 'developer-only repository check, never run for members',
    'system/extensions/packages/ai-verse-codex-learning/inspect_runtime.py': 'developer-only fixture on a throwaway folder',
  };
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'assets', 'archives', 'workspaces', '__pycache__']);
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(full);
  } };
  for (const top of ['bin', 'scripts', 'system', 'apps', 'automations']) if (fs.existsSync(path.join(ROOT, top))) walk(path.join(ROOT, top));
  const T = '(?:node|git|python3?|py|npm|npx|pip3?)(?:\\.exe|\\.cmd)?';
  const bare = `['"]${T}['"]`;
  const byKind = {
    js: [
      new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\\(\\s*${bare}`),
      new RegExp(`\\b(?:command|file|cmd|exe|executable|bin|binary)\\s*[:=]\\s*${bare}`),
      new RegExp(`\\|\\|\\s*${bare}`),
    ],
    py: [
      new RegExp(`(?:subprocess\\.\\w+|Popen|os\\.exec\\w*|os\\.system)\\(\\s*\\[?\\s*${bare}`),
      new RegExp(`shutil\\.which\\(\\s*${bare}`),
      new RegExp(`\\b\\w*(?:cmd|command|argv|args|exe|executable)\\w*\\s*=\\s*\\[\\s*${bare}`, 'i'),
      new RegExp(`\\bor\\s+${bare}`),
    ],
    shell: [
      new RegExp(`^\\s*(?:exec\\s+|\\$\\(\\s*|[A-Za-z_]+=\\$\\(\\s*)?${T}\\s`, 'm'),
      new RegExp(`\\bcommand -v ${T}\\b`),
    ],
  };
  const kindOf = rel => /\.(mjs|js|cjs)$/.test(rel) ? 'js' : /\.py$/.test(rel) ? 'py' : /\.(sh|cmd|bat|ps1)$/.test(rel) || !path.extname(rel) ? 'shell' : null;
  const isTest = rel => /(^|\/)(test[-_][^/]*|[^/]*\.test\.[^/]*)$/.test(rel) || /\/tests?\//.test(rel);
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const kind = kindOf(rel);
    if (!kind || isTest(rel) || rel in allow) continue;
    if (kind === 'shell' && !/^#!.*(sh|bash)/.test(fs.readFileSync(file, 'utf8').slice(0, 80)) && !/\.(cmd|bat|ps1)$/.test(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of byKind[kind]) if (pattern.test(text)) offenders.push(`${rel} matches ${pattern}`);
  }
  eq(offenders, [], `bare tool launches found; use scripts/toolchain: ${offenders.join('; ')}`);
  // The rule must really bite: these lines are what it exists to catch.
  const sample = ['subprocess.run(["git", "status"])', 'cmd = ["node", "x.mjs"]', 'shutil.which("node")', "spawnSync('python3', args)", "const command = 'git'", 'exec node "$ROOT/x.mjs"'];
  ok(sample.every(line => Object.values(byKind).flat().some(re => re.test(line))), 'lint patterns catch the usual bare launches');
}

// 6. The launcher runs the right tool.
if (process.platform !== 'win32') {
  const out = spawnSync(path.join(ROOT, 'scripts', 'ai-verse'), ['node', '-e', 'console.log(process.execPath)'], { encoding: 'utf8', env: { ...process.env, AI_VERSE_TOOLCHAIN_DIR: path.join(scratch, 'none') } });
  eq(out.status, 0, out.stderr);
  ok(path.isAbsolute(out.stdout.trim()), 'launcher runs Node by full path');
  const pfx = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'toolchain.mjs'), 'path-prefix'], { encoding: 'utf8', env: { ...process.env, AI_VERSE_TOOLCHAIN_DIR: path.join(scratch, 'none') } });
  eq(pfx.stdout.trim(), '', 'no private tools resolved, so nothing is put first on PATH');
  const viaNode = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'toolchain.mjs'), 'run', 'node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '', 'a b', '"q"', '%X%'], { encoding: 'utf8', env: { ...process.env, AI_VERSE_TOOLCHAIN_DIR: path.join(scratch, 'none') } });
  eq(JSON.parse(viaNode.stdout), ['', 'a b', '"q"', '%X%'], 'every argument is passed through untouched, including empty ones');
  eq(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'toolchain.mjs'), 'run', 'brew'], { encoding: 'utf8' }).status, 2, 'only node, python and git can be run');
  const bad = spawnSync(path.join(ROOT, 'scripts', 'ai-verse'), ['brew'], { encoding: 'utf8' });
  ok(bad.status !== 0, 'launcher refuses other tools');
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`toolchain tests passed (${checks} checks)`);
