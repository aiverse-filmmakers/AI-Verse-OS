// My skills are listed for chats, kept in step, and nothing else in the chat folders is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncMySkills } from './sync-my-skills.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-my-skills-')));
const root = path.join(base, 'os');
const local = path.join(base, 'local');
const skill = (dir, name, text) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text); };
let checks = 0;
const ok = (...args) => { assert.ok(...args); checks += 1; };
try {
  fs.mkdirSync(path.join(root, '.claude/skills/learn'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/skills/learn/SKILL.md'), 'os built in');
  fs.mkdirSync(path.join(root, '.agents/skills/copywriting'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents/skills/copywriting/SKILL.md'), 'library skill');
  skill(local, 'my-pitch', '---\nname: my-pitch\ndescription: v1\n---\n');
  skill(local, 'copywriting', '---\nname: copywriting\ndescription: mine\n---\n');

  let r = syncMySkills({ osRoot: root, localSkillsRoot: local });
  ok(fs.readFileSync(path.join(root, '.claude/skills/my-pitch/SKILL.md'), 'utf8').includes('v1'));
  ok(fs.readFileSync(path.join(root, '.agents/skills/my-pitch/SKILL.md'), 'utf8').includes('v1'));
  ok(fs.readFileSync(path.join(root, '.agents/skills/copywriting/SKILL.md'), 'utf8') === 'library skill', 'a library skill with the same name is never replaced');
  ok(r.skipped.some((line) => line.includes('.agents/skills/copywriting')));
  ok(fs.readFileSync(path.join(root, '.claude/skills/learn/SKILL.md'), 'utf8') === 'os built in');

  skill(local, 'my-pitch', '---\nname: my-pitch\ndescription: v2\n---\n');
  r = syncMySkills({ osRoot: root, localSkillsRoot: local });
  ok(fs.readFileSync(path.join(root, '.claude/skills/my-pitch/SKILL.md'), 'utf8').includes('v2'), 'an edited skill is refreshed');
  ok(r.updated.length === 2);

  r = syncMySkills({ osRoot: root, localSkillsRoot: local });
  ok(r.listed.length === 0 && r.updated.length === 0 && r.removed.length === 0, 'a second run changes nothing');

  fs.rmSync(path.join(local, 'my-pitch'), { recursive: true });
  r = syncMySkills({ osRoot: root, localSkillsRoot: local });
  ok(!fs.existsSync(path.join(root, '.claude/skills/my-pitch')), 'a deleted skill is removed from chats');
  ok(fs.existsSync(path.join(root, '.claude/skills/learn/SKILL.md')));
  console.log(`my skills listing checks passed: ${checks}`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
