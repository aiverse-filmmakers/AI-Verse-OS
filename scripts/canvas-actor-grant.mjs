/**
 * Read-only OS owner Canvas actor grant verification contract.
 *
 * No grant issuing, cookie checks, HTTP endpoints, auto-provisioning, or
 * policy bypass. The native owner installs a bounded file explicitly and
 * independently authenticates the caller/session. Fails closed if absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import {evaluateActionPermission} from './action-permission.mjs';

export const CANVAS_GRANT_SOURCE = 'ai-verse-os/canvas-actor-grants-v1';
export const CANVAS_GRANT_RELATIVE = '.aiverse/os/canvas-actor-grants.json';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE = /^(operator|[a-z0-9][a-z0-9-]{0,127})$/;
const UUID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METHOD = /^aiverse\.canvas\.(list|get|history|create|rename|edit|duplicate|revert|delete)$/;
const MAX_BYTES = 128 * 1024;
const MAX_GRANTS = 128;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const KEYS = new Set(['format','schema_version','generation','grants']);
const GRANT_KEYS = new Set(['grant_id','actor_kind','actor_id','scope',
  'system_id','principal','run_id','session_id','lease_epoch','expires_at','methods']);
const FACT_KEYS = new Set(['systemId','workspaceId','principal','actorKind',
  'method','runId','sessionId','actorId','now']);
const exact = (value, expected) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === expected.size
  && Object.keys(value).every(k => expected.has(k));
const safe = value => typeof value === 'string' && ID.test(value);
const epoch = text => typeof text === 'string' && text.length > 0
  && Number.isFinite(Date.parse(text)) && new Date(Date.parse(text)).toISOString() === text;
const deny = () => null;

function rootOf(osRoot) {
  if (typeof osRoot !== 'string' || !osRoot || osRoot.includes('\0')) throw Error('invalid root');
  const abs = path.resolve(osRoot);
  const root = fs.realpathSync(abs);
  if (!fs.lstatSync(abs).isDirectory() || !fs.lstatSync(root).isDirectory()) throw Error('unsafe root');
  const manifest = path.join(root,'AI-VERSE.yaml');
  const stat = fs.lstatSync(manifest);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 128 * 1024) throw Error('missing OS manifest');
  const top = fs.readFileSync(manifest,'utf8');
  if (!/^schema_version:\s*["']?2\./m.test(top) || !/^architecture:\s*unified-workspace/m.test(top))
    throw Error('incompatible OS manifest');
  for (const segment of ['operator','workspaces']) {
    if (!fs.lstatSync(path.join(root,segment)).isDirectory()) throw Error('incomplete OS root');
  }
  return root;
}
function pathOf(root) {
  const parts = CANVAS_GRANT_RELATIVE.split('/');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw Error('symlink grant path');
    if (part !== parts[parts.length - 1] && !stat.isDirectory())
      throw Error('unsafe grant parent');
  }
  return current;
}
function readDocument(root) {
  const file = pathOf(root);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file,flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 3 || stat.size > MAX_BYTES)
      throw Error('invalid grant file');
    // Unix permissions protect the local owner's explicit grant file.
    // Windows ACL admission remains an installation approval gate.
    if (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
      throw Error('grant must be owner-private');
    const raw = fs.readFileSync(fd,{encoding:'utf8'});
    if (Buffer.byteLength(raw,'utf8') > MAX_BYTES) throw Error('oversize');
    const doc = JSON.parse(raw);
    if (!exact(doc,KEYS) || doc.format !== CANVAS_GRANT_SOURCE
      || doc.schema_version !== 1 || !safe(doc.generation)
      || !Array.isArray(doc.grants) || doc.grants.length > MAX_GRANTS)
      throw Error('invalid grant schema');
    const ids = new Set();
    for (const g of doc.grants) {
      const fields = g?.actor_kind === 'bot' ? GRANT_KEYS :
        new Set([...GRANT_KEYS].filter(x => x !== 'run_id' && x !== 'session_id'));
      if (!exact(g,fields) || !safe(g.grant_id) || !safe(g.actor_id)
        || !safe(g.lease_epoch) || !safe(g.principal)
        || !WORKSPACE.test(g.scope) || !UUID.test(g.system_id)
        || !['human','bot'].includes(g.actor_kind)
        || !epoch(g.expires_at) || !Array.isArray(g.methods)
        || g.methods.length < 1 || g.methods.length > 9
        || g.methods.some(m => typeof m !== 'string' || !METHOD.test(m))
        || new Set(g.methods).size !== g.methods.length
        || (g.actor_kind === 'bot' && (!safe(g.run_id) || !safe(g.session_id)))
        || ids.has(g.grant_id))
        throw Error('invalid grant entry');
      ids.add(g.grant_id);
    }
    return doc;
  } finally { fs.closeSync(fd); }
}
/** A fresh read every time. No request-supplied paths, grants or authority. */
export function verifyInstalledCanvasGrant({osRoot,facts}) {
  try {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)
      || Object.keys(facts).some(k => !FACT_KEYS.has(k))
      || !UUID.test(facts.systemId) || !WORKSPACE.test(facts.workspaceId)
      || !safe(facts.principal) || !METHOD.test(facts.method)
      || !['human','bot'].includes(facts.actorKind)
      || (facts.actorId !== undefined && !safe(facts.actorId)))
      return deny();
    if (facts.actorKind === 'bot' &&
      (!safe(facts.runId) || !safe(facts.sessionId))) return deny();
    if (facts.actorKind === 'human' &&
      (facts.runId !== undefined || facts.sessionId !== undefined)) return deny();
    const now = facts.now === undefined ? Date.now() : facts.now;
    if (!Number.isSafeInteger(now) || now < 0) return deny();
    const root = rootOf(osRoot);
    // Reuse the existing OS evaluator's exact workspace manifest logic,
    // not a duplicate YAML parser or a browser-provided workspace status.
    const policy = evaluateActionPermission({osRoot:root,request:{
      action_class:'read_local',
      scope:facts.workspaceId==='operator'?'operator':'workspace:'+facts.workspaceId,
      request_fingerprint:'0'.repeat(64),
    }});
    if (policy.decision !== 'allow') return deny();
    const doc = readDocument(root);
    const matches = doc.grants.filter(g =>
      g.actor_kind === facts.actorKind && g.system_id === facts.systemId
      && g.scope === facts.workspaceId && g.principal === facts.principal
      && (facts.actorId === undefined || facts.actorId === g.actor_id)
      && g.methods.includes(facts.method)
      && (g.actor_kind === 'human' ||
        (g.run_id === facts.runId && g.session_id === facts.sessionId))
      && Date.parse(g.expires_at) > now
      && Date.parse(g.expires_at) - now <= MAX_LEASE_MS);
    if (matches.length !== 1) return deny(); // ambiguity = deny
    const grant = matches[0];
    return Object.freeze({
      source:CANVAS_GRANT_SOURCE,
      actorKind:grant.actor_kind, actorId:grant.actor_id,
      leaseEpoch:doc.generation + ':' + grant.lease_epoch,
      systemId:grant.system_id, workspaceId:grant.scope,
      principal:grant.principal, method:facts.method,
      ...(grant.actor_kind === 'bot'
        ? {runId:grant.run_id,sessionId:grant.session_id}:{}),
    });
  } catch { return deny(); }
}
