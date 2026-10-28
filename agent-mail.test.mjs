import test from 'node:test';
import assert from 'node:assert/strict';
import {composeOperatorMail,isAgentGeneratedMail,createOperatorMailer} from './agent-mail.mjs';
import {createMemoryStateStore,createPostgresStateStore} from './state-store.mjs';
import {PGlite} from '@electric-sql/pglite';
const a={taskId:'a'.repeat(64),operationId:'b'.repeat(64),truck:'WSE2UV4',client:'DHL',plan:'Plan do weryfikacji',questions:['Brak masy']};
test('mail is addressed exclusively to operator and identifies itself',()=>{const r=composeOperatorMail(a),raw=Buffer.from(r.raw,'base64url').toString();assert.equal(r.recipient,'og@tcog.pl');assert.match(raw,/To: og@tcog.pl/);assert.match(raw,/X-TCOG-Agent: operator-review-v1/);assert.match(r.text,/Brak masy/);assert.equal(composeOperatorMail(a).messageId,r.messageId);});
test('rejects header injection and unexpected links',()=>{assert.throws(()=>composeOperatorMail({...a,client:'DHL\r\nBcc: x@example.com'}));assert.throws(()=>composeOperatorMail({...a,sourceUrl:'https://evil.example/'}));});
test('agent marker is recognized exactly',()=>{assert.equal(isAgentGeneratedMail([{name:'X-TCOG-Agent',value:'operator-review-v1'}]),true);assert.equal(isAgentGeneratedMail([{name:'X-TCOG-Agent',value:'other'}]),false);});
for(const kind of ['memory','postgres'])test(`${kind}: concurrent and uncertain sends never repeat`,async()=>{
 const db=kind==='postgres'?new PGlite():null;
 const store=db?createPostgresStateStore(db):createMemoryStateStore();await store.initialize();
 const taskId='a'.repeat(64),opId='b'.repeat(64);await store.agentEnqueue('A',{id:taskId,source:{mailbox:'og@tcog.pl',message_id:'abcd',thread_id:'t',received_at:'2026-10-28T00:00:00Z'}});
 await store.modelReserve('A',opId,'2026-10-28',10,{task_id:taskId});await store.modelFinish('A',opId,'DONE',{task_id:taskId,draft:{client_key:'dhl-se',truck_registration:'WSE2UV4',driver_message:'Plan',missing_information:[],warnings:[]}});
 let calls=0;const mail=createOperatorMailer(store,{sendOperator:async()=>{calls++;throw Error('timeout');}},'A');
 await Promise.all([mail.sendDraft(opId),mail.sendDraft(opId)]);await mail.sendDraft(opId);assert.equal(calls,1);assert.equal((await store.operatorMailGet('A',opId)).state,'UNKNOWN');await store.close();if(db)await db.close();
});

test('successful delivery persists Gmail thread and reads only operator replies',async()=>{
 const store=createMemoryStateStore(),taskId='a'.repeat(64),opId='c'.repeat(64);
 await store.agentEnqueue('A',{id:taskId,source:{mailbox:'og@tcog.pl',message_id:'abcd'}});
 await store.modelReserve('A',opId,'2026-10-28',10,{});await store.modelFinish('A',opId,'DONE',{task_id:taskId,draft:{client_key:'dhl-se',truck_registration:'WSE2UV4',driver_message:'Plan',missing_information:[],warnings:[]}});
 const {createOperatorMailChannel}=await import('./agent-mail.mjs');let calls=0;
 const channel=createOperatorMailChannel(store,{sendOperator:async()=>{calls++;return {id:'111',threadId:'222'};},readOperatorThread:async id=>{assert.equal(id,'222');return {messages:[{id:'111'},{id:'333',payload:{headers:[{name:'From',value:'Oskar <og@tcog.pl>'}]}},{id:'444',payload:{headers:[{name:'From',value:'other@example.com'}]}}]};}},'A');
 assert.equal((await channel.run('agent_mail_send',{operation_id:opId})).sent,true);
 await channel.run('agent_mail_send',{operation_id:opId});assert.equal(calls,1);
 assert.deepEqual((await channel.run('agent_mail_replies',{operation_id:opId})).messages.map(x=>x.id),['333']);
});

for(const kind of ['memory','postgres'])test(`${kind}: draft history filters tenant/task and paginates`,async()=>{
 const db=kind==='postgres'?new PGlite():null,store=db?createPostgresStateStore(db):createMemoryStateStore();await store.initialize();
 for(let i=0;i<27;i++)await store.modelReserve('A',String(i).padStart(64,'0'),'2026-10-28',100,{task_id:i===26?'other':'task'});
 await store.modelReserve('B','x','2026-10-28',10,{task_id:'task'});
 const first=await store.modelOperations('A','task',0),second=await store.modelOperations('A','task',25);
 assert.equal(first.length,25);assert.equal(second.length,1);assert.equal(first[0].id,'0'.repeat(64));assert.equal((await store.modelOperations('B','task',0)).length,1);assert.equal((await store.modelOperations('A','missing',0)).length,0);
 await store.close();if(db)await db.close();
});
