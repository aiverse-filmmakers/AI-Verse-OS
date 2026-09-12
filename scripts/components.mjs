#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REGISTRY_REL = '.aiverse/extensions/registry.json';
const REGISTRY_LOCK_REL = '.aiverse/extensions/registry.json.lock';
const KNOWN = ['ai-verse-brain', 'ai-verse-memory', 'ai-verse-data'];

function fail(message, code = 2) {
  process.stderr.write(`components: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  let root = process.cwd();
  let json = false;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') {
      if (i + 1 >= argv.length) fail('--root requires a path');
      root = path.resolve(argv[++i]);
    } else if (token === '--json') {
      json = true;
    } else if (token.startsWith('-')) {
      fail(`unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  return { root, json, command: positional[0] || 'doctor' };
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function validateRoot(root) {
  const manifest = path.join(root, 'AI-VERSE.yaml');
  if (!fs.existsSync(manifest) || fs.lstatSync(manifest).isSymbolicLink()) {
    throw new Error(`not a safe AI-Verse OS root: ${root}`);
  }
  const text = fs.readFileSync(manifest, 'utf8');
  if (!/^schema_version:\s*["']?2(?:\.\d+)?["']?\s*$/m.test(text) ||
      !/^architecture:\s*["']?unified-workspace["']?\s*$/m.test(text)) {
    throw new Error('AI-Verse OS host is incompatible with schema v2 unified-workspace');
  }
  return path.resolve(root);
}

function readRegistry(root) {
  const file = path.join(root, REGISTRY_REL);
  if (!fs.existsSync(file)) return { state: 'absent', file, data: { schema_version: '1.0', extensions: {} } };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('local extension registry must be a regular non-symlink file');
  if (stat.size > 1024 * 1024) throw new Error('local extension registry is too large');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`local extension registry is invalid JSON: ${error.message}`); }
  if (!data || data.schema_version !== '1.0' || !data.extensions || typeof data.extensions !== 'object' || Array.isArray(data.extensions)) {
    throw new Error('local extension registry schema is invalid or unsupported');
  }
  return { state: 'present', file, data };
}

function registryLockState(root) {
  const file = path.join(root, REGISTRY_LOCK_REL);
  if (!fs.existsSync(file)) return { state: 'absent', file, diagnostics: [] };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      state: 'unsafe',
      file,
      diagnostics: ['extension registry lock must be a regular non-symlink file'],
    };
  }
  if (stat.size > 64 * 1024) {
    return {
      state: 'unsafe',
      file,
      diagnostics: ['extension registry lock is unexpectedly large'],
    };
  }
  let owner = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        owner = typeof parsed.extension_id === 'string' ? parsed.extension_id : null;
      }
    }
  } catch {
    // A lock is still authoritative even if its informational payload is malformed.
  }
  return {
    state: 'present',
    file,
    owner,
    diagnostics: [
      'extension registry is locked; component attachment mutations will fail closed until the owning installer finishes or an operator verifies an abandoned lock',
      'the OS doctor never steals or deletes registry locks automatically',
    ],
  };
}

function safeAttachedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\') ||
      relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  const candidate = path.join(root, ...parts);
  if (!fs.existsSync(candidate)) return false;
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const resolved = fs.realpathSync(candidate);
  return inside(resolved, fs.realpathSync(root));
}

function attachedComponent(root, registry, id) {
  const entry = registry.data.extensions[id];
  if (entry === undefined) return null;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { id, state: 'incompatible', diagnostics: ['registry entry is not an object'] };
  }
  const diagnostics = [];
  if (entry.id !== undefined && entry.id !== id) diagnostics.push('registry id mismatch');
  if (entry.supported !== true) diagnostics.push('supported is not true');
  if (entry.installed !== true) diagnostics.push('installed is not true');
  if (typeof entry.enabled !== 'boolean') diagnostics.push('enabled is not boolean');
  if (entry.engine && !safeAttachedFile(root, entry.engine)) diagnostics.push('registered engine path is missing or unsafe');
  if (entry.instructions && !safeAttachedFile(root, entry.instructions)) diagnostics.push('registered instructions path is missing or unsafe');
  if (diagnostics.length) return { id, state: 'incompatible', enabled: entry.enabled ?? null, diagnostics };
  return {
    id,
    state: entry.enabled ? 'attached-enabled' : 'attached-disabled',
    enabled: entry.enabled,
    version: typeof entry.version === 'string' ? entry.version : null,
    diagnostics: [],
  };
}

function localEvidence(root, id) {
  if (id === 'ai-verse-brain') {
    return fs.existsSync(path.join(root, 'operator', 'brain', 'installation.json'));
  }
  if (id === 'ai-verse-memory') {
    return fs.existsSync(path.join(root, 'scripts', 'ai-verse-memory', 'memory.py'));
  }
  if (id === 'ai-verse-data') {
    return fs.existsSync(path.join(root, '.aiverse', 'extensions', 'ai-verse-data', 'engine.mjs'));
  }
  return false;
}

