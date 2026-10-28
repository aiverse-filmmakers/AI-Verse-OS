import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CANVAS_GRANT_SOURCE,verifyInstalledCanvasGrant} from '../scripts/canvas-actor-grant.mjs';
import {CANVAS_GRANT_OWNER_SOURCE,createCanvasGrantOwnerLifecycle} from '../scripts/canvas-grant-owner-lifecycle.mjs';

const roots=[];
afterEach(()=>roots.splice(0).forEach(r=>fs.rmSync(r,{force:true,recursive:true})));
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'canvas-native-issue-')));
 roots.push(root);
 for(const d of ['operator','workspaces','workspaces/film','.aiverse','.aiverse/os'])
  fs.mkdirSync(path.join(root,d),{recursive:true});
 fs.writeFileSync(path.join(root,'AI-VERSE.yaml'),
  'schema_version: "2.0"\narchitecture: unified-workspace\n');
 const writeStatus=status=>fs.writeFileSync(path.join(root,'workspaces/film/WORKSPACE.yaml'),
  'schema_version: "2.0"\nid: "film"\nname: "Film"\nstatus: "'+status+'"\n');
 writeStatus('active');
 let approved=true,botRunning=true,wrongReceipt=false,approvalCount=0,checks=0,seenChange=null,approvalHook=null;
 const create=()=>createCanvasGrantOwnerLifecycle({
  osRoot:root,
  verifyCanonicalBotRun:async()=>{checks++;return botRunning},
  approveNativeOwnerChange:async info=>{
   approvalCount++;
   seenChange=info.permissionChange;
   if(approvalHook)await approvalHook(info);
   return approved?{
     source:CANVAS_GRANT_OWNER_SOURCE,approved:true,
     requestFingerprint:wrongReceipt?'0'.repeat(64):info.requestFingerprint,
     ownerId:'native-os-human',sessionId:'owner-session-1',
     expiresAt:new Date(Date.now()+60_000).toISOString(),
   }:null;
  },
 });
 const human={grant_id:'grant-human-1',actor_kind:'human',actor_id:'human-operator',
  scope:'operator',system_id:'system-1',principal:'owner-session-1',
  lease_epoch:'epoch-1',expires_at:new Date(Date.now()+600_000).toISOString(),
  methods:['aiverse.canvas.get','aiverse.canvas.create']};
 const bot={grant_id:'grant-bot-1',actor_kind:'bot',actor_id:'native-bot',
  scope:'film',system_id:'system-1',principal:'gateway-owner',
  run_id:'run-1',session_id:'session-1',lease_epoch:'epoch-bot-1',
  expires_at:new Date(Date.now()+600_000).toISOString(),
  methods:['aiverse.canvas.get','aiverse.canvas.edit']};
 let n=0;
 const request=(operation,more={})=>({operation,expectedGeneration:null,
  requestId:'req-'+(++n),reason:'explicit native owner approval',
  ...more});
 const file=path.join(root,'.aiverse/os/canvas-actor-grants.json');
 const read=(facts)=>verifyInstalledCanvasGrant({osRoot:root,facts});
 return {root,file,human,bot,request,read,create,writeStatus,
  blockApproval:()=>{approved=false},badReceipt:()=>{wrongReceipt=true},
  stopBot:()=>{botRunning=false},counts:()=>({approvalCount,checks}),
  change:()=>seenChange,afterApproval:fn=>{approvalHook=fn},
  setBot:state=>{botRunning=state}};
}
const humanFacts={systemId:'system-1',workspaceId:'operator',
 principal:'owner-session-1',actorKind:'human',method:'aiverse.canvas.get'};
const botFacts={systemId:'system-1',workspaceId:'film',
 principal:'gateway-owner',actorKind:'bot',runId:'run-1',
 sessionId:'session-1',method:'aiverse.canvas.edit'};
