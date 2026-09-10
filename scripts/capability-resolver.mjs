import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const PROVIDER_CONTRACT = 'aiverse-capability-provider-v1';
export const DISTRIBUTED_PROVIDER = 'aiverse-skills';
export const PACKAGE_DIGEST_ALGORITHM = 'aiverse-package-sha256-v1';
export const RESERVED_OS_ALIASES = new Set([
  'onboard', 'workspace', 'grill-me', 'link', 'audit', 'level-up', '3d-brain',
]);

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const HEX64 = /^[a-f0-9]{64}$/;
const INDEX_FIELDS = new Set(['contract', 'provider_id', 'generation_id', 'manifest_sha256', 'capabilities']);
const RECORD_FIELDS = new Set([
  'id', 'name', 'description', 'visibility', 'version', 'path',
  'package_state', 'digest', 'operators', 'dependencies',
]);

function hasExactKeys(object, expected) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  const keys = Object.keys(object);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function safeRealpath(target, label) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    throw new Error(`${label} cannot be resolved: ${error.message}`);
  }
}

function readJsonWithBytes(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return { data, bytes };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeSegment(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized || !SEGMENT.test(normalized)) {
    throw new Error(`Capability id cannot be represented safely: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function simpleScalar(raw) {
  const value = raw.trim();
  if (!value || ['|', '>', '|-', '>-', '|+', '>+'].includes(value)) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return String(JSON.parse(value)); } catch { /* fall through */ }
    }
    return value.slice(1, -1).replace(/''/g, "'") || null;
  }
  return value;
}

export function readSkillMetadata(skillMd) {
  const text = fs.readFileSync(skillMd, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    if (!line || /^\s/.test(line) || !line.includes(':')) continue;
    const at = line.indexOf(':');
    const key = line.slice(0, at).trim();
    if (!['name', 'description', 'version'].includes(key)) continue;
    const value = simpleScalar(line.slice(at + 1));
    if (value) out[key] = value;
  }
  return out;
}

function validatePackageSymlinks(packageRoot) {
  const realRoot = safeRealpath(packageRoot, 'package root');
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const item = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = safeRealpath(item, `symlink ${item}`);
        if (!isInside(resolved, realRoot)) throw new Error(`symlink escapes package: ${item}`);
        continue;
      }
      if (entry.isDirectory()) visit(item);
    }
  };
  visit(realRoot);
  return realRoot;
}

export function packageDigestV1(packageRoot) {
  const root = validatePackageSymlinks(packageRoot);
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const item = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile()) {
        const rel = path.relative(root, item).split(path.sep).join('/');
        files.push({ rel, file: item });
      }
    }
  };
  visit(root);
  files.sort((a, b) => Buffer.from(a.rel, 'utf8').compare(Buffer.from(b.rel, 'utf8')));
  const hash = crypto.createHash('sha256');
  for (const item of files) {
    hash.update(Buffer.from(item.rel, 'utf8'));
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(item.file));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function validStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length;
}

function validDigest(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && value.algorithm === PACKAGE_DIGEST_ALGORITHM &&
    typeof value.value === 'string' && HEX64.test(value.value);
}

function validateRelativePackagePath(providerRoot, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`invalid package path ${JSON.stringify(rel)}`);
  }
  if (rel.startsWith('/') || rel.endsWith('/') || rel.includes('//')) {
    throw new Error(`invalid package path ${JSON.stringify(rel)}`);
  }
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid package path ${JSON.stringify(rel)}`);
  }
  const base = safeRealpath(providerRoot, 'provider root');
  const joined = path.join(base, ...parts);
  const resolved = safeRealpath(joined, `package ${rel}`);
  if (!isInside(resolved, base)) throw new Error(`package path escapes provider root: ${rel}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory() || !fs.statSync(path.join(resolved, 'SKILL.md')).isFile()) {
    throw new Error(`package is missing SKILL.md: ${rel}`);
  }
  return resolved;
}

function synthesizedRecord({ providerRoot, provider, visibility, prefix, directoryName }) {
  const resolved = validateRelativePackagePath(providerRoot, directoryName);
  const digestValue = packageDigestV1(resolved);
  const metadata = readSkillMetadata(path.join(resolved, 'SKILL.md'));
  const bareId = normalizeSegment(directoryName);
  return {
    id: `${prefix}:${bareId}`,
    bare_id: bareId,
    name: metadata.name || directoryName,
    description: metadata.description || `Local capability ${metadata.name || directoryName}.`,
    provider,
    visibility,
    version: metadata.version || `0+sha256.${digestValue.slice(0, 12)}`,
    generation_id: `content-sha256:${digestValue}`,
    path: directoryName,
    package_state: 'valid',
    digest: { algorithm: PACKAGE_DIGEST_ALGORITHM, value: digestValue },
    operators: [],
    dependencies: [],
    readiness: 'UNVERIFIED',
    permission: 'unknown',
    approval: 'not_required',
    locator: {
      kind: 'directory',
      provider_root: safeRealpath(providerRoot, 'provider root'),
      package_path: resolved,
    },
  };
}

function scanDirectoryProvider({ root, provider, visibility, prefix }) {
  if (!fs.existsSync(root)) return { provider, state: 'absent', candidates: [], diagnostics: [] };
  let rootStat;
  try { rootStat = fs.statSync(root); } catch (error) {
    return { provider, state: 'degraded', candidates: [], diagnostics: [error.message] };
  }
  if (!rootStat.isDirectory()) {
    return { provider, state: 'degraded', candidates: [], diagnostics: [`provider root is not a directory: ${root}`] };
  }
  const candidates = [];
  const diagnostics = [];
  const ids = new Set();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const packagePath = path.join(root, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = fs.statSync(packagePath).isDirectory(); } catch {
        diagnostics.push(`${entry.name}: broken package symlink`);
        continue;
      }
    }
    if (!isDirectory || !fs.existsSync(path.join(packagePath, 'SKILL.md'))) continue;
    try {
      const record = synthesizedRecord({ providerRoot: root, provider, visibility, prefix, directoryName: entry.name });
      if (ids.has(record.id)) throw new Error(`duplicate capability id after normalization: ${record.id}`);
      ids.add(record.id);
      candidates.push(record);
    } catch (error) {
      diagnostics.push(`${entry.name}: ${error.message}`);
    }
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return { provider, state: diagnostics.length ? 'degraded' : 'healthy', candidates, diagnostics };
}

function distributedProvider(root) {
  const provider = DISTRIBUTED_PROVIDER;
  if (!fs.existsSync(root)) return { provider, state: 'absent', candidates: [], diagnostics: [] };
  const meta = path.join(root, '.aiverse');
  if (!fs.existsSync(meta)) return { provider, state: 'absent', candidates: [], diagnostics: [] };
  const activeFile = path.join(meta, 'active.json');
  if (!fs.existsSync(activeFile)) {
    if (fs.existsSync(path.join(meta, 'installed.json'))) {
      return { provider, state: 'unsupported', candidates: [], diagnostics: ['legacy mutable Skills provider has no immutable active generation'] };
    }
    return { provider, state: 'degraded', candidates: [], diagnostics: ['Skills metadata exists but active.json is missing'] };
  }

  try {
    const { data: active } = readJsonWithBytes(activeFile, 'Skills active generation pointer');
    if (active.schema_version !== 1) {
      return { provider, state: 'unsupported', candidates: [], diagnostics: [`unsupported Skills active pointer schema ${JSON.stringify(active.schema_version)}`] };
    }
    if (active.state === 'uninstalled') return { provider, state: 'absent', candidates: [], diagnostics: [] };
    if (active.state !== 'active' || typeof active.generation_id !== 'string' || !active.generation_id) {
      throw new Error('Skills active generation pointer is malformed');
    }
    const generationId = active.generation_id;
    if (generationId.includes('/') || generationId.includes('\\') || generationId === '.' || generationId === '..') {
      throw new Error('Skills active generation id is unsafe');
    }
    const generationsRoot = path.join(meta, 'generations');
    const generationRoot = path.join(generationsRoot, generationId);
    const realGenerations = safeRealpath(generationsRoot, 'Skills generations root');
    const realGeneration = safeRealpath(generationRoot, `Skills generation ${generationId}`);
    if (!isInside(realGeneration, realGenerations)) throw new Error('Skills generation path escapes lifecycle root');

    const manifestFile = path.join(realGeneration, '.aiverse', 'installed.json');
    const indexFile = path.join(realGeneration, '.aiverse', 'capability-index.json');
    const { data: manifest, bytes: manifestBytes } = readJsonWithBytes(manifestFile, 'Skills provider manifest');
    if (manifest.schema_version !== 3 || manifest.provider_contract !== PROVIDER_CONTRACT || manifest.provider_id !== provider) {
      return { provider, state: 'unsupported', candidates: [], diagnostics: ['Skills generation does not implement capability provider v1 manifest schema 3'] };
    }
    if (manifest.generation_id !== generationId) throw new Error('Skills manifest generation does not match active generation');

    const { data: index } = readJsonWithBytes(indexFile, 'Skills capability index');
    if (!hasExactKeys(index, INDEX_FIELDS)) throw new Error('Skills capability index has missing or unknown top-level fields');
    if (index.contract !== PROVIDER_CONTRACT || index.provider_id !== provider) throw new Error('Skills capability index contract/provider mismatch');
    if (index.generation_id !== generationId) throw new Error('Skills capability index generation mismatch');
    if (index.manifest_sha256 !== sha256(manifestBytes)) throw new Error('Skills capability index manifest hash is stale');
    if (!Array.isArray(manifest.packages)) throw new Error('Skills provider manifest packages must be an array');
    if (!Array.isArray(index.capabilities)) throw new Error('Skills capability index capabilities must be an array');

    const manifestCaps = new Map();
    for (const item of manifest.packages) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Skills manifest contains a non-object package');
      if (item.kind === 'support') continue;
      if (typeof item.qualified_id !== 'string' || !item.qualified_id.startsWith(`${provider}:`)) throw new Error('Skills manifest capability has invalid qualified_id');
      if (manifestCaps.has(item.qualified_id)) throw new Error(`duplicate Skills manifest capability ${item.qualified_id}`);
      validateRelativePackagePath(realGeneration, item.path);
      if (!validDigest(item.digest) || !validStringList(item.operators) || !validStringList(item.dependencies)) {
        throw new Error(`Skills manifest capability ${item.qualified_id} has invalid static metadata`);
      }
      manifestCaps.set(item.qualified_id, item);
    }

    const candidates = [];
    const seen = new Set();
    for (const record of index.capabilities) {
      if (!hasExactKeys(record, RECORD_FIELDS)) throw new Error('Skills capability index record has missing or unknown fields');
      if (typeof record.id !== 'string' || !record.id.startsWith(`${provider}:`)) throw new Error('Skills capability index record has invalid id');
      if (seen.has(record.id)) throw new Error(`duplicate Skills capability index id ${record.id}`);
      seen.add(record.id);
      const packageItem = manifestCaps.get(record.id);
      if (!packageItem) throw new Error(`Skills capability index contains uninstalled package ${record.id}`);
      const expected = {
        id: record.id,
        name: packageItem.name,
        description: packageItem.description,
        visibility: 'shared',
        version: packageItem.version,
        path: packageItem.path,
        package_state: 'valid',
        digest: packageItem.digest,
        operators: packageItem.operators,
        dependencies: packageItem.dependencies,
      };
      if (!isDeepStrictEqual(record, expected)) throw new Error(`Skills capability index record does not match manifest: ${record.id}`);
      validateRelativePackagePath(realGeneration, record.path);
      if (record.package_state !== 'valid') continue;
      const bareId = record.id.slice(provider.length + 1);
      if (!SEGMENT.test(bareId) || !validDigest(record.digest) || !validStringList(record.operators) || !validStringList(record.dependencies)) {
        throw new Error(`Skills capability index record has invalid metadata: ${record.id}`);
      }
      candidates.push({
        ...record,
        bare_id: bareId,
        provider,
        generation_id: generationId,
        readiness: 'UNVERIFIED',
        permission: 'unknown',
        approval: 'not_required',
        locator: {
          kind: 'provider-v1',
          provider_root: safeRealpath(root, 'Skills provider root'),
          generation_root: realGeneration,
          package_path: validateRelativePackagePath(realGeneration, record.path),
        },
      });
    }
    if (seen.size !== manifestCaps.size) throw new Error('Skills capability index is missing installed manifest capabilities');
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return { provider, state: 'healthy', candidates, diagnostics: [], generation_id: generationId };
  } catch (error) {
    return { provider, state: 'degraded', candidates: [], diagnostics: [error.message] };
  }
}

function workspaceIdFromScope(scope) {
  if (typeof scope !== 'string') throw new Error('scope must be a string');
  if (!scope.startsWith('workspace:')) return null;
  const id = scope.slice('workspace:'.length);
  if (!SEGMENT.test(id)) throw new Error(`invalid workspace scope: ${scope}`);
  return id;
}

function normalizeSearch(value) {
  return String(value ?? '').trim().toLowerCase();
}

function tokenize(value) {
  return normalizeSearch(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function relevanceScore(candidate, query) {
  const q = normalizeSearch(query);
  if (!q) return 1;
  if (candidate.id === q) return 100000;
  if (candidate.bare_id === q) return 50000;
  if (normalizeSearch(candidate.name) === q) return 45000;
  const tokens = tokenize(q);
  if (!tokens.length) return 0;
  const id = normalizeSearch(candidate.id);
  const bare = normalizeSearch(candidate.bare_id);
  const name = normalizeSearch(candidate.name);
  const desc = normalizeSearch(candidate.description);
  let score = 0;
  for (const token of tokens) {
    if (bare === token) score += 1000;
    else if (bare.startsWith(token)) score += 300;
    else if (bare.includes(token)) score += 150;
    if (name.includes(token)) score += 120;
    if (id.includes(token)) score += 80;
    if (desc.includes(token)) score += 25;
  }
  return score;
}

function providerPreference(candidate, workspaceId) {
  if (workspaceId && candidate.provider === `workspace:${workspaceId}`) return 0;
  if (candidate.provider === 'local') return 1;
  if (candidate.provider === DISTRIBUTED_PROVIDER) return 2;
  if (candidate.provider === 'os') return 3;
  return 4;
}

function publicProvider(provider) {
  return {
    provider: provider.provider,
    state: provider.state,
    generation_id: provider.generation_id ?? null,
    diagnostics: [...provider.diagnostics],
    candidate_count: provider.candidates.length,
  };
}

export function discoverCapabilities({
  osRoot = process.cwd(),
  scope = 'operator',
  query = '',
  qualifiedId = null,
  limit = 20,
  skillsRoot = path.join(os.homedir(), '.aiverse', 'skills'),
  localSkillsRoot = path.join(os.homedir(), '.aiverse', 'local-skills'),
} = {}) {
  const root = path.resolve(osRoot);
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml')) || !fs.existsSync(path.join(root, 'system', 'capabilities'))) {
    throw new Error(`not an AI-Verse OS root: ${root}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200');
  const workspaceId = workspaceIdFromScope(scope);

  const providers = [];
  providers.push(scanDirectoryProvider({
    root: path.join(root, 'system', 'capabilities'), provider: 'os', visibility: 'system', prefix: 'os',
  }));
  providers.push(distributedProvider(path.resolve(skillsRoot)));
  providers.push(scanDirectoryProvider({
    root: path.resolve(localSkillsRoot), provider: 'local', visibility: 'shared', prefix: 'local',
  }));
  if (workspaceId) {
    const workspaceRoot = path.join(root, 'workspaces', workspaceId);
    const realWorkspaces = safeRealpath(path.join(root, 'workspaces'), 'OS workspaces root');
    let safeWorkspace = null;
    if (fs.existsSync(workspaceRoot)) {
      try {
        const resolved = safeRealpath(workspaceRoot, `workspace ${workspaceId}`);
        if (!isInside(resolved, realWorkspaces)) throw new Error('workspace path escapes OS workspaces root');
        if (!fs.existsSync(path.join(resolved, 'WORKSPACE.yaml'))) throw new Error('workspace is missing WORKSPACE.yaml');
        safeWorkspace = resolved;
      } catch (error) {
        providers.push({ provider: `workspace:${workspaceId}`, state: 'degraded', candidates: [], diagnostics: [error.message] });
      }
    }
    if (safeWorkspace) {
      providers.push(scanDirectoryProvider({
        root: path.join(safeWorkspace, 'skills'),
        provider: `workspace:${workspaceId}`,
        visibility: `workspace:${workspaceId}`,
        prefix: `workspace:${workspaceId}`,
      }));
    } else if (!providers.some((item) => item.provider === `workspace:${workspaceId}`)) {
      providers.push({ provider: `workspace:${workspaceId}`, state: 'absent', candidates: [], diagnostics: [] });
    }
  }

  const all = providers.flatMap((provider) => provider.candidates);
  let effectiveQuery = query;
  if (qualifiedId) effectiveQuery = qualifiedId;
  let ranked = all.map((candidate) => ({ candidate, score: relevanceScore(candidate, effectiveQuery) }));
  if (effectiveQuery) ranked = ranked.filter(({ score }) => score > 0);
  if (qualifiedId) ranked = ranked.filter(({ candidate }) => candidate.id === qualifiedId);
  ranked.sort((a, b) => b.score - a.score ||
    providerPreference(a.candidate, workspaceId) - providerPreference(b.candidate, workspaceId) ||
    a.candidate.id.localeCompare(b.candidate.id));

  return {
    contract: PROVIDER_CONTRACT,
    scope,
    query: query || '',
    qualified_id: qualifiedId,
    providers: providers.map(publicProvider),
    candidates: ranked.slice(0, limit).map(({ candidate }) => candidate),
    total_matching_candidates: ranked.length,
  };
}

export function selectCapability(options = {}) {
  const scope = options.scope ?? 'operator';
  const workspaceId = workspaceIdFromScope(scope);
  const explicit = options.qualifiedId || (typeof options.query === 'string' && options.query.includes(':') ? options.query : null);
  if (explicit) {
    const discovery = discoverCapabilities({ ...options, qualifiedId: explicit, query: options.query || explicit, limit: 200 });
    const match = discovery.candidates.find((candidate) => candidate.id === explicit);
    return match
      ? { status: 'selected', selection: match, providers: discovery.providers }
      : { status: 'unavailable', requested: explicit, reason: 'qualified capability is absent, out of scope, or its provider is unhealthy', providers: discovery.providers };
  }

  const query = normalizeSearch(options.query);
  if (!query) throw new Error('selectCapability requires query or qualifiedId');
  const normalizedBare = normalizeSegment(query);
  const discovery = discoverCapabilities({ ...options, query, limit: 200 });

  if (RESERVED_OS_ALIASES.has(normalizedBare)) {
    const osId = `os:${normalizedBare}`;
    const match = discovery.candidates.find((candidate) => candidate.id === osId);
    return match
      ? { status: 'selected', selection: match, providers: discovery.providers }
      : { status: 'unavailable', requested: normalizedBare, reason: `protected OS alias ${normalizedBare} is unavailable`, providers: discovery.providers };
  }

  const exact = discovery.candidates
    .filter((candidate) => candidate.bare_id === normalizedBare)
    .sort((a, b) => providerPreference(a, workspaceId) - providerPreference(b, workspaceId) || a.id.localeCompare(b.id));
  if (exact.length) return { status: 'selected', selection: exact[0], providers: discovery.providers };
  if (discovery.candidates.length) return { status: 'selected', selection: discovery.candidates[0], providers: discovery.providers };
  return { status: 'unavailable', requested: query, reason: 'no authorized healthy capability matches the request', providers: discovery.providers };
}
