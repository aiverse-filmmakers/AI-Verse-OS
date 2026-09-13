#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const COMPONENT_LIFECYCLE_SCHEMA = '1.0';
export const COMPONENT_LIFECYCLE_PROVIDER = 'ai-verse-os/component-lifecycle-v1';

const REGISTRY_REL = '.aiverse/extensions/registry.json';
const REGISTRY_LOCK_REL = '.aiverse/extensions/registry.json.lock';
const PUBLIC_STATES = new Set([
  'absent',
  'installed',
  'setup-required',
  'disabled',
  'unhealthy',
  'migration-required',
  'ready',
]);

const BUILT_INS = Object.freeze({
  'ai-verse-brain': {
    aliases: ['brain'],
    package_source: 'github:aiverse-filmmakers/AI-Verse-Brain',
    setup_requirements: ['owner-controlled attach', 'owner-controlled initialize'],
    supported_lifecycle: ['install', 'setup', 'status', 'doctor', 'enable', 'disable', 'update', 'uninstall'],
    requested_scopes: ['operator', 'workspace:*'],
    requested_capabilities: ['intent', 'goals', 'strategy', 'evaluation'],
    authority_transfer_separate: true,
    uninstall_preserves_canonical_state: true,
  },
  'ai-verse-memory': {
    aliases: ['memory'],
    package_source: 'github:aiverse-filmmakers/AI-Verse-Memory',
    setup_requirements: ['owner-controlled native attachment', 'explicit migration when legacy state exists'],
    supported_lifecycle: ['install', 'setup', 'status', 'doctor', 'enable', 'disable', 'update', 'uninstall'],
    requested_scopes: ['operator', 'workspace:*'],
    requested_capabilities: ['historical-memory', 'recall'],
    authority_transfer_separate: true,
    uninstall_preserves_canonical_state: true,
  },
  'ai-verse-data': {
    aliases: ['data'],
    package_source: 'github:aiverse-filmmakers/AI-Verse-Data',
    setup_requirements: ['owner-controlled native attachment', 'explicit workspace initialization'],
    supported_lifecycle: ['install', 'setup', 'status', 'doctor', 'enable', 'disable', 'update', 'uninstall'],
    requested_scopes: ['workspace:*'],
    requested_capabilities: ['structured-data'],
    authority_transfer_separate: true,
    uninstall_preserves_canonical_state: true,
  },
  'aiverse-skills': {
    aliases: ['skills', 'ai-verse-skills'],
    package_source: 'github:aiverse-filmmakers/AI-Verse-Skills',
    setup_requirements: ['verified immutable active generation', 'OS discoverability'],
    supported_lifecycle: ['install', 'setup', 'status', 'doctor', 'enable', 'disable', 'update', 'uninstall'],
    requested_scopes: ['operator', 'workspace:*'],
    requested_capabilities: ['capability-provider'],
    authority_transfer_separate: true,
    uninstall_preserves_canonical_state: true,
  },
});

