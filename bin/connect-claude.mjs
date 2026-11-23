// Connects Claude Code (and Codex when present) to the AI-Verse learning package by itself (FL-78).
//
// One module, used by install, update, setup and `ai-verse-os connect`. status, doctor and onboard
// only read it (connectionStatus). It never adds a file to the installer required list.
//
// Order of connectAll:
//   1 detect the apps, 2 say what will happen, 3 settle Claude's own memory choice,
//   4 install the learning package when needed, 5 connect Claude (and Codex), 6 verify from the real
//   files, 7 report in plain words with the one action left.
// Everything is idempotent: when the files already show a current connection, no Python runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { TOOLS, toolPath, toolEnv } from '../scripts/toolchain.mjs';

const PACKAGE_ID = 'ai-verse-codex-learning';
const PACKAGE_REL = `system/extensions/packages/${PACKAGE_ID}`;
const INSTALLED_REL = `.aiverse/extensions/${PACKAGE_ID}`;
const CONNECT_REL = '.aiverse/os/connect.json';
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
const CLAUDE_SUBCOMMANDS = ['review', 'sources', 'query', 'intent', 'reflect', 'search-words'];
const CLAUDE_EXPECTED = CLAUDE_EVENTS.length;
const CODEX_EXPECTED_FALLBACK = 6;
const TURN_OFF_COMMAND = 'ai-verse-os connect --turn-off-claude-memory';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Same quoting rule as Python's shlex.quote, so rule text matches what the package wrote.
function shellQuote(value) {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Same splitting rule as Python's shlex.split for the shapes the package writes.
function shellSplit(text) {
  const parts = [];
  let current = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) { current += text[i + 1]; i += 1; }
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      started = true;
      i += 1;
    } else if (/\s/.test(ch)) {
      if (started || current) { parts.push(current); current = ''; started = false; }
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started || current) parts.push(current);
  return parts;
}

function samePath(a, b) {
  const norm = (value) => {
    const text = String(value).replace(/\\/g, '/');
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  return norm(a) === norm(b);
}

function realRoot(root) {
  try { return fs.realpathSync.native(root); } catch { return path.resolve(root); }
}

function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext);
        if (fs.statSync(candidate).isFile()) return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

function exists(file) {
  try { fs.statSync(file); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// 1. Which apps does this member have?
// ---------------------------------------------------------------------------

export function detectApps(env = process.env) {
  // The override exists for tests and CI only: it is ignored unless AI_VERSE_OS_TEST=1.
  const override = env.AI_VERSE_OS_TEST === '1' ? (env.AI_VERSE_OS_APPS || '').trim().toLowerCase() : '';
  if (override) {
    const names = override.split(/[\s,]+/).filter(Boolean);
    return { claude: names.includes('claude'), codex: names.includes('codex'), source: 'override' };
  }
  const home = os.homedir();
  const folders = { claude: [path.join(home, '.claude')], codex: [path.join(home, '.codex')] };
  if (process.platform === 'darwin') {
    folders.claude.push('/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app'));
    folders.codex.push('/Applications/Codex.app', path.join(home, 'Applications', 'Codex.app'));
  } else if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    folders.claude.push(path.join(local, 'AnthropicClaude'), path.join(local, 'Programs', 'claude'));
    folders.codex.push(path.join(local, 'Programs', 'Codex'));
  }
  return {
    claude: onPath('claude') || folders.claude.some(exists),
    codex: onPath('codex') || folders.codex.some(exists),
    source: 'detected',
  };
}

// ---------------------------------------------------------------------------
// Remembered answers (never asked twice)
// ---------------------------------------------------------------------------

function connectFile(root) { return path.join(root, CONNECT_REL); }

export function readChoice(root) {
  const data = readJson(connectFile(root));
  return data && (data.claude_memory === 'off' || data.claude_memory === 'keep') ? data.claude_memory : null;
}

