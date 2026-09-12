#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_VERSION = '0.1.0';
const DEFAULT_REPO = 'https://github.com/aiverse-filmmakers/AI-Verse-OS.git';
const REPO_URL = process.env.AI_VERSE_OS_REPO_URL || DEFAULT_REPO;

function out(message = '') {
  process.stdout.write(`${message}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`AI-Verse OS: ${message}\n`);
  process.exit(code);
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
    env: process.env,
  });

  if (result.error) {
    if (options.allowFailure) return result;
    fail(`Could not run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    fail(`${command} failed${detail ? `: ${detail}` : ''}`);
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
  const options = { positional: [] };

  while (args.length) {
    const token = args.shift();
    if (token === '--dir' || token === '-d') {
      if (!args.length) fail(`${token} requires a path`);
      options.dir = args.shift();
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
  ];
  return required.filter((item) => !fs.existsSync(path.join(root, item)));
}

function usage() {
  out(`AI-Verse OS CLI v${CLI_VERSION}\n`);
  out('Usage:');
  out('  ai-verse-os install [folder]');
  out('  ai-verse-os update [--dir folder]');
  out('  ai-verse-os doctor [--dir folder]');
  out('  ai-verse-os onboard [--dir folder]');
  out('  ai-verse-os components doctor [--dir folder]');
  out('  ai-verse-os components reconcile [--dir folder]');
  out('  ai-verse-os version');
  out('');
  out('First run without a global install:');
  out('  npx --yes github:aiverse-filmmakers/AI-Verse-OS install');
  out('');
  out('Install the command globally from GitHub:');
  out('  npm install -g github:aiverse-filmmakers/AI-Verse-OS');
  out('  ai-verse-os install');
}

function install(options) {
  const gitVersion = commandVersion('git');
  if (!gitVersion) fail('Git is required. Install Git and run the command again.');

  const targetArg = options.dir || options.positional[0] || 'AI-Verse-OS';
  const target = path.resolve(targetArg);

  if (isRoot(target)) {
    out(`AI-Verse OS is already installed at:\n${target}`);
    out('');
    out('If the CLI is installed globally, run:');
    out(`  ai-verse-os doctor --dir "${target}"`);
    out('Otherwise, open the folder in Claude Code or Codex and continue there.');
    return;
  }

  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length) {
      fail(`Install folder already exists and is not empty: ${target}`);
    }
  }

  out('AI-Verse OS installer');
  out('----------------------');
  out(`Git: ${gitVersion}`);
  out(`Source: ${REPO_URL}`);
  out(`Install to: ${target}`);
  out('');
  out('Downloading AI-Verse OS...');

  run('git', ['clone', '--depth', '1', '--branch', 'main', REPO_URL, target]);

  const missing = validateInstall(target);
  if (missing.length) {
    fail(`Install completed but validation failed. Missing: ${missing.join(', ')}`);
  }

  out('');
  out('✓ AI-Verse OS installed');
  out('✓ Claude skills present');
  out('✓ Codex skills present');
  out('✓ Architecture files present');
  out('');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    out(`Note: Node ${process.versions.node} is enough for the CLI, but Node 22+ is required for the full 3D Brain.`);
    out('');
  }

  out('Next:');
  out(`  cd "${target}"`);
  out('  Open this folder in Claude Code and run /onboard');
  out('  or open it in Codex and run $onboard');
  out('');
  out('If you installed the CLI globally, you can also run: ai-verse-os onboard');
}

function doctor(options) {
  let failed = false;
  const root = resolveRoot(options);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const gitVersion = commandVersion('git');
  const claudeVersion = commandVersion('claude');
  const codexVersion = commandVersion('codex');

  out('AI-Verse OS doctor');
  out('------------------');

  if (nodeMajor >= 18) out(`✓ Node ${process.versions.node}`);
  else {
    out(`✗ Node ${process.versions.node}. Node 18+ is required.`);
    failed = true;
  }

  if (nodeMajor >= 22) out('✓ Node is ready for 3D Brain');
  else out('! Node 22+ recommended for the full 3D Brain');

  if (gitVersion) out(`✓ ${gitVersion}`);
  else {
    out('✗ Git not found');
    failed = true;
  }

  if (!root) {
    out('✗ AI-Verse OS installation not found. Run this inside the OS or pass --dir.');
    failed = true;
  } else {
    out(`✓ AI-Verse OS found: ${root}`);
    const missing = validateInstall(root);
    if (missing.length) {
      out(`✗ Missing core files: ${missing.join(', ')}`);
      failed = true;
    } else {
      out('✓ Core architecture valid');
      out('✓ Claude onboarding skill present');
      out('✓ Codex onboarding skill present');
    }
  }

  if (claudeVersion) out(`✓ Claude CLI: ${claudeVersion}`);
  else out('! Claude CLI not detected (optional if using Codex or another supported runtime)');

  if (codexVersion) out(`✓ Codex CLI: ${codexVersion}`);
  else out('! Codex CLI not detected (optional if using Claude or another supported runtime)');

  if (failed) process.exitCode = 1;
  else out('\nAI-Verse OS is ready.');
}

function update(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  if (!fs.existsSync(path.join(root, '.git'))) {
    fail('This installation is not a Git checkout, so the CLI cannot update it safely.');
  }

  const gitVersion = commandVersion('git');
  if (!gitVersion) fail('Git is required to update AI-Verse OS.');

  const dirty = run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], {
    capture: true,
  }).stdout.trim();

  if (dirty) {
    fail('Tracked system files have local changes. Commit, stash, or revert them before updating. User-owned ignored data is not the problem.');
  }

  out(`Updating AI-Verse OS at ${root}...`);
  run('git', ['-C', root, 'fetch', 'origin', 'main']);
  run('git', ['-C', root, 'merge', '--ff-only', 'origin/main']);

  const missing = validateInstall(root);
  if (missing.length) fail(`Update finished but validation failed. Missing: ${missing.join(', ')}`);

  out('✓ AI-Verse OS is up to date.');
}

function components(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');
  const subcommand = options.positional[0] || 'doctor';
  if (!['doctor', 'reconcile'].includes(subcommand)) {
    fail('components expects doctor or reconcile');
  }
  const script = path.join(root, 'scripts', 'components.mjs');
  if (!fs.existsSync(script)) fail(`Component manager is missing: ${script}`);
  run(process.execPath, [script, subcommand, '--root', root]);
}

function onboard(options) {
  const root = resolveRoot(options);
  if (!root) fail('AI-Verse OS installation not found. Run inside it or use --dir <folder>.');

  const claude = commandVersion('claude');
  const codex = commandVersion('codex');

  out('AI-Verse OS onboarding');
  out('----------------------');
  out(`OS: ${root}`);
  out('');

  if (claude) {
    out('Claude Code detected.');
    out(`  cd "${root}"`);
    out('  claude');
    out('Then run: /onboard');
  }

  if (claude && codex) out('');

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
  case 'install':
    install(options);
    break;
  case 'update':
    update(options);
    break;
  case 'doctor':
    doctor(options);
    break;
  case 'onboard':
    onboard(options);
    break;
  case 'components':
    components(options);
    break;
  case 'version':
    out(CLI_VERSION);
    break;
  case 'help':
    usage();
    break;
  default:
    usage();
    fail(`Unknown command: ${command}`);
}
