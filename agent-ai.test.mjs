import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {access} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createMemoryStateStore,createPostgresStateStore} from './state-store.mjs';
import {createModelSetup} from './model-setup.mjs';
import {createAgentAI,openaiResponse} from './agent-ai.mjs';
import {extractPdf} from './pdf-extract.mjs';
import {createApp} from './server.mjs';
const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'12345',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
const taskId='a'.repeat(64),msg={id:'a1',threadId:'t1',internalDate:String(Date.now()-1000),labelIds:[],payload:{headers:[],mimeType:'text/plain',body:{data:Buffer.from('Example Warehouse, Street 1, DE00001 Example City. Reference EX123.').toString('base64url')}}};
const draft={client_key:'example',truck_registration:'ABC123',main_reference:'EX123',driver_message:'Cześć, jedziemy na załadunek.\nExample Warehouse, Street 1, DE00001 Example City.\nREF: EX123',stops:[{operation:'LOADING',address:'Example Warehouse, Street 1, DE00001 Example City',date:null,reference:'EX123',cargo:null,evidence:[{source_id:'mail:a1',quote:'Example Warehouse, Street 1'}]}],missing_information:['Route and distances need checking'],warnings:[]};
const config={key:'sk-'+'fakekey'.repeat(8),model:'gpt-6.1-terra',dailyLimit:1,outputLimit:4000,revision:'one'};
async function fixture(store,modelCall){await store.initialize();await store.agentEnqueue('A',{id:taskId,source:{message_id:'a1',thread_id:'t1',mailbox:'operator@example.com',received_at:new Date(Number(msg.internalDate)).toISOString()},created_at:new Date().toISOString(),possible_plan_change:false});
 for(const client of ['global','example'])await store.memoryAppend('A',client,0,{kind:'rule',client_key:client,operation:'upsert',context:{topic:'baseline'},content:{rule:'Example rule: use supplied addresses only.'},digest:client});
 const oauth={checkSaved:async()=>({emailAddress:'operator@example.com'}),request:async(m,path)=>{assert.equal(m,'GET');assert.equal(path,'messages/a1?format=full');return structuredClone(msg);}};
 return {api:createAgentAI(store,oauth,{read:async()=>({...config}),status:async()=>({configured:true,model:config.model})},'A',{modelCall}),oauth};}
