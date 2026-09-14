#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const PROVENANCE_FILE = 'context/AUTO-ORGANIZATION.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

function fail(message, code = 4) {
  process.stderr.write(`workspace-owner: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'ensure';
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
  if (command !== 'ensure') fail(`unknown command: ${command}`, 2);
  return { root: path.resolve(root) };
}

async function readInput() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error('ensure requires one JSON request on stdin');
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`request is invalid JSON: ${error.message}`); }
  return value;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function assertPlainDirectory(target, expected, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} does not exist`);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (path.relative(real, expected) !== '' || path.relative(expected, real) !== '') throw new Error(`${label} is not its expected physical slot`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory`);
  return real;
}

function safeFile(target, boundary, label) {
  if (!fs.existsSync(target)) return null;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!isInside(real, boundary) || !fs.statSync(real).isFile()) throw new Error(`${label} escapes its scope boundary`);
  return real;
}

function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
}

function cleanString(value, label, { required = false, max = 2000 } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const out = value.trim();
  if (required && !out) throw new Error(`${label} is required`);
  if (out.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return out || null;
}

function cleanStringArray(value, label, maxItems = 32) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`);
  const out = value.map((item, index) => cleanString(item, `${label}[${index}]`, { required: true, max: 500 }));
  return [...new Set(out)];
}

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128).replace(/-+$/g, '');
}

function normalizedName(value) {
  return value.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function containsSecretLike(value) {
  const text = JSON.stringify(value);
  return /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key)\s*[:=]\s*["']?[^\s"',}]{6,}/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(text);
}

function normalizeRequest(raw) {
  rejectUnknownKeys(raw, new Set(['workspace', 'evidence', 'authority', 'provenance']), 'request');
  rejectUnknownKeys(raw.workspace, new Set(['id', 'name', 'type', 'purpose', 'domains', 'canonical_sources']), 'workspace');
  rejectUnknownKeys(raw.evidence, new Set(['substantial_scope', 'boundary_clear', 'reason']), 'evidence');
  rejectUnknownKeys(raw.authority, new Set(['permission_expansion', 'privacy_ambiguous', 'new_connection', 'new_credential']), 'authority');
  rejectUnknownKeys(raw.provenance ?? {}, new Set(['trigger_ref', 'classifier', 'source']), 'provenance');

  const name = cleanString(raw.workspace.name, 'workspace.name', { required: true, max: 200 });
  const id = cleanString(raw.workspace.id, 'workspace.id', { max: 128 }) || slugify(name);
  if (!id || !ID_RE.test(id)) throw new Error('workspace.id cannot be derived safely; provide a lowercase slug');
  const type = cleanString(raw.workspace.type, 'workspace.type', { max: 100 }) || 'custom';
  const purpose = cleanString(raw.workspace.purpose, 'workspace.purpose', { max: 1000 }) || `Isolate work for ${name}.`;
  const domains = cleanStringArray(raw.workspace.domains, 'workspace.domains');
  const canonicalSources = cleanStringArray(raw.workspace.canonical_sources, 'workspace.canonical_sources');
  const reason = cleanString(raw.evidence.reason, 'evidence.reason', { required: true, max: 1000 });
  const triggerRef = cleanString(raw.provenance?.trigger_ref, 'provenance.trigger_ref', { max: 300 });
  const classifier = cleanString(raw.provenance?.classifier, 'provenance.classifier', { max: 200 });
  const source = cleanString(raw.provenance?.source, 'provenance.source', { max: 300 });

  const normalized = {
    workspace: { id, name, type, purpose, domains, canonical_sources: canonicalSources },
    evidence: {
      substantial_scope: raw.evidence.substantial_scope === true,
      boundary_clear: raw.evidence.boundary_clear === true,
      reason,
    },
    authority: {
      permission_expansion: raw.authority.permission_expansion === true,
      privacy_ambiguous: raw.authority.privacy_ambiguous === true,
      new_connection: raw.authority.new_connection === true,
      new_credential: raw.authority.new_credential === true,
    },
    provenance: { trigger_ref: triggerRef, classifier, source },
  };
  if (containsSecretLike(normalized)) throw new Error('request appears to contain credential/secret material; workspace organization accepts references, not secrets');
  return normalized;
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
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const PROVENANCE_FILE = 'context/AUTO-ORGANIZATION.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

function fail(message, code = 4) {
  process.stderr.write(`workspace-owner: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'ensure';
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
  if (command !== 'ensure') fail(`unknown command: ${command}`, 2);
  return { root: path.resolve(root) };
}

async function readInput() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error('ensure requires one JSON request on stdin');
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`request is invalid JSON: ${error.message}`); }
  return value;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function assertPlainDirectory(target, expected, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} does not exist`);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (path.relative(real, expected) !== '' || path.relative(expected, real) !== '') throw new Error(`${label} is not its expected physical slot`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory`);
  return real;
}

function safeFile(target, boundary, label) {
  if (!fs.existsSync(target)) return null;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!isInside(real, boundary) || !fs.statSync(real).isFile()) throw new Error(`${label} escapes its scope boundary`);
  return real;
}

function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
}

function cleanString(value, label, { required = false, max = 2000 } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const out = value.trim();
  if (required && !out) throw new Error(`${label} is required`);
  if (out.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return out || null;
}

function cleanStringArray(value, label, maxItems = 32) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`);
  const out = value.map((item, index) => cleanString(item, `${label}[${index}]`, { required: true, max: 500 }));
  return [...new Set(out)];
}

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128).replace(/-+$/g, '');
}

