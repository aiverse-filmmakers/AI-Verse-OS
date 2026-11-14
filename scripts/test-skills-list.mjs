// The two member groups: shipped skills under "Skills", personal and project skills under "My skills".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skillGroups } from './skills-list.mjs';

const osRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-skills-list-'));
try {
  const local = path.join(base, 'local');
  const mine = path.join(local, 'my-pitch-writer');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: my-pitch-writer\ndescription: Writes my client pitches. Use when pitching.\n---\n\nSteps.\n');
  const groups = skillGroups({ osRoot, localSkillsRoot: local, skillsRoot: path.join(base, 'no-library') });
  assert.ok(groups.skills.some((row) => row.name === 'learn'), 'OS built in skills are under Skills');
  assert.ok(groups.skills.every((row) => row.name !== 'my-pitch-writer'));
  const pitch = groups.my_skills.find((row) => row.name === 'my-pitch-writer');
  assert.ok(pitch, 'personal skills are under My skills');
  assert.equal(pitch.where, 'mine');
  assert.equal(pitch.description, 'Writes my client pitches.');
  const text = execFileSync(process.execPath, [path.join(osRoot, 'scripts/skills-list.mjs')], { encoding: 'utf8' });
  assert.match(text, /^Skills \(\d+\)/);
  assert.match(text, /\nMy skills \(\d+\)/);
  console.log('skills list checks passed: 7');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
