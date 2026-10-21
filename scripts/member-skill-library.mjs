import fs from 'node:fs';
import path from 'node:path';
import { existsEntry, readCapabilityJson, validateMemberPackage } from './capability-json.mjs';

export const MEMBER_LIBRARY_CONTRACT = 'aiverse-member-skill-library-v1';
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,99}$/;
const HEX = /^[a-f0-9]{64}$/;
const PORTABLE = { reusable: true, contains_workspace_data: false, contains_credentials: false, has_workspace_dependencies: false };
const SCOPE = /^(operator|workspace:[a-z0-9][a-z0-9-]*)$/;

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function regularJson(file, root) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000 || !inside(fs.realpathSync(file), fs.realpathSync(root))) {
    throw new Error('member library index is not a contained bounded regular file');
  }
  return readCapabilityJson(file, 4_000_000);
}

export function readMemberLibrary({ root, scope, digestPackage, metadataFor = null, revisionFor = null }) {
  const file = path.join(root, '.aiverse', 'member-library', 'index.json');
  if (!existsEntry(file)) return { candidates: [], diagnostics: [], state: 'absent' };
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('member root is redirected');
    const realRoot = fs.realpathSync(root);
    for (const rel of ['.aiverse', '.aiverse/member-library']) {
      if (fs.lstatSync(path.join(root, rel)).isSymbolicLink()) throw new Error('member metadata symlink refused');
    }
    const index = regularJson(file, root);
    if (index.contract !== MEMBER_LIBRARY_CONTRACT || !Number.isSafeInteger(index.sequence) || index.sequence < 0 ||
        Object.keys(index).some(key => !['contract', 'sequence', 'skills', 'events'].includes(key)) || !index.skills || typeof index.skills !== 'object' || Array.isArray(index.skills) || !Array.isArray(index.events) || index.events.some(event => !event || typeof event !== 'object' || Array.isArray(event))) {
      throw new Error('invalid member library index');
    }
    const candidates = [];
    for (const [id, record] of Object.entries(index.skills)) {
      if (!SEGMENT.test(id) || !record || record.id !== id || !record.revisions || typeof record.revisions !== 'object' || Array.isArray(record.revisions)) {
        throw new Error('invalid member skill identity');
      }
      const active = record.revisions[record.active_revision];
      if (!active || ['name', 'description', 'visibility'].some(key => record[key] !== active[key])) throw new Error('member active metadata mismatch');
      if (revisionFor && revisionFor.id !== `local:${id}`) continue;
      const requested = revisionFor?.id === `local:${id}` ? revisionFor.revision : record.active_revision;
      if (typeof requested !== 'string' || !HEX.test(requested)) throw new Error('invalid member revision');
      const item = record.revisions[requested];
      if (!item || typeof item.source_scope !== 'string' || typeof item.visibility !== 'string' || !SCOPE.test(item.source_scope) || (item.visibility !== 'shared' &&
          (!item.visibility.startsWith('workspace:') || item.visibility !== item.source_scope))) {
        throw new Error('invalid member revision scope');
      }
      if (item.visibility === 'shared' && (JSON.stringify(Object.keys(item.admission ?? {}).sort()) !== JSON.stringify(Object.keys(PORTABLE).sort()) ||
          Object.entries(PORTABLE).some(([key, value]) => item.admission[key] !== value))) {
        throw new Error('shared member revision lacks portability admission');
      }
      if (item.visibility !== 'shared' && item.visibility !== scope) continue;
      const rel = `.aiverse/member-library/packages/${id}/${requested}`;
      if (item.path !== rel || typeof item.name !== 'string' || !item.name || item.name.length > 100 ||
          typeof item.description !== 'string' || !item.description || item.description.length > 1024) {
        throw new Error('invalid member revision metadata');
      }
      const packagePath = path.join(root, rel);
      const realPackage = fs.realpathSync(packagePath);
      if (!inside(realPackage, realRoot) || realPackage !== path.join(realRoot, rel) ||
          fs.lstatSync(packagePath).isSymbolicLink()) throw new Error('member package path redirected');
      validateMemberPackage(realPackage);
      if (metadataFor) {
        const actual = metadataFor(path.join(realPackage, 'SKILL.md'));
        if (actual.name !== item.name || actual.description !== item.description) throw new Error('member package metadata differs from owner index');
      }
      if (item.provenance && (!Array.isArray(item.provenance.dependencies) || !Array.isArray(item.provenance.requested_capabilities) ||
          typeof item.provenance.requires_connection !== 'boolean' || typeof item.provenance.requires_credential !== 'boolean')) throw new Error('invalid member requirement metadata');
      if (digestPackage(packagePath) !== requested) throw new Error(`member revision integrity failed: ${id}`);
      candidates.push({
        id: `local:${id}`, bare_id: id, name: item.name, description: item.description,
        provider: 'local', visibility: item.visibility, version: `sha256:${requested}`,
        generation_id: `content-sha256:${requested}`, path: rel, package_state: 'valid',
        digest: { algorithm: 'aiverse-package-sha256-v1', value: requested },
        operators: [], dependencies: item.provenance?.dependencies ?? [],
        requested_capabilities: item.provenance?.requested_capabilities ?? [],
        requires_connection: item.provenance?.requires_connection ?? false,
        requires_credential: item.provenance?.requires_credential ?? false,
        ownership: 'member-owned', readiness: 'UNVERIFIED', permission: 'unknown', approval: 'not_required',
        library_contract: MEMBER_LIBRARY_CONTRACT,
        locator: { kind: 'directory', provider_root: realRoot, package_path: realPackage },
      });
    }
    return { candidates, diagnostics: [], state: 'healthy' };
  } catch (error) {
    return { candidates: [], diagnostics: [error.message], state: 'degraded' };
  }
}
