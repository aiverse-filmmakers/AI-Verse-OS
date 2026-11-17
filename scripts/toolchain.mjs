#!/usr/bin/env node
// The one place AI-Verse OS decides which Node, Python and Git to run.
//
// Order: the private copy the installer keeps for AI-Verse OS first, then a tool
// already on the computer only if it is recent enough. Nothing here ever installs
// through Homebrew or any other package manager, and nothing prompts the member.
// scripts/toolchain.py is the Python twin of resolveTool and must stay in step
// (scripts/test-toolchain.mjs checks both give the same answer).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TOOLS = ['node', 'python', 'git'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = path.join(HERE, '..', 'system', 'toolchain', 'manifest.json');

// Only real programs (.exe on Windows) are ever launched: .cmd and .bat files cannot be started
// safely without a shell, so PATHEXT entries other than .exe are deliberately ignored. The
// Windows "py" launcher is not used either: a private Python is downloaded instead.
const NAMES = {
  node: { posix: ['node'], win32: ['node.exe'] },
  python: { posix: ['python3', 'python'], win32: ['python.exe'] },
  git: { posix: ['git'], win32: ['git.exe'] },
};
// Windows Store "app execution alias" stubs open the Store instead of running anything.
const WINDOWS_STUB = /[\\/]WindowsApps[\\/]/i;
// On macOS these are Apple shims that pop up an install dialog unless the developer tools exist.
const DARWIN_SHIMS = new Set(['/usr/bin/git', '/usr/bin/python3', '/usr/bin/python']);
// Where each tool sits inside its private folder (these match the real archives listed in the manifest).
const PRIVATE_PATHS = {
  node: { posix: ['node/bin/node'], win32: ['node/node.exe'] },
  python: { posix: ['python/bin/python3'], win32: ['python/python.exe'] },
  git: { posix: ['git/bin/git'], win32: ['git/cmd/git.exe', 'git/bin/git.exe'] },
};
const LABEL = { node: 'Node.js', python: 'Python', git: 'Git' };

export const DEFAULT_MINIMUM = { node: '22.0.0', python: '3.9.0', git: '2.25.0' }; // same as the manifest (a test keeps them equal)

// Folders that copy only scripts/ have no manifest: fall back to the built-in minimums and no downloads.
export function loadManifest(file = MANIFEST_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { schema_version: '1.0', minimum: DEFAULT_MINIMUM, sources: {} }; }
}

// Private tools live once per member (not per OS folder) so install can use them
// before the OS folder exists.
export function toolchainDir(env = process.env, home = os.homedir()) {
  return env.AI_VERSE_TOOLCHAIN_DIR || path.join(home, '.aiverse', 'toolchain');
}

