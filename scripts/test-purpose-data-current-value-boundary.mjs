import assert from "node:assert/strict";

import { projectTransientDataCurrentValues } from "./purpose-data-current-value-boundary.mjs";

const provenance = {
  scope: { workspaceId: "film" },
  actor: { kind: "bot", id: "purpose-reader" },
  authorization: {
    mode: "host-bound",
    capabilityRefs: ["data:metrics:read"],
  },
  schemaVersion: 2,
  recordVersion: 7,
};

const zero = {
  state: "value",
  ref: {
    owner: "ai-verse-data",
    spaceId: "metrics",
    entity: "snapshots",
    recordId: "zero",
    field: "count",
  },
  value: 0,
  sourceUpdatedAt: "2026-10-07T12:00:00.000Z",
  provenance,
};

const disabled = {
  state: "value",
  ref: {
    owner: "ai-verse-data",
    spaceId: "metrics",
    entity: "snapshots",
    recordId: "disabled",
    field: "enabled",
  },
  value: false,
  sourceUpdatedAt: "2026-10-07T12:00:00.000Z",
  provenance,
};

const stale = {
  state: "stale",
  ref: {
    owner: "ai-verse-data",
    spaceId: "metrics",
    entity: "snapshots",
    recordId: "stale",
    field: "signups",
  },
  value: 12,
  sourceUpdatedAt: "2026-10-01T12:00:00.000Z",
  provenance,
};

const missing = {
  state: "missing",
  ref: {
    owner: "ai-verse-data",
    spaceId: "metrics",
    entity: "snapshots",
    recordId: "missing",
    field: "signups",
  },
  missing: "record",
};

const input = [zero, disabled, stale, missing];
const before = JSON.stringify(input);
const out = projectTransientDataCurrentValues(input);

assert.equal(JSON.stringify(input), before, "boundary must not mutate owner projections");
assert.equal(out.values.length, 4);
assert.equal(out.values[0].projection, "transient");
assert.equal(out.values[0].source_owner, "ai-verse-data");
assert.equal(out.values[0].value, 0);
assert.equal(out.values[1].value, false);
assert.equal(out.values[2].state, "stale");
assert.equal(out.values[2].source_updated_at, stale.sourceUpdatedAt);
assert.equal(out.values[3].state, "missing");
assert.equal(out.values[3].missing, "record");
assert.deepEqual(out.values[0].source_ref, zero.ref);
assert.deepEqual(out.values[0].provenance.scope, { workspaceId: "film" });
assert.equal(out.values[0].provenance.recordVersion, 7);

for (const item of out.values) {
  assert.equal(item.source_owner, "ai-verse-data");
  assert.equal(item.projection, "transient");
  assert.equal(Object.prototype.hasOwnProperty.call(item, "data"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(item, "record"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(item, "row"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(item, "canonical"), false);
}

for (const forbidden of [
  { ...zero, data: { count: 0 } },
  { ...zero, record: { data: { count: 0 } } },
  { ...zero, row: { count: 0 } },
  { ...zero, createdAt: "2026-10-07T00:00:00Z" },
  { ...zero, updatedAt: "2026-10-07T00:00:00Z" },
]) {
  assert.throws(
    () => projectTransientDataCurrentValues([forbidden]),
    (error) => error?.code === "PURPOSE_DATA_BOUNDARY_INVALID",
  );
}

assert.throws(
  () =>
    projectTransientDataCurrentValues([
      {
        ...zero,
        ref: { ...zero.ref, owner: "ai-verse-os" },
      },
    ]),
  (error) => error?.code === "PURPOSE_DATA_BOUNDARY_INVALID",
);

console.log("purpose Data current-value boundary: ok");