const CORE = Object.freeze(['ai-verse-brain', 'ai-verse-memory', 'aiverse-skills', 'ai-verse-data']);
const PROFILES = Object.freeze({
  detected: [],
  os: [],
  core: CORE,
  'five-component': CORE,
});

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function parseArgs(argv) {
  let root = process.cwd();
  let json = false;
  let apply = false;
  let profile = 'detected';
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') {
      if (i + 1 >= argv.length) fail('--root requires a path');
      root = path.resolve(argv[++i]);
    } else if (token === '--json') {
      json = true;
    } else if (token === '--apply') {
      apply = true;
    } else if (token === '--profile') {
      if (i + 1 >= argv.length) fail('--profile requires a value');
      profile = String(argv[++i]).toLowerCase();
    } else if (token.startsWith('-')) {
      fail(`unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (!Object.hasOwn(PROFILES, profile)) fail(`unknown profile: ${profile}`);
  return {
    root,
    json,
    apply,
    profile,
    command: positional[0] || 'doctor',
    component: positional[1] || null,
  };
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function validateRoot(rootInput) {
  const root = path.resolve(rootInput);
  const manifest = path.join(root, 'AI-VERSE.yaml');
  if (!fs.existsSync(manifest) || fs.lstatSync(manifest).isSymbolicLink()) {
    fail(`not a safe AI-Verse OS root: ${root}`);
  }
  const stat = fs.statSync(manifest);
  if (!stat.isFile()) fail('AI-VERSE.yaml must be a regular file');
  const text = fs.readFileSync(manifest, 'utf8');
  if (!/^schema_version:\s*["']?2(?:\.\d+)?["']?\s*$/m.test(text) ||
      !/^architecture:\s*["']?unified-workspace["']?\s*$/m.test(text)) {
    fail('AI-Verse OS host is incompatible with schema v2 unified-workspace');
  }
  return root;
}

function readRegistry(root) {
  const file = path.join(root, REGISTRY_REL);
  if (!fs.existsSync(file)) {
    return { state: 'absent', file, data: { schema_version: '1.0', extensions: {} } };
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('local extension registry must be a regular non-symlink file');
  if (stat.size > 1024 * 1024) fail('local extension registry is too large');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`local extension registry is invalid JSON: ${error.message}`);
  }
  if (!data || data.schema_version !== '1.0' || !data.extensions ||
      typeof data.extensions !== 'object' || Array.isArray(data.extensions)) {
    fail('local extension registry schema is invalid or unsupported');
  }
  return { state: 'present', file, data };
}

function registryLockState(root) {
  const file = path.join(root, REGISTRY_LOCK_REL);
  if (!fs.existsSync(file)) return { state: 'absent', diagnostics: [] };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { state: 'unsafe', diagnostics: ['extension registry lock must be a regular non-symlink file'] };
  }
  if (stat.size > 64 * 1024) {
    return { state: 'unsafe', diagnostics: ['extension registry lock is unexpectedly large'] };
  }
  let owner = null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          typeof parsed.extension_id === 'string') {
        owner = parsed.extension_id;
      }
    }
  } catch {
    // The lock remains authoritative even when its informational payload is malformed.
  }
  return {
    state: 'present',
    ...(owner ? { owner } : {}),
    diagnostics: [
      'extension registry is locked; attachment mutations fail closed until the owning installer finishes',
      'the OS never steals or deletes a component-owned registry lock automatically',
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
  return inside(fs.realpathSync(candidate), fs.realpathSync(root));
}

function normalizeComponentId(value) {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  if (Object.hasOwn(BUILT_INS, lower)) return lower;
  for (const [id, meta] of Object.entries(BUILT_INS)) {
    if (meta.aliases.includes(lower)) return id;
  }
  return lower;
}

function componentResult(id, state, extra = {}) {
  if (!PUBLIC_STATES.has(state)) throw new Error(`invalid public component state: ${state}`);
  return {
    id,
    state,
    health: state === 'ready' ? 'healthy' : (state === 'unhealthy' ? 'unhealthy' : 'unknown'),
    ready: state === 'ready',
    migration_required: state === 'migration-required',
    diagnostics: [],
    ...extra,
  };
}

function attachedComponent(root, registry, id, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return componentResult(id, 'unhealthy', { diagnostics: ['registry entry is not an object'] });
  }

  const diagnostics = [];
  if (entry.id !== undefined && entry.id !== id) diagnostics.push('registry id mismatch');
  if (entry.supported !== true) diagnostics.push('supported is not true');
  if (entry.installed !== true) diagnostics.push('installed is not true');
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') diagnostics.push('enabled is not boolean');
  if (entry.engine && !safeAttachedFile(root, entry.engine)) diagnostics.push('registered engine path is missing or unsafe');
  if (entry.instructions && !safeAttachedFile(root, entry.instructions)) diagnostics.push('registered instructions path is missing or unsafe');

  if (entry.migration_required === true || entry.state === 'migration-required') {
    return componentResult(id, 'migration-required', {
      version: typeof entry.version === 'string' ? entry.version : null,
      diagnostics: diagnostics.length ? diagnostics : ['component reports migration is required'],
    });
  }
  if (diagnostics.length) {
    return componentResult(id, 'unhealthy', {
      version: typeof entry.version === 'string' ? entry.version : null,
      diagnostics,
    });
  }
  if (entry.enabled === false) {
    return componentResult(id, 'disabled', {
      version: typeof entry.version === 'string' ? entry.version : null,
      enabled: false,
    });
  }
  return componentResult(id, 'ready', {
    version: typeof entry.version === 'string' ? entry.version : null,
    enabled: true,
  });
}

function localEvidence(root, id) {
  if (id === 'ai-verse-brain') {
    if (fs.existsSync(path.join(root, '.ai-verse-brain'))) return 'migration-required';
    if (fs.existsSync(path.join(root, 'operator', 'brain', 'installation.json'))) return 'setup-required';
  } else if (id === 'ai-verse-memory') {
    if (fs.existsSync(path.join(root, 'scripts', 'ai-verse-memory', 'memory.py'))) return 'setup-required';
  } else if (id === 'ai-verse-data') {
    if (fs.existsSync(path.join(root, '.aiverse', 'extensions', 'ai-verse-data', 'engine.mjs'))) return 'setup-required';
  }
  return 'absent';
}

function skillsRoot() {
  return path.resolve(process.env.AI_VERSE_SKILLS_ROOT || path.join(os.homedir(), '.aiverse', 'skills'));
}

function skillsState() {
  const root = skillsRoot();
  const active = path.join(root, '.aiverse', 'active.json');
  if (!fs.existsSync(active)) {
    return componentResult('aiverse-skills', fs.existsSync(root) ? 'installed' : 'absent', { root });
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(active, 'utf8'));
  } catch (error) {
    return componentResult('aiverse-skills', 'unhealthy', { root, diagnostics: [error.message] });
  }
  if (data.schema_version !== 1) {
    return componentResult('aiverse-skills', 'migration-required', {
      root,
      diagnostics: ['unsupported active pointer schema'],
    });
  }
  if (data.state === 'uninstalled' || data.state === 'disabled') {
    return componentResult('aiverse-skills', 'disabled', { root });
  }
  if (data.state !== 'active' || typeof data.generation_id !== 'string' || !data.generation_id) {
    return componentResult('aiverse-skills', 'unhealthy', {
      root,
      diagnostics: ['malformed active generation pointer'],
    });
  }
  const generation = path.join(root, '.aiverse', 'generations', data.generation_id);
  const manifest = path.join(generation, '.aiverse', 'installed.json');
  const index = path.join(generation, '.aiverse', 'capability-index.json');
  if (!fs.existsSync(manifest) || !fs.existsSync(index)) {
    return componentResult('aiverse-skills', 'unhealthy', {
      root,
      generation_id: data.generation_id,
      diagnostics: ['active provider generation is incomplete'],
    });
  }
  return componentResult('aiverse-skills', 'ready', {
    root,
    generation_id: data.generation_id,
    version: typeof data.version === 'string' ? data.version : null,
  });
}

function aggregateState(components, required, lock) {
  if (lock.state !== 'absent') return 'unhealthy';
  if (components.some(item => item.state === 'unhealthy')) return 'unhealthy';
  if (components.some(item => item.state === 'migration-required')) return 'migration-required';
  if (components.some(item => item.state === 'setup-required')) return 'setup-required';

  for (const id of required) {
    const item = components.find(candidate => candidate.id === id);
    if (!item || item.state === 'absent' || item.state === 'installed') return 'setup-required';
    if (item.state === 'disabled') return 'disabled';
    if (item.state !== 'ready') return item.state;
  }
  return 'ready';
}

export function inspectComponents(rootInput, profile = 'detected') {
  const root = validateRoot(rootInput);
  if (!Object.hasOwn(PROFILES, profile)) fail(`unknown profile: ${profile}`);
  const registry = readRegistry(root);
  const lock = registryLockState(root);
  const byId = new Map();

  for (const [id, entry] of Object.entries(registry.data.extensions)) {
    byId.set(id, attachedComponent(root, registry, id, entry));
  }

  for (const id of ['ai-verse-brain', 'ai-verse-memory', 'ai-verse-data']) {
    if (!byId.has(id)) {
      const state = localEvidence(root, id);
      byId.set(id, componentResult(id, state, {
        diagnostics: state === 'setup-required'
          ? ['component-owned local runtime/state exists but owner attachment is incomplete']
          : state === 'migration-required'
            ? ['legacy/standalone Brain state requires explicit owner-controlled migration before native attachment']
            : [],
      }));
    }
  }

  byId.set('aiverse-skills', skillsState());

  const components = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const required = [...PROFILES[profile]];
  const state = aggregateState(components, required, lock);
  const notReadyRequired = required.filter(id => components.find(item => item.id === id)?.state !== 'ready');

  return {
    schema_version: COMPONENT_LIFECYCLE_SCHEMA,
    provider: COMPONENT_LIFECYCLE_PROVIDER,
    root,
    profile,
    state,
    health: state === 'ready' ? 'healthy' : (state === 'unhealthy' ? 'unhealthy' : 'not-ready'),
    ready: state === 'ready',
    migration_required: components.some(item => item.state === 'migration-required'),
    required_components: required,
    missing_or_not_ready_required: notReadyRequired,
    registry: {
      schema_version: '1.0',
      state: registry.state,
      path: REGISTRY_REL,
    },
    registry_lock: lock,
    depth_checked: {
      structural: true,
      attachment_discovery: true,
      dependency: true,
      runtime: true,
      operational: false,
      system_composed: true,
    },
    components,
  };
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0;
}

function actionFor(item, report) {
  if (item.state === 'migration-required') {
    return {
      component: item.id,
      kind: 'migration',
      automatic: false,
      command: 'use the component owner migration command documented by that component',
      reason: 'OS setup never silently migrates or transfers a sibling canonical store.',
    };
  }
  if (!['installed', 'setup-required'].includes(item.state)) return null;

  if (item.id === 'ai-verse-brain') {
    return {
      component: item.id,
      kind: 'setup',
      automatic: commandExists('ai-verse-brain'),
      argv: ['ai-verse-brain', 'attach', report.root, '--apply'],
      followup_argv: ['ai-verse-brain', 'init', report.root, '--apply'],
      command: `ai-verse-brain attach "${report.root}" --apply && ai-verse-brain init "${report.root}" --apply`,
      reason: 'Brain owns attachment and initialization. This does not transfer strategic direction to Brain.',
    };
  }
  if (item.id === 'ai-verse-memory') {
    return {
      component: item.id,
      kind: 'setup',
      automatic: false,
      command: 'rerun the AI-Verse Memory owner installer against this OS root',
      reason: 'Memory owns attachment metadata, migration provenance, and canonical Memory lifecycle.',
    };
  }
  if (item.id === 'ai-verse-data') {
    return {
      component: item.id,
      kind: 'setup',
      automatic: false,
      command: `ai-verse-data install --root "${report.root}"`,
      reason: 'Data owns its runtime materialization, registry transaction, and workspace initialization.',
    };
  }
  if (item.id === 'aiverse-skills') {
    return {
      component: item.id,
      kind: 'setup',
      automatic: false,
      command: 'run the AI-Verse Skills owner setup/doctor for the installed immutable generation',
      reason: 'Skills owns immutable generations and readiness verification.',
    };
  }
  return {
    component: item.id,
    kind: 'setup',
    automatic: false,
    command: 'run the extension owner setup command',
    reason: 'OS will not invent lifecycle semantics for an unknown extension.',
  };
}

export function reconcilePlan(report, component = null) {
  const selected = component
    ? report.components.filter(item => item.id === normalizeComponentId(component))
    : report.components;
  const actions = [];
  if (report.registry_lock.state !== 'absent') {
    actions.push({
      component: 'extension-registry',
      kind: 'blocked',
      automatic: false,
      command: 'wait for the owning installer; inspect the lock manually only if it is proven abandoned',
      reason: 'The shared registry lock is never stolen automatically.',
    });
  }
  for (const item of selected) {
    const action = actionFor(item, report);
    if (action) actions.push(action);
  }
  return {
    ...report,
    mode: 'plan',
    component: component ? normalizeComponentId(component) : null,
    actions,
    mutated: false,
  };
}

function runOwnerCommand(argv) {
  const [command, ...args] = argv;
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    env: process.env,
  });
}

export function reconcileApply(report, component = null) {
  const plan = reconcilePlan(report, component);
  const results = [];
  let mutated = false;

  if (report.registry_lock.state !== 'absent') {
    return { ...plan, mode: 'apply', results, mutated: false };
  }

  for (const action of plan.actions) {
    if (!action.automatic || action.component !== 'ai-verse-brain' || !action.argv) {
      results.push({ component: action.component, status: 'skipped', reason: action.reason });
      continue;
    }
    const first = runOwnerCommand(action.argv);
    if (first.status !== 0) {
      results.push({
        component: action.component,
        status: 'failed',
        exit_code: first.status,
        detail: (first.stderr || first.stdout || '').trim(),
      });
      continue;
    }
    if (action.followup_argv) {
      const second = runOwnerCommand(action.followup_argv);
      if (second.status !== 0) {
        results.push({
          component: action.component,
          status: 'failed',
          exit_code: second.status,
          detail: (second.stderr || second.stdout || '').trim(),
        });
        continue;
      }
    }
    mutated = true;
    results.push({ component: action.component, status: 'executed', owner_command: true });
  }

  const refreshed = inspectComponents(report.root, report.profile);
  return {
    ...refreshed,
    mode: 'apply',
    component: component ? normalizeComponentId(component) : null,
    actions: plan.actions,
    results,
    mutated,
  };
}

function genericMetadata(id) {
  return {
    aliases: [],
    package_source: 'extension-owner',
    setup_requirements: ['extension owner setup'],
    supported_lifecycle: ['setup', 'status', 'doctor'],
    requested_scopes: [],
    requested_capabilities: [],
    authority_transfer_separate: true,
    uninstall_preserves_canonical_state: true,
  };
}

function descriptorFor(item) {
  const meta = BUILT_INS[item.id] || genericMetadata(item.id);
  return {
    component_id: item.id,
    version: item.version ?? null,
    compatibility: {
      os_schema: '2.x',
      extension_registry_schema: item.id === 'aiverse-skills' ? null : '1.0',
    },
    package_install_source: meta.package_source,
    setup_requirements: meta.setup_requirements,
    supported_lifecycle_commands: meta.supported_lifecycle,
    current_state: item.state,
    health: item.health,
    readiness: item.ready,
    required_host_version: 'AI-Verse OS schema 2.x',
    migration_requirement: item.migration_required,
    requested_scopes: meta.requested_scopes,
    requested_capabilities: meta.requested_capabilities,
    authority_transfer_separate: meta.authority_transfer_separate,
    uninstall_preserves_canonical_state: meta.uninstall_preserves_canonical_state,
  };
}

function projectComponentReport(report, component) {
  const id = normalizeComponentId(component);
  const current = report.components.find(item => item.id === id) || componentResult(id, 'absent');
  const lockHealthy = report.registry_lock?.state === 'absent';
  const state = lockHealthy ? current.state : 'unhealthy';
  return {
    ...report,
    profile: 'component',
    component: id,
    state,
    health: state === 'ready' ? 'healthy' : (state === 'unhealthy' ? 'unhealthy' : 'not-ready'),
    ready: state === 'ready',
    migration_required: current.migration_required,
    required_components: [id],
    missing_or_not_ready_required: current.state === 'ready' ? [] : [id],
    components: [current],
  };
}

export function lifecycleDescriptor(report, component = null) {
  const selected = component ? projectComponentReport(report, component) : report;
  return {
    schema_version: COMPONENT_LIFECYCLE_SCHEMA,
    provider: COMPONENT_LIFECYCLE_PROVIDER,
    host: {
      os_schema: '2.x',
      registry_schema: '1.0',
      profile: selected.profile,
      state: selected.state,
      ready: selected.ready,
    },
    components: selected.components.map(descriptorFor),
  };
}

function printHuman(report, command) {
  process.stdout.write(`AI-Verse components ${command}\n`);
  process.stdout.write(`Root: ${report.root}\n`);
  process.stdout.write(`State: ${report.state}\n`);
  process.stdout.write(`Ready: ${report.ready ? 'yes' : 'no'}\n`);
  if (report.registry_lock?.state !== 'absent') {
    const owner = report.registry_lock.owner ? ` (owner: ${report.registry_lock.owner})` : '';
    process.stdout.write(`! extension-registry-lock: ${report.registry_lock.state}${owner}\n`);
    for (const diagnostic of report.registry_lock.diagnostics || []) process.stdout.write(`    ${diagnostic}\n`);
  }
  for (const item of report.components || []) {
    process.stdout.write(`${item.state === 'ready' ? '✓' : item.state === 'absent' ? '-' : '!'} ${item.id}: ${item.state}\n`);
    for (const diagnostic of item.diagnostics || []) process.stdout.write(`    ${diagnostic}\n`);
  }
  for (const action of report.actions || []) {
    process.stdout.write(`  next: ${action.command}\n`);
  }
  if (command === 'doctor') {
    process.stdout.write('Depth: structural, attachment/discovery, dependency, runtime, system/composed. Operational owner-specific checks are not claimed here.\n');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = validateRoot(args.root);
  const component = normalizeComponentId(args.component);
  const report = inspectComponents(root, args.profile);

  let output;
  if (args.command === 'status' || args.command === 'doctor') {
    output = component ? projectComponentReport(report, component) : report;
  } else if (args.command === 'reconcile' || args.command === 'setup') {
    output = args.apply ? reconcileApply(report, component) : reconcilePlan(report, component);
    if (component) output = projectComponentReport(output, component);
  } else if (args.command === 'descriptor') {
    output = lifecycleDescriptor(report, component);
  } else {
    fail(`unknown command: ${args.command}`);
  }

  if (args.json || args.command === 'descriptor') process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else printHuman(output, args.command);

  if (args.command !== 'descriptor' && output.ready !== true) process.exitCode = 2;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`components: ${error.message}\n`);
    process.exitCode = Number(error.exitCode ?? 1);
  });
}