// Private preparation is the default. AI_VERSE_PRIVATE_TOOLCHAIN=off exists only for CI and tests.
export function privateToolchainEnabled(env = process.env) {
  return !/^(off|0|false|no)$/i.test(String(env.AI_VERSE_PRIVATE_TOOLCHAIN ?? 'on'));
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

export function atLeast(found, minimum) {
  const a = Array.isArray(found) ? found : parseVersion(found);
  const b = Array.isArray(minimum) ? minimum : parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// Windows environment names are case-insensitive: the key may be Path, PATH or path.
function envKey(env, name) {
  return Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());
}
function envGet(env, name) {
  const key = envKey(env, name);
  return key === undefined ? undefined : env[key];
}

function platformKey(platform) {
  return platform === 'win32' ? 'win32' : 'posix';
}

function defaultRun(file, args) {
  return spawnSync(file, args, { encoding: 'utf8', shell: false, timeout: 15_000, windowsHide: true });
}

// Apple's /usr/bin shims show an install dialog when the developer tools are missing, so they
// are only ever started after xcode-select confirms the tools are really there.
let developerTools;
export function developerToolsInstalled(run = defaultRun) {
  if (run === defaultRun && developerTools !== undefined) return developerTools;
  const result = run('/usr/bin/xcode-select', ['-p']);
  const present = Boolean(result) && !result.error && result.status === 0 && Boolean(String(result.stdout || '').trim());
  if (run === defaultRun) developerTools = present;
  return present;
}

export function versionOf(file, run = defaultRun) {
  const result = run(file, ['--version']);
  if (!result || result.error || result.status !== 0) return null;
  return parseVersion(`${result.stdout || ''} ${result.stderr || ''}`);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function pathCandidates(tool, env, platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(envGet(env, 'PATH') ?? '').split(sep).filter(Boolean);
  const found = [];
  for (const dir of dirs) for (const name of NAMES[tool][platformKey(platform)]) found.push(path.join(dir, name));
  return platform === 'win32' ? found.filter(file => !WINDOWS_STUB.test(file)) : found;
}

// Returns { tool, path, source: 'private' | 'system', version } or { tool, path: null, problem }.
export function resolveTool(tool, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.run || defaultRun;
  const manifest = options.manifest || loadManifest();
  const minimum = parseVersion(manifest.minimum?.[tool]);
  const dir = options.toolchainDir || toolchainDir(env);
  let tooOld = null;

  const tryFile = (file, source) => {
    if (!isFile(file)) return null;
    if (platform === 'darwin' && DARWIN_SHIMS.has(file) && !developerToolsInstalled(run)) return null;
    const version = versionOf(file, run);
    if (!version) return null;
    if (!atLeast(version, minimum)) { tooOld ??= { path: file, version: version.join('.') }; return null; }
    return { tool, path: file, source, version: version.join('.') };
  };

  for (const rel of PRIVATE_PATHS[tool][platformKey(platform)]) {
    const hit = tryFile(path.join(dir, ...rel.split('/')), 'private');
    if (hit) return hit;
  }
  const system = [...(tool === 'node' && options.runningNode !== null ? [options.runningNode || process.execPath] : []), ...pathCandidates(tool, env, platform)];
  for (const file of system) {
    const hit = tryFile(file, 'system');
    if (hit) return hit;
  }
  return { tool, path: null, source: null, version: tooOld?.version ?? null, problem: tooOld ? 'too-old' : 'missing' };
}

export function minimumLabel(tool, manifest = loadManifest()) {
  return String(manifest.minimum?.[tool] ?? '').replace(/(\.0)+$/, '');
}

export function plainProblem(found, manifest = loadManifest(), notes = [], platform = process.platform) {
  const name = LABEL[found.tool];
  const need = `${name} ${minimumLabel(found.tool, manifest)} or newer`;
  if (found.tool === 'git' && platform !== 'win32') {
    // Git has no portable download for macOS or Linux, so the member installs it the official way.
    const how = platform === 'darwin'
      ? 'Open the Terminal app and run: xcode-select --install   (Apple\'s own installer, it asks for nothing else). Then run the AI-Verse OS install again.'
      : 'Install it with your system\'s package manager (for example: sudo apt install git, or sudo dnf install git), then run the AI-Verse OS install again.';
    const state = found.problem === 'too-old' ? `Git on this computer is version ${found.version}, but AI-Verse OS needs ${need}.` : `AI-Verse OS needs ${need}, and it was not found on this computer.`;
    return `${state} Git has to be installed by you on this system. ${how} Nothing on your computer was changed.`;
  }
  const why = notes.find(note => note.includes(name));
  const tail = `${why ? ` ${why}` : ''} Nothing on your computer was changed. Please ask for help in the AI-Verse community.`;
  return found.problem === 'too-old'
    ? `${name} on this computer is version ${found.version}, but AI-Verse OS needs ${need}, and its own copy could not be set up.${tail}`
    : `AI-Verse OS needs ${need}. It was not found on this computer and its own copy could not be set up.${tail}`;
}

// Downloader seam. Tests pass their own; the default fetches the pinned, checksummed
// archive named in system/toolchain/manifest.json. It only ever writes inside the private
// toolchain folder, and never touches a tool the member already has.
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const STALL_MS = 60_000;
const TOTAL_MS = 20 * 60_000;

function tarProgram() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

// Member names come from the plain listing (one name per line, no metadata) and member kinds
// from the verbose listing, so a timestamp format can never hide a name.
function listArchive(archive, tar) {
  const read = flag => {
    const out = spawnSync(tar, [flag, archive], { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (out.error || out.status !== 0) throw new Error('could not read the download');
    return out.stdout.split(/\r?\n/).filter(Boolean);
  };
  return { names: read('-tf'), verbose: read('-tvf') };
}

export function unsafeEntries(names) {
  return names.filter(name => path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..'));
}

// Judge a listing before anything is written: no hard links, no links that leave the folder,
// no absolute or parent-relative names. If anything cannot be worked out, refuse (fail closed).
export function unsafeListing(names, verbose) {
  if (!Array.isArray(names) || !Array.isArray(verbose) || names.length !== verbose.length) return ['listing could not be matched'];
  const bad = [];
  names.forEach((name, index) => {
    const line = verbose[index];
    if (!name || unsafeEntries([name.replace(/\/+$/, '')]).length) { bad.push(name || line); return; }
    if (line[0] === 'h') { bad.push(name); return; }
    if (line[0] === 'l') {
      const at = line.lastIndexOf(' -> ');
      const target = at < 0 ? '' : line.slice(at + 4);
      if (!target) { bad.push(name); return; }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name.replace(/\\/g, '/')), target.replace(/\\/g, '/')));
      if (path.isAbsolute(target) || /^[A-Za-z]:/.test(target) || resolved.startsWith('../') || resolved === '..') bad.push(name);
    }
  });
  return bad;
}

// After unpacking, no link may point outside the unpacked folder.
export function escapingLinks(dir) {
  const root = fs.realpathSync(dir);
  const bad = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(path.dirname(full), fs.readlinkSync(full));
        if (path.isAbsolute(fs.readlinkSync(full)) || (target !== root && !target.startsWith(root + path.sep))) bad.push(full);
      } else if (entry.isDirectory()) walk(full);
      else if (fs.lstatSync(full).nlink > 1) bad.push(full);
    }
  };
  walk(root);
  return bad;
}

