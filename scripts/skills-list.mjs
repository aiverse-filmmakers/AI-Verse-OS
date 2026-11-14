#!/usr/bin/env node
// Every skill this OS can use, in the two groups members see: "Skills" (shipped with AI-Verse)
// and "My skills" (made or brought in by the member, plus the current project's own skills).
// Read only. Usage: node scripts/skills-list.mjs [--scope workspace:<id>] [--json]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCapabilities } from './capability-resolver.mjs';

export function skillGroups({ osRoot, scope = 'operator', skillsRoot, localSkillsRoot } = {}) {
  const result = discoverCapabilities({ osRoot, scope, query: '', limit: 200, skillsRoot, localSkillsRoot });
  const shipped = [];
  const mine = [];
  for (const item of result.candidates) {
    const row = { name: item.bare_id ?? item.name, id: item.id, description: firstSentence(item.description) };
    if (item.provider === 'os' || item.provider === 'aiverse-skills') shipped.push(row);
    else mine.push({ ...row, where: item.provider === 'local' ? 'mine' : 'this project' });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { scope, skills: shipped.sort(byName), my_skills: mine.sort(byName), complete: result.candidates.length === result.total_matching_candidates };
}

function firstSentence(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const end = value.search(/[.!?](\s|$)/);
  return (end > 0 ? value.slice(0, end + 1) : value).slice(0, 160);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const scopeAt = args.indexOf('--scope');
  const scope = scopeAt >= 0 ? args[scopeAt + 1] : 'operator';
  const osRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const groups = skillGroups({ osRoot, scope });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
  } else {
    const lines = [`Skills (${groups.skills.length})`];
    for (const row of groups.skills) lines.push(`  ${row.name}: ${row.description}`);
    lines.push('', `My skills (${groups.my_skills.length})`);
    if (!groups.my_skills.length) lines.push('  None yet. Make one with /skill or let /learn turn a workflow into one.');
    for (const row of groups.my_skills) lines.push(`  ${row.name}${row.where === 'this project' ? ' (this project)' : ''}: ${row.description}`);
    if (!groups.complete) lines.push('', 'Only the first 200 skills are shown.');
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}