const onUnix={skip:process.platform==='win32'};
test('Windows cannot use POSIX grant owner without reviewed ACL', {skip:process.platform!=='win32'},()=>{
 const f=fixture();
 assert.throws(()=>f.create(),/CANVAS_NATIVE_OWNER_DENIED/);
});
test('starts unprovisioned; denied explicit approval never creates any grant',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 assert.deepEqual(owner.list(),{provisioned:false,generation:null,grants:[]});
 f.blockApproval();
 await assert.rejects(owner.apply(f.request('issue',{grant:f.human})),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(fs.existsSync(f.file),false);
 assert.equal(f.read(humanFacts),null);
});
test('native-approved owner issues real grant atomically, read by existing verifier',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const result=await owner.apply(f.request('issue',{grant:f.human}));
 assert.equal(result.source,CANVAS_GRANT_OWNER_SOURCE);
 assert.equal(result.operation,'issue');
 assert.equal(result.grantCount,1);
 assert.equal(f.read(humanFacts)?.actorId,'human-operator');
 assert.equal(owner.list().grants[0].grantId,'grant-human-1');
 assert.equal(fs.statSync(f.file).mode&0o077,0);
 assert.ok(f.counts().approvalCount>0);
});
test('native approval sees exact scope, actor, methods, expiry and reason',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 await owner.apply(f.request('issue',{grant:f.human}));
 assert.deepEqual(f.change(),{
  operation:'issue',scope:'operator',
  grant:{grantId:'grant-human-1',actorKind:'human',
   actorId:'human-operator',scope:'operator',
   methods:['aiverse.canvas.get','aiverse.canvas.create'],
   expiresAt:f.human.expires_at},
  priorGeneration:null,reason:'explicit native owner approval',
 });
});
test('revocation requires independent owner approval and invalidates next read',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const first=await owner.apply(f.request('issue',{grant:f.human}));
 f.blockApproval();
 await assert.rejects(owner.apply(f.request('revoke',{
  expectedGeneration:first.afterGeneration,grantId:'grant-human-1',
 })),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.ok(f.read(humanFacts));
});
test('CAS prevents replay, stale issuance or revoke after another owner change',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const first=await owner.apply(f.request('issue',{grant:f.human}));
 await assert.rejects(owner.apply(f.request('issue',{
  expectedGeneration:null,grant:{...f.human,grant_id:'another-1'},
 })),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(owner.list().generation,first.afterGeneration);
 const revoked=await owner.apply(f.request('revoke',{
  expectedGeneration:first.afterGeneration,grantId:'grant-human-1',
 }));
 assert.equal(revoked.grantCount,0);
 assert.equal(f.read(humanFacts),null);
 assert.notEqual(revoked.afterGeneration,first.afterGeneration);
 await assert.rejects(owner.apply(f.request('revoke',{
  expectedGeneration:first.afterGeneration,grantId:'grant-human-1',
 })),/CANVAS_NATIVE_OWNER_DENIED/);
});
test('canonical bot verifier is required before and AFTER native approval',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 f.stopBot();
 await assert.rejects(owner.apply(f.request('issue',{grant:f.bot})),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(f.counts().approvalCount,0);
 assert.equal(fs.existsSync(f.file),false);
});
test('valid bot grant is scoped to run/session, and revoked atomically',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const result=await owner.apply(f.request('issue',{grant:f.bot}));
 assert.equal(f.read(botFacts)?.actorId,'native-bot');
 assert.ok(f.counts().checks>=2);
 assert.equal(f.read({...botFacts,runId:'other'}),null);
 const revoked=await owner.apply(f.request('revoke',{expectedGeneration:result.afterGeneration,
  grantId:'grant-bot-1'}));
 assert.equal(revoked.grantCount,0);
 assert.equal(f.read(botFacts),null);
});
test('bot never receives revert or delete approval through owner issuer',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 for(const method of ['aiverse.canvas.revert','aiverse.canvas.delete'])
  await assert.rejects(owner.apply(f.request('issue',{
   grant:{...f.bot,methods:[method]},
  })),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(f.counts().approvalCount,0);
});
test('workspace pause during native approval revokes issuance at effect edge',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 f.afterApproval(()=>f.writeStatus('paused'));
 await assert.rejects(owner.apply(f.request('issue',{grant:f.bot})),
  /CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(fs.existsSync(f.file),false);
});
test('canonical bot run canceled during owner approval cannot receive grant',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 f.afterApproval(()=>f.setBot(false));
 await assert.rejects(owner.apply(f.request('issue',{grant:f.bot})),
  /CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(fs.existsSync(f.file),false);
 assert.ok(f.counts().checks>=2);
});
test('invalid existing OS grant document never gets overwritten by lifecycle',onUnix,async()=>{
 const f=fixture();
 fs.writeFileSync(f.file,'{"corrupted":"true"}',{mode:0o600});
 assert.throws(()=>f.create(),/Error/);
 assert.equal(fs.readFileSync(f.file,'utf8'),'{"corrupted":"true"}');
});
test('stale generation changed externally during approval cannot be overwritten',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const first=await owner.apply(f.request('issue',{grant:f.human}));
 f.afterApproval(()=>{
  const current=JSON.parse(fs.readFileSync(f.file,'utf8'));
  current.generation='gen-external-owner-change';
  fs.writeFileSync(f.file,JSON.stringify(current),{mode:0o600});
 });
 await assert.rejects(owner.apply(f.request('revoke',{
  expectedGeneration:first.afterGeneration,grantId:f.human.grant_id,
 })),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(owner.list().generation,'gen-external-owner-change');
 assert.ok(f.read(humanFacts));
});
test('missing approval receipt, forged fingerprint, no authority all fail closed',onUnix,async()=>{
 const f=fixture();f.badReceipt();
 await assert.rejects(f.create().apply(f.request('issue',{grant:f.human})),
  /CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(fs.existsSync(f.file),false);
 assert.throws(()=>createCanvasGrantOwnerLifecycle({osRoot:f.root,
  approveNativeOwnerChange:null,verifyCanonicalBotRun:()=>true}),/CANVAS_NATIVE_OWNER_DENIED/);
});
test('oversized/expired lease, invalid fields and wildcard methods rejected',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const variants=[
  {...f.human,expires_at:new Date(Date.now()-1000).toISOString()},
  {...f.human,expires_at:new Date(Date.now()+26*3600*1000).toISOString()},
  {...f.human,methods:['*']},
  {...f.human,methods:['aiverse.canvas.get','aiverse.canvas.get']},
  {...f.human,unknown:'injected'},
  {...f.human,scope:'../other'},
 ];
 for(const grant of variants){
  await assert.rejects(owner.apply(f.request('issue',{grant})),/CANVAS_NATIVE_OWNER_DENIED/);
 }
 assert.equal(fs.existsSync(f.file),false);
});
test('paused workspace blocks issue at OS policy boundary, revoke still possible',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 f.writeStatus('paused');
 await assert.rejects(owner.apply(f.request('issue',{grant:f.bot})),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(f.counts().approvalCount,0);
 f.writeStatus('active');
 const first=await owner.apply(f.request('issue',{grant:f.bot}));
 f.writeStatus('paused');
 const revoked=await owner.apply(f.request('revoke',{
  expectedGeneration:first.afterGeneration,grantId:'grant-bot-1',
 }));
 assert.equal(revoked.grantCount,0);
});
test('ambiguous grant issue fails before any new canonical file revision',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const first=await owner.apply(f.request('issue',{grant:f.human}));
 const before=fs.readFileSync(f.file);
 await assert.rejects(owner.apply(f.request('issue',{
  expectedGeneration:first.afterGeneration,
  grant:{...f.human,grant_id:'grant-human-2'},
 })),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.deepEqual(fs.readFileSync(f.file),before);
});
test('owner refuses locked update, leaves existing grants and lock untouched',onUnix,async()=>{
 const f=fixture(),owner=f.create(),lock=path.join(f.root,'.aiverse/os/canvas-grant-change.lock');
 fs.writeFileSync(lock,'another owner holds lock',{flag:'wx',mode:0o600});
 await assert.rejects(owner.apply(f.request('issue',{grant:f.human})),/CANVAS_NATIVE_OWNER_DENIED/);
 assert.equal(fs.existsSync(lock),true);
 assert.equal(fs.existsSync(f.file),false);
});
test('owner refuses unsafe symlinked owner directory and private file',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const original=path.join(f.root,'.aiverse/os'),moved=path.join(f.root,'.aiverse/elsewhere');
 fs.renameSync(original,moved);fs.symlinkSync(moved,original);
 await assert.rejects(owner.apply(f.request('issue',{grant:f.human})),/Error/);
});
test('explicit revoke-all clears multiple granted scopes without a browser endpoint',onUnix,async()=>{
 const f=fixture(),owner=f.create();
 const first=await owner.apply(f.request('issue',{grant:f.human}));
 const second=await owner.apply(f.request('issue',{
  expectedGeneration:first.afterGeneration,grant:f.bot,
 }));
 const result=await owner.apply(f.request('revoke-all',{
  expectedGeneration:second.afterGeneration,
 }));
 assert.equal(result.grantCount,0);
 assert.equal(f.read(humanFacts),null);
 assert.equal(f.read(botFacts),null);
});
