import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createAgentQueue,mailReadPath,mailContext} from './agent-queue.mjs';
import {createPostgresStateStore,createMemoryStateStore} from './state-store.mjs';
import {createGmailOAuth,gmailVault,GMAIL_SCOPES} from './gmail-oauth.mjs';
import {createApp} from './server.mjs';
const now=Date.parse('2026-10-27T10:00:00Z');
const config={expected_revision:0,start_after:'2026-10-27T09:00:00Z',include_label_ids:['Label_in'],exclude_label_ids:['Label_skip'],mode:'review_only'};
const message=(id,thread='thread1',labels=['Label_in'])=>({id,threadId:thread,internalDate:String(now-1000),labelIds:labels,payload:{headers:[{name:'Subject',value:'Example forward plan'},{name:'From',value:'dispatch@example.com'}],mimeType:'text/plain',body:{data:Buffer.from('Example plan text').toString('base64url')}}});
const messages=[message('a1'),message('a2','thread1',['Label_in','Label_skip']),message('a3','other',['Label_in','SENT'])];
function fakeMail(){const calls=[];return {calls,checkSaved:async()=>({emailAddress:'operator@example.com'}),request:async(method,path)=>{
 calls.push({method,path});assert.equal(method,'GET');if(path==='labels')return {labels:[{id:'Label_in',type:'user',name:'TCOG/Example'},{id:'Label_skip',type:'user',name:'TCOG/Skip'}]};
 if(path.startsWith('messages?'))return {messages:messages.map(m=>({id:m.id})),nextPageToken:'next_1'};
 const found=messages.find(m=>path.startsWith('messages/'+m.id+'?'));if(found)return structuredClone(found);throw Error('unexpected fake request');
 }};}
