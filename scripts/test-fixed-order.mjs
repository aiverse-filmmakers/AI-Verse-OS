#!/usr/bin/env node
// Guard: no JavaScript in this repo may order text with the computer's own language.
// Use compareCodeUnits (stored or compared order) or compareForDisplay (shown to people) from fixed-order.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCodeUnits, compareForDisplay } from './fixed-order.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SOURCE = /\.(?:mjs|cjs|js|ts)$/;
// Minified third party bundles are not ours to edit.
const BUNDLE = /(?:^|\/)dist\/.*\.js$|\.min\.js$/;
const SELF = new Set(['scripts/fixed-order.mjs', 'scripts/test-fixed-order.mjs']);

const RULES = [
  [/\.localeCompare\s*\(/, 'bare localeCompare (use compareCodeUnits or compareForDisplay from scripts/fixed-order.mjs)'],
  [/\.toLocale(?:Lower|Upper)Case\s*\(\s*\)/, 'toLocaleLowerCase/UpperCase without a fixed locale'],
  [/Intl\.Collator\s*\(\s*\)/, 'Intl.Collator without a fixed locale'],
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const offenders = [];
for (const file of walk(repoRoot)) {
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  if (!SOURCE.test(rel) || BUNDLE.test(rel) || SELF.has(rel)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const [pattern, why] of RULES) if (pattern.test(line)) offenders.push(`${rel}:${index + 1}: ${why}`);
  });
}
assert.deepEqual(offenders, [], `Locale dependent ordering found:\n${offenders.join('\n')}`);

// The helpers themselves: plain code unit order, the same on every machine.
assert.equal(compareCodeUnits('a', 'b'), -1);
assert.equal(compareCodeUnits('b', 'a'), 1);
assert.equal(compareCodeUnits('a', 'a'), 0);
assert.equal(compareCodeUnits('B', 'a'), -1, 'uppercase sorts before lowercase in code unit order');
assert.equal(compareCodeUnits('skill-a', 'skill-b'), -1);
assert.equal(compareCodeUnits('a\u0000b', 'a\u0001b'), -1, 'control characters are not ignored');
assert.deepEqual(['b', 'ä', 'a', 'z'].sort(compareCodeUnits), ['a', 'b', 'z', 'ä']);
assert.deepEqual(['b', 'A', 'a', 'B'].sort(compareForDisplay), ['a', 'A', 'b', 'B']);

process.stdout.write('Fixed order guard: PASS\n');
