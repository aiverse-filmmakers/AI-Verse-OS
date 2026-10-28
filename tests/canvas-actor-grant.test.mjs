import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CANVAS_GRANT_SOURCE, CANVAS_GRANT_RELATIVE,verifyInstalledCanvasGrant} from '../scripts/canvas-actor-grant.mjs';

const roots=[];
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
const now=Date.now();
const expiry=new Date(now+15*60*1000).toISOString();
const human={
 grant_id:'grant-human-1',actor_kind:'human',actor_id:'operator-1',
 scope:'operator',system_id:'aiverse-1',principal:'os-session-1',
 lease_epoch:'human-epoch-1',expires_at:expiry,
 methods:['aiverse.canvas.get','aiverse.canvas.create','aiverse.canvas.edit'],
};
const bot={
 grant_id:'grant-bot-1',actor_kind:'bot',actor_id:'film-bot',
 scope:'film',system_id:'aiverse-1',principal:'gateway-operator',
 run_id:'run-1',session_id:'session-1',
 lease_epoch:'bot-epoch-1',expires_at:expiry,
 methods:['aiverse.canvas.get','aiverse.canvas.edit'],
};
const facts={
 human:{systemId:'aiverse-1',workspaceId:'operator',principal:'os-session-1',
   method:'aiverse.canvas.edit',actorKind:'human'},
 bot:{systemId:'aiverse-1',workspaceId:'film',principal:'gateway-operator',
   method:'aiverse.canvas.edit',actorKind:'bot',runId:'run-1',sessionId:'session-1'},
};
function fixture(grants=[human,bot]){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aiverse-os-grants-'));roots.push(root);
 fs.mkdirSync(path.join(root,'operator'));
 fs.mkdirSync(path.join(root,'workspaces'));
 fs.writeFileSync(path.join(root,'AI-VERSE.yaml'),
   'schema_version: "2.0"\narchitecture: unified-workspace\n');
 const file=path.join(root,CANVAS_GRANT_RELATIVE);
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const save=(items=grants,extra={})=>{
   fs.writeFileSync(file,JSON.stringify({format:CANVAS_GRANT_SOURCE,
     schema_version:1,generation:'gen-1',grants:items,...extra}),{mode:0o600});
   if(process.platform!=='win32')fs.chmodSync(file,0o600);
 };
 save();
 const verify=(input,osRoot=root)=>verifyInstalledCanvasGrant({osRoot,facts:input});
 return {root,file,save,verify};
}
test('no grant document is denial, never creates a file',()=>{
 const x=fixture();fs.unlinkSync(x.file);
 assert.equal(x.verify(facts.human),null);
 assert.equal(fs.existsSync(x.file),false);
});
test('exact scoped native human grant yields bound projection; browser label alone does not',()=>{
 const x=fixture(),grant=x.verify(facts.human);
 assert.equal(grant.source,CANVAS_GRANT_SOURCE);
 assert.equal(grant.actorId,'operator-1');
 assert.equal(grant.leaseEpoch,'gen-1:human-epoch-1');
 assert.equal(x.verify({...facts.human,principal:'local-operator'}),null);
 assert.equal(x.verify({...facts.human,workspaceId:'film'}),null);
 assert.equal(x.verify({...facts.human,systemId:'another-1'}),null);
 assert.equal(x.verify({...facts.human,method:'aiverse.canvas.delete'}),null);
 assert.equal(x.verify({...facts.human,actorId:'someone-else'}),null);
});
test('bot is bound to independently confirmed run, session, principal, workspace and method',()=>{
 const x=fixture(),g=x.verify(facts.bot);
 assert.equal(g.actorId,'film-bot');
 assert.equal(g.runId,'run-1');
 assert.equal(g.sessionId,'session-1');
 for(const [field,value] of Object.entries({runId:'run-2',sessionId:'session-2',
  principal:'wrong-principal',workspaceId:'operator',method:'aiverse.canvas.delete',
  actorId:'other-bot',actorKind:'human'}))
   assert.equal(x.verify({...facts.bot,[field]:value}),null,field);
});
test('direct revocation, generation rollover, expiry and future oversized lease all deny',()=>{
 const x=fixture();
 assert.ok(x.verify(facts.bot));
 x.save([human]);
 assert.equal(x.verify(facts.bot),null);
 x.save([human,bot],{generation:'gen-2'});
 assert.equal(x.verify(facts.bot).leaseEpoch,'gen-2:bot-epoch-1');
 x.save([human,{...bot,expires_at:new Date(now-1000).toISOString()}]);
 assert.equal(x.verify(facts.bot),null);
 x.save([human,{...bot,expires_at:new Date(now+25*60*60*1000).toISOString()}]);
 assert.equal(x.verify(facts.bot),null);
});
test('ambiguous, malformed, extra-field and spoofed-issuer grants fail closed',()=>{
 const x=fixture();
 x.save([human,{...human,grant_id:'grant-2'}]);
 assert.equal(x.verify(facts.human),null);
 x.save([human,bot],{issuer:'unknown'});
 assert.equal(x.verify(facts.human),null);
 x.save([human,bot],{format:'forged-grants'});
 assert.equal(x.verify(facts.human),null);
 x.save([{...human,actor_id:'bad/actor'},bot]);
 assert.equal(x.verify(facts.bot),null,'reject entire invalid owner file');
 x.save([{...human,methods:['aiverse.canvas.get','aiverse.canvas.get']},bot]);
 assert.equal(x.verify(facts.bot),null);
});
test('no user-controlled path, grant or approval fields in verification facts',()=>{
 const x=fixture();
 assert.equal(x.verify({...facts.human,osRoot:x.root}),null);
 assert.equal(x.verify({...facts.human,approval:'allowed'}),null);
 assert.equal(x.verify({...facts.bot,grant:bot}),null);
});
test('reject unsafe symlinked grant files or parents', {skip:process.platform==='win32'},()=>{
 const x=fixture();const target=path.join(x.root,'outside.json');
 fs.renameSync(x.file,target);fs.symlinkSync(target,x.file);
 assert.equal(x.verify(facts.human),null);
 fs.unlinkSync(x.file);fs.renameSync(target,x.file);
 fs.renameSync(path.dirname(x.file),path.join(x.root,'unsafe-real'));
 fs.symlinkSync(path.join(x.root,'unsafe-real'),path.dirname(x.file));
 assert.equal(x.verify(facts.human),null);
});
test('reject world-readable grant file', {skip:process.platform==='win32'},()=>{
 const x=fixture();fs.chmodSync(x.file,0o644);
 assert.equal(x.verify(facts.human),null);
});
test('reject unrelated and outdated OS root manifests',()=>{
 const x=fixture(),m=path.join(x.root,'AI-VERSE.yaml');
 fs.writeFileSync(m,'schema_version: "1.0"\narchitecture: other\n');
 assert.equal(x.verify(facts.human),null);
});
