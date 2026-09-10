#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const ACTION_PERMISSION_SOURCE = 'ai-verse-os/action-permission-v1';
export const POLICY_VALUES = new Set(['allow', 'confirm', 'human-review', 'deny']);
export const DEFAULT_APPROVAL = Object.freeze({
  external_actions: 'confirm',
  destructive_actions: 'confirm',
  high_stakes_decisions: 'human-review',
});

export const ACTION_CLASSES = new Set([
  'read_local',
  'read_connected',
  'write_local_reversible',
  'modify_canonical_state',
  'external_write_reversible',
  'send_message',
  'publish_publicly',
  'spend_money',
  'create_commit_or_pr',
  'merge_or_deploy',
  'delete_data',
  'change_permissions',
  'security_sensitive',
  'high_stakes_domain_action',
]);

const REQUEST_FIELDS = new Set([
  'request_id', 'action_class', 'scope', 'operation', 'parameters', 'idempotency_key',
  'in_scope', 'within_budget', 'reversible', 'reason', 'created_at', 'request_fingerprint',
]);
const POLICY_KEYS = new Set(Object.keys(DEFAULT_APPROVAL));
const HEX64 = /^[a-f0-9]{64}$/;
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SCOPE = /^(operator|workspace:[a-z0-9][a-z0-9._-]{0,127})$/;
const POLICY_RANK = Object.freeze({ allow: 0, confirm: 1, 'human-review': 2, deny: 3 });

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function scalar(raw) {
  let value = String(raw ?? '').trim();
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash).trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return String(JSON.parse(value)); } catch { throw new Error('invalid quoted YAML scalar'); }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function indentOf(line) {
  if (/\t/.test(line.match(/^[\t ]*/)?.[0] ?? '')) throw new Error('tabs are not allowed in policy YAML');
  return line.length - line.trimStart().length;
}

function parseTopLevelScalars(text, wanted) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent !== 0 || !trimmed.includes(':')) continue;
    const at = trimmed.indexOf(':');
    const key = trimmed.slice(0, at).trim();
    if (!wanted.has(key)) continue;
    if (own(result, key)) throw new Error(`duplicate top-level field: ${key}`);
    result[key] = scalar(trimmed.slice(at + 1));
  }
  return result;
}

function parseApprovalSection(text, { strictDocument = false } = {}) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let approvalIndent = null;
  let seenApproval = false;
  let seenSchema = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(line);

    if (approvalIndent === null) {
      if (indent !== 0) {
        if (strictDocument) throw new Error('unexpected nested content outside approval');
        continue;
      }
      if (!trimmed.includes(':')) throw new Error('invalid YAML mapping line');
      const at = trimmed.indexOf(':');
      const key = trimmed.slice(0, at).trim();
      const raw = trimmed.slice(at + 1);
      if (key === 'schema_version') {
        if (!strictDocument) continue;
        if (seenSchema) throw new Error('duplicate schema_version');
        seenSchema = true;
        if (scalar(raw) !== '1.0') throw new Error('unsupported action permission schema_version');
        continue;
      }
      if (key === 'approval') {
        if (seenApproval) throw new Error('duplicate approval section');
        if (scalar(raw) !== '') throw new Error('approval must be a mapping');
        seenApproval = true;
        approvalIndent = indent;
        continue;
      }
      if (strictDocument) throw new Error(`unknown action permission policy field: ${key}`);
      continue;
    }

    if (indent <= approvalIndent) {
      approvalIndent = null;
      index -= 1;
      continue;
    }
    if (indent !== approvalIndent + 2 || !trimmed.includes(':')) {
      throw new Error('approval entries must be direct two-space mapping children');
    }
    const at = trimmed.indexOf(':');
    const key = trimmed.slice(0, at).trim();
    if (!POLICY_KEYS.has(key)) throw new Error(`unknown approval key: ${key}`);
    if (own(out, key)) throw new Error(`duplicate approval key: ${key}`);
    const value = scalar(trimmed.slice(at + 1));
    if (!POLICY_VALUES.has(value)) throw new Error(`invalid approval value for ${key}: ${value}`);
    out[key] = value;
  }

  if (strictDocument && (!seenSchema || !seenApproval)) {
    throw new Error('action permission policy requires schema_version and approval');
  }
  return out;
}