function normalizedName(value) {
  return value.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function containsSecretLike(value) {
  const text = JSON.stringify(value);
  return /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key)\s*[:=]\s*["']?[^\s"',}]{6,}/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(text);
}

function normalizeRequest(raw) {
  rejectUnknownKeys(raw, new Set(['workspace', 'evidence', 'authority', 'provenance']), 'request');
  rejectUnknownKeys(raw.workspace, new Set(['id', 'name', 'type', 'purpose', 'domains', 'canonical_sources']), 'workspace');
  rejectUnknownKeys(raw.evidence, new Set(['substantial_scope', 'boundary_clear', 'reason']), 'evidence');
  rejectUnknownKeys(raw.authority, new Set(['permission_expansion', 'privacy_ambiguous', 'new_connection', 'new_credential']), 'authority');
  rejectUnknownKeys(raw.provenance ?? {}, new Set(['trigger_ref', 'classifier', 'source']), 'provenance');

  const name = cleanString(raw.workspace.name, 'workspace.name', { required: true, max: 200 });
  const id = cleanString(raw.workspace.id, 'workspace.id', { max: 128 }) || slugify(name);
  if (!id || !ID_RE.test(id)) throw new Error('workspace.id cannot be derived safely; provide a lowercase slug');
  const type = cleanString(raw.workspace.type, 'workspace.type', { max: 100 }) || 'custom';
  const purpose = cleanString(raw.workspace.purpose, 'workspace.purpose', { max: 1000 }) || `Isolate work for ${name}.`;
  const domains = cleanStringArray(raw.workspace.domains, 'workspace.domains');
  const canonicalSources = cleanStringArray(raw.workspace.canonical_sources, 'workspace.canonical_sources');
  const reason = cleanString(raw.evidence.reason, 'evidence.reason', { required: true, max: 1000 });
  const triggerRef = cleanString(raw.provenance?.trigger_ref, 'provenance.trigger_ref', { max: 300 });
  const classifier = cleanString(raw.provenance?.classifier, 'provenance.classifier', { max: 200 });
  const source = cleanString(raw.provenance?.source, 'provenance.source', { max: 300 });

  const normalized = {
    workspace: { id, name, type, purpose, domains, canonical_sources: canonicalSources },
    evidence: {
      substantial_scope: raw.evidence.substantial_scope === true,
      boundary_clear: raw.evidence.boundary_clear === true,
      reason,
    },
    authority: {
      permission_expansion: raw.authority.permission_expansion === true,
      privacy_ambiguous: raw.authority.privacy_ambiguous === true,
      new_connection: raw.authority.new_connection === true,
      new_credential: raw.authority.new_credential === true,
    },
    provenance: { trigger_ref: triggerRef, classifier, source },
  };
  if (containsSecretLike(normalized)) throw new Error('request appears to contain credential/secret material; workspace organization accepts references, not secrets');
  return normalized;
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
, 'm');
  const match = text.match(re);
  return match ? parseScalar(match[1]) : null;
}