function writeChoice(root, choice, how) {
  const file = connectFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = { schema_version: '1.0', claude_memory: choice, decided_how: how, decided_at: new Date().toISOString() };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 6. Verify from the real files, never from return values
// ---------------------------------------------------------------------------

function packageState(root) {
  const source = path.join(root, PACKAGE_REL);
  const installed = path.join(root, INSTALLED_REL);
  const manifest = readJson(path.join(source, 'PACKAGE.json'));
  if (!manifest || !manifest.files) return { available: false, installed: false, matches: false };
  let matches = true;
  for (const name of Object.keys(manifest.files)) {
    try {
      if (sha256File(path.join(installed, name)) !== sha256File(path.join(source, name))) { matches = false; break; }
    } catch { matches = false; break; }
  }
  const registry = readJson(path.join(root, '.aiverse/extensions/registry.json'));
  const entry = registry?.extensions?.[PACKAGE_ID];
  const registered = Boolean(entry && entry.installed === true);
  const receipt = readJson(path.join(installed, 'install-receipt.json'));
  return { available: true, installed: registered && Boolean(receipt), matches: matches && registered && Boolean(receipt), receipt };
}

function isOurClaudeHandler(handler, root, bridge) {
  if (!handler || handler.type !== 'command' || typeof handler.command !== 'string') return null;
  const parts = shellSplit(handler.command);
  if (!parts || parts.length !== 9) return null;
  if (!/^python(\d+(\.\d+)*)?(\.exe)?$/i.test(path.basename(parts[0].replace(/\\/g, '/')))) return null;
  if (!samePath(parts[1], bridge)) return null;
  if (parts[2] !== '--root' || !samePath(parts[3], root)) return null;
  if (parts[4] !== '--build') return null;
  if (parts[6] !== '--harness' || parts[7] !== 'claude' || parts[8] !== 'hook') return null;
  return { build: parts[5] };
}

function claudeRules(root, python) {
  const prefix = [python, path.join(root, INSTALLED_REL, 'bridge.py'), '--harness', 'claude'].map(shellQuote).join(' ');
  const folder = path.join(root, 'runtime/codex-learning/claude-input').split(path.sep).join('/');
  return [...CLAUDE_SUBCOMMANDS.map((name) => `Bash(${prefix} ${name}:*)`), `Edit(/${folder}/**)`];
}

function claudeRan(root, build) {
  const file = path.join(root, 'runtime/codex-learning/events.jsonl');
  try {
    if (!build || fs.statSync(file).size > 4_000_000) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(-5000);
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row.harness === 'claude' && row.build === build && row.event === 'UserPromptSubmit') return true;
      } catch { /* skip */ }
    }
  } catch { /* no events yet */ }
  return false;
}

function verifyClaude(root, choice) {
  const settingsFile = path.join(root, '.claude/settings.local.json');
  const bridgeFile = path.join(root, INSTALLED_REL, 'bridge.py');
  const record = readJson(path.join(root, INSTALLED_REL, 'claude-adapter.json'));
  const result = {
    hooks_present: 0, hooks_expected: CLAUDE_EXPECTED, hooks_current: 0, allow_rules_present: 0, allow_rules_expected: CLAUDE_SUBCOMMANDS.length + 1,
    memory_off: false, memory_ok: false, ran_in_chat: false, settings_problem: null, current: false,
  };
  let settings = {};
  if (exists(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
    } catch {
      result.settings_problem = 'invalid';
      return result;
    }
  }
  const build = exists(bridgeFile) ? sha256File(bridgeFile) : null;
  const rootReal = realRoot(root);
  for (const event of CLAUDE_EVENTS) {
    const groups = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
    let present = false;
    let current = false;
    for (const group of groups) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        const ours = isOurClaudeHandler(handler, rootReal, path.join(rootReal, INSTALLED_REL, 'bridge.py'));
        if (!ours) continue;
        present = true;
        if (build && ours.build === build) current = true;
      }
    }
    if (present) result.hooks_present += 1;
    if (current) result.hooks_current += 1;
  }
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  if (record?.python) {
    const wanted = claudeRules(rootReal, record.python);
    result.allow_rules_present = wanted.filter((rule) => allow.includes(rule)).length;
  }
  result.memory_off = settings.autoMemoryEnabled === false;
  if (choice === 'keep') result.memory_ok = !(result.memory_off && record?.written_auto_memory === false);
  else if (choice === 'off') result.memory_ok = result.memory_off;
  else result.memory_ok = true;
  result.ran_in_chat = claudeRan(root, build);
  result.current = result.hooks_current === CLAUDE_EXPECTED && result.allow_rules_present === result.allow_rules_expected && result.memory_ok;
  return result;
}

