// My skills are listed for chats, kept in step, and nothing else in the chat folders is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncMySkills } from './sync-my-skills.mjs';
import { packageDigestV1 } from './capability-resolver-core.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-my-skills-')));
const root = path.join(base, 'os');
const local = path.join(base, 'local');
const skill = (dir, name, text) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text); };
const memberRoot = path.join(local, '.aiverse/member-library');
const members = {};
function addMember(id, name, visibility, enabled = true) {
  const staging = path.join(base, id);
  skill(staging, name, `---\nname: ${name}\ndescription: Start a new project from a short idea\n---\n`);
  const packageDir = path.join(staging, name);
  fs.mkdirSync(path.join(packageDir, 'assets'));
  fs.writeFileSync(path.join(packageDir, 'assets/starter.html'), '<main>Starter project</main>');
  const revision = packageDigestV1(packageDir);
  const relative = `.aiverse/member-library/packages/${id}/${revision}`;
  const target = path.join(local, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(packageDir, target);
  const item = { name, description: 'Start a new project from a short idea', visibility,
    source_scope: 'workspace:alpha', path: relative, admission: visibility === 'shared' ?
      { reusable: true, contains_workspace_data: false, contains_credentials: false, has_workspace_dependencies: false } : {} };
  members[id] = { id, name, description: item.description, visibility, enabled,
    active_revision: revision, revisions: { [revision]: item } };
}
const writeIndex = () => fs.writeFileSync(path.join(memberRoot, 'index.json'),
  JSON.stringify({ contract: 'aiverse-member-skill-library-v1', sequence: 0, skills: members, events: [] }));
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

  addMember('approved-board', 'project-starter', 'shared');
  addMember('private-board', 'private-starter', 'workspace:alpha');
  addMember('disabled-board', 'disabled-starter', 'shared', false);
  const duplicate = members['approved-board'].revisions[members['approved-board'].active_revision];
  fs.cpSync(path.join(local, duplicate.path), path.join(local, 'project-starter'), { recursive: true });
  writeIndex();
  r = syncMySkills({ osRoot: root, localSkillsRoot: local });
  ok(!r.skipped.some((item) => item.startsWith('project-starter:')), 'identical legacy and approved copies are one listing');
  for (const folder of ['.agents/skills', '.claude/skills']) {
    const listed = path.join(root, folder);
    ok(fs.readFileSync(path.join(listed, 'project-starter/assets/starter.html'), 'utf8').includes('Starter project'));
    ok(!fs.existsSync(path.join(listed, 'private-starter')));
    ok(!fs.existsSync(path.join(listed, 'disabled-starter')));
  }
  fs.writeFileSync(path.join(memberRoot, 'index.json'), '{}');
  assert.throws(() => syncMySkills({ osRoot: root, localSkillsRoot: local }), /cannot be read/);
  ok(fs.existsSync(path.join(root, '.agents/skills/project-starter/SKILL.md')), 'keeps the last known copy on a corrupt index');
  fs.rmSync(path.join(local, 'project-starter'), { recursive: true });
  members['approved-board'].enabled = false;
  writeIndex();
  r = syncMySkills({ osRoot: root, localSkillsRoot: local });
  ok(r.removed.filter((target) => target.endsWith('/project-starter')).length === 2);
  console.log(`my skills listing checks passed: ${checks}`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