function assertRegularContainedFile(file, root, label) {
  const rootReal = fs.realpathSync(root);
  const parentReal = fs.realpathSync(path.dirname(file));
  const relativeParent = path.relative(rootReal, parentReal);
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new Error(`${label} parent escapes OS root`);
  }
  const lst = fs.lstatSync(file);
  if (lst.isSymbolicLink() || !lst.isFile()) throw new Error(`${label} must be a regular file`);
  const real = fs.realpathSync(file);
  const rel = path.relative(rootReal, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes OS root`);
  }
  return real;
}

function validateOsRoot(osRoot) {
  const root = fs.realpathSync(path.resolve(osRoot));
  const manifest = path.join(root, 'AI-VERSE.yaml');
  assertRegularContainedFile(manifest, root, 'AI-VERSE.yaml');
  const top = parseTopLevelScalars(fs.readFileSync(manifest, 'utf8'), new Set(['schema_version', 'architecture']));
  if (!/^2\./.test(top.schema_version ?? '') || top.architecture !== 'unified-workspace') {
    throw new Error('incompatible AI-Verse OS host');
  }
  if (!fs.statSync(path.join(root, 'operator')).isDirectory() || !fs.statSync(path.join(root, 'workspaces')).isDirectory()) {
    throw new Error('incomplete AI-Verse OS v2 host');
  }
  return root;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('permission request must be an object');
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(key)) throw new Error(`unknown permission request field: ${key}`);
  }
  for (const key of ['action_class', 'scope', 'request_fingerprint']) {
    if (typeof request[key] !== 'string' || !request[key]) throw new Error(`permission request ${key} is required`);
  }
  if (!ACTION_CLASSES.has(request.action_class)) throw new Error(`unknown action class: ${request.action_class}`);
  if (!SCOPE.test(request.scope)) throw new Error(`invalid action scope: ${request.scope}`);
  if (!HEX64.test(request.request_fingerprint)) throw new Error('request_fingerprint must be 64 lowercase hex characters');
  return request;
}

function applicableCategories(actionClass) {
  switch (actionClass) {
    case 'read_local':
    case 'write_local_reversible':
    case 'modify_canonical_state':
      return [];
    case 'read_connected':
    case 'external_write_reversible':
    case 'send_message':
    case 'publish_publicly':
    case 'create_commit_or_pr':
    case 'merge_or_deploy':
      return ['external_actions'];
    case 'spend_money':
      return ['external_actions', 'high_stakes_decisions'];
    case 'delete_data':
      return ['destructive_actions'];
    case 'change_permissions':
    case 'security_sensitive':
      return ['destructive_actions', 'high_stakes_decisions'];
    case 'high_stakes_domain_action':
      return ['high_stakes_decisions'];
    default:
      throw new Error(`unknown action class: ${actionClass}`);
  }
}

function stricter(left, right) {
  return POLICY_RANK[left] >= POLICY_RANK[right] ? left : right;
}

function operatorApproval(root) {
  const policyFile = path.join(root, 'automations', 'policies', 'action-permissions.yaml');
  if (!fs.existsSync(policyFile)) return { ...DEFAULT_APPROVAL };
  assertRegularContainedFile(policyFile, root, 'operator action permission policy');
  const parsed = parseApprovalSection(fs.readFileSync(policyFile, 'utf8'), { strictDocument: true });
  return { ...DEFAULT_APPROVAL, ...parsed };
}

function workspaceApproval(root, workspaceId) {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error('workspace id is not valid for AI-Verse OS');
  const dir = path.join(root, 'workspaces', workspaceId);
  const dirReal = fs.realpathSync(dir);
  const workspacesReal = fs.realpathSync(path.join(root, 'workspaces'));
  const rel = path.relative(workspacesReal, dirReal);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('workspace path escapes workspaces root');
  }
  const manifest = path.join(dirReal, 'WORKSPACE.yaml');
  assertRegularContainedFile(manifest, root, 'workspace manifest');
  const text = fs.readFileSync(manifest, 'utf8');
  const top = parseTopLevelScalars(text, new Set(['schema_version', 'id', 'status']));
  if (!/^2\./.test(top.schema_version ?? '')) throw new Error('workspace schema is incompatible');
  if (top.id !== workspaceId) throw new Error('workspace manifest id does not match scope');
  if (!['active', 'paused', 'archived'].includes(top.status)) throw new Error('workspace status is invalid');
  if (top.status !== 'active') return { state: top.status, approval: { ...DEFAULT_APPROVAL } };
  const parsed = parseApprovalSection(text);
  return { state: 'active', approval: { ...DEFAULT_APPROVAL, ...parsed } };
}

function decisionForPolicy(policy) {
  if (policy === 'deny') return 'deny';
  if (policy === 'confirm' || policy === 'human-review') return 'approval_required';
  return 'allow';
}

function boundResult(request, decision, reason) {
  return {
    decision,
    request_fingerprint: request.request_fingerprint,
    scope: request.scope,
    action_class: request.action_class,
    source: ACTION_PERMISSION_SOURCE,
    reason,
  };
}

export function evaluateActionPermission({ osRoot = process.cwd(), request }) {
  validateRequest(request);
  let root;
  try {
    root = validateOsRoot(osRoot);
  } catch (error) {
    return boundResult(request, 'deny', `OS permission failed closed: ${error.message}`);
  }

  let operator;
  try {
    operator = operatorApproval(root);
  } catch (error) {
    return boundResult(request, 'deny', `operator permission policy failed closed: ${error.message}`);
  }

  let workspace = null;
  if (request.scope.startsWith('workspace:')) {
    try {
      workspace = workspaceApproval(root, request.scope.slice('workspace:'.length));
    } catch (error) {
      return boundResult(request, 'deny', `workspace permission policy failed closed: ${error.message}`);
    }
    if (workspace.state !== 'active') {
      return boundResult(request, 'deny', `workspace is ${workspace.state}; action execution is disabled`);
    }
  }

  const categories = applicableCategories(request.action_class);
  if (categories.length === 0) {
    return boundResult(request, 'allow', 'OS has no additional permission floor for this local action class');
  }

  let effective = 'allow';
  const applied = [];
  for (const category of categories) {
    const operatorValue = operator[category] ?? DEFAULT_APPROVAL[category];
    let value = operatorValue;
    if (workspace) value = stricter(value, workspace.approval[category] ?? DEFAULT_APPROVAL[category]);
    effective = stricter(effective, value);
    applied.push(`${category}=${value}`);
  }

  return boundResult(
    request,
    decisionForPolicy(effective),
    `OS permission floor (${applied.join(', ')}) resolved to ${effective}`,
  );
}

function parseCli(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      if (index + 1 >= argv.length) throw new Error('--root requires a path');
      root = argv[++index];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node scripts/action-permission.mjs [--root <ai-verse-os-root>] < request.json\n');
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { root };
}

async function main() {
  const { root } = parseCli(process.argv.slice(2));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('permission request JSON is required on stdin');
  const request = JSON.parse(raw);
  const result = evaluateActionPermission({ osRoot: root, request });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`action-permission: ${error.message}\n`);
    process.exitCode = 2;
  });
}