function verifyCodex(root, pkg) {
  const receipt = pkg.receipt;
  const commands = new Set(receipt?.hook_commands || []);
  const expected = Array.isArray(receipt?.handlers) && receipt.handlers.length ? receipt.handlers.length : CODEX_EXPECTED_FALLBACK;
  const hooks = readJson(path.join(root, '.codex/hooks.json'));
  let present = 0;
  for (const groups of Object.values(hooks?.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (commands.has(handler?.command)) present += 1;
      }
    }
  }
  return { hooks_present: present, hooks_expected: expected, current: commands.size > 0 && present === expected };
}

// Read only. Used by status, doctor and onboard, and by connectAll for the before and after check.
export function connectionStatus(root, { apps = detectApps() } = {}) {
  const pkg = packageState(root);
  const choice = readChoice(root);
  const result = {
    apps: { claude: apps.claude, codex: apps.codex },
    package: { available: pkg.available, installed: pkg.installed, matches_release: pkg.matches },
    choice,
    claude: null,
    codex: null,
    connected: false,
    state: 'no-apps',
  };
  if (!apps.claude && !apps.codex) return result;
  if (!pkg.available) { result.state = 'package-missing'; return result; }
  if (!pkg.installed || !pkg.matches) { result.state = 'not-connected'; return result; }
  if (apps.claude) result.claude = verifyClaude(root, choice);
  if (apps.codex) result.codex = verifyCodex(root, pkg);
  const claudeOk = !apps.claude || result.claude.current;
  const codexOk = !apps.codex || result.codex.current;
  result.connected = claudeOk && codexOk;
  result.state = result.connected ? 'connected' : 'not-connected';
  return result;
}

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

function missingWords(status) {
  const missing = [];
  const c = status.claude;
  if (c) {
    if (c.settings_problem) missing.push('Claude settings file for this folder cannot be read');
    else {
      if (c.hooks_current < c.hooks_expected) missing.push(`${c.hooks_expected - c.hooks_current} of ${c.hooks_expected} Claude helpers are off or out of date`);
      if (c.allow_rules_present < c.allow_rules_expected) missing.push('some Claude permissions for the helpers are missing');
      if (!c.memory_ok) missing.push(status.choice === 'keep' ? 'Claude memory is still switched off' : 'Claude memory is still on');
    }
  }
  if (status.codex && !status.codex.current) missing.push(`${status.codex.hooks_expected - status.codex.hooks_present} of ${status.codex.hooks_expected} Codex helpers are off`);
  if (!status.package.installed || !status.package.matches_release) missing.push('the learning package is not installed or differs from this release');
  return missing;
}

export function connectionLines(status) {
  if (status.state === 'no-apps') {
    return ['OS not connected: no Claude Code or Codex was found on this computer.', 'Install Claude Code or Codex, then run: ai-verse-os connect'];
  }
  if (status.state === 'package-missing') {
    return ['OS connection not checked: the learning package is not part of this folder.'];
  }
  const lines = [];
  const c = status.claude;
  const x = status.codex;
  if (status.connected) {
    if (c) lines.push(`OS connected: ${c.hooks_current} of ${c.hooks_expected} helpers on${x ? ' for Claude Code' : ''}.`);
    if (x) lines.push(`OS connected for Codex: ${x.hooks_present} of ${x.hooks_expected} helpers on.`);
    if (c && c.ran_in_chat) lines.push('Claude Code has run them in a chat. Nothing more to do.');
    else if (c) lines.push('One action left: quit and reopen Claude Code in this folder, and say yes if it asks to trust the folder. Then start a new chat.');
    if (x) lines.push('For Codex: open Settings, then Hooks, and trust this folder\'s helpers. Codex does not let a program do that for you.');
    return lines;
  }
  if (c && !c.settings_problem) lines.push(`OS not connected yet: ${c.hooks_current} of ${c.hooks_expected} helpers on${x ? ' for Claude Code' : ''}.`);
  else if (c) lines.push('OS not connected yet: 0 of 5 helpers on.');
  else if (x) lines.push(`OS not connected yet: ${x.hooks_present} of ${x.hooks_expected} Codex helpers on.`);
  if (!lines.length) lines.push('OS not connected yet.');
  for (const item of missingWords(status)) lines.push(`Missing: ${item}.`);
  lines.push('One action: run  ai-verse-os connect  and read what it says.');
  return lines;
}

