import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const at=process.argv.indexOf('--root');
const root=path.resolve(at>=0?process.argv[at+1]:process.cwd());
const candidates=[];

async function add(label,p,type='markdown'){
  try{
    const stat=await fs.stat(p);
    candidates.push({label,path:p,type,isDirectory:stat.isDirectory()});
  }catch{}
}

for(const [label,p] of [
  ['Operator profile','operator/profile'],
  ['Operator current context','operator/context'],
  ['Operator memory','operator/memory'],
  ['Shared knowledge','knowledge'],
  ['System frameworks','references'],
  ['Shared skills','.claude/skills']
]) await add(label,path.join(root,p));

const workspaces=path.join(root,'workspaces');
try{
  for(const entry of await fs.readdir(workspaces,{withFileTypes:true})){
    if(!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    await add(`Workspace: ${entry.name}`,path.join(workspaces,entry.name));
  }
}catch{}

await add('Codex Memory',path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'memories'),'codex-memory');

const claude=path.join(os.homedir(),'.claude','projects');
const encoded=root.replace(/[^a-zA-Z0-9]/g,'-').toLowerCase();
try{
  for(const entry of await fs.readdir(claude,{withFileTypes:true})){
    if(entry.isDirectory() && entry.name.toLowerCase()===encoded) await add('Claude memory',path.join(claude,entry.name,'memory'));
  }
}catch{}

console.log(JSON.stringify({
  root,
  candidates,
  note:'Candidate paths only. Categories are chosen from the actual installation. No profession or domain is assumed; ask the user which sources to include before reading external memory.'
},null,2));
