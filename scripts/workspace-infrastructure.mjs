#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const STATUS_SCHEMA = 'ai-verse.workspace-infrastructure-status/v1';
const OWNER = 'ai-verse-os';
const DOMAIN = 'workspace-infrastructure';
const CURRENT_GENERATION = 'workspace-id-slot-v1';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

function fail(message, code = 4) {
  process.stderr.write(`workspace-infrastructure: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'detect';
  let root = process.cwd();
  while (args.length) {
    const token = args.shift();
    if (token === '--root' || token === '--dir') {
      const value = args.shift();
      if (!value) fail(`${token} requires a path`, 2);
      root = path.resolve(value);
    } else {
      fail(`unknown option: ${token}`, 2);
    }
  }
  if (command !== 'detect') fail(`unknown command: ${command}`, 2);
  return { root: path.resolve(root) };
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function parseScalar(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"') || value.startsWith("'")) {
    if (value.startsWith('"')) {
      try { return JSON.parse(value); } catch { return value.slice(1, -1); }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function topScalar(text, key) {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
  const match = text.match(re);
  return match ? parseScalar(match[1]) : null;
}

function findNestedWorkspaceManifests(start, root) {
  const found = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(target);
      } else if (entry.isFile() && entry.name === 'WORKSPACE.yaml') {
        found.push(relative(root, target));
      }
    }
  };
  visit(start);
  return found.sort();
}

function addFinding(findings, code, slot, message, details = {}) {
  findings.push({
    code,
    disposition: 'BLOCKED/REVIEW',
    slot,
    message,
    ...details,
  });
}

function detect(root) {
  const findings = [];
  const observations = [];
  const workspacesRoot = path.join(root, 'workspaces');

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('AI-Verse root must be an existing directory');
  }

  if (!fs.existsSync(workspacesRoot)) {
    addFinding(
      findings,
      'workspaces-root-missing',
      'workspaces',
      'The supported Workspaces root is missing.',
    );
    return buildResult(root, observations, findings);
  }

  const workspacesLstat = fs.lstatSync(workspacesRoot);
  if (workspacesLstat.isSymbolicLink() || !workspacesLstat.isDirectory()) {
    addFinding(
      findings,
      'workspaces-root-not-plain-directory',
      'workspaces',
      'The supported Workspaces root must be a real directory, not a symlink or file.',
    );
    return buildResult(root, observations, findings);
  }

  const realWorkspacesRoot = fs.realpathSync(workspacesRoot);
  const entries = fs.readdirSync(realWorkspacesRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== '_template')
    .sort((a, b) => a.name.localeCompare(b.name));

  const byManifestId = new Map();

  for (const entry of entries) {
    const target = path.join(realWorkspacesRoot, entry.name);
    const slot = `workspaces/${entry.name}`;

    if (entry.isSymbolicLink()) {
      addFinding(
        findings,
        'workspace-slot-symlink',
        slot,
        'A Workspace slot is a symlink and cannot be accepted as canonical storage.',
      );
      observations.push({ slot, id: null, generation: null, state: 'blocked-review' });
      continue;
    }

    if (!entry.isDirectory()) continue;

    const observationStart = findings.length;
    let manifestId = null;

    if (!ID_RE.test(entry.name)) {
      addFinding(
        findings,
        'invalid-workspace-slot-id',
        slot,
        'A direct Workspace directory is not a valid canonical Workspace ID slot.',
      );
    }

    const realTarget = fs.realpathSync(target);
    if (!isInside(realTarget, realWorkspacesRoot)) {
      addFinding(
        findings,
        'workspace-slot-escapes-root',
        slot,
        'A Workspace directory resolves outside the supported Workspaces root.',
      );
    }

    const manifestPath = path.join(realTarget, 'WORKSPACE.yaml');
    if (!fs.existsSync(manifestPath)) {
      addFinding(
        findings,
        'workspace-manifest-missing',
        slot,
        'A direct Workspace directory is missing WORKSPACE.yaml.',
      );
    } else if (fs.lstatSync(manifestPath).isSymbolicLink()) {
      addFinding(
        findings,
        'workspace-manifest-symlink',
        slot,
        'WORKSPACE.yaml must be a real file inside its Workspace.',
      );
    } else if (!fs.statSync(manifestPath).isFile()) {
      addFinding(
        findings,
        'workspace-manifest-not-file',
        slot,
        'WORKSPACE.yaml is not a regular file.',
      );
    } else {
      let text = null;
      try {
        text = fs.readFileSync(manifestPath, 'utf8');
      } catch {
        addFinding(
          findings,
          'workspace-manifest-unreadable',
          slot,
          'WORKSPACE.yaml could not be read safely.',
        );
      }
      if (text !== null) {
        manifestId = topScalar(text, 'id');
        if (!manifestId || !ID_RE.test(manifestId)) {
          addFinding(
            findings,
            'invalid-workspace-manifest-id',
            slot,
            'WORKSPACE.yaml does not contain a valid canonical Workspace ID.',
          );
          manifestId = null;
        } else {
          const existing = byManifestId.get(manifestId) ?? [];
          existing.push(slot);
          byManifestId.set(manifestId, existing);
          if (manifestId !== entry.name) {
            addFinding(
              findings,
              'workspace-id-slot-mismatch',
              slot,
              'Workspace identity does not match its currently supported storage slot.',
              { manifest_id: manifestId },
            );
          }
        }
      }
    }

    for (const nested of findNestedWorkspaceManifests(realTarget, root)) {
      if (nested === `${slot}/WORKSPACE.yaml`) continue;
      addFinding(
        findings,
        'nested-workspace-manifest',
        slot,
        'A nested WORKSPACE.yaml was found below a direct Workspace/root slot; nested Workspace storage is not supported by the current generation.',
        { nested_manifest: nested },
      );
    }

    observations.push({
      slot,
      id: manifestId,
      generation: findings.length === observationStart ? CURRENT_GENERATION : null,
      state: findings.length === observationStart ? 'current' : 'blocked-review',
    });
  }

  for (const [manifestId, slots] of [...byManifestId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (slots.length < 2) continue;
    for (const slot of slots.sort()) {
      addFinding(
        findings,
        'duplicate-workspace-id',
        slot,
        'The same canonical Workspace ID is claimed by more than one storage slot.',
        { manifest_id: manifestId, conflicting_slots: slots },
      );
      const observation = observations.find((item) => item.slot === slot);
      if (observation) {
        observation.generation = null;
        observation.state = 'blocked-review';
      }
    }
  }

  return buildResult(root, observations, findings);
}

function buildResult(root, observations, findings) {
  findings.sort((a, b) => `${a.slot}:${a.code}`.localeCompare(`${b.slot}:${b.code}`));
  observations.sort((a, b) => a.slot.localeCompare(b.slot));
  const current = findings.length === 0;
  return {
    schema_version: STATUS_SCHEMA,
    owner: OWNER,
    domain: DOMAIN,
    current_generation: CURRENT_GENERATION,
    state: current ? 'current' : 'blocked-review',
    disposition: current ? 'CURRENT' : 'BLOCKED/REVIEW',
    root: path.resolve(root),
    workspace_count: observations.length,
    workspaces: observations,
    findings,
    mutated: false,
  };
}

const { root } = parseArgs(process.argv.slice(2));
try {
  const result = detect(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.state === 'current' ? 0 : 2);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