for(const backend of ['memory','postgres'])test(backend+': durable intake, no duplicate after retry/restart, pagination, tenant isolation, conflicting labels and config CAS',async()=>{
 const db=backend==='postgres'?new PGlite():null;const pool=db?{query:(s,p)=>p?db.query(s,p):db.exec(s).then(x=>x.at(-1))}:null;
 const store=pool?createPostgresStateStore(pool):createMemoryStateStore();await store.initialize();const mail=fakeMail();const a=createAgentQueue(store,mail,'tenant-A',{now:()=>now});
 assert.equal((await a.run('agent_status')).config.mode,'paused');await assert.rejects(a.run('agent_scan',{label_id:'Label_in'}),/paused/);
 await a.run('agent_configure',config);
 await assert.rejects(a.run('agent_configure',config),/revision conflict/);
 const dry=await a.run('agent_scan',{label_id:'Label_in'});assert.equal(dry.dry_run,true);assert.equal(dry.candidates.length,2);assert.equal(dry.next_page_token,'next_1');assert.equal((await a.run('agent_tasks')).items.length,0);assert.ok(!mail.calls.some(c=>c.path.includes('format=full')));
 const first=await a.run('agent_scan',{label_id:'Label_in',dry_run:false});assert.equal(first.candidates.filter(x=>x.written).length,2);assert.equal(first.candidates[1].state,'NEEDS_CONTEXT');assert.equal(first.candidates[1].possible_plan_change,true);assert.equal(first.skipped.length,1);assert.equal(first.ai_calls,0);
 const restarted=createAgentQueue(pool?createPostgresStateStore(pool):store,mail,'tenant-A',{now:()=>now});const replay=await restarted.run('agent_scan',{label_id:'Label_in',dry_run:false});assert.ok(replay.candidates.every(x=>!x.written&&x.already_queued));
 const [x,y]=await Promise.all([store.agentEnqueue('tenant-A',{...first.candidates[0],id:'another'}),store.agentEnqueue('tenant-A',{...first.candidates[0],id:'another'})]);assert.equal([x,y].filter(x=>x.inserted).length,1);
 assert.equal((await restarted.run('agent_tasks')).items.length,3);assert.equal((await createAgentQueue(store,mail,'tenant-B').run('agent_tasks')).items.length,0);
 const context=await restarted.run('agent_task_context',{task_id:first.candidates[0].id});assert.equal(context.text,'Example plan text');assert.equal(context.content_complete,true);
 assert.equal((await restarted.run('agent_status')).scheduler_enabled,false);
 const updated=await restarted.run('agent_configure',{...config,expected_revision:1,mode:'paused'});assert.equal(updated.config.revision,2);await assert.rejects(a.run('agent_scan',{label_id:'Label_in'}),/paused/);
 if(db)await db.close();
});
test('Gmail read allowlist rejects send/delete, unknown destinations, raw bulk payloads and unbounded queries',()=>{
 for(const p of ['messages?maxResults=25&labelIds=Label_in&q=after%3A1&includeSpamTrash=false','messages/a1?format=metadata&metadataHeaders=Subject','messages/a1?format=full','messages/a1/attachments/id'])assert.equal(mailReadPath(p),true,p);
 for(const p of ['messages/send','messages/a1?format=raw','https://evil.example/messages','../messages/a1?format=full','messages?maxResults=500&includeSpamTrash=false','messages?maxResults=1&includeSpamTrash=true','messages/a1?format=full&access_token=secret','messages/a1?format=full#x'])assert.equal(mailReadPath(p),false,p);
});
test('context explicitly flags PDFs, html-only, detached text and truncated messages',()=>{
 const pdf=message('a1');pdf.payload={mimeType:'multipart/mixed',parts:[pdf.payload,{filename:'plan.pdf',mimeType:'application/pdf',body:{attachmentId:'a',size:100}}]};assert.equal(mailContext(pdf).attachments_pending,true);
 const html=message('a1');html.payload={mimeType:'text/html',body:{data:Buffer.from('<p>plan</p>').toString('base64url')}};assert.equal(mailContext(html).content_complete,false);
 const detached=message('a1');detached.payload.body={attachmentId:'text'};assert.equal(mailContext(detached).content_complete,false);
 const huge=message('a1');huge.payload.body.data=Buffer.alloc(66000,120).toString('base64url');assert.equal(mailContext(huge).content_complete,false);assert.ok(mailContext(huge).warnings.includes('message_text_truncated'));
});
test('OAuth read session verifies mailbox once and never permits mail writes or credential redirects',async()=>{
 const env={PUBLIC_URL:'https://example.com',OAUTH_CLIENT_SECRET:'s'.repeat(40),GOOGLE_GMAIL_CLIENT_ID:'fake-client',GOOGLE_GMAIL_CLIENT_SECRET:'fake-secret',GOOGLE_GMAIL_EXPECTED_EMAIL:'operator@example.com'};
 env.GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED=gmailVault(env.OAUTH_CLIENT_SECRET,env.PUBLIC_URL).seal('refresh-token',{clientId:'fake-client',email:'operator@example.com',refreshToken:'fake-refresh',scope:GMAIL_SCOPES.join(' ')});
 const calls=[];const oauth=createGmailOAuth(env,{fetchImpl:async(url,o)=>{calls.push(url);assert.equal(o.redirect,'error');if(url.includes('/token'))return new Response(JSON.stringify({access_token:'fake-access',scope:GMAIL_SCOPES.join(' ')}));if(url.endsWith('/profile'))return new Response(JSON.stringify({emailAddress:'operator@example.com'}));return new Response(JSON.stringify(message('a1')));}});
 const read=await oauth.readSession();await read('messages/a1?format=metadata');await read('messages/a1?format=full');assert.equal(calls.filter(x=>x.includes('/token')).length,1);await assert.rejects(async()=>read('messages/send'));await assert.rejects(oauth.request('POST','messages/send',{}));
});
test('queue configuration validates labels, boundaries and mailbox binding',async()=>{
 const store=createMemoryStateStore(),mail=fakeMail(),a=createAgentQueue(store,mail,'T',{now:()=>now});
 for(const bad of [{...config,start_after:'2020-01-01T00:00:00Z'},{...config,include_label_ids:['INBOX']},{...config,include_label_ids:['Label_in','Label_in']},{...config,exclude_label_ids:['Label_in']},{...config,mode:'autonomous'}])await assert.rejects(a.run('agent_configure',bad));
 await a.run('agent_configure',config);const saved=await a.run('agent_scan',{label_id:'Label_in',dry_run:false});mail.checkSaved=async()=>({emailAddress:'wrong@example.com'});await assert.rejects(a.run('agent_task_context',{task_id:saved.candidates[0].id}),/mailbox mismatch/);
});
test('MCP queue requires existing read/write scopes and cannot be used to enable AI or external writes',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'12345',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const server=createApp(env,undefined,{gmailClient:fakeMail()});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:env.PUBLIC_URL+'/mcp',scope,exp:Date.now()+60000,sub:'12345'})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 const call=async(scope,name,args)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await r.json()).result;};
 try{
  assert.equal((await call('firetms:read firetms:write','agent_status',{})).isError,true);
  const status=JSON.parse((await call('memory:read','agent_status',{})).content[0].text);assert.equal(status.external_writes_enabled,false);
  assert.equal((await call('memory:read gmail:read','agent_configure',config)).isError,true);
  assert.equal((await call('memory:read memory:write gmail:read','agent_configure',{...config,start_after:new Date(Date.now()-10000).toISOString()})).isError,undefined);
  assert.equal((await call('memory:read memory:write gmail:read','agent_configure',{...config,auto_send:true})).isError,true);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('bootstrap configures existing operational labels without scanning mail and preserves a paused configuration',async()=>{
 const db=new PGlite(),pool={query:(s,p)=>p?db.query(s,p):db.exec(s).then(x=>x.at(-1))},store=createPostgresStateStore(pool);await store.initialize();
 const calls=[],oauth={request:async(m,p)=>{calls.push(p);assert.equal(m,'GET');assert.equal(p,'labels');return {labels:[{id:'Label_in',type:'user',name:'TCOG/Operacyjne/Do analizy'},{id:'Label_skip',type:'user',name:'TCOG/Pominięte/Example'}]};}};
 const api=createAgentQueue(store,oauth,'A',{now:()=>now});
 const result=await api.bootstrap();assert.equal(result.configured,true);assert.equal(result.mode,'review_only');assert.equal(calls.length,1);
 const current=(await api.run('agent_status')).config;assert.equal(current.start_after,new Date(now).toISOString());assert.deepEqual(current.include_label_ids,['Label_in']);
 await store.agentConfig('A',1,{...current,mode:'paused'});assert.equal((await api.bootstrap()).mode,'paused');assert.equal(calls.length,1);assert.equal((await api.run('agent_tasks')).items.length,0);
 await db.close();
});
