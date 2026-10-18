// Read only explicitly linked fields through the existing OS/Data permission seam.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { invokeDataHost, OS_DATA_HOST_PROTOCOL } from './data-host.mjs';
import { validateDirectionScope } from './direction-owner-core.mjs';
import { projectTransientDataCurrentValues } from './purpose-data-current-value-boundary.mjs';

const MAX_INPUT_BYTES = 65_536;
const script = fileURLToPath(import.meta.url);

function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid Purpose Data binding fields');
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function refKey(ref) {
  return JSON.stringify([ref.owner, ref.scope, ref.kind, ref.id, ref.version ?? '']);
}

function validateBindings(scope, bindings) {
  validateDirectionScope(scope);
  if (!scope.startsWith('workspace:')) throw new Error('Purpose Data bindings require a workspace scope');
  if (!Array.isArray(bindings) || bindings.length > 32) throw new Error('Purpose Data supports at most 32 explicit bindings');
  for (const binding of bindings) {
    fields(binding, ['purpose_ref', 'ref', 'staleAfterMs']);
    fields(binding.purpose_ref, ['owner', 'scope', 'kind', 'id', 'version'], ['owner', 'scope', 'kind', 'id']);
    const purpose = binding.purpose_ref;
    if (purpose.scope !== scope || purpose.owner === 'ai-verse-data'
      || ![purpose.owner, purpose.kind, purpose.id].every(identifier)
      || (purpose.version !== undefined && !identifier(purpose.version))) throw new Error('Purpose Data binding has an invalid or different-scope Purpose ref');
    fields(binding.ref, ['owner', 'spaceId', 'entity', 'recordId', 'field']);
    if (binding.ref.owner !== 'ai-verse-data' || !['spaceId', 'entity', 'recordId', 'field'].every(key => identifier(binding.ref[key]))) {
      throw new Error('Purpose Data binding requires an exact Data field ref');
    }
    if (!Number.isSafeInteger(binding.staleAfterMs) || binding.staleAfterMs < 0) throw new Error('Purpose Data freshness must be a non-negative safe integer');
  }
}

export function createDataPurposeReader(root = process.cwd(), { scope = 'operator', bindings, now } = {}) {
  if (scope === 'operator' && bindings === undefined) return undefined;
  if (bindings !== undefined) validateBindings(scope, bindings);
  const base = path.resolve(root);
  return request => {
    if (request.scope !== scope) throw new Error('Purpose Data reader scope changed');
    if (bindings === undefined) return { status: 'unavailable', scope, reason: 'data_purpose_bindings_required' };
    const input = JSON.stringify({ ...request, bindings, now: now ?? new Date().toISOString() });
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw new Error('Purpose Data request exceeds byte limit');
    const out = spawnSync(process.execPath, [script, '--root', base], {
      input, encoding: 'utf8', shell: false, timeout: 10_000, maxBuffer: 131_072,
    });
    if (out.error || out.status !== 0) return { status: 'unavailable', scope, reason: 'data_purpose_reader_unavailable' };
    let result;
    try { result = JSON.parse(out.stdout); }
    catch { return { status: 'unavailable', scope, reason: 'data_purpose_reader_invalid_output' }; }
    if (result.scope !== scope) throw new Error('Purpose Data reader returned a different scope');
    return result;
  };
}

async function readLinkedValues(root, request) {
  const { scope, bindings, purpose_refs: purposeRefs, now } = request;
  validateBindings(scope, bindings);
  if (!Array.isArray(purposeRefs)) throw new Error('Purpose refs are required');
  const retained = new Set(purposeRefs.map(refKey));
  const selected = bindings.filter(binding => retained.has(refKey(binding.purpose_ref)));
  if (!selected.length) return { status: 'ok', scope, bindings: [] };
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Purpose Data clock is invalid');
  const records = new Map();
  const values = [];
  for (const { ref, staleAfterMs } of selected) {
    const recordKey = JSON.stringify([ref.spaceId, ref.entity, ref.recordId]);
    if (!records.has(recordKey)) {
      try {
        const host = await invokeDataHost({ osRoot: root, request: {
          protocol: OS_DATA_HOST_PROTOCOL, request_id: `purpose-${randomUUID()}`,
          operation: 'request', scope, reason: 'Read an explicitly linked Purpose Data field',
          data: { operation: 'data.record.get', payload: { spaceId: ref.spaceId, entity: ref.entity, recordId: ref.recordId } },
        } });
        const out = host.result;
        if (host.status !== 'succeeded' || host.effect_occurred !== false || out?.ok !== true
          || out.protocol !== 'ai-verse-data/0.1' || out.operation !== 'data.record.get'
          || out.scope?.workspaceId !== scope.slice('workspace:'.length)
          || out.result?.spaceId !== ref.spaceId || out.result?.entity !== ref.entity || out.result?.recordId !== ref.recordId) {
          throw new Error('Purpose Data owner returned an invalid record binding');
        }
        records.set(recordKey, out);
      } catch (error) {
        if (error.code !== 'RECORD_NOT_FOUND') throw error;
        records.set(recordKey, null);
      }
    }
    const out = records.get(recordKey);
    if (!out) { values.push({ ref, state: 'missing', missing: 'record' }); continue; }
    const record = out.result;
    if (!Object.hasOwn(record.data, ref.field)) { values.push({ ref, state: 'missing', missing: 'field' }); continue; }
    const updatedMs = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedMs)) throw new Error('Purpose Data source timestamp is invalid');
    values.push({
      ref, state: nowMs - updatedMs > staleAfterMs ? 'stale' : 'value', value: record.data[ref.field], sourceUpdatedAt: record.updatedAt,
      provenance: { scope: out.scope, actor: out.actor, authorization: out.authorization, schemaVersion: record.schemaVersion, recordVersion: record.version },
    });
  }
  const projected = projectTransientDataCurrentValues(values).values;
  return { status: 'ok', scope, bindings: selected.map((binding, index) => ({ purpose_ref: binding.purpose_ref, current: projected[index] })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  let request;
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('Expected --root');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) throw new Error('Purpose Data input exceeds byte limit');
      chunks.push(chunk);
    }
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(await readLinkedValues(process.argv[3], request)));
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : undefined;
    process.stdout.write(JSON.stringify({ status: 'unavailable', scope: request?.scope,
      reason: code ?? (error.exitCode === 6 ? 'data_purpose_permission_denied' : 'data_purpose_read_unavailable') }));
  }
}
