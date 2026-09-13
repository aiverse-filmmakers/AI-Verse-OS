#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_VERSION = '0.2.0';
const LIFECYCLE_SCHEMA = '1.0';
const SETUP_SCHEMA = '1.0';
const DEFAULT_REPO = 'https://github.com/aiverse-filmmakers/AI-Verse-OS.git';
const REPO_URL = process.env.AI_VERSE_OS_REPO_URL || DEFAULT_REPO;
const SETUP_MARKER_REL = '.aiverse/os/setup.json';

function out(message = '') {
  process.stdout.write(`${message}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`AI-Verse OS: ${message}\n`);
  process.exit(code);
}

function emit(value, json = false) {
  if (json) out(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') out(value);
  else out(JSON.stringify(value, null, 2));
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
    env: options.env || process.env,
  });
  if (result.error) {
    if (options.allowFailure) return result;
    fail(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    fail(`${command} failed${detail ? `: ${detail}` : ''}`, result.status || 1);
  }
  return result;
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
    version: CLI_VERSION,
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
  const result = run(process.execPath, args, { capture: true, allowFailure: true });
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
      version: CLI_VERSION,
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
    version: CLI_VERSION,
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
  out(`AI-Verse OS CLI v${CLI_VERSION}\n`);
  out('Usage:');
  out('  ai-verse-os install [folder] [--json]');
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

function install(options) {
  const gitVersion = commandVersion('git');
  if (!gitVersion) fail('Git is required. Install Git and run the command again.');
  const targetArg = options.dir || options.positional[0] || 'AI-Verse-OS';
  const target = path.resolve(targetArg);

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

  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    fail(`Install folder already exists and is not empty: ${target}`);
  }

  if (!options.json) {
    out('AI-Verse OS installer');
    out('----------------------');
    out(`Git: ${gitVersion}`);
    out(`Source: ${REPO_URL}`);
    out(`Install to: ${target}`);
  }

  run('git', ['clone', '--depth', '1', '--branch', 'main', REPO_URL, target], { capture: options.json });

  const missing = validateInstall(target);
  if (missing.length) fail(`Install completed but validation failed. Missing: ${missing.join(', ')}`);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'install',
    component_id: 'ai-verse-os',
    version: CLI_VERSION,
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

function setup(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  const missing = validateInstall(root);
  if (missing.length) fail(`OS installation is incomplete. Missing: ${missing.join(', ')}`);

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
    version: CLI_VERSION,
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
      version: CLI_VERSION,
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
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const gitVersion = commandVersion('git');
  const missing = validateInstall(root);
  const structural = missing.length === 0 && nodeMajor >= 18 && Boolean(gitVersion);
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
      node: { ok: nodeMajor >= 18, version: process.versions.node, complete_beta_baseline: nodeMajor >= 22 },
      git: { ok: Boolean(gitVersion), version: gitVersion },
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
    out(`${nodeMajor >= 18 ? '✓' : '✗'} Node ${process.versions.node}`);
    out(`${gitVersion ? '✓' : '✗'} Git${gitVersion ? `: ${gitVersion}` : ''}`);
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
  run('git', ['-C', root, 'fetch', 'origin', 'main'], { capture: options.json });
  run('git', ['-C', root, 'merge', '--ff-only', 'origin/main'], { capture: options.json });
  const missing = validateInstall(root);
  if (missing.length) fail(`Update finished but validation failed. Missing: ${missing.join(', ')}`);
  const after = readSetup(root);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'update',
    component_id: 'ai-verse-os',
    version: CLI_VERSION,
    state: after.state,
    root,
    setup_preserved: before.setup_at ? before.setup_at === after.setup_at : after.configured === false,
  };
  if (options.json) emit(result, true);
  else out('✓ AI-Verse OS is up to date. Setup and ignored user-owned state were preserved.');
}

function reinstall(options) {
  if (!options.force) fail('reinstall requires --force because it restores tracked OS files to origin/main while preserving ignored user-owned state.');
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  if (!fs.existsSync(path.join(root, '.git'))) fail('This installation is not a Git checkout.');
  if (!commandVersion('git')) fail('Git is required to reinstall AI-Verse OS.');

  const before = readSetup(root);
  run('git', ['-C', root, 'fetch', 'origin', 'main'], { capture: options.json });
  run('git', ['-C', root, 'reset', '--hard', 'origin/main'], { capture: options.json });
  const missing = validateInstall(root);
  if (missing.length) fail(`Reinstall validation failed. Missing: ${missing.join(', ')}`);
  const after = readSetup(root);

  const result = {
    schema_version: LIFECYCLE_SCHEMA,
    command: 'reinstall',
    component_id: 'ai-verse-os',
    version: CLI_VERSION,
    state: after.state,
    root,
    tracked_files_restored: true,
    setup_preserved: before.setup_at ? before.setup_at === after.setup_at : after.configured === false,
    canonical_user_state_purged: false,
  };
  if (options.json) emit(result, true);
  else out('✓ AI-Verse OS tracked runtime files reinstalled. Ignored canonical user state and setup state were preserved.');
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
    const human = run(process.execPath, args, { allowFailure: true });
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
    version: CLI_VERSION,
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
  out('AI-Verse OS onboarding');
  out('----------------------');
  out(`OS: ${root}`);
  if (claude) {
    out('Claude Code detected.');
    out(`  cd "${root}"`);
    out('  claude');
    out('Then run: /onboard');
  }
  if (codex) {
    out('Codex detected.');
    out(`  cd "${root}"`);
    out('  codex');
    out('Then run: $onboard');
  }
  if (!claude && !codex) {
    out('Open this folder in a supported capable AI runtime.');
    out('Claude Code: run /onboard');
    out('Codex: run $onboard or select the onboard skill');
  }
}

const { command, options } = parse(process.argv.slice(2));

if (options.version || command === '--version' || command === '-v') {
  out(CLI_VERSION);
  process.exit(0);
}
if (options.help) {
  usage();
  process.exit(0);
}

switch (command) {
  case 'install': install(options); break;
  case 'setup': setup(options); break;
  case 'status': status(options); break;
  case 'doctor': doctor(options); break;
  case 'update': update(options); break;
  case 'reinstall': reinstall(options); break;
  case 'onboard': onboard(options); break;
  case 'components': components(options); break;
  case 'descriptor': descriptor(options); break;
  case 'version': out(CLI_VERSION); break;
  case 'help': usage(); break;
  default:
    usage();
    fail(`Unknown command: ${command}`);
}
