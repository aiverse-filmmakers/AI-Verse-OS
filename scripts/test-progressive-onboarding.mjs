#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');

const canonical = read('system/capabilities/onboard/SKILL.md');
const claude = read('.claude/skills/onboard/SKILL.md');
const codex = read('.agents/skills/onboard/SKILL.md');
const runtime = read('AGENTS.md');
const intake = read('ai-verse-os-intake.md');
const cli = read('bin/ai-verse-os.mjs');
const readme = read('README.md');

assert.equal(claude, canonical, 'Claude onboard adapter must match canonical capability');
assert.equal(codex, canonical, 'Codex onboard adapter must match canonical capability');

assert.match(canonical, /What would you like help with\?/);
assert.match(canonical, /Do \*\*not\*\* stop the task merely because Q1-Q7 are incomplete\./);
assert.match(canonical, /A partially completed intake is valid during normal use\./);
assert.match(canonical, /Optional full\/deep intake/);
assert.match(canonical, /reuse known answers rather than asking them again/i);
assert.match(canonical, /direction_owner = brain/);
assert.match(canonical, /does not itself authorize a new Automation, permanent Bot, credential, Connection, permission expansion, destructive change, or strategic handover/);

assert.match(runtime, /First-use and progressive onboarding rule/);
assert.match(runtime, /What would you like help with\?/);
assert.match(runtime, /seven-question intake remains available/);
assert.match(runtime, /do not create a second onboarding store/);

assert.match(intake, /optional for normal first use/i);
assert.match(intake, /Unanswered placeholders are valid during normal use/);
assert.match(intake, /Hard cap for a deliberate full intake: 7 primary questions/);

assert.match(cli, /Start with a real request\. AI-Verse will learn missing context progressively\./);
assert.match(cli, /Optional deep intake/);
assert.match(readme, /start with a real request/i);
assert.match(readme, /seven-question intake remains available/i);

assert.doesNotMatch(
  canonical,
  /If none are filled, interview one question at a time\./,
  'fresh first use must not default to mandatory questionnaire behavior',
);

process.stdout.write('Progressive onboarding acceptance: PASS\n');
