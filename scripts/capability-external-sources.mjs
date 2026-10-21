import fs from 'node:fs';
import path from 'node:path';
import { existsEntry, readCapabilityJson, validateMemberPackage } from './capability-json.mjs';

export const EXTERNAL_SOURCES_CONTRACT = 'aiverse-external-capability-sources-v1';
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,99}$/;
const HEX = /^[a-f0-9]{64}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Explicit package allowlist, not a scan of a plugin cache or another workspace.
export function externalSources({ osRoot, scope, digestPackage, metadataFor }) {
  const root = fs.realpathSync(osRoot);
  const file = path.join(root, '.aiverse/capability-sources.json');
  if (!existsEntry(file)) return [];
  try {
    if (fs.realpathSync(file) !== file) throw new Error('external source registration is redirected');
    const data = readCapabilityJson(file, 131072);
    if (!record(data) || data.contract !== EXTERNAL_SOURCES_CONTRACT || Object.keys(data).some(k => !['contract', 'sources'].includes(k)) ||
        !Array.isArray(data.sources) || data.sources.length > 32) throw new Error('invalid external source registration');
    const seen = new Set();
    const providers = [];
    for (const source of data.sources) {
      if (!record(source) || typeof source.id !== 'string' || !SEGMENT.test(source.id) || seen.has(source.id)) throw new Error('invalid or duplicate external source identity');
      seen.add(source.id);
      const provider = `external:${source.id}`;
      if (source.supported !== true || source.installed !== true || source.enabled !== true) {
        providers.push({ provider, state: 'disabled', candidates: [], diagnostics: ['source is not supported, installed and enabled'] });
        continue;
      }
      if (source.visibility !== 'shared' && !/^workspace:[a-z0-9][a-z0-9-]*$/.test(source.visibility)) throw new Error('invalid external visibility');
      if (source.visibility !== 'shared' && source.visibility !== scope) continue;
      try {
        if (source.kind !== 'directory-packages-v1' || typeof source.root !== 'string' || !path.isAbsolute(source.root) ||
            !Array.isArray(source.packages) || source.packages.length > 200) throw new Error('unsupported external source descriptor');
        const realRoot = fs.realpathSync(source.root);
        const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
        const protectedRoots = ['operator', 'workspaces', 'connections'].map(part => path.join(root, part));
        if (protectedRoots.some(privateRoot => inside(realRoot, privateRoot))) throw new Error('external registration cannot expose OS private state');
        if (fs.lstatSync(source.root).isSymbolicLink() || !fs.statSync(realRoot).isDirectory()) throw new Error('external source root is redirected');
        const ids = new Set(), candidates = [];
        for (const item of source.packages) {
          if (!record(item) || typeof item.id !== 'string' || !SEGMENT.test(item.id) || ids.has(item.id) || typeof item.path !== 'string' || typeof item.digest !== 'string' || !HEX.test(item.digest)) throw new Error('invalid external package identity or digest');
          ids.add(item.id);
          const parts = item.path.split('/');
          if (parts.some(p => !p || p === '.' || p === '..') || item.path.includes('\\') || item.path.includes('\0') || /^[a-z]:/i.test(item.path)) throw new Error('invalid external package locator');
          const packagePath = path.join(realRoot, ...parts);
          if (protectedRoots.some(privateRoot => inside(packagePath, privateRoot))) throw new Error('external registration cannot expose OS private state');
          if (fs.realpathSync(packagePath) !== packagePath) throw new Error('external package path is redirected');
          validateMemberPackage(packagePath);
          if (digestPackage(packagePath) !== item.digest) throw new Error('external package changed; refresh its explicit registration');
          const metadata = metadataFor(path.join(packagePath, 'SKILL.md'));
          if (!metadata.name || metadata.name.length > 100 || !metadata.description || metadata.description.length > 1024) throw new Error('external package requires bounded metadata');
          candidates.push({ id: `${provider}:${item.id}`, bare_id: item.id, name: metadata.name, description: metadata.description,
            provider, visibility: source.visibility, version: metadata.version ?? `sha256:${item.digest}`,
            generation_id: `content-sha256:${item.digest}`, path: item.path, package_state: 'valid',
            digest: { algorithm: 'aiverse-package-sha256-v1', value: item.digest }, operators: [], dependencies: [],
            readiness: 'UNVERIFIED', permission: 'unknown', approval: 'not_required', ownership: 'external', read_only: true,
            locator: { kind: 'external-directory-v1', provider_root: realRoot, package_path: packagePath } });
        }
        providers.push({ provider, state: 'healthy', candidates, diagnostics: [] });
      } catch (error) {
        providers.push({ provider, state: 'degraded', candidates: [], diagnostics: [error.message] });
      }
    }
    return providers;
  } catch (error) {
    return [{ provider: 'external', state: 'degraded', candidates: [], diagnostics: [error.message] }];
  }
}
