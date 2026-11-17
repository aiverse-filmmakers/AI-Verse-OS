#!/usr/bin/env node
// The one place a member's API keys live: `.env` at the AI-Verse OS root.
// Commands: set NAME (value from stdin or a hidden prompt), status, run -- <approved command>.
// Output hiding in `run` is only a convenience for accidental printing, not a protection: an approved
// command receives the keys and could send them anywhere. Values are never printed by this helper, never put in process arguments, and never written anywhere but `.env`.
// Private toolchain launcher (scripts/ai-verse) is not required: run with `node scripts/secrets.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MIN_SCRUB_LENGTH = 4;
const MIN_VALUE_LENGTH = 4;
const FORBIDDEN_NAMES = new Set(['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'HOME', 'SHELL', 'IFS', 'BASH_ENV', 'ENV', 'NODE_PATH']);

// Names that change how programs start or behave are never stored or injected.
export function isForbiddenName(name) {
  const n = String(name).toUpperCase();
  return FORBIDDEN_NAMES.has(n) || n.startsWith('DYLD_') || n.startsWith('GIT_') || n.startsWith('LD_');
}

// The root is always the folder that contains this script (resolved through links), never the
// current folder. AI_VERSE_OS_ROOT is only accepted when it names that same folder.
export function osRoot() {
  const own = path.resolve(fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))), '..');
  const asked = process.env.AI_VERSE_OS_ROOT;
  if (asked) {
    let real;
    try { real = fs.realpathSync(asked); } catch { real = null; }
    if (real !== own) throw new Error('AI_VERSE_OS_ROOT does not match the folder this script lives in, so nothing was done.');
  }
  return own;
}

const BARE_INTERPRETERS = new Set(['node', 'python', 'python3', 'sh', 'bash', 'zsh', 'env', 'git', 'npx', 'curl', 'wget']);

// Returns the first .env.allow line that is only an interpreter (with or without flags), or null.
function bareInterpreterEntry(lines) {
  for (const l of lines) {
    const parts = l.split(/\s+/);
    if (BARE_INTERPRETERS.has(path.basename(parts[0])) && parts.slice(1).every((p) => p.startsWith('-'))) return l;
  }
  return null;
}

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// True when .gitignore ignores the root `.env` file (last matching rule wins).
export function envIsIgnored(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return false; }
  let ignored = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (['.env', '/.env', '.env*', '/.env*', '**/.env'].includes(pattern)) ignored = !negated;
  }
  return ignored;
}

