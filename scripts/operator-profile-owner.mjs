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
  if (!['ensure', 'read', 'correct-preference'].includes(command)) fail(`unknown command: ${command}`, 2);
  return { command, root: path.resolve(root) };
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

function normalizePreferenceCorrection(raw) {
  rejectUnknownKeys(raw, new Set(['category', 'previous', 'replacement', 'expected_sha256', 'evidence', 'provenance']), 'request');
  const category = cleanString(raw.category, 'category', { required: true, max: 64 });
  if (!['communication', 'working_style', 'quality_expectations', 'avoid'].includes(category)) {
    throw new Error('category must name a correctable preference category');
  }
  const previous = cleanString(raw.previous, 'previous', { required: true, max: 1000 });
  const replacement = cleanString(raw.replacement, 'replacement', { required: true, max: 1000 });
  const expected_sha256 = cleanString(raw.expected_sha256, 'expected_sha256', { required: true, max: 64 });
  if (!/^[a-f0-9]{64}$/.test(expected_sha256)) throw new Error('expected_sha256 must be a lowercase SHA-256 digest');
  if (normalizeFact(previous) === normalizeFact(replacement)) throw new Error('replacement must change the preference');
  rejectUnknownKeys(raw.evidence, new Set(['stable', 'explicit_or_strong', 'privacy_ambiguous', 'contains_sensitive', 'contains_secret', 'reason']), 'evidence');
  rejectUnknownKeys(raw.provenance ?? {}, new Set(['trigger_ref', 'classifier', 'source']), 'provenance');
  const evidence = {
    stable: raw.evidence.stable === true,
    explicit_or_strong: raw.evidence.explicit_or_strong === true,
    privacy_ambiguous: raw.evidence.privacy_ambiguous === true,
    contains_sensitive: raw.evidence.contains_sensitive === true,
    contains_secret: raw.evidence.contains_secret === true,
    reason: cleanString(raw.evidence.reason, 'evidence.reason', { required: true, max: 1000 }),
  };
  const provenance = {
    trigger_ref: cleanString(raw.provenance?.trigger_ref, 'provenance.trigger_ref', { required: true, max: 300 }),
    classifier: cleanString(raw.provenance?.classifier, 'provenance.classifier', { max: 200 }),
    source: cleanString(raw.provenance?.source, 'provenance.source', { max: 300 }),
  };
  if (containsSecretLike({ previous, replacement, evidence, provenance })) throw new Error('profile correction appears to contain credential/secret material');
  if (containsForeignRuntimeInstruction(replacement)) throw new Error('foreign runtime/system instructions cannot become operator preferences');
  return { category, previous, replacement, expected_sha256, evidence, provenance };
}

function resolveProfileRoot(root, { create = false } = {}) {
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) throw new Error(`AI-Verse OS root not found: ${root}`);
  const realRoot = fs.realpathSync(root);
  const operatorExpected = path.join(realRoot, 'operator');
  const operatorRoot = assertPlainDirectory(path.join(root, 'operator'), operatorExpected, 'operator root');
  const profilePath = path.join(operatorRoot, 'profile');
  if (!fs.existsSync(profilePath)) {
    if (!create) return null;
    fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  }
  return assertPlainDirectory(profilePath, path.join(operatorRoot, 'profile'), 'operator profile root');
}

