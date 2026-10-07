const MAX_ITEMS = 32;
const MAX_OUTPUT_BYTES = 16_384;
const FORBIDDEN_ROW_KEYS = new Set([
  "data",
  "record",
  "row",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "deletedAt",
  "deletedReason",
  "deletedBy",
]);

function invalid(message) {
  const error = new Error(message);
  error.code = "PURPOSE_DATA_BOUNDARY_INVALID";
  throw error;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
}

function assertNoRawRowShape(value, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_ROW_KEYS.has(key)) {
      invalid(`${label} must not contain canonical Data row field ${key}`);
    }
  }
}

function copyRef(ref, label) {
  assertObject(ref, `${label}.ref`);
  if (ref.owner !== "ai-verse-data") {
    invalid(`${label}.ref.owner must remain ai-verse-data`);
  }
  for (const key of ["spaceId", "entity", "recordId", "field"]) {
    if (typeof ref[key] !== "string" || ref[key].length === 0) {
      invalid(`${label}.ref.${key} must be a non-empty string`);
    }
  }
  return {
    owner: "ai-verse-data",
    spaceId: ref.spaceId,
    entity: ref.entity,
    recordId: ref.recordId,
    field: ref.field,
  };
}

function copyProvenance(provenance, label) {
  assertObject(provenance, `${label}.provenance`);
  assertObject(provenance.scope, `${label}.provenance.scope`);
  assertObject(provenance.actor, `${label}.provenance.actor`);
  assertObject(provenance.authorization, `${label}.provenance.authorization`);
  if (typeof provenance.scope.workspaceId !== "string") {
    invalid(`${label}.provenance.scope.workspaceId must be a string`);
  }
  if (typeof provenance.actor.kind !== "string" || typeof provenance.actor.id !== "string") {
    invalid(`${label}.provenance.actor must identify the Data read actor`);
  }
  if (typeof provenance.authorization.mode !== "string") {
    invalid(`${label}.provenance.authorization.mode must be a string`);
  }
  if (!Number.isSafeInteger(provenance.schemaVersion) || provenance.schemaVersion < 1) {
    invalid(`${label}.provenance.schemaVersion must be a positive integer`);
  }
  if (!Number.isSafeInteger(provenance.recordVersion) || provenance.recordVersion < 1) {
    invalid(`${label}.provenance.recordVersion must be a positive integer`);
  }

  return {
    scope: { workspaceId: provenance.scope.workspaceId },
    actor: { kind: provenance.actor.kind, id: provenance.actor.id },
    authorization: provenance.authorization.capabilityRefs === undefined
      ? { mode: provenance.authorization.mode }
      : {
          mode: provenance.authorization.mode,
          capabilityRefs: [...provenance.authorization.capabilityRefs],
        },
    schemaVersion: provenance.schemaVersion,
    recordVersion: provenance.recordVersion,
  };
}

function isPrimitive(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function projectTransientDataCurrentValues(items) {
  if (!Array.isArray(items) || items.length < 1) {
    invalid("Data current-value boundary requires at least one projected item");
  }
  if (items.length > MAX_ITEMS) {
    invalid(`Data current-value boundary supports at most ${MAX_ITEMS} items`);
  }

  const projected = items.map((item, index) => {
    const label = `items[${index}]`;
    assertNoRawRowShape(item, label);
    const ref = copyRef(item.ref, label);
    if (!["value", "stale", "missing"].includes(item.state)) {
      invalid(`${label}.state must be value, stale, or missing`);
    }

    if (item.state === "missing") {
      if (!["record", "field"].includes(item.missing)) {
        invalid(`${label}.missing must be record or field`);
      }
      return Object.freeze({
        projection: "transient",
        source_owner: "ai-verse-data",
        state: "missing",
        source_ref: Object.freeze(ref),
        missing: item.missing,
      });
    }

    if (!Object.prototype.hasOwnProperty.call(item, "value") || !isPrimitive(item.value)) {
      invalid(`${label}.value must be a JSON primitive and may legitimately be 0, false, or null`);
    }
    if (typeof item.sourceUpdatedAt !== "string" || !Number.isFinite(Date.parse(item.sourceUpdatedAt))) {
      invalid(`${label}.sourceUpdatedAt must be a valid owner timestamp`);
    }
    const provenance = copyProvenance(item.provenance, label);
    return Object.freeze({
      projection: "transient",
      source_owner: "ai-verse-data",
      state: item.state,
      source_ref: Object.freeze(ref),
      value: item.value,
      source_updated_at: item.sourceUpdatedAt,
      provenance: Object.freeze(provenance),
    });
  });

  const result = Object.freeze({ values: Object.freeze(projected) });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OUTPUT_BYTES) {
    invalid(`Data current-value boundary output exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  return result;
}
