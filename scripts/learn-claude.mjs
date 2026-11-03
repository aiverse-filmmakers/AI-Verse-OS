// Turns the configured claude command into a (command, leading args) pair that can be spawned WITHOUT a shell.
//
// POSIX: the name is looked up on PATH by spawn itself, nothing to do.
// Windows: spawn cannot run a .cmd shim without a shell (and cmd.exe quoting of JSON arguments is not safe), so we find the
// file ourselves (PATH x PATHEXT) and look at what it is:
//   claude.exe              spawn it directly (native installer)
//   claude.cmd / .bat shim  the npm shim names a node script ("%dp0%\node_modules\...\cli.js"); run that script with the
//                           current node (process.execPath). Nothing is passed through a shell.
//   anything else           (a PowerShell .ps1 shim included, which is not supported) unresolved: the reviewer is not run (code claude_unresolved) rather than falling back to a shell.
// A configured claude_command whose first item is a .js/.mjs/.cjs file is run with node on every platform.

import fs from 'node:fs';
import path from 'node:path';

const SHIM_TARGET = /"%dp0%[\\/]+([^"%]+\.(?:c|m)?js)"/i;

export function shimTarget(cmdText) {
  const match = SHIM_TARGET.exec(cmdText);
  return match ? match[1] : null;
}

function findOnPath(name, { env, pathMod, fsMod }) {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasExt = exts.includes(pathMod.extname(name).toLowerCase());
  const dirs = pathMod.isAbsolute(name) || /[\\/]/.test(name) ? [''] : (env.PATH || env.Path || '').split(pathMod.delimiter).filter(Boolean);
  // .exe wins over .cmd when both exist
  const order = ['.exe', ...exts.filter((e) => e !== '.exe')];
  for (const dir of dirs) {
    const base = dir ? pathMod.join(dir, name) : name;
    for (const ext of hasExt ? [''] : order) {
      const candidate = base + ext;
      try {
        if (fsMod.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

// Returns { command, args } or { error: 'claude_unresolved' | 'claude_missing' }.
export function resolveClaude(configured, { platform = process.platform, env = process.env, pathMod = path, fsMod = fs, node = process.execPath } = {}) {
  const [name, ...rest] = configured;
  if (/\.(?:c|m)?js$/i.test(name)) return { command: node, args: [name, ...rest] };
  if (platform !== 'win32') return { command: name, args: rest };
  const found = findOnPath(name, { env, pathMod, fsMod });
  if (!found) return { error: 'claude_missing' };
  const ext = pathMod.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: found, args: rest };
  if (ext === '.cmd' || ext === '.bat') {
    let text = '';
    try { text = fsMod.readFileSync(found, 'utf8'); } catch {}
    const target = shimTarget(text);
    const script = target && pathMod.join(pathMod.dirname(found), ...target.split(/[\\/]+/));
    if (script && fsMod.existsSync(script)) return { command: node, args: [script, ...rest] };
  }
  return { error: 'claude_unresolved' };
}