function failureWords(error) {
  const text = String(error || '');
  if (/read only/.test(text)) return 'A settings file for this folder is read only, so it was left exactly as it was. Make it writable (or move it), then run: ai-verse-os connect';
  if (/not valid JSON|not a JSON object|malformed/.test(text)) return 'Your Claude settings file for this folder (.claude/settings.local.json) could not be read, so it was left exactly as it was. Fix or move that file, then run: ai-verse-os connect';
  if (/edited since install/.test(text)) return 'Someone edited the helper entries in .claude/settings.local.json. They were left exactly as they were. Put them back, or remove the helper entries, then run: ai-verse-os connect';
  if (/preserve locally modified|preserve unsupported|preserve unknown/.test(text)) return 'A helper file in .aiverse/extensions was changed by hand, so it was not replaced. Nothing was overwritten. Ask for help in the AI-Verse community, or move that folder aside and run: ai-verse-os connect';
  if (/Python >=3\.9/.test(text)) return 'The OS could not find a usable Python. Run: ai-verse-os setup, then ai-verse-os connect';
  if (/Node runtime/.test(text)) return 'The OS could not find its Node runtime. Run: ai-verse-os setup, then ai-verse-os connect';
  if (/not a compatible AI-Verse OS/.test(text)) return 'This folder does not look like a complete AI-Verse OS folder.';
  return `The helper installer stopped: ${text.slice(0, 240) || 'no details were given'}. Nothing else was changed. Run: ai-verse-os connect`;
}

// ---------------------------------------------------------------------------
// Running the package
// ---------------------------------------------------------------------------

