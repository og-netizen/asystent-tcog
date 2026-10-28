import test from 'node:test';import assert from 'node:assert/strict';import {comparePlans,compareOperations} from './plan-changes.mjs';
const p={client_key:'client',truck_registration:'ABC123',main_reference:'REF123',driver_message:'Plan',stops:[{operation:'LOADING',address:'A',date:'2026-10-28',reference:'LOAD123',cargo:'10 palet'},{operation:'UNLOADING',address:'B',date:'2026-10-29',reference:null,cargo:'10 palet'}]};
test('compares date, location, quantity and references without mutating original',()=>{const c=structuredClone(p);c.stops[1].date='2026-10-30';c.stops[1].address='C';c.stops[1].cargo='12 palet';c.stops[1].reference='NEW123';const r=comparePlans(p,c);assert.deepEqual(r.changes.map(x=>x.field),['address','date','reference','cargo']);assert.equal(p.stops[1].address,'B');assert.equal(r.external_writes,false);});
test('inserted or reordered operations compare whole sequence',()=>{const c=structuredClone(p);c.stops.unshift({operation:'ATTACH_SEMITRAILER',address:'Port'});assert.deepEqual(comparePlans(p,c).changes.map(x=>x.field),['stop_sequence']);});
test('different customer, truck or main reference requires context',()=>{const c={...p,truck_registration:'OTHER',main_reference:'OTHER',client_key:'other'};assert.equal(comparePlans(p,c).status,'NEEDS_CONTEXT');assert.equal(comparePlans(p,p).status,'UNCHANGED');});
test('rejects unrelated threads and reversed chronology',async()=>{let different=true;const store={modelOperation:async(t,id)=>({state:'DONE',payload:{task_id:id,draft:p}}),agentTask:async(t,id)=>({source:{thread_id:different?id:'same',mailbox:'self',received_at:id==='old'?'2026-10-29':'2026-10-28'}})};await assert.rejects(compareOperations(store,'tenant','old','new'),/unrelated/);different=false;await assert.rejects(compareOperations(store,'tenant','old','new'),/chronology/);});

import {createMemoryStateStore,createPostgresStateStore} from './state-store.mjs';import {PGlite} from '@electric-sql/pglite';import {createOperatorMailer} from './agent-mail.mjs';
for(const kind of ['memory','postgres'])test(`${kind}: predecessor lookup excludes newer messages`,async()=>{
 const db=kind==='postgres'?new PGlite():null,s=db?createPostgresStateStore(db):createMemoryStateStore();await s.initialize();
 for(const [id,date]of [['old','2026-10-27T00:00:00Z'],['new','2026-10-29T00:00:00Z']])await s.agentEnqueue('A',{id,source:{thread_id:'same',mailbox:'self',received_at:date}});
 assert.equal((await s.agentThread('A','same','middle','self','2026-10-28T00:00:00Z')).id,'old');assert.equal((await s.agentThread('A','same','middle','self')).id,'new');await s.close();if(db)await db.close();
});
test('changed proposal requires baseline before email and includes differences',async()=>{
 const s=createMemoryStateStore();let calls=0,raw;
 const old='a'.repeat(64),current='b'.repeat(64);
 for(const [id,date,changed]of [[old,'2026-10-27T00:00:00Z',false],[current,'2026-10-28T00:00:00Z',true]]){
  await s.agentEnqueue('A',{id,possible_plan_change:changed,source:{mailbox:'og@tcog.pl',message_id:changed?'bb':'aa',thread_id:'same',received_at:date}});
  const d=structuredClone(p);if(changed)d.stops[1].date='2026-10-30';await s.modelReserve('A',id,'2026-10-28',10,{});await s.modelFinish('A',id,'DONE',{task_id:id,draft:d});
 }
 const mail=createOperatorMailer(s,{sendOperator:async r=>{calls++;raw=r;return {id:'cc',threadId:'dd'};}},'A');assert.equal((await mail.sendDraft(current)).reason,'previous_proposal_required');assert.equal(calls,0);assert.equal(await s.operatorMailGet('A',current),undefined);
 assert.equal((await mail.sendDraft(current,old)).sent,true);const mime=Buffer.from(raw,'base64url').toString();const body=Buffer.from(mime.split('\r\n\r\n')[1].replace(/\s/g,''),'base64').toString();assert.match(body,/2026-10-29.*2026-10-30/);assert.equal(calls,1);
});
