#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS, prepareToolchain, resolveTool, toolPath, toolEnv } from '../scripts/toolchain.mjs';

// The OS version has one authority: release/component-release.json (the accepted
// release descriptor). The CLI never carries its own number, and it asks the
// TARGET install (not this launcher) to resolve the label, so a global CLI of one
// version never stamps its own version on another install. The target's
// scripts/os-version.mjs verifies the descriptor describes the checked out source
// before the label is trusted; otherwise the label is reported as unverified.
// package.json's version is only an npm placeholder and is not the OS version.
const LAUNCHER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function versionFields(root) {
  const unknown = { version: 'unknown', version_status: 'unverified', release_descriptor_version: null };
  try {
    const result = spawnSync(toolPath('node') || process.execPath, [path.join(root, 'scripts', 'os-version.mjs'), '--local', '--root', root], {
      encoding: 'utf8', shell: false, timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return unknown;
    const info = JSON.parse(result.stdout);
    return {
      version: info.status === 'verified' && typeof info.version === 'string' && info.version ? info.version : 'unknown',
      version_status: info.status === 'verified' ? 'verified' : 'unverified',
      release_descriptor_version: typeof info.descriptor_version === 'string' ? info.descriptor_version : null,
    };
  } catch {
    return unknown;
  }
}

const LIFECYCLE_SCHEMA = '1.0';
const SETUP_SCHEMA = '1.0';
const DEFAULT_REPO = 'https://github.com/aiverse-filmmakers/AI-Verse-OS.git';
const REPO_URL = process.env.AI_VERSE_OS_REPO_URL || DEFAULT_REPO;
const INSTALL_COMMAND = 'npx --yes https://codeload.github.com/aiverse-filmmakers/AI-Verse-OS/tar.gz/main install';
const SETUP_MARKER_REL = '.aiverse/os/setup.json';

// Remove credentials from any text before it is shown: user:password@ in an address, and token style query values.
function redact(text) {
  return String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\/\s@]+@/gi, '$1')
    .replace(/([?&#;][^=&#;\s]*(?:token|password|passwd|pass|secret|key|auth|sig|credential)[^=&#;\s]*=)[^&#;\s]*/gi, '$1***');
}

const redactUrl = redact;

function out(message = '') {
  process.stdout.write(`${message}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`AI-Verse OS: ${redact(message)}\n`);
  process.exit(code);
}

function emit(value, json = false) {
  if (json) out(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') out(value);
  else out(JSON.stringify(value, null, 2));
}

// Node, Python and Git always run from the OS's own toolchain (see scripts/toolchain.mjs).
function run(command, args = [], options = {}) {
  let file = command;
  if (TOOLS.includes(command)) {
    file = toolPath(command);
    if (!file) {
      if (options.allowFailure) return { error: new Error(`${command} is not available`), status: null, stdout: '', stderr: '' };
      fail(`${command} is not available. Run: ai-verse-os setup`);
    }
  }
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: options.raw ? 'buffer' : 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
    env: options.env || toolEnv({ tools: Object.fromEntries(TOOLS.map(t => [t, { path: toolPath(t) }])) }),
  });
  if (result.error) {
    if (options.allowFailure) return result;
    fail(`Could not run ${command}: ${redact(result.error.message)}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    fail(`${command} failed${detail ? `: ${detail}` : ''}`, result.status || 1);
  }
  return result;
}

// Members receive the version accepted for release, never whatever is newest on main.
function acceptedRevision(root, ref) {
  const raw = run('git', ['-C', root, 'show', `${ref}:release/component-release.json`], { capture: true }).stdout;
  let release = null;
  try { release = JSON.parse(raw); } catch {}
  if (release?.release_status !== 'accepted' || !/^[a-f0-9]{40}$/.test(release?.revision ?? '')) fail('Stopped: no valid accepted release was found, so nothing was changed.');
  return release.revision;
}

// An acceptance commit only touches release/, so a tip that differs from the accepted code in nothing else is that release.
function acceptedCommit(root, ref) {
  const accepted = acceptedRevision(root, ref);
  const changed = run('git', ['-C', root, 'diff', '--name-only', accepted, ref], { capture: true }).stdout.split('\n').filter(Boolean);
  if (!changed.every((file) => file.startsWith('release/'))) return accepted;
  return run('git', ['-C', root, 'rev-parse', `${ref}^{commit}`], { capture: true }).stdout.trim();
}

function commandVersion(command) {
  const result = run(command, ['--version'], { capture: true, allowFailure: true });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim().split('\n')[0] || 'available';
}

function parse(argv) {
  const args = [...argv];
  const command = args.shift() || 'help';
  const options = { positional: [], profile: null, json: false, apply: false, force: false };
  while (args.length) {
    const token = args.shift();
    if (token === '--dir' || token === '-d') {
      if (!args.length) fail(`${token} requires a path`);
      options.dir = args.shift();
    } else if (token === '--profile') {
      if (!args.length) fail('--profile requires a value');
      options.profile = args.shift();
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--apply') {
      options.apply = true;
    } else if (token === '--force') {
      options.force = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token === '--version' || token === '-v') {
      options.version = true;
    } else if (token.startsWith('-')) {
      fail(`Unknown option: ${token}`);
    } else {
      options.positional.push(token);
    }
  }
  return { command, options };
}

function isRoot(candidate) {
  return fs.existsSync(path.join(candidate, 'AI-VERSE.yaml')) &&
    fs.existsSync(path.join(candidate, 'AGENTS.md'));
}

// Real path of a folder that may not exist yet: resolve the nearest existing ancestor through symlinks, then add the rest back.
function realPathOrPlanned(candidate) {
  let current = path.resolve(candidate);
  const rest = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

// A damaged AI-Verse OS checkout (AGENTS.md or AI-VERSE.yaml deleted): needs git plus both the release descriptor and the component manager.
function isRepairableRoot(candidate) {
  return fs.existsSync(path.join(candidate, '.git')) &&
    fs.existsSync(path.join(candidate, 'release', 'component-release.json')) &&
    fs.existsSync(path.join(candidate, 'scripts', 'components.mjs'));
}

// Intact installs are found as usual. A damaged one is only accepted when it is exactly the named folder, or the current folder; parents are never searched.
function resolveRepairableRoot(options) {
  if (options.dir) {
    const candidate = path.resolve(options.dir);
    return isRoot(candidate) || isRepairableRoot(candidate) ? candidate : null;
  }
  const intact = findRoot();
  if (intact) return intact;
  const here = path.resolve(process.cwd());
  return isRepairableRoot(here) ? here : null;
}

function findRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (isRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveRoot(options) {
  if (options.dir) {
    const candidate = path.resolve(options.dir);
    return isRoot(candidate) ? candidate : null;
  }
  return findRoot();
}

function validateInstall(root) {
  const required = [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'AI-VERSE.yaml',
    'system/architecture/README.md',
    'system/schemas/workspace.schema.yaml',
    'workspaces/_template/WORKSPACE.yaml',
    'skills/registry.yaml',
    '.claude/skills/onboard/SKILL.md',
    '.agents/skills/onboard/SKILL.md',
    '.claude/skills/3d-brain/SKILL.md',
    '.agents/skills/3d-brain/SKILL.md',
    'scripts/components.mjs',
    // Do not add new files here until the accepted release contains them: installs validate the accepted release tree.
  ];
  return required.filter(item => !fs.existsSync(path.join(root, item)));
}

function setupPath(root) {
  return path.join(root, SETUP_MARKER_REL);
}

function readSetup(root) {
  const file = setupPath(root);
  if (!fs.existsSync(file)) {
    return {
      state: 'setup-required',
      configured: false,
      profile: null,
      migration_required: false,
      diagnostics: ['AI-Verse OS setup has not been completed for this root'],
    };
  }
  try {
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
      return { state: 'unhealthy', configured: false, profile: null, migration_required: false, diagnostics: ['setup marker is unsafe'] };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.schema_version !== SETUP_SCHEMA) {
      return {
        state: 'migration-required',
        configured: false,
        profile: typeof data.profile === 'string' ? data.profile : null,
        migration_required: true,
        diagnostics: ['setup marker schema is not current and must be refreshed by setup'],
      };
    }
    if (typeof data.profile !== 'string' || !data.profile) {
      return { state: 'unhealthy', configured: false, profile: null, migration_required: false, diagnostics: ['setup marker profile is invalid'] };
    }
    return {
      state: 'ready',
      configured: true,
      profile: data.profile,
      migration_required: false,
      setup_at: data.setup_at || null,
      updated_at: data.updated_at || null,
      grants: data.grants || {},
      diagnostics: [],
    };
  } catch (error) {
    return {
      state: 'unhealthy',
      configured: false,
      profile: null,
      migration_required: false,
      diagnostics: [`setup marker is unreadable: ${error.message}`],
    };
  }
}

function writeSetup(root, profile, previous = null) {
  const aiverse = path.join(root, '.aiverse');
  const dir = path.join(aiverse, 'os');
  if (fs.existsSync(aiverse) && fs.lstatSync(aiverse).isSymbolicLink()) fail('.aiverse must not be a symlink');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) fail('.aiverse/os must not be a symlink');
  const now = new Date().toISOString();
  const payload = {
    schema_version: SETUP_SCHEMA,
    component_id: 'ai-verse-os',
    ...versionFields(root),
    profile,
    setup_at: previous?.setup_at || now,
    updated_at: now,
    grants: {
      component_authority_transfer: false,
      external_account_authorization: false,
      permission_broadening: false,
    },
  };
  const file = setupPath(root);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

function profileFor(root, options) {
  if (options.profile) return String(options.profile).toLowerCase();
  const setup = readSetup(root);
  return setup.profile || 'detected';
}

function componentReport(root, command, { profile = 'detected', apply = false, component = null } = {}) {
  const script = path.join(root, 'scripts', 'components.mjs');
  if (!fs.existsSync(script)) fail(`Component manager is missing: ${script}`);
  const args = [script, command, '--root', root, '--profile', profile, '--json'];
  if (apply) args.push('--apply');
  if (component) args.splice(2, 0, component);
  const result = run('node', args, { capture: true, allowFailure: true });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    fail(`component lifecycle returned invalid JSON: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return { report: parsed, exitCode: result.status ?? 1, stderr: (result.stderr || '').trim() };
}

function statusObject(root, options = {}) {
  const missing = validateInstall(root);
  const setup = readSetup(root);
  const profile = options.profile || setup.profile || 'detected';

  if (missing.length) {
    return {
      schema_version: LIFECYCLE_SCHEMA,
      component_id: 'ai-verse-os',
      ...versionFields(root),
      state: 'unhealthy',
      health: 'unhealthy',
      ready: false,
      profile,
      migration_required: false,
      diagnostics: [`missing core files: ${missing.join(', ')}`],
      setup,
      components: null,
    };
  }

  const { report: components } = componentReport(root, 'status', { profile });
  let state = 'ready';
  if (setup.state !== 'ready') state = setup.state;
  else if (components.state !== 'ready') state = components.state;

  return {
    schema_version: LIFECYCLE_SCHEMA,
    component_id: 'ai-verse-os',
    ...versionFields(root),
    state,
    health: state === 'ready' ? 'healthy' : (state === 'unhealthy' ? 'unhealthy' : 'not-ready'),
    ready: state === 'ready',
    profile,
    migration_required: setup.migration_required === true || components.migration_required === true,
    diagnostics: [...(setup.diagnostics || [])],
    setup,
    components,
  };
}

function usage() {
  out(`AI-Verse OS CLI v${versionFields(LAUNCHER_ROOT).version}\n`);
  out('Usage:');
  out('  ai-verse-os install [folder] [--json]   (downloads itself into a new or empty folder; default ./AI-Verse-OS)');
  out('  ai-verse-os setup [--dir folder] [--profile detected|core] [--json]');
  out('  ai-verse-os status [--dir folder] [--profile detected|core] [--json]');
  out('  ai-verse-os doctor [--dir folder] [--profile detected|core] [--json]');
  out('  ai-verse-os update [--dir folder] [--json]');
  out('  ai-verse-os reinstall --force [--dir folder] [--json]');
  out('  ai-verse-os onboard [--dir folder]');
  out('  ai-verse-os components <status|doctor|setup|reconcile|descriptor> [component] [--apply] [--json]');
  out('  ai-verse-os descriptor [--dir folder] [--json]');
  out('  ai-verse-os version');
}

// Check (and where a trusted download is listed, prepare) Node, Python and Git up front,
// so a missing tool stops the install here in plain words instead of at first use.
async function requirePrerequisites(options) {
  const report = await prepareToolchain();
  if (!report.ok) {
    if (options.json) emit({ schema_version: LIFECYCLE_SCHEMA, state: 'prerequisites-missing', ready: false, problems: report.problems }, true);
    fail(`Stopped before changing anything.\n${report.problems.join('\n')}`);
  }
  return report;
}

async function install(options) {
  const explicit = options.dir || options.positional[0];
  // Run from inside an installation with no folder named: it is already installed, so do not nest a second copy.
  const here = explicit ? null : findRoot(realPathOrPlanned(process.cwd()));
  const target = here || realPathOrPlanned(explicit || 'AI-Verse-OS');

  if (isRoot(target)) {
    const result = {
      schema_version: LIFECYCLE_SCHEMA,
      command: 'install',
      component_id: 'ai-verse-os',
      state: 'installed',
      changed: false,
      root: target,
      next: 'setup',
    };
    if (options.json) emit(result, true);
    else {
      out(`AI-Verse OS is already installed at:\n${target}`);
      out(`Next: ai-verse-os setup --dir "${target}"`);
    }
    return;
  }

  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    fail([
      `Nothing was installed and nothing was changed, because the install location is a file, not a folder: ${target}`,
      'To continue, name a new folder:',
      `  ${INSTALL_COMMAND} <new-folder-name>`,
    ].join('\n'));
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    fail([
      `Nothing was installed and nothing was changed, because the install folder already has files in it: ${target}`,
      'AI-Verse OS installs into a new or empty folder and downloads itself, so no separate download step is needed.',
      'To continue, run the same command from the folder where you want AI-Verse-OS created, or name a new folder:',
      `  ${INSTALL_COMMAND} <new-folder-name>`,
    ].join('\n'));
  }
  const enclosing = findRoot(path.dirname(target));
  if (enclosing) {
    fail([
      `Nothing was installed and nothing was changed, because this folder is inside an existing AI-Verse OS: ${enclosing}`,
      'To continue, run the command from a folder outside it, or use the existing one with:',
      `  ai-verse-os setup --dir "${enclosing}"`,
    ].join('\n'));
  }

  // Every refusal above has already happened, so a refused install changes and downloads nothing.
  await requirePrerequisites(options);
  const gitVersion = commandVersion('git');
  if (!gitVersion) fail('Git is not available. Run the install again or ask for help in the AI-Verse community.');

  if (!options.json) {
    out('AI-Verse OS installer');
    out('----------------------');
    out(`Git: ${gitVersion}`);
    out(`Source: ${redactUrl(REPO_URL)}`);
    out(`Install to: ${target}`);
  }

  run('git', ['clone', '--branch', 'main', REPO_URL, target], { capture: options.json });
  const accepted = acceptedCommit(target, 'HEAD');
  run('git', ['-C', target, 'checkout', '--quiet', '-B', 'main', accepted], { capture: options.json });
  if (run('git', ['-C', target, 'rev-parse', 'HEAD'], { capture: true }).stdout.trim() !== accepted) fail('Install stopped: the checked out version is not the accepted release.');

  const missing = validateInstall(target);
  if (missing.length) fail(`Install completed but validation failed. Missing: ${missing.join(', ')}`);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'install',
    component_id: 'ai-verse-os',
    ...versionFields(target),
    state: 'installed',
    changed: true,
    root: target,
    setup_required: true,
    next: 'setup',
  };
  if (options.json) emit(result, true);
  else {
    out('✓ AI-Verse OS installed');
    out('Install does not attach sibling components, transfer authority, or grant permissions.');
    out(`Next: ai-verse-os setup --dir "${target}"`);
  }
}

async function setup(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  const missing = validateInstall(root);
  if (missing.length) fail(`OS installation is incomplete. Missing: ${missing.join(', ')}`);
  await requirePrerequisites(options);

  const before = readSetup(root);
  const profile = options.profile || before.profile || 'detected';
  const applied = componentReport(root, 'setup', { profile, apply: true });
  const marker = writeSetup(root, profile, before.state === 'ready' && before.profile === profile ? before : null);
  const current = statusObject(root, { profile });
  const changed = !(before.state === 'ready' && before.profile === profile && applied.report.mutated !== true);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'setup',
    component_id: 'ai-verse-os',
    ...versionFields(root),
    root,
    profile,
    state: current.state,
    ready: current.ready,
    changed,
    setup: marker,
    component_setup: applied.report,
    grants: marker.grants,
  };

  if (options.json) emit(result, true);
  else {
    out(`AI-Verse OS setup: ${current.state}`);
    out(`Profile: ${profile}`);
    for (const action of applied.report.actions || []) {
      if (action.automatic === false) out(`Next owner action for ${action.component}: ${action.command}`);
    }
    out('Setup does not transfer Brain authority, authorize external accounts, or broaden permissions.');
  }
  if (!current.ready) process.exitCode = 2;
}

function status(options) {
  const root = resolveRoot(options);
  if (!root) {
    const result = {
      schema_version: LIFECYCLE_SCHEMA,
      component_id: 'ai-verse-os',
      version: 'unknown',
      version_status: 'unverified',
      state: 'absent',
      ready: false,
    };
    if (options.json) emit(result, true);
    else out('AI-Verse OS: absent');
    process.exitCode = 2;
    return;
  }
  const result = statusObject(root, { profile: options.profile || undefined });
  if (options.json) emit(result, true);
  else {
    out(`AI-Verse OS status: ${result.state}`);
    out(`Root: ${root}`);
    out(`Profile: ${result.profile}`);
    out(`Ready: ${result.ready ? 'yes' : 'no'}`);
  }
  if (!result.ready) process.exitCode = 2;
}

function doctor(options) {
  const root = resolveRoot(options);
  if (!root) {
    const result = {
      schema_version: LIFECYCLE_SCHEMA,
      component_id: 'ai-verse-os',
      state: 'absent',
      ready: false,
      depth_checked: { structural: false, setup: false, attachment_discovery: false, runtime: false, dependency: false, operational: false, system_composed: false },
    };
    if (options.json) emit(result, true);
    else out('✗ AI-Verse OS installation not found.');
    process.exitCode = 2;
    return;
  }

  const result = statusObject(root, { profile: options.profile || undefined });
  const gitVersion = commandVersion('git');
  const toolchain = Object.fromEntries(TOOLS.map(t => [t, resolveTool(t)]));
  const missing = validateInstall(root);
  const toolsOk = TOOLS.every(t => toolchain[t].path);
  const structural = missing.length === 0 && toolsOk;
  const doctorResult = {
    ...result,
    command: 'doctor',
    depth_checked: {
      structural: true,
      setup: true,
      attachment_discovery: true,
      runtime: true,
      dependency: true,
      operational: false,
      system_composed: true,
    },
    checks: {
      node: { ok: Boolean(toolchain.node.path), version: toolchain.node.version, source: toolchain.node.source },
      python: { ok: Boolean(toolchain.python.path), version: toolchain.python.version, source: toolchain.python.source },
      git: { ok: Boolean(toolchain.git.path), version: toolchain.git.version, source: toolchain.git.source },
      core_files: { ok: missing.length === 0, missing },
      setup: { ok: result.setup.state === 'ready', state: result.setup.state },
      components: { ok: result.components?.ready === true, state: result.components?.state ?? 'unknown' },
    },
    ready: structural && result.ready,
  };
  doctorResult.state = doctorResult.ready ? 'ready' : result.state === 'ready' ? 'unhealthy' : result.state;
  doctorResult.health = doctorResult.ready ? 'healthy' : (doctorResult.state === 'unhealthy' ? 'unhealthy' : 'not-ready');

  if (options.json) emit(doctorResult, true);
  else {
    out('AI-Verse OS doctor');
    out('------------------');
    for (const t of TOOLS) out(`${toolchain[t].path ? '✓' : '✗'} ${t[0].toUpperCase()}${t.slice(1)}${toolchain[t].path ? ` ${toolchain[t].version} (${toolchain[t].source})` : ': not found'}`);
    out(`${missing.length ? '✗' : '✓'} Core architecture`);
    out(`${result.setup.state === 'ready' ? '✓' : '!'} Setup: ${result.setup.state}`);
    out(`${result.components?.ready ? '✓' : '!'} Composed profile: ${result.components?.state}`);
    out('Depth checked: structural, setup, attachment/discovery, runtime, dependency, system/composed.');
    out('Operational owner-specific checks are not claimed by the OS doctor.');
    out(doctorResult.ready ? '\nAI-Verse OS is ready.' : '\nAI-Verse OS is not ready.');
  }
  if (!doctorResult.ready) process.exitCode = 2;
}

function update(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  if (!fs.existsSync(path.join(root, '.git'))) fail('This installation is not a Git checkout, so the CLI cannot update it safely.');
  if (!commandVersion('git')) fail('Git is required to update AI-Verse OS.');

  const dirty = run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { capture: true }).stdout.trim();
  if (dirty) fail('Tracked system files have local changes. Commit, stash, or revert them before updating. User-owned ignored data is preserved.');

  const before = readSetup(root);
  fetchSource(root, options);
  const accepted = acceptedCommit(root, 'FETCH_HEAD');
  run('git', ['-C', root, 'merge', '--ff-only', accepted], { capture: options.json });
  if (run('git', ['-C', root, 'merge-base', '--is-ancestor', accepted, 'HEAD'], { allowFailure: true, capture: true }).status !== 0) fail('Update stopped: the installed version does not include the accepted release.');
  const missing = validateInstall(root);
  if (missing.length) fail(`Update finished but validation failed. Missing: ${missing.join(', ')}`);
  const after = readSetup(root);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'update',
    component_id: 'ai-verse-os',
    ...versionFields(root),
    state: after.state,
    root,
    setup_preserved: before.setup_at ? before.setup_at === after.setup_at : after.configured === false,
  };
  if (options.json) emit(result, true);
  else out('✓ AI-Verse OS is up to date. Setup and ignored user-owned state were preserved.');
}

// Fetch main from the installer's own known source, never from the folder's own origin remote.
function fetchSource(root, options) {
  const result = run('git', ['-C', root, 'fetch', '--quiet', REPO_URL, 'main'], { capture: true, allowFailure: true });
  if (result.error || result.status !== 0) fail('Could not download the AI-Verse OS release from its source. Check the connection and the source address, then try again. Nothing was changed.');
}

function backupStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Save everything the reset would discard: edited tracked files, untracked or ignored files that sit where the
// accepted release has a file (or inside a folder path where it has a file), and local commits (under a backup ref).
// File names are handled as raw bytes (kept as latin1 strings internally) so names that are not valid UTF-8 survive.
function saveBeforeReinstall(root, accepted, options) {
  const git = (args) => run('git', ['-C', root, ...args], { capture: true, allowFailure: true });
  const gitRaw = (args) => {
    const result = run('git', ['-C', root, ...args], { capture: true, allowFailure: true, raw: true });
    return Buffer.isBuffer(result.stdout) ? result.stdout.toString('latin1') : '';
  };
  const saved = { backup_dir: null, edited_files: [], deleted_files: [], colliding_files: [], backup_ref: null };
  const shown = (rel) => Buffer.from(rel, 'latin1').toString('utf8');
  const rootBytes = Buffer.from(root, 'utf8');
  const bytesPath = (base, rel) => Buffer.concat([base, Buffer.from('/'), Buffer.from(rel, 'latin1')]);
  const parentOf = (buf) => buf.subarray(0, buf.lastIndexOf(0x2f));

  const entries = gitRaw(['status', '--porcelain', '-z', '--untracked-files=no']).split('\0').filter(Boolean);
  const files = [];
  for (let k = 0; k < entries.length; k += 1) {
    const code = entries[k].slice(0, 2);
    files.push(entries[k].slice(3));
    if (code.includes('R') || code.includes('C')) k += 1; // the next entry is the old name of a rename
  }

  // Untracked or ignored files the reset would overwrite: same path as a release file, or below a path where the release has a file.
  const releaseSet = new Set(gitRaw(['ls-tree', '-r', '-z', '--name-only', accepted]).split('\0').filter(Boolean));
  const releaseDirs = new Set();
  for (const rel of releaseSet) {
    for (let at = rel.indexOf('/'); at !== -1; at = rel.indexOf('/', at + 1)) releaseDirs.add(rel.slice(0, at));
  }
  const collides = (rel) => {
    if (releaseSet.has(rel) || releaseDirs.has(rel)) return true;
    for (let at = rel.indexOf('/'); at !== -1; at = rel.indexOf('/', at + 1)) {
      if (releaseSet.has(rel.slice(0, at))) return true;
    }
    return false;
  };
  const loose = [
    ...gitRaw(['ls-files', '-z', '--others', '--exclude-standard']).split('\0'),
    ...gitRaw(['ls-files', '-z', '--others', '--ignored', '--exclude-standard']).split('\0'),
  ].filter((rel) => rel && !rel.startsWith('.aiverse-backups/'));
  const colliding = [...new Set(loose)].filter((entry) => collides(entry.endsWith('/') ? entry.slice(0, -1) : entry));

  const stamp = backupStamp();
  let dir = null;
  const ensureDir = () => {
    if (dir) return dir;
    let candidate = path.join(root, '.aiverse-backups', `reinstall-${stamp}`);
    for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(root, '.aiverse-backups', `reinstall-${stamp}-${n}`);
    dir = candidate;
    return dir;
  };
  // Copy a file, a symlink (as a link, never followed) or a whole folder. Anything else cannot be saved, so the reinstall stops.
  const copyTree = (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from, { encoding: 'buffer' }), to);
    else if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from, { encoding: 'buffer' })) {
        copyTree(Buffer.concat([from, Buffer.from('/'), name]), Buffer.concat([to, Buffer.from('/'), name]));
      }
    } else if (stat.isFile()) fs.copyFileSync(from, to);
    else fail('Reinstall stopped before changing anything: a file of yours is of a kind that cannot be backed up (not a plain file, folder or link). Move it out of the way and run reinstall again.');
  };
  const copy = (entry, list) => {
    const rel = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const from = bytesPath(rootBytes, rel);
    let stat = null;
    try { stat = fs.lstatSync(from); } catch {}
    if (!stat) { saved.deleted_files.push(shown(rel)); return; }
    const to = bytesPath(Buffer.from(ensureDir(), 'utf8'), rel);
    fs.mkdirSync(parentOf(to), { recursive: true });
    copyTree(from, to);
    list.push(shown(rel));
  };
  for (const rel of files) copy(rel, saved.edited_files);
  for (const rel of colliding) copy(rel, saved.colliding_files);
  if (dir) {
    saved.backup_dir = dir;
    // Keep the backups out of git. The exclude file is handled as bytes so nothing already in it is changed.
    const excludeRel = git(['rev-parse', '--git-path', 'info/exclude']).stdout.trim();
    if (excludeRel) {
      const exclude = path.resolve(root, excludeRel);
      let bytes = Buffer.alloc(0);
      try { bytes = fs.readFileSync(exclude); } catch {}
      if (!bytes.toString('latin1').split(/\r?\n/).includes('/.aiverse-backups/')) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        const gap = bytes.length && bytes[bytes.length - 1] !== 0x0a ? '\n' : '';
        fs.writeFileSync(exclude, Buffer.concat([bytes, Buffer.from(`${gap}/.aiverse-backups/\n`, 'utf8')]));
      }
    }
  }

  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).stdout.trim();
  if (head) {
    const lost = git(['rev-list', '--max-count=1', head, '--not', accepted]).stdout.trim();
    if (lost) {
      const ref = `refs/aiverse-backups/reinstall-${stamp}`;
      let name = ref;
      for (let n = 2; git(['rev-parse', '--verify', '--quiet', name]).status === 0; n += 1) name = `${ref}-${n}`;
      const made = git(['update-ref', name, head]);
      if (made.status !== 0) fail('Reinstall stopped before changing anything: your own saved changes could not be backed up.');
      saved.backup_ref = name;
    }
  }
  return saved;
}

function reinstall(options) {
  if (!options.force) fail('reinstall requires --force because it restores tracked OS files to the accepted release while preserving ignored user-owned state.');
  const root = resolveRepairableRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  if (!fs.existsSync(path.join(root, '.git'))) fail('This installation is not a Git checkout.');
  if (!commandVersion('git')) fail('Git is required to reinstall AI-Verse OS.');

  const before = readSetup(root);
  fetchSource(root, options);
  const accepted = acceptedCommit(root, 'FETCH_HEAD');
  const saved = saveBeforeReinstall(root, accepted, options);
  run('git', ['-C', root, 'reset', '--hard', '--quiet', accepted], { capture: true });
  if (run('git', ['-C', root, 'rev-parse', 'HEAD'], { capture: true }).stdout.trim() !== accepted) fail('Reinstall stopped: the restored version is not the accepted release.');
  const missing = validateInstall(root);
  if (missing.length) fail(`Reinstall validation failed. Missing: ${missing.join(', ')}`);
  const after = readSetup(root);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'reinstall',
    component_id: 'ai-verse-os',
    ...versionFields(root),
    state: after.state,
    root,
    tracked_files_restored: true,
    setup_preserved: before.setup_at ? before.setup_at === after.setup_at : after.configured === false,
    canonical_user_state_purged: false,
    backup_dir: saved.backup_dir,
    backed_up_files: saved.edited_files,
    backed_up_untracked_files: saved.colliding_files,
    deleted_files_restored: saved.deleted_files,
    backup_ref: saved.backup_ref,
  };
  if (options.json) emit(result, true);
  else {
    out('✓ AI-Verse OS tracked runtime files reinstalled to the accepted release. Ignored canonical user state and setup state were preserved.');
    if (saved.backup_dir) out(`Your edited files were saved first in: ${saved.backup_dir}`);
    if (saved.backup_ref) out(`Your own commits were saved first under the git reference: ${saved.backup_ref}`);
  }
}

function components(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  const subcommand = options.positional[0] || 'doctor';
  const component = options.positional[1] || null;
  if (!['status', 'doctor', 'setup', 'reconcile', 'descriptor'].includes(subcommand)) {
    fail('components expects status, doctor, setup, reconcile, or descriptor');
  }
  const profile = profileFor(root, options);
  const result = componentReport(root, subcommand, {
    profile,
    apply: options.apply || subcommand === 'setup',
    component,
  });
  if (options.json || subcommand === 'descriptor') emit(result.report, true);
  else {
    const script = path.join(root, 'scripts', 'components.mjs');
    const args = [script, subcommand, '--root', root, '--profile', profile];
    if (component) args.splice(2, 0, component);
    if (options.apply || subcommand === 'setup') args.push('--apply');
    const human = run('node', args, { allowFailure: true });
    if (human.status !== 0) process.exitCode = human.status;
    return;
  }
  if (subcommand !== 'descriptor' && result.exitCode !== 0) process.exitCode = result.exitCode;
}

function descriptor(options) {
  const root = resolveRoot(options);
  const current = root ? statusObject(root, { profile: options.profile || undefined }) : {
    state: 'absent',
    health: 'unknown',
    ready: false,
    profile: options.profile || 'detected',
    migration_required: false,
  };
  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    component_id: 'ai-verse-os',
    ...versionFields(root),
    compatibility: { os_schema: '2.x', extension_registry_schema: '1.0' },
    package_install_source: 'github:aiverse-filmmakers/AI-Verse-OS',
    setup_requirements: ['explicit setup after install', 'selected composed profile readiness'],
    supported_lifecycle_commands: ['install', 'setup', 'status', 'doctor', 'update', 'reinstall'],
    current_state: current.state,
    health: current.health,
    readiness: current.ready,
    required_host_version: null,
    migration_requirement: current.migration_required,
    requested_scopes: ['operator', 'workspace:*'],
    requested_capabilities: ['host-composition', 'permission-floor', 'routing'],
    authority_transfer_separate: true,
    uninstall_preserves_canonical_state: true,
    enable_disable_supported: false,
    setup_grants: {
      component_authority_transfer: false,
      external_account_authorization: false,
      permission_broadening: false,
    },
  };
  emit(result, true);
}

function onboard(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  const current = statusObject(root, { profile: options.profile || undefined });
  if (!current.ready) fail(`AI-Verse OS is ${current.state}; run setup and doctor before onboarding`, 2);

  const claude = commandVersion('claude');
  const codex = commandVersion('codex');
  out('AI-Verse OS first use');
  out('--------------------');
  out(`OS: ${root}`);
  out('Start with a real request. AI-Verse will learn missing context progressively.');
  out('Optional deep intake remains available through the onboard capability.');
  if (claude) {
    out('Claude Code detected.');
    out(`  cd "${root}"`);
    out('  claude');
    out('Then ask for what you want help with. Optional deep intake: /onboard full');
  }
  if (codex) {
    out('Codex detected.');
    out(`  cd "${root}"`);
    out('  codex');
    out('Then ask for what you want help with. Optional deep intake: $onboard full');
  }
  if (!claude && !codex) {
    out('Open this folder in a supported capable AI runtime.');
    out('Start with a real request.');
    out('Optional deep intake: select the onboard capability and request a full intake.');
  }
}

const { command, options } = parse(process.argv.slice(2));

if (options.version || command === '--version' || command === '-v') {
  out(versionFields(LAUNCHER_ROOT).version);
  process.exit(0);
}
if (options.help) {
  usage();
  process.exit(0);
}

switch (command) {
  case 'install': await install(options); break;
  case 'setup': await setup(options); break;
  case 'status': status(options); break;
  case 'doctor': doctor(options); break;
  case 'update': update(options); break;
  case 'reinstall': reinstall(options); break;
  case 'onboard': onboard(options); break;
  case 'components': components(options); break;
  case 'descriptor': descriptor(options); break;
  case 'version': out(versionFields(LAUNCHER_ROOT).version); break;
  case 'help': usage(); break;
  default:
    usage();
    fail(`Unknown command: ${command}`);
}