function inventoryWorkspaces(root, workspacesRoot) {
  const entries = [];
  for (const dirent of fs.readdirSync(workspacesRoot, { withFileTypes: true })) {
    if (dirent.name === '_template') continue;
    const target = path.join(workspacesRoot, dirent.name);
    if (dirent.isSymbolicLink()) throw new Error(`workspace entry must not be a symlink: ${dirent.name}`);
    if (!dirent.isDirectory()) continue;
    const real = fs.realpathSync(target);
    if (!isInside(real, workspacesRoot)) throw new Error(`workspace entry escapes workspaces root: ${dirent.name}`);
    const manifestPath = path.join(real, 'WORKSPACE.yaml');
    const manifest = safeFile(manifestPath, real, `workspace ${dirent.name} manifest`);
    let id = dirent.name;
    let name = dirent.name;
    if (manifest) {
      const text = fs.readFileSync(manifest, 'utf8');
      id = topScalar(text, 'id') || id;
      name = topScalar(text, 'name') || name;
    }
    entries.push({ dir: dirent.name, root: real, manifest, id, name });
  }
  return entries;
}

function selectExisting(entries, request) {
  const targetId = request.workspace.id;
  const targetName = normalizedName(request.workspace.name);
  const matches = entries.filter((entry) =>
    entry.dir === targetId ||
    entry.id === targetId ||
    normalizedName(entry.name) === targetName
  );
  const unique = [...new Map(matches.map((entry) => [entry.root, entry])).values()];
  if (unique.length > 1) return { conflict: unique.map((entry) => ({ id: entry.id, name: entry.name, dir: entry.dir })) };
  return { entry: unique[0] ?? null };
}

function renderList(key, values) {
  if (!values.length) return `${key}: []\n`;
  return `${key}:\n${values.map((value) => `  - ${JSON.stringify(value)}`).join('\n')}\n`;
}

function renderManifest(request, now) {
  const w = request.workspace;
  return [
    'schema_version: "2.0"',
    `id: ${JSON.stringify(w.id)}`,
    `name: ${JSON.stringify(w.name)}`,
    `type: ${JSON.stringify(w.type)}`,
    'status: "active"',
    renderList('domains', w.domains).trimEnd(),
    `purpose: ${JSON.stringify(w.purpose)}`,
    'owners: []',
    'success_criteria: []',
    'current_context: "context/CURRENT.md"',
    renderList('canonical_sources', w.canonical_sources).trimEnd(),
    'connections: []',
    'privacy:',
    '  classification: "private"',
    '  notes: "Automatically organized without widening known privacy or permission boundaries."',
    'approval:',
    '  external_actions: "confirm"',
    '  destructive_actions: "confirm"',
    '  high_stakes_decisions: "human-review"',
    'capabilities:',
    '  shared: []',
    '  local: []',
    'automations: []',
    'metadata:',
    `  created: ${JSON.stringify(now)}`,
    `  last_reviewed: ${JSON.stringify(now)}`,
    '  auto_organized: true',
    '',
  ].join('\n');
}

function renderCurrent(request, now) {
  const sources = request.workspace.canonical_sources.length
    ? request.workspace.canonical_sources.map((value) => `- ${value}`)
    : ['- none yet'];
  return [
    '# Current Workspace Context',
    '',
    `Last reviewed: ${now.slice(0, 10)}`,
    '',
    '## Current state',
    '',
    `- This workspace isolates ongoing work for ${request.workspace.name}.`,
    '',
    '## Next useful actions',
    '',
    '- Continue the requested work inside this scope.',
    '',
    '## Pending decisions',
    '',
    '- none',
    '',
    '## Constraints / approvals',
    '',
    '- Internal organization does not grant new permissions, credentials, Connections, external actions, or recurring responsibilities.',
    '',
    '## Source pointers',
    '',
    ...sources,
    '',
  ].join('\n');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  return value;
}

