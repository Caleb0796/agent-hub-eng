import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { G0Store } from './store.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'hub-g0-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const s=new G0Store(join(dir,'relay'));const ep=(role,cmd,input)=>{const r=spawnSync(resolve('.venv-g0/bin/python'),['g0/endpoint.py',join(dir,role),role,cmd],{encoding:'utf8',input:JSON.stringify(input)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)};const reg={};for(const role of ['dot','duet']){reg[role]=ep(role,'register');s.send(role,{text:JSON.stringify(reg[role]),idempotency_key:'reg'});}const claim=role=>s.claim({role,claim_id:s.data.registrations[role].id,expected_fingerprint:reg[role].fingerprint});const pin=role=>{const peer=role==='dot'?'duet':'dot';ep(role,'pin',{public:reg[peer].payload,fingerprint:reg[peer].fingerprint})};return {s,ep,claim,pin,reg,dir}}
test('claim, relay ciphertext, restart, decrypt and replay denial',t=>{const {s,ep,claim,pin,reg,dir}=setup(t);assert.throws(()=>s.inbox('dot'),/claim/);assert.throws(()=>s.claim({role:'dot',claim_id:s.data.registrations.dot.id,expected_fingerprint:'wrong'}),/mismatch/);claim('dot');claim('duet');assert.throws(()=>claim('dot'),/already/);pin('dot');pin('duet');const env=ep('dot','seal',{text:'secret sentinel 123',run:s.data.run_id,idempotency_key:'first'});const send=()=>s.send('dot',{text:JSON.stringify(env),idempotency_key:'first'});send();assert.equal(send().idempotent,true);const restarted=new G0Store(join(dir,'relay'));const received=restarted.inbox('duet').messages[0].envelope;assert.equal(ep('duet','open',{env:received,run:s.data.run_id}).text,'secret sentinel 123');assert.ok(!JSON.stringify(restarted.data).includes('secret sentinel'));assert.ok(!JSON.stringify(restarted.data).includes('AGE-SECRET-KEY'));const bad=structuredClone(env);bad.payload.to='dot';assert.throws(()=>s.send('dot',{text:JSON.stringify(bad),idempotency_key:'bad'}),/Routing/);s.revoke();assert.throws(send,/closed/)});
test('unclaimed send, agent approval, key change and expired claim denied',t=>{const {s,ep,claim,pin,reg}=setup(t);pin('dot');const env=ep('dot','seal',{text:'test',run:s.data.run_id});assert.throws(()=>s.send('dot',{text:JSON.stringify(env),idempotency_key:'x'}),/owners/);assert.throws(()=>s.send('dot',{text:'plaintext',idempotency_key:'p'}),/plaintext/);assert.throws(()=>s.send('dot',{text:'{"g0":1,"op":"claim"}',idempotency_key:'c'}),/cannot approve/);const copy=structuredClone(reg.dot);copy.payload.age=reg.duet.payload.age;assert.throws(()=>s.send('dot',{text:JSON.stringify(copy),idempotency_key:'reg'}),/Signature/);s.now=()=>Date.now()+31*60_000;assert.throws(()=>claim('dot'),/expired/)});
import { startServers } from '../src/server.mjs';
import { BridgeStore } from '../src/store.mjs';
test('public listener cannot reach owner controls; MCP role and browser origin enforced',async t=>{
  const {s,dir}=setup(t);const auth=new BridgeStore(join(dir,'auth'));s.authenticate=token=>auth.authenticate(token);s.connectionTokens=auth.data.tokens;
  const live=await startServers({directory:dir,storeOverride:s,port:0,adminPort:0});t.after(()=>live.stop());
  const base=`http://127.0.0.1:${live.port}`,owner=`http://127.0.0.1:${live.adminPort}`;
  assert.equal((await fetch(base+'/api/g0/status')).status,404);
  assert.equal((await fetch(base+'/api/g0/claim',{method:'POST'})).status,404);
  assert.equal((await fetch(owner+'/api/g0/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(owner+'/api/g0/status',{headers:{Origin:'https://evil.example'}})).status,403);
  const call={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_identity',arguments:{}}};
  const headers={'Content-Type':'application/json','mcp-protocol-version':'2026-07-28'};
  assert.equal((await fetch(base+'/mcp/'+auth.data.tokens.dot,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(call)})).status,403);
  const r=await fetch(base+'/mcp/'+auth.data.tokens.dot,{method:'POST',headers,body:JSON.stringify(call)}).then(r=>r.json());
  assert.equal(r.result.structuredContent.your_role,'dot');assert.equal(r.result.structuredContent.mode,'agent_hub_g0');
  const viaBearer=await fetch(base+'/mcp',{method:'POST',headers:{...headers,Authorization:'Bearer '+auth.data.tokens.duet},body:JSON.stringify(call)}).then(r=>r.json());
  assert.equal(viaBearer.result.structuredContent.your_role,'duet');
  assert.equal((await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify(call)})).status,404);
  const spec=await fetch(base+'/g0/connect.json').then(r=>r.json());assert.equal(spec.authentication.type,'api_key');assert.ok(!JSON.stringify(spec).includes(auth.data.tokens.dot));
});
test('Dot–Muse pair has independent role routing and rejects Duet', t=>{
 const dir=mkdtempSync(join(tmpdir(),'hub-muse-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const s=new G0Store(join(dir,'relay'),{participants:['dot','muse'],maxMessages:2});const ep=(role,cmd,input)=>{const r=spawnSync(resolve('.venv-g0/bin/python'),['g0/endpoint.py',join(dir,role),role,cmd],{encoding:'utf8',input:JSON.stringify(input)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)};
 const regs={};for(const role of ['dot','muse']){regs[role]=ep(role,'register');s.send(role,{text:JSON.stringify(regs[role]),idempotency_key:'register'});s.claim({role,claim_id:s.data.registrations[role].id,expected_fingerprint:regs[role].fingerprint})}
 assert.throws(()=>s.identity('duet'),/closed/);assert.equal(s.identity('muse').peer,'dot');assert.equal(s.identity('dot').peer,'muse');
 ep('dot','pin',{public:regs.muse.payload,fingerprint:regs.muse.fingerprint});ep('muse','pin',{public:regs.dot.payload,fingerprint:regs.dot.fingerprint});
 const env=ep('dot','seal',{text:'dedicated Muse test',run:s.data.run_id,to:'muse'});s.send('dot',{text:JSON.stringify(env),idempotency_key:'one'});
 assert.equal(ep('muse','open',{env:s.inbox('muse').messages[0].envelope,run:s.data.run_id}).text,'dedicated Muse test');
 const reply=ep('muse','seal',{text:'reply',run:s.data.run_id,to:'dot',reply_to:env.payload.id});s.send('muse',{text:JSON.stringify(reply),idempotency_key:'two'});
 const extra=ep('dot','seal',{text:'third',run:s.data.run_id,to:'muse'});assert.throws(()=>s.send('dot',{text:JSON.stringify(extra),idempotency_key:'three'}),/limit/);
 assert.throws(()=>new G0Store(join(dir,'relay')),/different participants/);
 const restart=new G0Store(join(dir,'relay'),{participants:['dot','muse']});assert.equal(restart.status().message_count,2);assert.equal(restart.status().max_messages,2);
});
