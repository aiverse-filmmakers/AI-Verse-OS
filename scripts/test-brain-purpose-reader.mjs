import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createBrainPurposeReader } from './brain-purpose-reader.mjs';

function pythonExecutable() {
  const candidates = process.env.PYTHON ? [process.env.PYTHON]
    : process.platform === 'win32' ? ['python'] : ['python3', 'python'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (result.status === 0 && path.isAbsolute(result.stdout.trim())) return result.stdout.trim();
  }
  return undefined;
}

const python = pythonExecutable();

function fixture(t, { reader = '.aiverse/extensions/brain-read.py', body } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-brain-purpose-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.aiverse', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiverse', 'extensions', 'registry.json'), JSON.stringify({
    schema_version: '1.0',
    extensions: {
      'ai-verse-brain': {
        supported: true, installed: true, enabled: true, public_purpose_reader: reader,
      },
    },
  }));
  fs.writeFileSync(path.join(root, '.aiverse', 'brain-purpose.json'), JSON.stringify({ python }));
  if (reader.startsWith('.aiverse/extensions/')) {
    const file = path.join(root, reader);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body ?? `import json, sys\ni = sys.argv.index('--scope')\nprint(json.dumps({'schema_version': '1.0', 'scope': sys.argv[i + 1], 'direction_owner': 'brain'}))\n`);
  }
  return root;
}

test('loads only a registered public reader and enforces returned scope and owner', { skip: !python }, t => {
  const root = fixture(t);
  const reader = createBrainPurposeReader(root);
  assert.equal(typeof reader, 'function');
  assert.deepEqual(reader('workspace:alpha'), {
    schema_version: '1.0', scope: 'workspace:alpha', direction_owner: 'brain',
  });
});

test('unregistered Brain and unsafe reader paths stay unavailable', { skip: !python }, t => {
  const root = fixture(t, { reader: '../outside.py' });
  assert.equal(createBrainPurposeReader(root), undefined);
  const registryPath = path.join(root, '.aiverse', 'extensions', 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schema_version: '1.0', extensions: {} }));
  assert.equal(createBrainPurposeReader(root), undefined);
});

test('a public reader returning the wrong scope or owner fails closed', { skip: !python }, t => {
  const root = fixture(t, { body: `import json\nprint(json.dumps({'schema_version': '1.0', 'scope': 'workspace:other', 'direction_owner': 'os'}))\n` });
  const result = createBrainPurposeReader(root)('workspace:alpha');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'brain_public_reader_unavailable');
});