function currentPreferences(profileRoot) {
  const file = profileRoot ? safeFile(path.join(profileRoot, PREFERENCES_FILE), profileRoot, 'operator profile preferences') : null;
  const text = file ? fs.readFileSync(file, 'utf8') : '';
  const managed = extractManagedBlock(text);
  const preferences = managed ? parseManagedPreferences(managed.body) : {
    communication: [], working_style: [], approval_boundaries: [], quality_expectations: [], avoid: [],
  };
  return { file, text, preferences, source_sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function readProfile(profileRoot) {
  const identityFile = profileRoot ? safeFile(path.join(profileRoot, IDENTITY_FILE), profileRoot, 'operator profile identity') : null;
  const identityText = identityFile ? fs.readFileSync(identityFile, 'utf8') : '';
  const identityManaged = extractManagedBlock(identityText);
  const identity = identityManaged ? parseManagedIdentity(identityManaged.body) : { name: null, roles: [], domains: [], notes: [] };
  const current = currentPreferences(profileRoot);
  return {
    schema_version: SCHEMA_VERSION,
    operation: 'read',
    state: 'ready',
    identity,
    preferences: current.preferences,
    preferences_source_sha256: current.source_sha256,
  };
}

function correctPreference(profileRoot, request) {
  const current = currentPreferences(profileRoot);
  const provenanceRequest = {
    identity: { name: null, roles: [], domains: [], notes: [] },
    preferences: { [request.category]: [request.replacement] },
    correction: { category: request.category, previous: request.previous, replacement: request.replacement },
    evidence: request.evidence,
    provenance: request.provenance,
  };
  const base = {
    schema_version: SCHEMA_VERSION,
    operation: 'correct-preference',
    user_confirmation_required: false,
    permission_expanded: false,
    connection_created: false,
    credential_created: false,
    automation_created: false,
    permanent_bot_created: false,
  };
  if (hasProvenance(profileRoot, provenanceRequest)) {
    return { ...base, state: 'existing', changed: false, category: request.category, source_sha256: current.source_sha256, reason: 'this preference correction was already applied' };
  }
  const initialValues = current.preferences[request.category];
  const replacementKey = normalizeFact(request.replacement);
  if (!initialValues.some((value) => value === request.previous)
      && initialValues.some((value) => normalizeFact(value) === replacementKey)) {
    return { ...base, state: 'existing', changed: false, category: request.category, source_sha256: current.source_sha256, reason: 'the requested preference is already current' };
  }
  if (request.expected_sha256 !== current.source_sha256) {
    return { ...base, state: 'stale', changed: false, source_sha256: current.source_sha256, reason: 'profile preferences changed since they were read; reread and reconcile before correcting' };
  }
  if (!request.evidence.stable || !request.evidence.explicit_or_strong) {
    return { ...base, state: 'ignored-weak', changed: false, reason: 'a preference correction needs stable, explicit or strong evidence' };
  }
  if (request.evidence.privacy_ambiguous || request.evidence.contains_sensitive) {
    return { ...base, state: 'needs-clarification', changed: false, user_confirmation_required: true, reason: 'profile privacy/sensitivity is materially ambiguous' };
  }
  if (request.evidence.contains_secret) {
    return { ...base, state: 'blocked-secret', changed: false, reason: 'secret-bearing material cannot be stored in operator profile' };
  }
  const values = current.preferences[request.category];
  const matches = values.filter((value) => normalizeFact(value) === normalizeFact(request.previous));
  if (matches.length !== 1) {
    return { ...base, state: 'needs-clarification', changed: false, user_confirmation_required: true, reason: matches.length ? 'the old preference appears more than once' : 'the exact old preference is no longer present' };
  }
  if (matches[0] !== request.previous) {
    return { ...base, state: 'needs-clarification', changed: false, user_confirmation_required: true, reason: 'the stored preference differs from the exact value being corrected' };
  }
  const updated = { ...current.preferences };
  let inserted = false;
  updated[request.category] = values.flatMap((value) => {
    if (value !== request.previous) return [value];
    if (values.some((existing) => existing !== request.previous && normalizeFact(existing) === replacementKey)) return [];
    if (inserted) return [];
    inserted = true;
    return [request.replacement];
  });
  const nextManaged = renderPreferences(updated);
  const managed = extractManagedBlock(current.text);
  const next = managed
    ? managed.before + nextManaged.replace(/\n$/, '') + managed.after + (managed.after.endsWith('\n') ? '' : '\n')
    : (current.text.trim() ? current.text.replace(/\s*$/, '\n\n') : '# Working Preferences\n\n') + nextManaged;
  if (next === current.text) return { ...base, state: 'existing', changed: false, reason: 'the preference correction is already reflected' };

  if (current.file) atomicWrite(current.file, next);
  else atomicWrite(path.join(profileRoot, PREFERENCES_FILE), next);
  const history = updateProvenance(profileRoot, provenanceRequest, new Date().toISOString(), 'corrected');
  return { ...base, state: current.file ? 'evolved' : 'created', changed: true, category: request.category, source_sha256: crypto.createHash('sha256').update(next).digest('hex'), provenance: { fingerprint: history.fingerprint, changed: history.changed } };
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
    next = managed.before + nextManaged.replace(/\n$/, '') + managed.after;
    if (!next.endsWith('\n')) next += '\n';
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
    correction: request.correction,
    reason: request.evidence.reason,
    trigger_ref: request.provenance.trigger_ref,
    classifier: request.provenance.classifier,
    source: request.provenance.source,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function hasProvenance(profileRoot, request) {
  const file = safeFile(path.join(profileRoot, PROVENANCE_FILE), profileRoot, 'operator profile provenance');
  if (!file) return false;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`operator profile provenance is unreadable: ${error.message}`); }
  if (!doc || doc.schema_version !== SCHEMA_VERSION || !Array.isArray(doc.history)) {
    throw new Error('operator profile provenance is incompatible');
  }
  const fingerprint = profileFingerprint(request);
  return doc.history.some((event) => event.fingerprint === fingerprint);
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
    ...(request.correction ? { correction: request.correction } : {}),
  });
  atomicWrite(file, JSON.stringify(doc, null, 2) + '\n');
  return { changed: true, fingerprint };
}

async function main() {
  const { command, root } = parseArgs(process.argv.slice(2));
  const raw = await readInput();
  const profileRoot = resolveProfileRoot(root, { create: command !== 'read' });
  if (command === 'read') {
    process.stdout.write(JSON.stringify(readProfile(profileRoot), null, 2) + '\n');
    return;
  }
  if (command === 'correct-preference') {
    const request = normalizePreferenceCorrection(raw);
    process.stdout.write(JSON.stringify(correctPreference(profileRoot, request), null, 2) + '\n');
    return;
  }
  const request = normalizeRequest(raw);

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
