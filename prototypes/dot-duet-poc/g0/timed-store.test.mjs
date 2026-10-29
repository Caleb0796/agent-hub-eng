import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {TimedG0Store} from './timed-store.mjs';
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'hub-timed-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let now=Date.now();
 const s=new TimedG0Store(join(dir,'relay'),{now:()=>now});
 const ep=(role,command,input)=>{const r=spawnSync(resolve('.venv-g0/bin/python'),['g0/endpoint.py',join(dir,role),role,command],{encoding:'utf8',input:JSON.stringify(input)});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)};
 const registrations={};for(const role of ['dot','muse']){registrations[role]=ep(role,'register');s.send(role,{text:JSON.stringify(registrations[role]),idempotency_key:'reg'});s.claim({role,claim_id:s.data.registrations[role].id,expected_fingerprint:registrations[role].fingerprint})}
 for(const role of ['dot','muse']){const peer=role==='dot'?'muse':'dot';ep(role,'pin',{public:registrations[peer].payload,fingerprint:registrations[peer].fingerprint})}
 const seal=(role,key,reply_to=null)=>ep(role,'seal',{text:'synthetic timed test '+key,run:s.data.run_id,to:role==='dot'?'muse':'dot',reply_to,idempotency_key:key});
 const send=(role,env,key)=>s.send(role,{text:JSON.stringify(env),idempotency_key:key});
 return {s,seal,send,dir,registrations,advance:ms=>now+=ms,now:()=>now};
}
test('ten minute clock starts at first ciphertext, cannot be extended, cutoff rejects sends but permits receipt reads',t=>{
 const {s,seal,send,advance,now}=setup(t);const first=seal('dot','first');assert.throws(()=>send('dot',first,'first'),/not armed/);
 s.startConversation();advance(10000);assert.equal(s.status().conversation.deadline,null);send('dot',first,'first');const began=now();
 assert.equal(Date.parse(s.status().conversation.deadline),began+600000);assert.throws(()=>s.startConversation(),/cannot be extended/);
 assert.equal(send('dot',first,'first').idempotent,true);
 const second=seal('muse','second',first.payload.id);advance(599999);send('muse',second,'second');advance(1);
 assert.equal(s.status().conversation_closed,true);assert.throws(()=>send('dot',seal('dot','late',second.payload.id),'late'),/closed/);
 assert.equal(s.inbox('dot').messages.length,1);assert.equal(s.inbox('dot').conversation_closed,true);
});
test('opening role, alternation, latest reply reference and message cap enforced',t=>{
 const {s,seal,send}=setup(t);s.startConversation(600,2);
 assert.throws(()=>send('muse',seal('muse','wrong-open'),'wrong-open'),/Dot must open/);
 const a=seal('dot','a');send('dot',a,'a');assert.throws(()=>send('dot',seal('dot','again'),'again'),/Alternate/);
 assert.throws(()=>send('muse',seal('muse','wrong-reply'),'wrong-reply'),/latest peer/);
 const b=seal('muse','b',a.payload.id);send('muse',b,'b');assert.equal(s.status().conversation_closed,true);
 assert.throws(()=>send('dot',seal('dot','c',b.payload.id),'c'),/closed/);
});
test('armed but never started experiment expires; persisted first message recovers original deadline',t=>{
 const a=setup(t);a.s.startConversation();a.advance(180000);assert.equal(a.s.status().conversation_closed,true);assert.throws(()=>a.send('dot',a.seal('dot','late-open'),'late-open'),/closed/);
 const b=setup(t);b.s.startConversation();b.send('dot',b.seal('dot','first'),'first');const deadline=b.s.data.conversation.deadline;
 b.s.data.conversation.started_at=null;b.s.data.conversation.deadline=null;writeFileSync(b.s.file,JSON.stringify(b.s.data));
 const restarted=new TimedG0Store(join(b.dir,'relay'),{now:b.now});assert.equal(restarted.data.conversation.deadline,deadline);
});
test('task-scoped session cannot arm before both authenticated client reconfirmations',t=>{
 const {s,registrations}=setup(t);s.data.require_reconfirmation=true;
 assert.throws(()=>s.startConversation(),/preflight/);
 s.send('dot',{text:JSON.stringify(registrations.dot),idempotency_key:'reconfirm-dot'});
 assert.throws(()=>s.startConversation(),/preflight/);
 s.send('muse',{text:JSON.stringify(registrations.muse),idempotency_key:'reconfirm-muse'});
 assert.equal(s.startConversation().conversation.duration_seconds,600);
});
