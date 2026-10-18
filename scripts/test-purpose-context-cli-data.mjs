import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPurposeContextCli, explainPurposeContextCli } from './purpose-context.mjs';
import { invokeDataHost, OS_DATA_HOST_PROTOCOL } from './data-host.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const scope = 'workspace:alpha-';
const purposeRef = { owner: 'ai-verse-os', scope, kind: 'current-context', id: 'active' };
const binding = (field = 'count', recordId = 'today') => ({
  purpose_ref: purposeRef,
  ref: { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId, field },
  staleAfterMs: 3_600_000,
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-cli-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  fs.mkdirSync(path.join(root, 'operator'), { recursive: true });
  const workspace = path.join(root, 'workspaces', 'alpha-');
  fs.mkdirSync(path.join(workspace, 'context'), { recursive: true });
  const manifest = path.join(workspace, 'WORKSPACE.yaml');
  fs.writeFileSync(manifest, 'schema_version: "2.0"\nid: alpha-\nname: Synthetic\ntype: project\nstatus: active\npurpose: Test\n');
  fs.writeFileSync(path.join(workspace, 'context', 'CURRENT.md'), '## Objective\n\n- Ship synthetic work\n');
  const ext = path.join(root, '.aiverse', 'extensions');
  fs.mkdirSync(ext, { recursive: true });
  const registry = path.join(ext, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schema_version: '1.0', extensions: { 'ai-verse-data': {
    supported: true, installed: true, enabled: true, engine: '.aiverse/extensions/engine.mjs',
  } } }));
  fs.writeFileSync(path.join(ext, 'engine.mjs'), `
import fs from 'node:fs';
export function describe() { return { protocol:'ai-verse-data-host/1.0', actorBinding:'human:local-operator', authorizationBinding:'local-operator' }; }
export async function handleRequest(request) {
  fs.appendFileSync(new URL('./calls.jsonl', import.meta.url), JSON.stringify(request)+'\\n');
  if (request.operation !== 'data.request' || request.data.operation !== 'data.record.get') throw new Error('Unexpected operation');
  const {spaceId,entity,recordId}=request.data.payload;
  if(recordId==='missing') { const error=new Error('Missing record'); error.code='RECORD_NOT_FOUND'; throw error; }
  return { protocol:'ai-verse-data/0.1',ok:true,operation:'data.record.get',scope:{workspaceId:recordId==='wrong-scope'?'beta':'alpha-'},actor:{kind:'human',id:'local-operator'},authorization:{mode:'local-operator'},result:{spaceId,entity,recordId,schemaVersion:1,version:2,updatedAt:recordId==='old'?'2000-01-01T00:00:00Z':new Date().toISOString(),data:{count:0,blocked:false,note:null,nested:{bad:true},extra:'RAW_PRIVATE_RECORD_MARKER'}}};
}
`);
  return { root, workspace, manifest, registry, log: path.join(ext, 'calls.jsonl') };
}

function run(f, bindings, flags = []) {
  const args = [path.join(scripts, 'purpose-context.mjs'), 'read', '--root', f.root, '--scope', scope, ...flags];
  if (bindings !== undefined) args.push('--data-bindings');
  const out = spawnSync(process.execPath, args, { input: bindings === undefined ? undefined : JSON.stringify(bindings), encoding: 'utf8' });
  return { ...out, json: out.status === 0 ? JSON.parse(out.stdout) : undefined };
}

test('both public CLI helpers forward a supplied Data reader', t => {
  const f = fixture(t);
  let calls = 0;
  const options = { root:f.root, scope, readPurposeDataCurrentState(request) { calls++; return {status:'ok',scope:request.scope,bindings:[]}; } };
  readPurposeContextCli(options);
  assert.equal(calls,1);
  assert.throws(() => explainPurposeContextCli({...options,ref:'goal:missing'}));
  assert.equal(calls,2);
});

test('real command reads selected scalars through Data host and retains freshness/missing evidence', t => {
  const f=fixture(t);
  const out=run(f,[binding('count'),binding('blocked'),binding('note'),binding('count','old'),binding('not-there'),binding('count','missing')]);
  assert.equal(out.status,0,out.stderr);
  const current=out.json.current_state.filter(x=>x.kind==='data_current_state');
  assert.equal(current.length,3);
  assert.deepEqual(new Map(current.map(x=>[x.source_ref.field,x.value])),new Map([['count',0],['blocked',false],['note',null]]));
  const diagnostics=out.json.section_states.data_current_state.diagnostics;
  assert.equal(diagnostics.filter(x=>x.state==='stale').length,1);
  assert.equal(diagnostics.filter(x=>x.state==='missing').length,2);
  assert.ok(current.every(x=>x.source_provenance.scope.workspaceId==='alpha-'));
  assert.ok(!out.stdout.includes('RAW_PRIVATE_RECORD_MARKER'));
  const calls=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,3,'read identical records once per projection');
  assert.ok(calls.every(x=>x.operation==='data.request'&&x.data.operation==='data.record.get'));
  assert.equal(fs.existsSync(path.join(f.workspace,'data')),false,'normal read must not initialize Data');
});

test('no bindings gives an explicit unconfigured state without reading Data', t => {
  const f=fixture(t),out=run(f);
  assert.equal(out.status,0,out.stderr);
  assert.equal(out.json.section_states.data_current_state.reason,'data_purpose_bindings_required');
  assert.equal(fs.existsSync(f.log),false);
});