function proxySet(env = process.env) {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

// Network seam: returns { length, chunks } where chunks yields Buffers. Stops if no data
// arrives for a minute, or the whole download takes too long.
async function openDownload(url) {
  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(new Error('the download took too long')), TOTAL_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    clearTimeout(total);
    throw new Error(proxySet() ? 'the download could not connect; a network proxy is set on this computer and this installer cannot use proxies yet' : `the download could not connect (${error.cause?.code || error.message})`);
  }
  if (!response.ok || !response.body) { clearTimeout(total); throw new Error(`the download failed (${response.status})`); }
  const length = Number(response.headers.get('content-length')) || null;
  async function* chunks() {
    const reader = response.body.getReader();
    try {
      for (;;) {
        let stall;
        const next = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { stall = setTimeout(() => { controller.abort(); reject(new Error('the download stalled')); }, STALL_MS); }),
        ]).finally(() => clearTimeout(stall));
        if (next.done) return;
        yield Buffer.from(next.value);
      }
    } finally { clearTimeout(total); try { reader.releaseLock(); } catch {} }
  }
  return { length, chunks: chunks(), cancel: () => { try { controller.abort(); } catch {} response.body.cancel().catch(() => {}); } };
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

// `open` is the network seam: tests hand in local bytes, so nothing is downloaded.
export function makeDownloader(open = openDownload, limit = MAX_DOWNLOAD_BYTES) {
  return {
    async install(tool, source, destination) {
      if (!source?.url || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('no trusted download is listed');
      if (!/^https:\/\//.test(source.url)) throw new Error('the download address is not secure');
      const parent = path.dirname(destination);
      ensurePrivateDir(parent);
      const work = fs.mkdtempSync(path.join(parent, `.${tool}-incoming-`));
      let download;
      try {
        download = await open(source.url);
        if (download.length && download.length > limit) throw new Error('the download is larger than expected, so it was refused');
        const archive = path.join(work, 'archive');
        const hash = crypto.createHash('sha256');
        let size = 0;
        const out = fs.openSync(archive, 'w', 0o600);
        try {
          for await (const chunk of download.chunks) {
            size += chunk.length;
            if (size > limit) { download.cancel?.(); throw new Error('the download is larger than expected, so it was refused'); }
            hash.update(chunk);
            for (let at = 0; at < chunk.length;) at += fs.writeSync(out, chunk, at);
          }
        } finally { fs.closeSync(out); }
        if (hash.digest('hex') !== source.sha256) throw new Error('the download did not match its published checksum, so it was thrown away');
        const tar = tarProgram();
        // The listing and the unpack read this same hashed file.
        const listing = listArchive(archive, tar);
        if (unsafeListing(listing.names, listing.verbose).length) throw new Error('the download holds unsafe files (links or paths leaving its folder), so it was refused');
        const staged = path.join(work, 'unpacked');
        fs.mkdirSync(staged, { mode: 0o700 });
        const unpacked = spawnSync(tar, ['-xf', archive, '-C', staged, '--strip-components', String(source.strip ?? 1), '--no-same-owner', '--no-same-permissions'], { shell: false, windowsHide: true });
        if (unpacked.error || unpacked.status !== 0) throw new Error('could not unpack the download');
        if (escapingLinks(staged).length) throw new Error('the download held a link pointing outside its folder, so it was refused');
        clearSpecialBits(staged);
        // Swap in with renames so a half finished download is never left in place.
        const previous = `${destination}.old-${process.pid}`;
        if (fs.existsSync(destination)) fs.renameSync(destination, previous);
        try { fs.renameSync(staged, destination); } catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, destination); throw error; }
        fs.rmSync(previous, { recursive: true, force: true });
      } finally {
        try { download?.cancel?.(); } catch {}
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
export const defaultDownloader = makeDownloader();

// Clear setuid and setgid (and make nothing world-writable) on everything unpacked.
function clearSpecialBits(dir) {
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      const mode = fs.statSync(full).mode;
      if (mode & 0o7022) { try { fs.chmodSync(full, mode & 0o755); } catch {} }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
}

// One install of one tool at a time: a lock folder holding its owner's process id and a random
// token. The owner touches the folder every 30 s while it works; a lock is only broken when it
// has not been touched for longer than the stall limit AND its owner process is gone.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function withToolLock(dir, tool, fn, { waitMs = 5 * 60_000, staleMs = 2 * STALL_MS, pollMs = 200, heartbeatMs = 30_000 } = {}) {
  ensurePrivateDir(dir);
  const lock = path.join(dir, `.${tool}.lock`);
  const ownerFile = path.join(lock, 'owner.json');
  const token = crypto.randomBytes(16).toString('hex');
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const idle = Date.now() - fs.statSync(lock).mtimeMs;
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
        if (idle > staleMs && !processAlive(owner?.pid)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch {}
      if (Date.now() > until) throw new Error(`another AI-Verse OS install is still preparing ${LABEL[tool]}`);
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }));
  const beat = setInterval(() => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {} }, heartbeatMs);
  beat.unref?.();
  try {
    // Leftovers of an interrupted earlier run.
    for (const name of fs.readdirSync(dir)) if (name.startsWith(`.${tool}-incoming-`) || name.startsWith(`${tool}.old-`)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    return await fn();
  } finally {
    clearInterval(beat);
    // Only remove a lock this run still owns.
    try { if (JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token === token) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

// Prepare a private copy of every tool that is missing or too old (on by default), then
// confirm every tool can be found. Returns { ok, tools, problems, notes }. Never throws
// for a missing tool and never prompts. A tool the member already has that is recent
// enough is left alone, and system tools are never changed.
export async function prepareToolchain(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const manifest = options.manifest || loadManifest();
  const dir = options.toolchainDir || toolchainDir(env);
  const downloader = options.downloader || defaultDownloader;
  const enabled = options.privateToolchain ?? privateToolchainEnabled(env);
  const base = { ...options, env, platform, manifest, toolchainDir: dir };
  const notes = [];
  const tools = {};
  const problems = [];

  for (const tool of TOOLS) {
    let found = resolveTool(tool, base);
    if (enabled && !found.path) {
      const source = manifest.sources?.[`${platform}-${options.arch || process.arch}`]?.[tool];
      if (source) {
        try {
          await withToolLock(dir, tool, async () => {
            // Another install may have finished while this one waited.
            clearToolCache();
            if (resolveTool(tool, base).path) return;
            await downloader.install(tool, source, path.join(dir, tool));
          }, options.lock);
        } catch (error) {
          notes.push(`Could not set up AI-Verse OS's own ${LABEL[tool]}: ${error.message}.`);
        }
        clearToolCache();
        found = resolveTool(tool, base);
      }
    }
    tools[tool] = found;
    if (!found.path) problems.push(plainProblem(found, manifest, notes, platform));
  }
  return { ok: problems.length === 0, tools, problems, notes, toolchain_dir: dir };
}

// Environment for child processes. Only the private tool folders are put first on PATH, so
// a tool the member already had is never shadowed by anything unexpected. The member's own
// PATH variable is reused under its existing name (Windows calls it Path).
export function toolEnv(report, env = process.env, platform = process.platform) {
  const dirs = [...new Set(Object.values(report?.tools || {}).filter(t => t?.path && t.source === 'private').map(t => path.dirname(t.path)))];
  const sep = platform === 'win32' ? ';' : ':';
  const key = envKey(env, 'PATH') ?? 'PATH';
  return { ...env, [key]: [...dirs, env[key] ?? ''].filter(Boolean).join(sep) };
}

// Synchronous lookup used by every OS script. Returns a full path or null, never a bare name.
const cache = new Map();
export function clearToolCache() { cache.clear(); developerTools = undefined; }
export function toolPath(tool, options = {}) {
  const key = `${tool}|${envGet(options.env || process.env, 'PATH')}|${(options.env || process.env).AI_VERSE_TOOLCHAIN_DIR ?? ''}`;
  if (!options.run && cache.has(key)) return cache.get(key);
  const found = resolveTool(tool, options).path;
  if (!options.run) cache.set(key, found);
  return found;
}

function cli(argv) {
  const [command, tool] = argv;
  if (command === 'resolve' && TOOLS.includes(tool)) {
    const found = resolveTool(tool);
    if (!found.path) { process.stderr.write(`${plainProblem(found)}\n`); process.exit(1); }
    process.stdout.write(`${found.path}\n`);
    return;
  }
  if (command === 'run') {
    // Used by the launchers: run the named tool from the OS's own copies, passing every argument through untouched.
    const [, name, ...rest] = argv;
    if (!TOOLS.includes(name)) { process.stderr.write('Usage: scripts/ai-verse <node|python|git> [arguments]\n'); process.exit(2); }
    const found = resolveTool(name);
    if (!found.path) { process.stderr.write(`${plainProblem(found)}\n`); process.exit(1); }
    const report = { tools: Object.fromEntries(TOOLS.map(t => [t, resolveTool(t)])) };
    const result = spawnSync(found.path, rest, { stdio: 'inherit', shell: false, env: toolEnv(report) });
    process.exit(result.error ? 1 : (result.status ?? 1));
  }
  if (command === 'path-prefix') {
    // Folders of tools that really resolve to the private copy, for the launchers to put first on PATH.
    const report = { tools: Object.fromEntries(TOOLS.map(t => [t, resolveTool(t)])) };
    const env = toolEnv(report, { PATH: '' });
    process.stdout.write(`${env.PATH}\n`);
    return;
  }
  if (command === 'check') {
    prepareToolchain().then(report => {
      for (const found of Object.values(report.tools)) {
        if (found.path) process.stdout.write(`${LABEL[found.tool]} ${found.version} (${found.source})\n`);
      }
      for (const problem of report.problems) process.stderr.write(`${problem}\n`);
      process.exit(report.ok ? 0 : 1);
    });
    return;
  }
  process.stderr.write('Usage: node scripts/toolchain.mjs check | resolve <node|python|git>\n');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
