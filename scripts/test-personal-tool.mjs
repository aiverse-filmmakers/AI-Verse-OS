import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initializeTool,checkTool,dependencyPlan,installDependencies} from './personal-tool.mjs';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aiverse-tool-placement-')));
let checks=0;
const reject=fn=>{assert.throws(fn);checks++;};
const opts=(name='example',runtime='node',scope='operator')=>({root,name,runtime,scope});
try {
 for(const dir of ['operator','workspaces/demo','apps'])fs.mkdirSync(path.join(root,dir),{recursive:true});
 fs.writeFileSync(path.join(root,'AI-VERSE.yaml'),'schema_version: "2.0"\narchitecture: unified-workspace\n');
 fs.writeFileSync(path.join(root,'workspaces/demo/WORKSPACE.yaml'),'schema_version: "2.0"\nid: demo\nstatus: active\n');
 fs.copyFileSync(fileURLToPath(new URL('../.gitignore',import.meta.url)),path.join(root,'.gitignore'));
 assert.equal(spawnSync('git',['init',root],{encoding:'utf8'}).status,0);
 const protectedFiles=['package.json','package-lock.json','pyproject.toml','requirements.txt'];
 for(const file of protectedFiles)fs.writeFileSync(path.join(root,file),'Core sentinel '+file);
 const baseline=protectedFiles.map(f=>fs.readFileSync(path.join(root,f),'utf8'));
 assert.equal(initializeTool(opts()).applied,false);assert.equal(fs.existsSync(path.join(root,'apps/example')),false);checks++;
 initializeTool({...opts(),apply:true});assert.equal(checkTool(opts()).ok,true);checks++;
 reject(()=>initializeTool({...opts(),apply:true}));
 for(const name of ['..','../escape','/tmp/tool','a/b','a\\b','--flag','', 'UPPER'])reject(()=>initializeTool(opts(name)));
 for(const scope of ['workspace:missing','workspace:../demo','bad'])reject(()=>initializeTool(opts('other','node',scope)));
 initializeTool({...opts('scoped','python','workspace:demo'),apply:true});checks++;
 const py=dependencyPlan({...opts('scoped','python','workspace:demo'),packages:['requests==2.32.3']});
 assert.equal(py.steps.length,2);assert.ok(py.steps[0].args.includes('-I'));assert.ok(py.steps[1].command.startsWith(path.join(root,'workspaces/demo/tools/scoped/.venv')));checks++;
 const plan=dependencyPlan({...opts(),packages:['dotenv@16.4.5','@scope/pkg@1.0.0']});
 assert.ok(plan.steps[0].args.includes('--ignore-scripts'));assert.ok(plan.steps[0].args.includes('--global=false'));assert.ok(plan.steps[0].args.includes('--workspaces=false'));assert.equal(plan.steps[0].args[plan.steps[0].args.indexOf('--prefix')+1],path.join(root,'apps/example'));checks++;
 for(const spec of ['--prefix=/tmp','../local','file:foo','https://evil/pkg','pkg;echo','pkg\nname','-g'])reject(()=>dependencyPlan({...opts(),packages:[spec]}));
 let calls=0;
 installDependencies({...opts(),packages:['dotenv'],apply:false},()=>{calls++;});assert.equal(calls,0);checks++;
 installDependencies({...opts(),packages:['dotenv'],apply:true},(command,args,options)=>{calls++;assert.equal(options.cwd,path.join(root,'apps/example'));assert.equal(options.shell,false);return {status:0};});assert.equal(calls,1);checks++;
 reject(()=>installDependencies({...opts(),packages:['dotenv'],apply:true},()=>({status:1})));
 const manifest=path.join(root,'apps/example/package.json');fs.writeFileSync(manifest,'{"private":true,"workspaces":["../../"]}');reject(()=>checkTool(opts()));fs.writeFileSync(manifest,'{"private":true}');
 // Real public CLI rejects root/traversal without touching Core.
 const cli=spawnSync(process.execPath,[fileURLToPath(new URL('./personal-tool.mjs',import.meta.url)),'init','--root',root,'--scope','operator','--name','..','--runtime','node','--apply'],{encoding:'utf8'});assert.equal(cli.status,2);checks++;
 // Directory links need elevated privilege on some Windows hosts; junctions cover directory escapes there.
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'aiverse-tool-outside-'));
 try {
  fs.symlinkSync(outside,path.join(root,'apps/linked'),process.platform==='win32'?'junction':'dir');reject(()=>initializeTool({...opts('linked'),apply:true}));
  fs.symlinkSync(outside,path.join(root,'apps/example/node_modules'),process.platform==='win32'?'junction':'dir');reject(()=>checkTool(opts()));
 } finally {fs.rmSync(outside,{recursive:true,force:true});}
 fs.writeFileSync(path.join(root,'workspaces/demo/WORKSPACE.yaml'),'schema_version: "2.0"\nid: demo\nstatus: paused\n');reject(()=>checkTool(opts('scoped','python','workspace:demo')));
 assert.deepEqual(protectedFiles.map(f=>fs.readFileSync(path.join(root,f),'utf8')),baseline);checks++;
 for(const file of ['apps/example/package.json','workspaces/demo/tools/scoped/pyproject.toml'])assert.equal(spawnSync('git',['-C',root,'check-ignore','--quiet',file]).status,0);checks++;
 console.log(`Personal tool placement: PASS (${checks} checks; Core manifests unchanged).`);
}finally{fs.rmSync(root,{recursive:true,force:true});}