function unescapeDouble(s) {
  return s.replace(/\\([\\"nr])/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));
}

function escapeDouble(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

export function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = unescapeDouble(v.slice(1, -1));
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

function readEnv(root) {
  const file = path.join(root, '.env');
  let st;
  try { st = fs.lstatSync(file); } catch { return new Map(); }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('.env is not a plain file (it is a link or a folder), so it was not used.');
  try { return parseEnv(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') throw new Error('This command cannot read .env from inside the sandbox. The member must approve running it outside the sandbox.');
    return new Map();
  }
}

// Member owned list of commands that may receive keys: one command prefix per line.
export function allowedToRun(root, argv) {
  const file = path.join(root, '.env.allow');
  let text;
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    text = fs.readFileSync(file, 'utf8');
  } catch { return false; }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const bare = bareInterpreterEntry(lines);
  if (bare) throw new Error(`The line "${bare}" in .env.allow lists only a program like node or git, which would let it run anything with your keys. List the exact command instead, for example: npm test. Nothing was run.`);
  return lines.some((l) => {
    const parts = l.split(/\s+/);
    return parts.length <= argv.length && parts.every((p, i) => p === argv[i]);
  });
}

export function setSecret(root, name, value) {
  if (!isValidName(name)) throw new Error('That is not a valid variable name. Use letters, digits and underscores, starting with a letter or underscore.');
  if (isForbiddenName(name)) throw new Error('That name changes how programs start (like PATH or NODE_OPTIONS), so it is not allowed here.');
  if (!envIsIgnored(root)) throw new Error('Refusing to write: .gitignore does not cover .env, so the key could be committed. Add `.env` to .gitignore first.');
  if (typeof value !== 'string' || value.length < MIN_VALUE_LENGTH) throw new Error('The value is empty or shorter than 4 characters, so nothing was saved.');
  if (value.includes('\0')) throw new Error('The value contains a null character, so nothing was saved.');
  const file = path.join(root, '.env');
  let st = null;
  try { st = fs.lstatSync(file); } catch { /* new file */ }
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error('Refusing to write: .env is not a plain file (it is a link or a folder). Remove it yourself and try again.');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { /* new file */ }
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entry = `${name}="${escapeDouble(value)}"`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  let replaced = false;
  lines = lines.filter((l) => {
    if (!re.test(l)) return true;
    if (replaced) return false;
    replaced = true;
    return true;
  }).map((l) => (re.test(l) ? entry : l));
  if (!replaced) lines.push(entry);
  const tmp = `${file}.tmp-${crypto.randomBytes(12).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600); // fails if the name already exists, even as a link
    fs.writeSync(fd, lines.join('\n') + '\n');
    fs.closeSync(fd); fd = undefined;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* already renamed or never created */ }
  }
}

export function statusList(root) {
  const env = readEnv(root);
  const names = new Set(env.keys());
  try {
    for (const k of parseEnv(fs.readFileSync(path.join(root, '.env.example'), 'utf8')).keys()) names.add(k);
  } catch { /* no example */ }
  try {
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    for (const raw of example.split(/\r?\n/)) {
      const m = /^#\s*([A-Z_][A-Z0-9_]*)\s*=\s*$/.exec(raw.trim());
      if (m) names.add(m[1]);
    }
  } catch { /* none */ }
  return [...names].sort().map((n) => ({ name: n, state: env.get(n) ? 'set' : 'missing' }));
}

function variants(value) {
  const set = new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64')]);
  return [...set].filter((v) => v.length >= MIN_SCRUB_LENGTH);
}

function makeScrubber(values, write) {
  const needles = values.flatMap(variants).sort((a, b) => b.length - a.length);
  const keep = needles.length ? Math.max(...needles.map((n) => n.length)) - 1 : 0;
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const clean = (s) => needles.reduce((acc, n) => acc.split(n).join('[hidden]'), s);
  return {
    push(chunk) {
      const s = clean(carry + decoder.write(chunk));
      const cut = Math.max(0, s.length - keep);
      carry = s.slice(cut);
      if (cut) write(s.slice(0, cut));
    },
    end() {
      const s = clean(carry + decoder.end());
      carry = '';
      if (s) write(s);
    },
  };
}

export function runWithSecrets(root, argv) {
  return new Promise((resolve) => {
    if (!argv.length) { process.stderr.write('Nothing to run. Usage: secrets run -- <command> [args]\n'); resolve(2); return; }
    let allowed;
    try { allowed = allowedToRun(root, argv); } catch (e) { process.stderr.write(`${e.message}\n`); resolve(1); return; }
    if (!allowed) {
      process.stderr.write('This command is not on your approved list, so it was not run and no keys were given to it. To allow it, add a line with the command (for example: node my-tool.mjs) to the .env.allow file in the OS folder yourself. Only list commands you trust: they receive your keys and could send them anywhere. See .env.allow.example.\n');
      resolve(1); return;
    }
    let env;
    try { env = readEnv(root); } catch (e) { process.stderr.write(`${e.message}\n`); resolve(1); return; }
    for (const k of [...env.keys()]) if (isForbiddenName(k)) env.delete(k);
    const child = spawn(argv[0], argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, ...Object.fromEntries(env) },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const values = [...env.values()].filter(Boolean);
    const out = makeScrubber(values, (s) => process.stdout.write(s));
    const err = makeScrubber(values, (s) => process.stderr.write(s));
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      process.stderr.write(`Could not start the command: ${e.code || 'error'}\n`);
      resolve(e.code === 'ENOENT' ? 127 : 126);
    });
    child.on('close', (code, signal) => {
      out.end(); err.end();
      resolve(code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9 })[signal] || 1) : 1));
    });
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function hiddenPrompt(label) {
  return new Promise((resolve) => {
    process.stderr.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const USAGE = `Usage:
  node scripts/secrets.mjs set NAME        save a key (value from stdin or a hidden prompt, never as an argument)
  node scripts/secrets.mjs status          list key names as set or missing, never values
  node scripts/secrets.mjs run -- <cmd>    run one command from your .env.allow list with the keys available to it
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    const root = osRoot();
    if (cmd === 'set') {
      if (rest.length !== 1) { process.stderr.write('Give just the name, for example: set OPENAI_API_KEY. The value is read from stdin or a hidden prompt, never from arguments.\n'); return 2; }
      const name = rest[0];
      if (!isValidName(name)) { process.stderr.write('That is not a valid variable name. Use letters, digits and underscores, starting with a letter or underscore.\n'); return 2; }
      if (!envIsIgnored(root)) { process.stderr.write('Refusing to write: .gitignore does not cover .env, so the key could be committed. Add `.env` to .gitignore first.\n'); return 1; }
      let value;
      if (process.stdin.isTTY) value = await hiddenPrompt(`Value for ${name} (hidden): `);
      else value = (await readStdin()).replace(/\r?\n$/, '');
      setSecret(root, name, value);
      process.stdout.write(`${name} is set.\n`);
      return 0;
    }
    if (cmd === 'status') {
      const rows = statusList(root);
      if (!rows.length) process.stdout.write('No keys yet. Save one with: node scripts/secrets.mjs set NAME\n');
      for (const r of rows) process.stdout.write(`${r.name}: ${r.state}\n`);
      return 0;
    }
    if (cmd === 'run') {
      const i = rest.indexOf('--');
      return await runWithSecrets(root, i === -1 ? rest : rest.slice(i + 1));
    }
    process.stderr.write(USAGE);
    return cmd ? 2 : 0;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
