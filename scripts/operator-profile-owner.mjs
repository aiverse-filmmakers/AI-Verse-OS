#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const IDENTITY_FILE = 'identity.md';
const PREFERENCES_FILE = 'preferences.md';
const PROVENANCE_FILE = 'AUTO-ORGANIZATION.json';
const START = '<!-- ai-verse-profile:auto:start -->';
const END = '<!-- ai-verse-profile:auto:end -->';

function fail(message, code = 4) {
  process.stderr.write(`operator-profile-owner: ${message}\n`);
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
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`request is invalid JSON: ${error.message}`); }
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
  if (path.relative(real, expected) !== '' || path.relative(expected, real) !== '') {
    throw new Error(`${label} is not its expected physical slot`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory`);
  return real;
}

function safeFile(target, boundary, label) {
  if (!fs.existsSync(target)) return null;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!isInside(real, boundary) || !fs.statSync(real).isFile()) {
    throw new Error(`${label} escapes its scope boundary`);
  }
  return real;
}

function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
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

function cleanStringArray(value, label, maxItems = 64) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`);
  const out = value.map((item, index) =>
    cleanString(item, `${label}[${index}]`, { required: true, max: 1000 })
  );
  return [...new Set(out)];
}

function containsSecretLike(value) {
  const text = JSON.stringify(value);
  return /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key)\s*[:=]\s*["']?[^\s"',}]{6,}/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(text);
}

function containsForeignRuntimeInstruction(value) {
  const text = String(value ?? '').trim();
  return /\b(?:you are\s+(?:hermes|claude|chatgpt|codex)|call\s+(?:the\s+)?[A-Za-z0-9_-]*\s*(?:memory|tool)|use\s+(?:hermes|claude|chatgpt|codex)\s+(?:tool|subagent|agent)|ignore\s+(?:the\s+)?(?:system|developer|previous)\s+instructions?)\b/i.test(text);
}

