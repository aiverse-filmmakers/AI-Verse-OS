#!/usr/bin/env node
/** Placement boundary for supported personal tool creation and dependency installs.
 * Not a sandbox: third-party package code and arbitrary shell writes remain host-controlled.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateActionPermission} from './action-permission.mjs';
import {createHash} from 'node:crypto';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
function plainDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error(`Tool path must be a real directory: ${dir}`);
}
function plainFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error(`Tool manifest must be a regular file: ${file}`);
}
export function toolLocation({root = process.cwd(), scope, name}) {
  root = fs.realpathSync(root);
  if (!NAME.test(name ?? '')) throw Error('Use a tool name containing lowercase letters, digits and hyphens (maximum 64 characters).');
  // Reuse the host's existing OS/workspace validation and local-action floor.
  const request = {action_class:'write_local_reversible',scope,
    request_fingerprint:createHash('sha256').update(JSON.stringify({root,scope,name})).digest('hex')};
  const permission = evaluateActionPermission({osRoot:root,request});
  if(permission.decision!=='allow') throw Error(permission.reason);
  const parts = scope === 'operator' ? ['apps', name] : ['workspaces', scope.slice(10), 'tools', name];
  let dir = root;
  for (const part of parts) {
    dir = path.join(dir, part);
    try {fs.lstatSync(dir);plainDirectory(dir);} catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  return {root, directory: dir, scope, name};
}
function manifest(location, runtime) {
  const file = path.join(location.directory, runtime === 'node' ? 'package.json' : 'pyproject.toml');
  plainFile(file);
  if (runtime === 'node') {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.private !== true || data.workspaces) throw Error('A personal Node tool requires private:true and no workspace redirects.');
  }
  for (const child of ['node_modules', 'package-lock.json', '.npmrc', '.venv']) {
    const file = path.join(location.directory, child);
    try {if (fs.lstatSync(file).isSymbolicLink()) throw Error(`Tool child must not be redirected: ${child}`);} catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  return file;
}
function runtimeValid(runtime) {
  if (!['node','python'].includes(runtime)) throw Error('Runtime must be node or python.');
}
export function initializeTool(options) {
  runtimeValid(options.runtime);
  const loc = toolLocation(options);
  try {fs.lstatSync(loc.directory);throw Error('Tool already exists; use check/install. Nothing was overwritten.');} catch(e) {if(e.code!=='ENOENT')throw e;}
  const result = {...loc, runtime: options.runtime, applied: false};
  if (!options.apply) return result;
  const parent = path.dirname(loc.directory);
  // Only the final tools container may be missing; workspace roots must already exist.
  if (!fs.existsSync(parent)) fs.mkdirSync(parent);
  plainDirectory(parent);
  fs.mkdirSync(loc.directory);
  const file = path.join(loc.directory, options.runtime === 'node' ? 'package.json' : 'pyproject.toml');
  const body = options.runtime === 'node'
    ? JSON.stringify({name:loc.name,private:true,version:'0.0.0',type:'module'},null,2)+'\n'
    : `[project]\nname = "${loc.name}"\nversion = "0.0.0"\ndependencies = []\n`;
  fs.writeFileSync(file,body,{flag:'wx'});
  return {...result,applied:true};
}
export function checkTool(options) {
  runtimeValid(options.runtime);
  const loc = toolLocation(options);
  plainDirectory(loc.directory);
  return {...loc,runtime:options.runtime,manifest:manifest(loc,options.runtime),ok:true};
}
export function dependencyPlan(options) {
  const loc = checkTool(options);
  const specs = options.packages ?? [];
  const pattern = options.runtime === 'node'
    ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9.*^~+_-]*)?$/
    : /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[[a-zA-Z0-9_,.-]+\])?(?:(?:==|>=|<=|~=|>|<)[a-zA-Z0-9][a-zA-Z0-9.*+_-]*)?$/;
  if (!specs.length || specs.length>64 || specs.some(s=>typeof s!=='string'||s.length>256||!pattern.test(s))) throw Error('Supply registry package names with optional versions; flags, URLs and local paths are not accepted.');
  if(options.runtime==='node') {
    const args=['--prefix',loc.directory,'--global=false','--workspaces=false','--ignore-scripts','--no-audit','--no-fund','install',...specs];
    // Windows .cmd shims require a shell; invoke npm's JavaScript entrypoint instead.
    if(process.platform==='win32') {
      const cli=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
      plainFile(cli);
      return {...loc,steps:[{command:process.execPath,args:[cli,...args]}]};
    }
    return {...loc,steps:[{command:'npm',args}]};
  }
  const venv = path.join(loc.directory,'.venv');
  if(fs.existsSync(venv)) {
    plainDirectory(venv);
    const config=path.join(venv,'pyvenv.cfg');plainFile(config);
    if(!/^include-system-site-packages\s*=\s*false\s*$/mi.test(fs.readFileSync(config,'utf8'))) throw Error('Tool virtual environment must exclude system site-packages.');
  }
  const python = path.join(venv,process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
  const steps = fs.existsSync(venv) ? [] : [{command:process.platform==='win32'?'python':'python3',args:['-I','-m','venv',venv]}];
  steps.push({command:python,args:['-I','-m','pip','--isolated','install','--prefix',venv,'--no-user',...specs]});
  return {...loc,steps};
}
export function installDependencies(options, run = spawnSync) {
  const plan = dependencyPlan(options);
  if(!options.apply) return {...plan,applied:false};
  for(const step of plan.steps) {
    // Recheck containment at each dispatch; no shell or arbitrary command input.
    checkTool(options);
    const result=run(step.command,step.args,{cwd:plan.directory,stdio:'inherit',shell:false});
    if(result.error || result.status!==0) throw Error('Dependency installation failed. Existing files were preserved; inspect tool-local package-manager output before retrying.');
  }
  return {...plan,applied:true};
}
function main(argv) {
  const command=argv.shift();
  const options={root:process.cwd(),scope:'operator',packages:[]};
  while(argv.length) {
    const arg=argv.shift();
    if(arg==='--apply') options.apply=true;
    else if(['--root','--scope','--name','--runtime','--package'].includes(arg)) {
      const value=argv.shift();if(!value || value.startsWith('--'))throw Error(`${arg} requires a value`);
      if(arg==='--package') options.packages.push(value);else options[arg.slice(2)]=value;
    }else throw Error(`Unknown argument: ${arg}`);
  }
  const operation={init:initializeTool,check:checkTool,install:installDependencies}[command];
  if(!operation)throw Error('Usage: node scripts/personal-tool.mjs init|check|install --name <slug> --runtime node|python [--scope operator|workspace:<id>] [--package <registry-spec>] [--apply]. Init/install preview by default.');
  console.log(JSON.stringify(operation(options),null,2));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {main(process.argv.slice(2));}catch(e){console.error(`personal-tool: ${e.message}`);process.exitCode=2;}
}
