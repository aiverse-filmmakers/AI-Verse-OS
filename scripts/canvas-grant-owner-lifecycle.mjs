/**
 * Native OS-owner Canvas grant lifecycle, NOT an HTTP/bot command.
 *
 * Every change requires a separately authenticated, single-operation native
 * owner approval callback. The callback comes from the installed OS host,
 * NEVER from request data. A running bot must also pass independent
 * canonical GatewayStore verification before receiving a bot grant.
 *
 * This stage deliberately does not issue destructive-action approvals,
 * authenticate the real Mac owner, validate Windows ACLs or install itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {evaluateActionPermission} from './action-permission.mjs';
import {CANVAS_GRANT_SOURCE,readInstalledCanvasGrantSnapshot,
  validateCanvasGrantDocument} from './canvas-actor-grant.mjs';

export const CANVAS_GRANT_OWNER_SOURCE='ai-verse-os/canvas-owner-change-v1';
const GRANT_METHOD=/^aiverse\.canvas\.(list|get|history|create|rename|edit|duplicate|revert)$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE=/^(operator|[a-z0-9][a-z0-9-]{0,127})$/;
const ERR='CANVAS_NATIVE_OWNER_DENIED';
const fail=reason=>Object.assign(new Error(ERR),{code:ERR,reason});
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value==='object') {
    const out={};for(const k of Object.keys(value).sort())out[k]=stable(value[k]);
    return out;
  }
  return value;
}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const permitted=value=>typeof value==='string'&&ID.test(value);
const expires=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))
  &&new Date(Date.parse(value)).toISOString()===value;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const REQUEST_KEYS=['operation','expectedGeneration','requestId','reason','grant','grantId'];
const BOT_KEYS=['grant_id','actor_kind','actor_id','scope','system_id',
  'principal','run_id','session_id','lease_epoch','expires_at','methods'];
const HUMAN_KEYS=BOT_KEYS.filter(k=>k!=='run_id'&&k!=='session_id');
function validateRequest(req) {
  if (!req||typeof req!=='object'||Array.isArray(req)
    ||Object.keys(req).some(k=>!REQUEST_KEYS.includes(k))) throw fail('request schema');
  if (!['issue','revoke','revoke-all'].includes(req.operation)
    ||!permitted(req.requestId)||!req.reason
    ||typeof req.reason!=='string'||req.reason.length>1000
    ||typeof req.expectedGeneration!=='string'&&req.expectedGeneration!==null
    ||(req.expectedGeneration!==null&&!permitted(req.expectedGeneration)))
    throw fail('request identity');
  if (req.operation==='issue') {
    if(req.grantId!==undefined)throw fail('grantId not allowed');
    const g=req.grant;
    if(!exact(g,g?.actor_kind==='bot'?BOT_KEYS:HUMAN_KEYS)
      ||!permitted(g.grant_id)||!permitted(g.actor_id)
      ||!permitted(g.lease_epoch)||!permitted(g.principal)
      ||!permitted(g.system_id)||!WORKSPACE.test(g.scope)
      ||!expires(g.expires_at)||!Array.isArray(g.methods)
      ||!g.methods.length||g.methods.length>8
      ||g.methods.some(m=>typeof m!=='string'||!GRANT_METHOD.test(m))
      ||new Set(g.methods).size!==g.methods.length)
      throw fail('unsafe grant');
    if(g.actor_kind!=='human'&&g.actor_kind!=='bot')throw fail('actor kind');
    if(g.actor_kind==='bot'){
      if(!permitted(g.run_id)||!permitted(g.session_id)
        ||g.methods.includes('aiverse.canvas.revert'))throw fail('bot scope');
    }
    const ttl=Date.parse(g.expires_at)-Date.now();
    if(ttl<=0||ttl>24*3600*1000)throw fail('expired/oversized lease');
  }else{
    if(req.grant!==undefined|| (req.operation==='revoke'
      ?!permitted(req.grantId):req.grantId!==undefined))
      throw fail('revocation target');
  }
  return req;
}
function checkOwnerScope(root,scope) {
  const result=evaluateActionPermission({osRoot:root,request:{
    action_class:'read_local',scope:scope==='operator'?'operator':'workspace:'+scope,
    request_fingerprint:'0'.repeat(64),
  }});
  if(result.decision!=='allow')throw fail('inactive scope');
}
/**
 * Owner lifecycle adapter. The native host, not Dashboard/browser, injects
 * independently authenticated owner approval and live bot-run verification.
 */
