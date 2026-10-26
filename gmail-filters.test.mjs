import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createGmailFilters} from './gmail-filters.mjs';
import {createApp} from './server.mjs';
function mock(){let filters=[],posts=0,deletes=0;const labels=[{id:'Label_1',name:'TCOG/Klienci/SGL',type:'user'},{id:'Label_2',name:'TCOG/Pominięte/Stawki',type:'user'},{id:'Other',name:'Private',type:'user'}];return {get filters(){return filters},set filters(v){filters=v},get posts(){return posts},get deletes(){return deletes},checkSaved:async()=>({emailAddress:'og@tcog.pl'}),request:async(m,p,b)=>{if(m==='GET')return structuredClone(p==='labels'?{labels}:{filter:filters});if(m==='POST'){posts++;const f={id:'new_'+posts,...structuredClone(b)};filters.push(f);return f;}deletes++;filters=filters.filter(f=>f.id!==p.split('/').at(-1));return {};}};}
const data={query:'from:example.com subject:tour',add_label_id:'Label_1'};
test('Gmail preview is read-only, TCOG-only; apply verifies and deduplicates repeated writes',async()=>{
 const m=mock(),c=createGmailFilters(m);
 const p=await c.run('gmail_preview_filter_change',data);assert.equal(m.posts,0);assert.equal(p.written,false);
 const r=await c.run('gmail_apply_filter_change',{review_token:p.review_token});assert.equal(r.verified,true);assert.equal(m.posts,1);
 assert.deepEqual(await c.run('gmail_apply_filter_change',{review_token:p.review_token}),r);assert.equal(m.posts,1);
 const p2=await c.run('gmail_preview_filter_change',data);assert.equal((await c.run('gmail_apply_filter_change',{review_token:p2.review_token})).written,false);
 for(const bad of [{...data,add_label_id:'TRASH'},{...data,add_label_id:'Other'},{...data,remove_label_ids:['INBOX']},{...data,forward:'evil@example.com'}])await assert.rejects(c.run('gmail_preview_filter_change',bad));
});
test('Gmail replacement detects conflicts, preserves unrelated filters and creates before deleting',async()=>{
 const m=mock();m.filters=[{id:'old',criteria:{query:'old'},action:{addLabelIds:['Label_1']}},{id:'private',criteria:{query:'private'},action:{forward:'private@example.com'}}];
 const c=createGmailFilters(m),p=await c.run('gmail_preview_filter_change',{...data,replace_filter_id:'old'});
 m.filters[0].criteria.query='changed';await assert.rejects(c.run('gmail_apply_filter_change',{review_token:p.review_token}),/changed/);assert.equal(m.posts,0);
 const next=await c.run('gmail_preview_filter_change',{...data,replace_filter_id:'old'});const done=await c.run('gmail_apply_filter_change',{review_token:next.review_token});assert.equal(done.verified,true);assert.equal(m.deletes,1);assert.ok(m.filters.some(f=>f.id==='private'));
 await assert.rejects(c.run('gmail_preview_filter_change',{...data,replace_filter_id:'private'}));
});
test('Gmail ambiguous writes are not retried, expired reviews cannot execute',async()=>{
 const m=mock();let posts=0;const base=m.request;m.request=async(...a)=>{if(a[0]==='POST'){posts++;throw Error('timeout')}return base(...a)};
 let time=1000;const c=createGmailFilters(m,{now:()=>time});const p=await c.run('gmail_preview_filter_change',data);
 for(let i=0;i<2;i++)await assert.rejects(c.run('gmail_apply_filter_change',{review_token:p.review_token}),/uncertain|already/);assert.equal(posts,1);
 const p2=await c.run('gmail_preview_filter_change',data);time+=900001;await assert.rejects(c.run('gmail_apply_filter_change',{review_token:p2.review_token}),/expired/);
});
test('MCP Gmail scopes isolate existing FireTMS credentials from Gmail writes',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake',GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED:'fake'};
 const m=mock(),app=createApp(env,undefined,{gmailClient:m});await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const rpc=async(scope,method,params)=>{const p=Buffer.from(JSON.stringify({aud:env.PUBLIC_URL+'/mcp',sub:env.WFIRMA_COMPANY_ID,scope,exp:Date.now()+10000})).toString('base64url');const token=p+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(p).digest('base64url');return (await fetch('http://127.0.0.1:'+app.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()};
 try{
  const list=await rpc('firetms:read','tools/list');assert.ok(list.result.tools.some(t=>t.name==='gmail_list_filters'));
  assert.equal((await rpc('firetms:read firetms:write','tools/call',{name:'gmail_list_filters'})).result.isError,true);
  const preview=await rpc('gmail:read','tools/call',{name:'gmail_preview_filter_change',arguments:data});const p=JSON.parse(preview.result.content[0].text);
  assert.equal((await rpc('gmail:read','tools/call',{name:'gmail_apply_filter_change',arguments:{review_token:p.review_token}})).result.isError,true);
  const done=await rpc('gmail:read gmail:write','tools/call',{name:'gmail_apply_filter_change',arguments:{review_token:p.review_token}});assert.equal(JSON.parse(done.result.content[0].text).verified,true);
 }finally{app.closeAllConnections();await new Promise(r=>app.close(r));}
});