function skillsState() {
  const root = path.join(os.homedir(), '.aiverse', 'skills');
  const active = path.join(root, '.aiverse', 'active.json');
  if (!fs.existsSync(active)) return { id: 'aiverse-skills', state: 'absent', root, diagnostics: [] };
  try {
    const data = JSON.parse(fs.readFileSync(active, 'utf8'));
    if (data.schema_version !== 1) return { id: 'aiverse-skills', state: 'incompatible', root, diagnostics: ['unsupported active pointer schema'] };
    if (data.state === 'uninstalled') return { id: 'aiverse-skills', state: 'available-inactive', root, diagnostics: [] };
    if (data.state !== 'active' || typeof data.generation_id !== 'string' || !data.generation_id) {
      return { id: 'aiverse-skills', state: 'incompatible', root, diagnostics: ['malformed active generation pointer'] };
    }
    const generation = path.join(root, '.aiverse', 'generations', data.generation_id);
    const manifest = path.join(generation, '.aiverse', 'installed.json');
    const index = path.join(generation, '.aiverse', 'capability-index.json');
    if (!fs.existsSync(manifest) || !fs.existsSync(index)) {
      return { id: 'aiverse-skills', state: 'incompatible', root, diagnostics: ['active provider generation is incomplete'] };
    }
    return { id: 'aiverse-skills', state: 'available-active', root, generation_id: data.generation_id, diagnostics: [] };
  } catch (error) {
    return { id: 'aiverse-skills', state: 'incompatible', root, diagnostics: [error.message] };
  }
}

function inspect(root) {
  const registry = readRegistry(root);
  const registryLock = registryLockState(root);
  const components = [];
  for (const id of KNOWN) {
    const attached = attachedComponent(root, registry, id);
    if (attached) components.push(attached);
    else if (localEvidence(root, id)) {
      components.push({
        id,
        state: 'available-unattached',
        diagnostics: ['component-owned local state/runtime exists without a local attachment entry'],
      });
    } else {
      components.push({ id, state: 'absent', diagnostics: [] });
    }
  }
  components.push(skillsState());
  const ok =
    components.every(item => item.state !== 'incompatible') &&
    registryLock.state === 'absent';
  return {
    ok,
    root,
    registry: registry.state,
    registry_lock: {
      state: registryLock.state,
      ...(registryLock.owner ? { owner: registryLock.owner } : {}),
      diagnostics: registryLock.diagnostics,
    },
    components,
  };
}

function reconcilePlan(report) {
  const actions = [];
  if (report.registry_lock?.state !== 'absent') {
    actions.push({
      component: 'extension-registry',
      command: 'wait for the owning installer to finish; if no installer is running, inspect .aiverse/extensions/registry.json.lock before removing it manually',
      automatic: false,
      reason: 'The shared extension registry lock is never stolen automatically.',
    });
  }
  for (const item of report.components) {
    if (item.state !== 'available-unattached') continue;
    if (item.id === 'ai-verse-brain') {
      actions.push({
        component: item.id,
        command: `ai-verse-brain attach "${report.root}" --apply`,
        automatic: false,
        reason: 'Brain owns its attachment lifecycle; OS will not synthesize Brain registration.',
      });
    } else if (item.id === 'ai-verse-memory') {
      actions.push({
        component: item.id,
        command: 'rerun the AI-Verse Memory installer against this OS root',
        automatic: false,
        reason: 'Memory owns its versioned attachment metadata and repair lifecycle.',
      });
    } else if (item.id === 'ai-verse-data') {
      actions.push({
        component: item.id,
        command: `ai-verse-data install --root "${report.root}"`,
        automatic: false,
        reason: 'Data owns its extension materialization and registry transaction.',
      });
    }
  }
  return { ...report, mode: 'plan-only', actions, mutated: false };
}

function printHuman(report, reconciliation = false) {
  process.stdout.write(`AI-Verse components ${reconciliation ? 'reconcile' : 'doctor'}\n`);
  process.stdout.write(`Root: ${report.root}\n`);
  if (report.registry_lock?.state !== 'absent') {
    const owner = report.registry_lock?.owner ? ` (owner: ${report.registry_lock.owner})` : '';
    process.stdout.write(`! extension-registry-lock: ${report.registry_lock.state}${owner}\n`);
    for (const diagnostic of report.registry_lock?.diagnostics || []) {
      process.stdout.write(`    ${diagnostic}\n`);
    }
  }
  for (const item of report.components) {
    process.stdout.write(`${item.state === 'incompatible' ? '!' : '-'} ${item.id}: ${item.state}\n`);
    for (const diagnostic of item.diagnostics || []) process.stdout.write(`    ${diagnostic}\n`);
  }
  if (reconciliation) {
    if (!report.actions.length) process.stdout.write('No attachment reconciliation is needed.\n');
    for (const action of report.actions) process.stdout.write(`  next: ${action.command}\n`);
    process.stdout.write('Reconcile is plan-only in the first beta; component-owned installers perform mutations.\n');
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const root = validateRoot(args.root);
  const report = inspect(root);
  if (args.command === 'doctor') {
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report, false);
    if (!report.ok) process.exitCode = 2;
  } else if (args.command === 'reconcile') {
    const plan = reconcilePlan(report);
    if (args.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else printHuman(plan, true);
    if (!report.ok) process.exitCode = 2;
  } else {
    fail(`unknown command: ${args.command}`);
  }
} catch (error) {
  fail(error.message);
}