function eventFingerprint(request, workspaceId) {
  const material = stableObject({
    workspace_id: workspaceId,
    reason: request.evidence.reason,
    domains: request.workspace.domains,
    canonical_sources: request.workspace.canonical_sources,
    trigger_ref: request.provenance.trigger_ref,
    classifier: request.provenance.classifier,
    source: request.provenance.source,
  });
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function updateProvenance(workspaceRoot, request, kind, now) {
  const file = path.join(workspaceRoot, ...PROVENANCE_FILE.split('/'));
  const existing = safeFile(file, workspaceRoot, 'workspace auto-organization provenance');
  let doc = { schema_version: SCHEMA_VERSION, workspace_id: request.workspace.id, history: [] };
  if (existing) {
    try { doc = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch (error) { throw new Error(`workspace auto-organization provenance is unreadable: ${error.message}`); }
    if (!doc || doc.schema_version !== SCHEMA_VERSION || doc.workspace_id !== request.workspace.id || !Array.isArray(doc.history)) {
      throw new Error('workspace auto-organization provenance is incompatible');
    }
  }
  const fingerprint = eventFingerprint(request, request.workspace.id);
  if (doc.history.some((event) => event.fingerprint === fingerprint)) return { changed: false, fingerprint, file: path.relative(workspaceRoot, file).split(path.sep).join('/') };
  doc.history.push({
    fingerprint,
    kind,
    at: now,
    reason: request.evidence.reason,
    trigger_ref: request.provenance.trigger_ref,
    classifier: request.provenance.classifier,
    source: request.provenance.source,
    domains: request.workspace.domains,
    canonical_sources: request.workspace.canonical_sources,
  });
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { changed: true, fingerprint, file: path.relative(workspaceRoot, file).split(path.sep).join('/') };
}

function parseListItem(raw) {
  const match = raw.match(/^\s{2}-\s+(.+?)\s*$/);
  return match ? parseScalar(match[1]) : null;
}

function mergeTopLevelList(text, key, additions) {
  if (!additions.length) return { text, changed: false, supported: true };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(.*)$`).test(line));
  if (start < 0) return { text, changed: false, supported: false };
  const first = lines[start].match(new RegExp(`^${key}:\\s*(.*)$`))[1].trim();
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) end += 1;

  let current = [];
  if (first === '[]' || first === '') {
    for (let i = start + 1; i < end; i += 1) {
      if (!lines[i].trim()) continue;
      const item = parseListItem(lines[i]);
      if (item == null) return { text, changed: false, supported: false };
      current.push(item);
    }
  } else {
    return { text, changed: false, supported: false };
  }

  const merged = [...current];
  for (const value of additions) if (!merged.includes(value)) merged.push(value);
  if (merged.length === current.length) return { text, changed: false, supported: true };
  const replacement = merged.length ? [`${key}:`, ...merged.map((value) => `  - ${JSON.stringify(value)}`)] : [`${key}: []`];
  lines.splice(start, end - start, ...replacement);
  return { text: lines.join('\n'), changed: true, supported: true };
}

function safelyEvolveManifest(entry, request) {
  if (!entry.manifest) return { changed: false, diagnostics: ['existing workspace has no manifest; canonical boundary was not guessed'] };
  let text = fs.readFileSync(entry.manifest, 'utf8');
  const diagnostics = [];
  let changed = false;
  for (const [key, additions] of [['domains', request.workspace.domains], ['canonical_sources', request.workspace.canonical_sources]]) {
    const merged = mergeTopLevelList(text, key, additions);
    if (!merged.supported && additions.length) diagnostics.push(`${key} uses unsupported YAML shape; left unchanged rather than rewriting user-owned syntax`);
    text = merged.text;
    changed ||= merged.changed;
  }
  if (changed) atomicWrite(entry.manifest, text.endsWith('\n') ? text : `${text}\n`);
  return { changed, diagnostics };
}

function ensureOperationalContext(workspaceRoot, request, now) {
  const contextDir = path.join(workspaceRoot, 'context');
  if (fs.existsSync(contextDir)) {
    if (fs.lstatSync(contextDir).isSymbolicLink() || !fs.statSync(contextDir).isDirectory()) {
      throw new Error('workspace context path must be a real directory');
    }
    const real = fs.realpathSync(contextDir);
    if (!isInside(real, workspaceRoot)) throw new Error('workspace context directory escapes workspace boundary');
  } else {
    fs.mkdirSync(contextDir, { recursive: true, mode: 0o700 });
  }
  const current = path.join(contextDir, 'CURRENT.md');
  const existing = safeFile(current, workspaceRoot, 'workspace current context');
  if (existing) return { changed: false, path: current };
  atomicWrite(current, renderCurrent(request, now));
  return { changed: true, path: current };
}

function createWorkspace(workspacesRoot, request, now) {
  const target = path.join(workspacesRoot, request.workspace.id);
  if (!isInside(target, workspacesRoot)) throw new Error('workspace path escapes workspaces root');
  if (fs.existsSync(target)) throw new Error('target workspace path already exists but was not selected as the matching workspace');
  fs.mkdirSync(path.join(target, 'context'), { recursive: true, mode: 0o700 });
  atomicWrite(path.join(target, 'WORKSPACE.yaml'), renderManifest(request, now));
  atomicWrite(path.join(target, 'context', 'CURRENT.md'), renderCurrent(request, now));
  return fs.realpathSync(target);
}

function resultBase(request) {
  return {
    schema_version: SCHEMA_VERSION,
    operation: 'ensure',
    requested_workspace: { id: request.workspace.id, name: request.workspace.name },
    user_confirmation_required: false,
    permission_expanded: false,
    connection_created: false,
    credential_created: false,
    automation_created: false,
    permanent_bot_created: false,
  };
}

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const request = normalizeRequest(await readInput());
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) throw new Error(`AI-Verse OS root not found: ${root}`);
  const realRoot = fs.realpathSync(root);
  const workspacesExpected = path.join(realRoot, 'workspaces');
  const workspacesRoot = assertPlainDirectory(path.join(root, 'workspaces'), workspacesExpected, 'workspaces root');
  const base = resultBase(request);

  if (!request.evidence.substantial_scope) {
    process.stdout.write(`${JSON.stringify({ ...base, state: 'ignored-trivial', changed: false, reason: 'scope is not substantial enough to justify isolation' }, null, 2)}\n`);
    return;
  }
  if (!request.evidence.boundary_clear || request.authority.privacy_ambiguous) {
    process.stdout.write(`${JSON.stringify({ ...base, state: 'needs-clarification', changed: false, user_confirmation_required: true, reason: 'scope/privacy boundary is materially ambiguous' }, null, 2)}\n`);
    return;
  }
  if (request.authority.permission_expansion || request.authority.new_connection || request.authority.new_credential) {
    process.stdout.write(`${JSON.stringify({ ...base, state: 'blocked-authority', changed: false, user_confirmation_required: true, reason: 'workspace organization cannot grant permissions, Connections, or credentials' }, null, 2)}\n`);
    return;
  }

  const entries = inventoryWorkspaces(realRoot, workspacesRoot);
  const selected = selectExisting(entries, request);
  if (selected.conflict) {
    process.stdout.write(`${JSON.stringify({ ...base, state: 'needs-clarification', changed: false, user_confirmation_required: true, reason: 'multiple existing workspaces match this scope', matches: selected.conflict }, null, 2)}\n`);
    return;
  }

  const now = new Date().toISOString();
  let workspaceRoot;
  let state;
  let manifestEvolution = { changed: false, diagnostics: [] };
  let contextEvolution = { changed: false, path: null };
  if (selected.entry) {
    workspaceRoot = selected.entry.root;
    request.workspace.id = selected.entry.id;
    state = 'existing';
    manifestEvolution = safelyEvolveManifest(selected.entry, request);
    contextEvolution = ensureOperationalContext(workspaceRoot, request, now);
  } else {
    workspaceRoot = createWorkspace(workspacesRoot, request, now);
    contextEvolution = { changed: true, path: path.join(workspaceRoot, 'context', 'CURRENT.md') };
    state = 'created';
  }

  const provenance = updateProvenance(workspaceRoot, request, selected.entry ? 'evolved' : 'created', now);
  const changed = !selected.entry || manifestEvolution.changed || contextEvolution.changed || provenance.changed;
  if (selected.entry && changed) state = 'evolved';

  process.stdout.write(`${JSON.stringify({
    ...base,
    state,
    changed,
    workspace: {
      id: request.workspace.id,
      name: request.workspace.name,
      path: path.relative(realRoot, workspaceRoot).split(path.sep).join('/'),
      manifest: path.relative(realRoot, path.join(workspaceRoot, 'WORKSPACE.yaml')).split(path.sep).join('/'),
      current_context: path.relative(realRoot, path.join(workspaceRoot, 'context', 'CURRENT.md')).split(path.sep).join('/'),
    },
    provenance,
    diagnostics: manifestEvolution.diagnostics,
  }, null, 2)}\n`);
}

main().catch((error) => fail(error.message, 4));