function runPackage(root, args) {
  const python = toolPath('python');
  if (!python) return { ok: false, error: 'Python is not available. Run: ai-verse-os setup' };
  const env = {
    ...toolEnv({ tools: Object.fromEntries(TOOLS.map((t) => [t, { path: toolPath(t) }])) }),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const script = path.join(root, PACKAGE_REL, 'install.py');
  const result = spawnSync(python, [script, ...args, '--root', root, '--python', python, '--json'], {
    cwd: root, encoding: 'utf8', shell: false, env, windowsHide: true, timeout: 120_000,
  });
  if (result.error) return { ok: false, error: result.error.message };
  let parsed = null;
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && !parsed; i -= 1) {
    try { parsed = JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  if (result.status !== 0 || !parsed || parsed.ok === false) {
    return { ok: false, error: (parsed && parsed.error) || (result.stderr || result.stdout || '').trim().split('\n').pop() || 'unknown error' };
  }
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------
// 3. Claude's own memory: ask once, remember, never flip on update
// ---------------------------------------------------------------------------

async function settleMemoryChoice(root, status, ctx) {
  const requested = ctx.memory; // 'off' | 'keep' | undefined, from an explicit flag
  const known = readChoice(root);
  if (requested) {
    if (requested !== known) writeChoice(root, requested, 'flag');
    return { choice: requested, how: 'flag', asked: false };
  }
  if (known) return { choice: known, how: 'remembered', asked: false };
  // Hand installed earlier with memory already off: keep it as is and remember it.
  if (status.claude && status.claude.memory_off && status.claude.hooks_present > 0) {
    writeChoice(root, 'off', 'existing');
    return { choice: 'off', how: 'existing', asked: false };
  }
  if (ctx.interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer = '';
    try {
      answer = (await rl.question('Claude Code has its own memory, which can answer in place of AI-Verse. Switch it off for this folder only? (y/N) ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    const choice = answer === 'y' || answer === 'yes' ? 'off' : 'keep';
    writeChoice(root, choice, 'asked');
    return { choice, how: 'asked', asked: true };
  }
  // A choice that was never asked is not stored: this run keeps memory on, a later run that can ask will ask.
  return { choice: 'keep', how: 'not asked', asked: false };
}

// ---------------------------------------------------------------------------
// The one function
// ---------------------------------------------------------------------------

export async function connectAll(root, options = {}) {
  const ctx = {
    json: Boolean(options.json),
    interactive: options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.json && !process.env.CI),
    memory: options.memory || null,
    say: options.json ? () => {} : (line = '') => process.stdout.write(`${line}\n`),
  };
  const apps = detectApps();
  const before = connectionStatus(root, { apps });
  const report = (status, extra = {}) => ({ ...status, changed: false, steps: [], notes: [], ...extra });

  if (before.state === 'no-apps') {
    for (const line of connectionLines(before)) ctx.say(line);
    ctx.say('Nothing on your computer was changed.');
    return report(before);
  }
  if (before.state === 'package-missing') {
    for (const line of connectionLines(before)) ctx.say(line);
    return report(before);
  }

  // The memory choice only matters for Claude members.
  let memory = { choice: null, how: null, asked: false };
  const claudeBefore = before.claude;
  const claudeMemoryNeeds = apps.claude;

  // 2. Say first what will happen, but only when something has to change.
  const preChoice = readChoice(root);
  const memoryUnsettled = claudeMemoryNeeds && ctx.interactive && !ctx.memory && !preChoice;
  const needsWork = !before.connected || (ctx.memory && ctx.memory !== preChoice) || memoryUnsettled;
  if (!needsWork) {
    for (const line of connectionLines(before)) ctx.say(line);
    ctx.say('Nothing changed.');
    return report(before, { notes: ['already connected'] });
  }

  ctx.say('Connecting AI-Verse OS to your AI app');
  if (apps.claude) ctx.say('For Claude Code: the OS will switch on its 5 helpers for this folder only (a file in .claude, which is not shared).');
  if (apps.codex) ctx.say('For Codex: the OS will install its 6 helpers for this folder.');
  if (apps.claude) {
    ctx.say('Two steps are Claude\'s own and cannot be done for you: quit and reopen Claude Code, and say yes when it asks to trust this folder.');
    ctx.say('Anything you said in a chat before this connection cannot be saved.');
  }
  ctx.say('');

  if (claudeMemoryNeeds) {
    memory = await settleMemoryChoice(root, { claude: claudeBefore }, ctx);
    if (!memory.asked && memory.how === 'not asked') {
      ctx.say(`Claude's own memory was left on, because this run could not ask you. To switch it off later: ${TURN_OFF_COMMAND}`);
    }
  }

  const steps = [];
  const notes = [];
  let failure = null;

  // 4. The learning package, never claude-install first.
  const pkgNow = packageState(root);
  if (!pkgNow.installed || !pkgNow.matches) {
    const r = runPackage(root, ['install']);
    if (!r.ok) failure = r.error;
    else steps.push('learning package installed');
  }

  // 5. Claude member only: claude-install when hooks are missing, stale or the memory choice changed.
  if (!failure && apps.claude) {
    const mid = connectionStatus(root, { apps });
    if (!mid.claude || !mid.claude.current) {
      const args = ['claude-install'];
      if (memory.choice) args.push('--auto-memory', memory.how === 'not asked' ? 'unasked' : memory.choice);
      const r = runPackage(root, args);
      if (!r.ok) failure = r.error;
      else steps.push('Claude Code helpers switched on');
    }
  }

  // 6. Verify from the real files.
  const after = connectionStatus(root, { apps });
  const changed = steps.length > 0 || Boolean(memory.asked);
  if (failure) {
    ctx.say(failureWords(failure));
    for (const line of connectionLines(after)) ctx.say(line);
    return { ...after, changed, steps, notes, error: String(failure).slice(0, 300), memory_choice: memory.choice };
  }
  if (after.claude && memory.choice === 'off' && !after.claude.memory_off) notes.push('memory switch not confirmed');
  for (const line of connectionLines(after)) ctx.say(line);
  if (apps.claude && memory.choice === 'keep' && memory.how !== 'not asked') ctx.say(`Claude's own memory stays on. To switch it off later: ${TURN_OFF_COMMAND}`);
  if (!changed && after.connected) ctx.say('Nothing changed.');
  return { ...after, changed, steps, notes, memory_choice: memory.choice };
}

// Install, update and setup never fail because of the connection step. A problem is reported in plain words.
export async function connectSafely(root, options = {}) {
  try {
    return await connectAll(root, options);
  } catch (error) {
    const message = failureWords(error?.message);
    if (!options.json) process.stdout.write(`${message}\n`);
    return { state: 'not-connected', connected: false, changed: false, steps: [], notes: [], error: String(error?.message || error).slice(0, 300) };
  }
}