export function createCanvasGrantOwnerLifecycle({
  osRoot,approveNativeOwnerChange,verifyCanonicalBotRun,
}){
  if(process.platform==='win32')throw fail('Windows ACL admission not implemented');
  if(typeof approveNativeOwnerChange!=='function'
    ||typeof verifyCanonicalBotRun!=='function')throw fail('missing native authority');
  // Root must already be real and OS setup must already own private directories.
  const initial=readInstalledCanvasGrantSnapshot(osRoot);
  const root=initial.root;
  const expectedOwner=fs.statSync(root).uid;
  if(expectedOwner!==process.getuid())throw fail('foreign OS owner');
  const snapshot=()=>{
    const current=readInstalledCanvasGrantSnapshot(root);
    if(current.root!==root||fs.statSync(current.root).uid!==expectedOwner)
      throw fail('OS root rebound');
    return current;
  };
  const list=()=> {
    const current=snapshot().document;
    return Object.freeze({provisioned:current!==null,
      generation:current?.generation??null,
      // Read-only owner status: no token, file path or trusted session exposed.
      grants:current?.grants.map(g=>({
        grantId:g.grant_id,actorKind:g.actor_kind,scope:g.scope,
        expiresAt:g.expires_at,methods:[...g.methods],
      }))??[]});
  };
  const apply=async request=>{
    // Immutable value snapshot: an asynchronous native approval must never
    // approve one permission set and later write a caller-mutated grant.
    const req=validateRequest(structuredClone(request));
    if(req.grant){
      Object.freeze(req.grant.methods);
      Object.freeze(req.grant);
    }
    Object.freeze(req);
    const before=snapshot();
    const beforeGen=before.document?.generation??null;
    if(req.expectedGeneration!==beforeGen)throw fail('stale generation');
    if(req.operation==='issue'){
      checkOwnerScope(root,req.grant.scope);
      if(req.grant.actor_kind==='bot'){
        const active=await verifyCanonicalBotRun({
          runId:req.grant.run_id,sessionId:req.grant.session_id,
          systemId:req.grant.system_id,workspaceId:req.grant.scope,
          principal:req.grant.principal,actorId:req.grant.actor_id,
        });
        if(active!==true)throw fail('unverified running bot');
      }
    }
    // Native approval UI can render the exact human-readable permission
    // changes, rather than demanding approval of an opaque hash alone.
    const displayedScope=req.operation==='issue'
      ?req.grant.scope:req.operation==='revoke'
        ?before.document?.grants.find(g=>g.grant_id===req.grantId)?.scope??null
        :'all-scopes';
    const displayedGrant=req.operation==='issue'
      ?{grantId:req.grant.grant_id,actorKind:req.grant.actor_kind,
        actorId:req.grant.actor_id,scope:req.grant.scope,
        methods:[...req.grant.methods],expiresAt:req.grant.expires_at}
      :req.operation==='revoke'?{grantId:req.grantId}:null;
    const permissionChange=Object.freeze({
      operation:req.operation,scope:displayedScope,grant:displayedGrant,
      priorGeneration:beforeGen,reason:req.reason,
    });
    const fingerprint=hash({root,request:req});
    const approval=await approveNativeOwnerChange({
      source:CANVAS_GRANT_OWNER_SOURCE,osRoot:root,
      requestId:req.requestId,operation:req.operation,
      requestFingerprint:fingerprint,reason:req.reason,
      permissionChange,
    });
    if(!approval||approval.source!==CANVAS_GRANT_OWNER_SOURCE
      ||approval.approved!==true||approval.requestFingerprint!==fingerprint
      ||!permitted(approval.ownerId)||!permitted(approval.sessionId)
      ||!expires(approval.expiresAt)||Date.parse(approval.expiresAt)<=Date.now()
      ||Date.parse(approval.expiresAt)-Date.now()>300_000)
      throw fail('missing or expired independent owner approval');
    // Repeat expiry at the final effect edge; approval must not outlive a
    // slow owner dialog, file lock wait, or native callback.

    const lock=path.join(before.parent,'canvas-grant-change.lock');
    let fd;
    try{fd=fs.openSync(lock,fs.constants.O_CREAT|fs.constants.O_EXCL
      |fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0),0o600);}
    catch{throw fail('concurrent owner update');}
    let temp=null;
    try{
      const now=snapshot();
      if((now.document?.generation??null)!==req.expectedGeneration)
        throw fail('stale generation after approval');
      if(req.operation==='issue') {
        checkOwnerScope(root,req.grant.scope);
        // A slow approval must not create a grant that expired while the
        // human was reviewing the exact operation.
        if(Date.parse(req.grant.expires_at)<=Date.now())
          throw fail('target grant expired before effect');
        if(req.grant.actor_kind==='bot') {
          // No admission from old proof while bot run stops during owner UI.
          if(await verifyCanonicalBotRun({
            runId:req.grant.run_id,sessionId:req.grant.session_id,
            systemId:req.grant.system_id,workspaceId:req.grant.scope,
            principal:req.grant.principal,actorId:req.grant.actor_id,
          })!==true)throw fail('stale bot run');
        }
      }
      let grants=now.document?.grants??[];
      if(req.operation==='issue'){
        if(grants.some(g=>g.grant_id===req.grant.grant_id
          ||(g.actor_kind===req.grant.actor_kind
            &&g.actor_id===req.grant.actor_id
            &&g.scope===req.grant.scope&&g.principal===req.grant.principal
            &&g.methods.some(m=>req.grant.methods.includes(m)))))
          throw fail('duplicate/ambiguous admission');
        grants=[...grants,req.grant];
      }else if(req.operation==='revoke'){
        if(!grants.some(g=>g.grant_id===req.grantId))throw fail('unknown grant');
        grants=grants.filter(g=>g.grant_id!==req.grantId);
      }else{
        if(grants.length===0)throw fail('already empty');
        grants=[];
      }
      const afterGen='gen-'+crypto.randomUUID();
      const next=validateCanvasGrantDocument({
        format:CANVAS_GRANT_SOURCE,schema_version:1,generation:afterGen,grants,
      });
      if(Date.parse(approval.expiresAt)<=Date.now())
        throw fail('approval expired before effect');
      // Durably write a new owner-private file, then atomic rename. Never
      // overwrite through a symlink or create a directory at an HTTP path.
      temp=path.join(now.parent,'canvas-grants-'+crypto.randomUUID()+'.tmp');
      const tmpfd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT
        |fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);
      try{fs.writeFileSync(tmpfd,JSON.stringify(next),'utf8');fs.fsyncSync(tmpfd);}
      finally{fs.closeSync(tmpfd);}
      const check=snapshot();
      if((check.document?.generation??null)!==req.expectedGeneration)
        throw fail('concurrent grant file change');
      fs.renameSync(temp,now.file);temp=null;
      const dirfd=fs.openSync(now.parent,fs.constants.O_RDONLY);
      try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
      const stored=snapshot().document;
      if(stored.generation!==afterGen)throw fail('grant commit verification');
      return Object.freeze({
        source:CANVAS_GRANT_OWNER_SOURCE,requestId:req.requestId,
        operation:req.operation,ownerId:approval.ownerId,
        beforeGeneration:beforeGen,afterGeneration:afterGen,
        affectedGrantId:req.grant?.grant_id??req.grantId??null,
        grantCount:stored.grants.length,requestFingerprint:fingerprint,
        // This is a native in-process change receipt, not tamper-proof audit.
      });
    }finally{
      if(temp)try{fs.unlinkSync(temp);}catch{}
      fs.closeSync(fd);
      try{fs.unlinkSync(lock);}catch{}
    }
  };
  return Object.freeze({list,apply});
}