function normalizeRequest(raw) {
  rejectUnknownKeys(raw, new Set(['identity', 'preferences', 'evidence', 'provenance']), 'request');
  rejectUnknownKeys(raw.identity ?? {}, new Set(['name', 'roles', 'domains', 'notes']), 'identity');
  rejectUnknownKeys(
    raw.preferences ?? {},
    new Set(['communication', 'working_style', 'approval_boundaries', 'quality_expectations', 'avoid']),
    'preferences'
  );
  rejectUnknownKeys(
    raw.evidence,
    new Set(['stable', 'explicit_or_strong', 'privacy_ambiguous', 'contains_sensitive', 'contains_secret', 'reason']),
    'evidence'
  );
  rejectUnknownKeys(raw.provenance ?? {}, new Set(['trigger_ref', 'classifier', 'source']), 'provenance');

  const identity = {
    name: cleanString(raw.identity?.name, 'identity.name', { max: 200 }),
    roles: cleanStringArray(raw.identity?.roles, 'identity.roles', 32),
    domains: cleanStringArray(raw.identity?.domains, 'identity.domains', 32),
    notes: cleanStringArray(raw.identity?.notes, 'identity.notes', 64),
  };
  const preferences = {
    communication: cleanStringArray(raw.preferences?.communication, 'preferences.communication', 64),
    working_style: cleanStringArray(raw.preferences?.working_style, 'preferences.working_style', 64),
    approval_boundaries: cleanStringArray(raw.preferences?.approval_boundaries, 'preferences.approval_boundaries', 32),
    quality_expectations: cleanStringArray(raw.preferences?.quality_expectations, 'preferences.quality_expectations', 64),
    avoid: cleanStringArray(raw.preferences?.avoid, 'preferences.avoid', 64),
  };
  const evidence = {
    stable: raw.evidence.stable === true,
    explicit_or_strong: raw.evidence.explicit_or_strong === true,
    privacy_ambiguous: raw.evidence.privacy_ambiguous === true,
    contains_sensitive: raw.evidence.contains_sensitive === true,
    contains_secret: raw.evidence.contains_secret === true,
    reason: cleanString(raw.evidence.reason, 'evidence.reason', { required: true, max: 1000 }),
  };
  const provenance = {
    trigger_ref: cleanString(raw.provenance?.trigger_ref, 'provenance.trigger_ref', { max: 300 }),
    classifier: cleanString(raw.provenance?.classifier, 'provenance.classifier', { max: 200 }),
    source: cleanString(raw.provenance?.source, 'provenance.source', { max: 300 }),
  };

  const hasIdentity = identity.name || identity.roles.length || identity.domains.length || identity.notes.length;
  const hasPreferences = Object.values(preferences).some((items) => items.length);
  if (!hasIdentity && !hasPreferences) throw new Error('operator profile request contains no profile facts');

  if (containsSecretLike({ identity, preferences })) {
    throw new Error('operator profile request appears to contain credential/secret material');
  }
  for (const item of [
    ...preferences.communication,
    ...preferences.working_style,
    ...preferences.approval_boundaries,
    ...preferences.quality_expectations,
    ...preferences.avoid,
  ]) {
    if (containsForeignRuntimeInstruction(item)) {
      throw new Error('foreign runtime/system instructions cannot become operator preferences');
    }
  }

  return { identity, preferences, evidence, provenance };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalizeFact(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function mergeFacts(existing, additions) {
  const out = [...existing];
  const seen = new Set(existing.map(normalizeFact));
  for (const value of additions) {
    const key = normalizeFact(value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function extractManagedBlock(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < 0 || end < start) throw new Error('operator profile managed block is malformed');
  return {
    before: text.slice(0, start),
    body: text.slice(start + START.length, end),
    after: text.slice(end + END.length),
  };
}

function parseManagedIdentity(body) {
  const doc = { name: null, roles: [], domains: [], notes: [] };
  let section = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Name: ')) {
      doc.name = line.slice('Name: '.length).trim() || null;
      continue;
    }
    if (line === '### Roles and responsibilities') { section = 'roles'; continue; }
    if (line === '### Relevant domains') { section = 'domains'; continue; }
    if (line === '### Notes') { section = 'notes'; continue; }
    if (line.startsWith('- ') && section) doc[section].push(line.slice(2).trim());
  }
  return doc;
}

function parseManagedPreferences(body) {
  const doc = {
    communication: [],
    working_style: [],
    approval_boundaries: [],
    quality_expectations: [],
    avoid: [],
  };
  const headings = new Map([
    ['### Communication', 'communication'],
    ['### Working style', 'working_style'],
    ['### Approval boundaries', 'approval_boundaries'],
    ['### Quality expectations', 'quality_expectations'],
    ['### Avoid', 'avoid'],
  ]);
  let section = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (headings.has(line)) { section = headings.get(line); continue; }
    if (line.startsWith('- ') && section) doc[section].push(line.slice(2).trim());
  }
  return doc;
}

function renderList(title, values) {
  if (!values.length) return '';
  return [`### ${title}`, '', ...values.map((value) => `- ${value}`), ''].join('\n');
}

function renderIdentity(identity) {
  return [
    START,
    '## AI-Verse supported profile facts',
    '',
    identity.name ? `Name: ${identity.name}` : '',
    identity.name ? '' : '',
    renderList('Roles and responsibilities', identity.roles).trimEnd(),
    renderList('Relevant domains', identity.domains).trimEnd(),
    renderList('Notes', identity.notes).trimEnd(),
    END,
  ].filter((line, index, all) => !(line === '' && index > 0 && all[index - 1] === '')).join('\n') + '\n';
}

function renderPreferences(preferences) {
  return [
    START,
    '## AI-Verse supported working preferences',
    '',
    renderList('Communication', preferences.communication).trimEnd(),
    renderList('Working style', preferences.working_style).trimEnd(),
    renderList('Approval boundaries', preferences.approval_boundaries).trimEnd(),
    renderList('Quality expectations', preferences.quality_expectations).trimEnd(),
    renderList('Avoid', preferences.avoid).trimEnd(),
    END,
  ].filter((line, index, all) => !(line === '' && index > 0 && all[index - 1] === '')).join('\n') + '\n';
}

function unmarkedName(text) {
  const match = text.match(/^Name:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  if (!value || /^\[.*\]$/.test(value)) return null;
  return value;
}

function evolveFile(file, boundary, label, incoming, parseManaged, renderManaged, conflictCheck = null) {
  const existingFile = safeFile(file, boundary, label);
  let text = existingFile ? fs.readFileSync(existingFile, 'utf8') : '';
  const managed = extractManagedBlock(text);
  const current = managed ? parseManaged(managed.body) : null;

  if (conflictCheck) {
    const conflict = conflictCheck(text, current, incoming);
    if (conflict) return { state: 'needs-clarification', changed: false, reason: conflict };
  }

  const merged = current ? conflictCheck?.merge?.(current, incoming) ?? incoming : incoming;
  let nextManaged = renderManaged(merged);
  let next;
  if (managed) {
    const before = managed.before.endsWith('\n') || managed.before === '' ? managed.before : managed.before + '\n';
    const after = managed.after.startsWith('\n') || managed.after === '' ? managed.after : '\n' + managed.after;
    next = before + nextManaged + after.replace(/^\n+/, '\n');
  } else if (text.trim()) {
    next = text.replace(/\s*$/, '\n\n') + nextManaged;
  } else {
    const title = label.includes('identity') ? '# Identity\n\n' : '# Working Preferences\n\n';
    next = title + nextManaged;
  }

  if (next === text) return { state: 'existing', changed: false };
  atomicWrite(file, next);
  return { state: existingFile ? 'evolved' : 'created', changed: true };
}

function mergeIdentity(current, incoming) {
  return {
    name: current.name || incoming.name,
    roles: mergeFacts(current.roles, incoming.roles),
    domains: mergeFacts(current.domains, incoming.domains),
    notes: mergeFacts(current.notes, incoming.notes),
  };
}

function mergePreferences(current, incoming) {
  const out = {};
  for (const key of Object.keys(incoming)) out[key] = mergeFacts(current[key] ?? [], incoming[key]);
  return out;
}

function profileFingerprint(request) {
  const material = {
    identity: request.identity,
    preferences: request.preferences,
    reason: request.evidence.reason,
    trigger_ref: request.provenance.trigger_ref,
    classifier: request.provenance.classifier,
    source: request.provenance.source,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function updateProvenance(profileRoot, request, now, outcome) {
  const file = path.join(profileRoot, PROVENANCE_FILE);
  const existing = safeFile(file, profileRoot, 'operator profile provenance');
  let doc = { schema_version: SCHEMA_VERSION, history: [] };
  if (existing) {
    try { doc = JSON.parse(fs.readFileSync(existing, 'utf8')); }
    catch (error) { throw new Error(`operator profile provenance is unreadable: ${error.message}`); }
    if (!doc || doc.schema_version !== SCHEMA_VERSION || !Array.isArray(doc.history)) {
      throw new Error('operator profile provenance is incompatible');
    }
  }
  const fingerprint = profileFingerprint(request);
  if (doc.history.some((event) => event.fingerprint === fingerprint)) {
    return { changed: false, fingerprint };
  }
  doc.history.push({
    fingerprint,
    at: now,
    outcome,
    reason: request.evidence.reason,
    trigger_ref: request.provenance.trigger_ref,
    classifier: request.provenance.classifier,
    source: request.provenance.source,
  });
  atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
  return { changed: true, fingerprint };
}

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const request = normalizeRequest(await readInput());

  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) throw new Error(`AI-Verse OS root not found: ${root}`);
  const realRoot = fs.realpathSync(root);
  const operatorExpected = path.join(realRoot, 'operator');
  const operatorRoot = assertPlainDirectory(path.join(root, 'operator'), operatorExpected, 'operator root');
  const profilePath = path.join(operatorRoot, 'profile');
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  const profileRoot = assertPlainDirectory(profilePath, path.join(operatorRoot, 'profile'), 'operator profile root');

  const base = {
    schema_version: SCHEMA_VERSION,
    operation: 'ensure',
    user_confirmation_required: false,
    permission_expanded: false,
    connection_created: false,
    credential_created: false,
    automation_created: false,
    permanent_bot_created: false,
  };

  if (!request.evidence.stable || !request.evidence.explicit_or_strong) {
    process.stdout.write(JSON.stringify({
      ...base,
      state: 'ignored-weak',
      changed: false,
      reason: 'profile facts are not stable and strongly supported enough for automatic persistence',
    }, null, 2) + '\n');
    return;
  }
  if (request.evidence.privacy_ambiguous || request.evidence.contains_sensitive) {
    process.stdout.write(JSON.stringify({
      ...base,
      state: 'needs-clarification',
      changed: false,
      user_confirmation_required: true,
      reason: 'profile privacy/sensitivity is materially ambiguous',
    }, null, 2) + '\n');
    return;
  }
  if (request.evidence.contains_secret) {
    process.stdout.write(JSON.stringify({
      ...base,
      state: 'blocked-secret',
      changed: false,
      user_confirmation_required: false,
      reason: 'secret-bearing material cannot be stored in operator profile',
    }, null, 2) + '\n');
    return;
  }

  const identityFile = path.join(profileRoot, IDENTITY_FILE);
  const preferencesFile = path.join(profileRoot, PREFERENCES_FILE);
  const existingIdentity = safeFile(identityFile, profileRoot, 'operator profile identity');
  if (request.identity.name && existingIdentity) {
    const text = fs.readFileSync(existingIdentity, 'utf8');
    const managed = extractManagedBlock(text);
    const known = managed ? parseManagedIdentity(managed.body).name : null;
    const manual = unmarkedName(managed ? managed.before + managed.after : text);
    for (const value of [known, manual]) {
      if (value && normalizeFact(value) !== normalizeFact(request.identity.name)) {
        process.stdout.write(JSON.stringify({
          ...base,
          state: 'needs-clarification',
          changed: false,
          user_confirmation_required: true,
          reason: 'operator name conflicts with an existing profile value',
          existing_name: value,
          proposed_name: request.identity.name,
        }, null, 2) + '\n');
        return;
      }
    }
  }

  let identityResult = { state: 'unchanged', changed: false };
  const hasIdentity = request.identity.name || request.identity.roles.length || request.identity.domains.length || request.identity.notes.length;
  if (hasIdentity) {
    const currentFile = safeFile(identityFile, profileRoot, 'operator profile identity');
    const text = currentFile ? fs.readFileSync(currentFile, 'utf8') : '';
    const managed = extractManagedBlock(text);
    const current = managed ? parseManagedIdentity(managed.body) : { name: null, roles: [], domains: [], notes: [] };
    const merged = mergeIdentity(current, request.identity);
    identityResult = evolveFile(identityFile, profileRoot, 'operator profile identity', merged, parseManagedIdentity, renderIdentity);
  }

  let preferencesResult = { state: 'unchanged', changed: false };
  const hasPreferences = Object.values(request.preferences).some((items) => items.length);
  if (hasPreferences) {
    const currentFile = safeFile(preferencesFile, profileRoot, 'operator profile preferences');
    const text = currentFile ? fs.readFileSync(currentFile, 'utf8') : '';
    const managed = extractManagedBlock(text);
    const current = managed ? parseManagedPreferences(managed.body) : {
      communication: [], working_style: [], approval_boundaries: [], quality_expectations: [], avoid: [],
    };
    const merged = mergePreferences(current, request.preferences);
    preferencesResult = evolveFile(preferencesFile, profileRoot, 'operator profile preferences', merged, parseManagedPreferences, renderPreferences);
  }

  const changed = identityResult.changed || preferencesResult.changed;
  const state = changed ? (identityResult.state === 'created' || preferencesResult.state === 'created' ? 'created' : 'evolved') : 'existing';
  const now = new Date().toISOString();
  const provenance = updateProvenance(profileRoot, request, now, state);

  process.stdout.write(JSON.stringify({
    ...base,
    state,
    changed: changed || provenance.changed,
    identity: identityResult,
    preferences: preferencesResult,
    provenance: { fingerprint: provenance.fingerprint, changed: provenance.changed },
  }, null, 2) + '\n');
}

main().catch((error) => fail(error.message));