const input={task_id:taskId,client_key:'example',truck_registration:'ABC123'};
async function pdfFixture(store,modelCall,{complete=true}={}){
 const {oauth}=await fixture(store,modelCall);let reads=0;
 const message={...structuredClone(msg),payload:{mimeType:'multipart/mixed',parts:[structuredClone(msg.payload),{partId:'1',mimeType:'application/pdf',filename:'example.pdf',body:{size:40,attachmentId:'initial'}}]}};
 let bytes=Buffer.from('%PDF-1.4 synthetic document version one');
 oauth.request=async(method,path)=>{assert.equal(method,'GET');if(path==='messages/a1?format=full'){const copy=structuredClone(message);copy.payload.parts[1].body.attachmentId='rotating-'+(++reads);return copy;}assert.match(path,/^messages\/a1\/attachments\/rotating-\d+$/);return {data:bytes.toString('base64url')};};
 const options={pdfExtract:async()=>({text:'Example PDF warehouse, Street 2. Reference EX123.',complete,pages:1}),modelCall};
 const setup={read:async()=>({...config})};
 return {api:createAgentAI(store,oauth,setup,'A',options),restart:()=>createAgentAI(store,oauth,setup,'A',options),message,setBytes:x=>{bytes=Buffer.from(x);}};
}
for(const backend of ['memory','postgres'])test(backend+': rotating Gmail attachment handles preserve preview identity and charge only once',async()=>{
 const db=backend==='postgres'?new PGlite():null,pool=db?{query:(s,p)=>p?db.query(s,p):db.exec(s).then(x=>x.at(-1))}:null,store=pool?createPostgresStateStore(pool):createMemoryStateStore();let calls=0;
 try{
  const f=await pdfFixture(store,async(c,request)=>{calls++;const source=request.data.sources.find(s=>s.id.startsWith('pdf:'));return {draft:{...structuredClone(draft),stops:[{...structuredClone(draft.stops[0]),evidence:[{source_id:source.id,quote:'Example PDF warehouse, Street 2'}]}]},usage:{input_tokens:100,output_tokens:200}};});
  const first=await f.api.run('agent_preview_draft',input),second=await f.api.run('agent_preview_draft',input);assert.equal(first.operation_id,second.operation_id);assert.equal(calls,0);
  const result=await f.restart().run('agent_generate_draft',{review_token:first.review_token});assert.equal(result.operation.state,'DONE');assert.equal(calls,1);
  const replay=await f.restart().run('agent_generate_draft',{review_token:second.review_token});assert.equal(replay.cached,true);assert.equal(calls,1);
 }finally{if(db)await db.close();}
});
test('real PDF bytes, filename or mail changes invalidate preview before any model call',async()=>{
 for(const change of [f=>f.setBytes('%PDF-1.4 synthetic document version two'),f=>{f.message.payload.parts[1].filename='replacement.pdf';},f=>{f.message.payload.parts[0].body.data=Buffer.from('Changed loading date and address').toString('base64url');}]){
  let calls=0;const f=await pdfFixture(createMemoryStateStore(),async()=>{calls++;return {draft};});const preview=await f.api.run('agent_preview_draft',input);change(f);
  await assert.rejects(f.api.run('agent_generate_draft',{review_token:preview.review_token}),/context changed/);assert.equal(calls,0);
 }
});
test('incomplete PDFs still block preview unless explicitly ignored by stable attachment identity',async()=>{
 let calls=0;const f=await pdfFixture(createMemoryStateStore(),async(c,request)=>{calls++;assert.ok(!request.data.sources.some(s=>s.id.startsWith('pdf:')));return {draft:structuredClone(draft)};},{complete:false});
 await assert.rejects(f.api.run('agent_preview_draft',input),/unresolved attachments/);
 const bundle=await f.api.run('agent_sources',{task_id:taskId});assert.equal(bundle.complete,false);
 const preview=await f.api.run('agent_preview_draft',{...input,ignored_attachment_ids:[bundle.unresolved[0].id]});
 const result=await f.api.run('agent_generate_draft',{review_token:preview.review_token});assert.equal(result.operation.state,'DONE');assert.equal(calls,1);
});
for(const backend of ['memory','postgres'])test(backend+': model preview is free, duplicate calls charge once, daily quota and restart reuse are durable',async()=>{
 const db=backend==='postgres'?new PGlite():null,pool=db?{query:(s,p)=>p?db.query(s,p):db.exec(s).then(x=>x.at(-1))}:null,store=pool?createPostgresStateStore(pool):createMemoryStateStore();let calls=0;
 const vendor=async(c,request)=>{calls++;assert.equal(c.key,config.key);assert.ok(!JSON.stringify(request).includes(config.key));return {draft:structuredClone(draft),usage:{input_tokens:100,output_tokens:200},request_id:'req-test',response_id:'resp-test'};};
 const {api,oauth}=await fixture(store,vendor);const preview=await api.run('agent_preview_draft',input);assert.equal(calls,0);assert.equal(preview.ai_called,false);assert.ok(!JSON.stringify(preview).includes(config.key));
 const results=await Promise.all([api.run('agent_generate_draft',{review_token:preview.review_token}),api.run('agent_generate_draft',{review_token:preview.review_token})]);assert.equal(calls,1);assert.ok(results.some(r=>r.operation.state==='DONE'));
 const restarted=createAgentAI(pool?createPostgresStateStore(pool):store,oauth,{read:async()=>config},'A',{modelCall:vendor});const replay=await restarted.run('agent_generate_draft',{review_token:preview.review_token});assert.equal(replay.operation.state,'DONE');assert.equal(calls,1);assert.equal(replay.operation.payload.requires_human_review,true);
 const second=await api.run('agent_preview_draft',{...input,operator_context:'Different explicit context'});const capped=await api.run('agent_generate_draft',{review_token:second.review_token});assert.equal(capped.operation.state,'DAILY_LIMIT');assert.equal(calls,1);
 assert.equal((await store.modelOperation('B',preview.operation_id)),undefined);if(db)await db.close();
});
test('incomplete sources, missing profiles and stale context block model charges',async()=>{
 const store=createMemoryStateStore();let calls=0;const {api,oauth}=await fixture(store,async()=>{calls++;return {draft};});
 await assert.rejects(api.run('agent_preview_draft',{...input,client_key:'missing'}),/rules missing/);
 const preview=await api.run('agent_preview_draft',input);
 await store.memoryAppend('A','example',1,{kind:'rule',client_key:'example',operation:'upsert',context:{topic:'baseline'},content:{rule:'Changed instruction'},digest:'new'});
 await assert.rejects(api.run('agent_generate_draft',{review_token:preview.review_token}),/context changed/);
 const original=oauth.request;oauth.request=async()=>({...structuredClone(msg),payload:{mimeType:'text/html',body:{data:'aGVsbG8'}}});await assert.rejects(api.run('agent_preview_draft',input),/context incomplete/);oauth.request=original;
 await store.agentEnqueue('A',{id:'b'.repeat(64),source:{message_id:'a2',thread_id:'t1',mailbox:'operator@example.com',received_at:new Date(Date.now()+1000).toISOString()}});await assert.rejects(api.run('agent_preview_draft',input),/newer thread/);assert.equal(calls,0);
});
test('ambiguous vendor error or unsupported invented distance is recorded and never retried automatically',async()=>{
 for(const vendor of [async()=>{throw Error('AI vendor HTTP 500');},async()=>({draft:{...structuredClone(draft),driver_message:'Jedziemy 123 km'}}),async()=>({draft:{...structuredClone(draft),stops:[{...draft.stops[0],evidence:[{source_id:'mail:a1',quote:'invented source address'}]}]}})]){
  const store=createMemoryStateStore();let calls=0;const {api}=await fixture(store,async(...a)=>{calls++;return vendor(...a);});const preview=await api.run('agent_preview_draft',input);const first=await api.run('agent_generate_draft',{review_token:preview.review_token});assert.equal(first.operation.state,'UNKNOWN');assert.equal(first.operation.payload.retry,false);await api.run('agent_generate_draft',{review_token:preview.review_token});assert.equal(calls,1);
 }
});
test('OpenAI transport has fixed destination, no tools, store=false, bounded JSON and safe errors',async()=>{
 const result=await openaiResponse(config,{instructions:'Example rules',data:{source:'Example'}},{fetchImpl:async(url,o)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(o.redirect,'error');const body=JSON.parse(o.body);assert.equal(body.store,false);assert.deepEqual(body.tools,[]);assert.equal(body.text.format.strict,true);assert.equal(body.max_output_tokens,4000);return new Response(JSON.stringify({status:'completed',id:'resp-1',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(draft)}]}],usage:{input_tokens:100,output_tokens:200}}),{headers:{'x-request-id':'req-1'}});}});assert.equal(result.draft.main_reference,'EX123');
 for(const data of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}])await assert.rejects(openaiResponse(config,{instructions:'X',data:{}},{fetchImpl:async()=>new Response(JSON.stringify(data))}));
 try{await openaiResponse(config,{instructions:'X',data:{}},{fetchImpl:async()=>new Response('VENDOR_SECRET',{status:401})});assert.fail();}catch(e){assert.equal(e.message,'AI vendor HTTP 401');assert.ok(!JSON.stringify(e).includes('VENDOR_SECRET'));}
});
test('PDF extraction is bounded, identifies scanned/partial pages and removes temporary files',async()=>{
 const bytes=Buffer.from('%PDF-1.4 example synthetic content');let temp;
 const complete=await extractPdf(bytes,{runner:async(cmd,args,options)=>{assert.equal(options.timeout,15000);assert.equal(options.env.OAUTH_CLIENT_SECRET,undefined);temp=args[0];return {stdout:cmd==='pdfinfo'?'Pages: 1\nEncrypted: no\n':'Example source text long enough for the single synthetic page\f'};}});assert.equal(complete.complete,true);await assert.rejects(access(temp));
 const scanned=await extractPdf(bytes,{runner:async cmd=>({stdout:cmd==='pdfinfo'?'Pages: 2\nEncrypted: no\n':'A full paragraph of source text on the first synthetic page\f\f'})});assert.equal(scanned.complete,false);
 await assert.rejects(extractPdf(bytes,{runner:async()=>({stdout:'Pages: 31\nEncrypted: no\n'})}),/page limit/);await assert.rejects(extractPdf(bytes,{runner:async()=>({stdout:'Pages: 1\nEncrypted: yes\n'})}),/encrypted/);await assert.rejects(extractPdf(Buffer.from('invalid bytes')));
});
test('secure model form checks origin/password/CSRF and stores key only in a sealed SQL-compatible envelope',async()=>{
 const store=createMemoryStateStore(),setup=createModelSetup(env,store),app=createApp(env,undefined,{stateStore:store});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 try{
  const page=await fetch(base+'/ai/setup');assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store, private');const html=await page.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const post=(fields={},origin=env.PUBLIC_URL)=>fetch(base+'/ai/setup',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({csrf,password:env.ADMIN_PASSWORD,api_key:config.key,model:config.model,daily_limit:'20',output_limit:'4000',...fields})});
  assert.equal((await post({},'https://evil.example')).status,403);assert.equal((await post({password:'bad'})).status,403);assert.equal((await post({csrf:'bad'})).status,400);
  const response=await post();assert.equal(response.status,200);assert.ok(!(await response.text()).includes(config.key));const sealed=await store.get('ai-config:12345','active');assert.ok(!JSON.stringify(sealed).includes(config.key));assert.equal((await setup.read()).key,config.key);assert.ok(!JSON.stringify(await setup.status()).includes(config.key));
 }finally{app.closeAllConnections();await new Promise(r=>app.close(r));}
});
test('paid generation requires ai:generate; existing memory write grants cannot authorize charges',async()=>{
 const app=createApp(env);await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:env.PUBLIC_URL+'/mcp',scope,exp:Date.now()+60000,sub:'12345'})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 try{
  const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token('memory:read memory:write gmail:read')},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_generate_draft',arguments:{review_token:'fake'}}})});const result=(await r.json()).result;assert.equal(result.isError,true);assert.match(result._meta['mcp/www_authenticate'][0],/ai:generate/);
  const meta=await(await fetch(base+'/.well-known/oauth-authorization-server')).json();assert.ok(meta.scopes_supported.includes('ai:generate'));
 }finally{app.closeAllConnections();await new Promise(r=>app.close(r));}
});
test('SQL daily cap can admit a previously capped operation on the next day, while successful operations stay cached',async()=>{
 const db=new PGlite(),pool={query:(s,p)=>p?db.query(s,p):db.exec(s).then(x=>x.at(-1))},store=createPostgresStateStore(pool);await store.initialize();
 assert.equal((await store.modelReserve('A','one','2026-10-27',1,{})).allowed,true);await store.modelFinish('A','one','DONE',{budget_day:'2026-10-27'});
 assert.equal((await store.modelReserve('A','two','2026-10-27',1,{})).allowed,false);
 assert.equal((await store.modelReserve('A','two','2026-10-28',1,{})).allowed,true);
 assert.equal((await store.modelReserve('A','one','2026-10-28',1,{})).allowed,false);await db.close();
});