test('unretained Purpose refs never reach Data', t => {
  const f=fixture(t),unrelated=binding();
  unrelated.purpose_ref={...purposeRef,id:'not-retained'};
  const out=run(f,[unrelated]);
  assert.equal(out.status,0,out.stderr);
  assert.equal(fs.existsSync(f.log),false);
  assert.equal(out.json.current_state?.some(x=>x.kind==='data_current_state')??false,false);
});

test('scope mismatch, excessive bindings and invalid freshness fail before owner access', t => {
  const f=fixture(t);
  for(const bindings of [[{...binding(),purpose_ref:{...purposeRef,scope:'workspace:beta'}}],Array.from({length:33},()=>binding()),[{...binding(),staleAfterMs:-1}]]) {
    const out=run(f,bindings);
    assert.notEqual(out.status,0);
    assert.equal(fs.existsSync(f.log),false);
  }
});

test('disabled Data and paused workspaces are unavailable without invoking the engine', t => {
  const f=fixture(t),registry=JSON.parse(fs.readFileSync(f.registry,'utf8'));
  registry.extensions['ai-verse-data'].enabled=false;
  fs.writeFileSync(f.registry,JSON.stringify(registry));
  let out=run(f,[binding()]);
  assert.equal(out.status,0,out.stderr);
  assert.equal(out.json.section_states.data_current_state.state,'unavailable');
  assert.equal(fs.existsSync(f.log),false);
  registry.extensions['ai-verse-data'].enabled=true;
  fs.writeFileSync(f.registry,JSON.stringify(registry));
  fs.writeFileSync(f.manifest,fs.readFileSync(f.manifest,'utf8').replace('status: active','status: paused'));
  out=run(f,[binding()]);
  assert.equal(out.status,0,out.stderr);
  assert.equal(out.json.section_states.data_current_state.state,'unavailable');
  assert.equal(fs.existsSync(f.log),false);
});

test('wrong owner scope and non-scalar values are unavailable, not accepted facts', t => {
  const f=fixture(t);
  for(const b of [binding('count','wrong-scope'),binding('nested')]) {
    const out=run(f,[b]);
    assert.equal(out.status,0,out.stderr);
    assert.equal(out.json.section_states.data_current_state.state,'unavailable');
    assert.equal(out.json.current_state?.some(x=>x.kind==='data_current_state')??false,false);
  }
});

test('installed Data owner reads through the actual command in a temporary workspace', { skip: !process.env.AIVERSE_DATA_TEST_ENGINE }, async t => {
  const f=fixture(t);
  const engine=path.resolve(process.env.AIVERSE_DATA_TEST_ENGINE);
  fs.writeFileSync(path.join(f.root,'AGENTS.md'),'# Synthetic OS runtime\n');
  fs.mkdirSync(path.join(f.root,'system','extensions'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'system','extensions','README.md'),'Extension registry: .aiverse/extensions/registry.json\n');
  fs.writeFileSync(path.join(f.root,'.aiverse','extensions','engine.mjs'),
    `export { describe, handleRequest } from ${JSON.stringify(pathToFileURL(engine).href)};\n`);
  let id=0;
  async function request(operation,payload) {
    return invokeDataHost({osRoot:f.root,request:{protocol:OS_DATA_HOST_PROTOCOL,request_id:`fixture-${++id}`,operation,scope,reason:'Explicit synthetic test setup',...(payload?{data:payload}:{})}});
  }
  // A normal read must not create a missing canonical database.
  const missing=run(f,[binding()]);
  assert.equal(missing.status,0,missing.stderr);
  assert.equal(missing.json.section_states.data_current_state.reason,'WORKSPACE_DATA_UNAVAILABLE');
  assert.equal(fs.existsSync(path.join(f.workspace,'data','ai-verse-data.sqlite')),false);
  await request('init');
  await request('request',{operation:'data.space.create',payload:{spaceId:'metrics',name:'Metrics',authority:'local_canonical'}});
  await request('request',{operation:'data.schema.create',payload:{spaceId:'metrics',entity:'snapshots',name:'Snapshots',fields:{count:{type:'number'},blocked:{type:'boolean'},note:{type:'string',nullable:true}}}});
  const created=await request('request',{operation:'data.record.create',payload:{spaceId:'metrics',entity:'snapshots',idempotencyKey:'synthetic-record',data:{count:0,blocked:false,note:null}}});
  const record=created.result.result;
  const before=await request('request',{operation:'data.record.get',payload:{spaceId:'metrics',entity:'snapshots',recordId:record.recordId}});
  const out=run(f,['count','blocked','note'].map(field=>binding(field,record.recordId)));
  assert.equal(out.status,0,out.stderr);
  const current=out.json.current_state.filter(x=>x.kind==='data_current_state');
  assert.equal(current.length,3);
  assert.deepEqual(new Map(current.map(x=>[x.source_ref.field,x.value])),new Map([['count',0],['blocked',false],['note',null]]));
  assert.ok(current.every(x=>x.source_updated_at===record.updatedAt&&x.source_provenance.recordVersion===record.version));
  const after=await request('request',{operation:'data.record.get',payload:{spaceId:'metrics',entity:'snapshots',recordId:record.recordId}});
  assert.deepEqual(after.result.result,before.result.result,'Purpose must not change canonical Data');
});
