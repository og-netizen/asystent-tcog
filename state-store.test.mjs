import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresStateStore} from './state-store.mjs';
import {createFiretms} from './firetms.mjs';
import {createGmailFilters} from './gmail-filters.mjs';

test('PostgreSQL receipts survive client restart; atomic consume and claim allow only one winner',async()=>{
 const db=new PGlite();const pool={query:(sql,p)=>p?db.query(sql,p):db.exec(sql).then(x=>x.at(-1))};
 const first=createPostgresStateStore(pool);await first.initialize();const expires=Date.now()+60000;
 await first.put('codes','raw-secret-code',{scope:'gmail:read'},expires);
 const second=createPostgresStateStore(pool);
 assert.equal((await second.get('codes','raw-secret-code')).scope,'gmail:read');
 const taken=await Promise.all([first.take('codes','raw-secret-code'),second.take('codes','raw-secret-code')]);assert.equal(taken.filter(Boolean).length,1);
 await first.put('writes','raw-review-token',{state:'prepared',data:{ref:'TRIP-1'}},expires);
 const claimed=await Promise.all([first.claim('writes','raw-review-token','prepared','checking'),second.claim('writes','raw-review-token','prepared','checking')]);assert.equal(claimed.filter(Boolean).length,1);
 assert.equal((await second.get('writes','raw-review-token')).state,'checking');
 const raw=await db.query('SELECT key_hash FROM tcog_state');assert.ok(raw.rows.every(r=>!r.key_hash.includes('raw-review')));
 await first.put('codes','expired',{scope:'expired'},Date.now()-1000);assert.equal(await second.get('codes','expired'),undefined);await first.prune('codes');assert.equal(await second.count('codes'),0);
 await db.close();
});

test('FireTMS replicas share a receipt and never repeat an ambiguous vendor write after restart',async()=>{
 const db=new PGlite();const pool={query:(sql,p)=>p?db.query(sql,p):db.exec(sql).then(x=>x.at(-1))};
 const store=createPostgresStateStore(pool);await store.initialize();let posts=0;
 const vendor=async(u,k,m='GET')=>{if(m==='GET')return {items:[]};posts++;throw Error('timeout');};
 const data={receptionDate:'2026-10-27T09:00:00+01:00',client:{id:'client-1'},clientOrderNumber:'TEST-STATE',cargoHandlings:[{cargoHandlingType:'LOADING',term:'2026-10-28T09:00:00+01:00',address:{addressType:'FULL',city:'Test',zipCode:'DE23570',companyName:'Test Co',streetWithNumber:'Street 1'}},{cargoHandlingType:'UNLOADING',term:'2026-10-29T09:00:00+01:00',address:{addressType:'FULL',city:'Test',zipCode:'DE23570',companyName:'Test Co',streetWithNumber:'Street 1'}}]};
 const a=createFiretms({FIRETMS_API_KEY:'fake'},vendor,store);
 const preview=await a.run('firetms_preview_create_load',{data});
 const b=createFiretms({FIRETMS_API_KEY:'fake'},vendor,createPostgresStateStore(pool));
 const results=await Promise.allSettled([a.run('firetms_create_load',{data,review_token:preview.review_token}),b.run('firetms_create_load',{data,review_token:preview.review_token})]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(posts,1);
 const restarted=createFiretms({FIRETMS_API_KEY:'fake'},vendor,createPostgresStateStore(pool));await assert.rejects(restarted.run('firetms_create_load',{data,review_token:preview.review_token}),/unknown/);assert.equal(posts,1);await db.close();
});

test('Gmail replicas cannot apply the same receipt twice',async()=>{
 const db=new PGlite();const pool={query:(sql,p)=>p?db.query(sql,p):db.exec(sql).then(x=>x.at(-1))};const store=createPostgresStateStore(pool);await store.initialize();let posts=0;const filters=[];
 const oauth={checkSaved:async()=>({emailAddress:'og@tcog.pl'}),request:async(m,p,b)=>{if(p==='labels')return {labels:[{id:'Label_1',name:'TCOG/Klienci/SGL',type:'user'}]};if(m==='GET')return {filter:structuredClone(filters)};posts++;const f={id:'new-1',...b};filters.push(f);return f;}};
 const a=createGmailFilters(oauth,{stateStore:store}),b=createGmailFilters(oauth,{stateStore:createPostgresStateStore(pool)});
 const preview=await a.run('gmail_preview_filter_change',{query:'from:example.com',add_label_id:'Label_1'});
 await Promise.allSettled([a.run('gmail_apply_filter_change',{review_token:preview.review_token}),b.run('gmail_apply_filter_change',{review_token:preview.review_token})]);assert.equal(posts,1);
 const replay=await b.run('gmail_apply_filter_change',{review_token:preview.review_token});assert.equal(replay.verified,true);assert.equal(posts,1);await db.close();
});

test('OAuth code issued on one server can be exchanged once on another SQL-backed server',async()=>{
 const {createApp}=await import('./server.mjs');const {createHash}=await import('node:crypto');
 const db=new PGlite();const pool={query:(sql,p)=>p?db.query(sql,p):db.exec(sql).then(x=>x.at(-1))};const store=createPostgresStateStore(pool);await store.initialize();
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const apps=[createApp(env,undefined,{stateStore:store}),createApp(env,undefined,{stateStore:createPostgresStateStore(pool)})];
 for(const s of apps)await new Promise(r=>s.listen(0,'127.0.0.1',r));const base=apps.map(s=>'http://127.0.0.1:'+s.address().port);
 try{
  const verifier='v'.repeat(64),q=new URLSearchParams({client_id:'asystent-tcog',redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',response_type:'code',scope:'gmail:read',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  const page=await fetch(base[0]+'/authorize?'+q);const html=await page.text(),ticket=html.match(/name="ticket" value="([^"]+)"/)[1];const cookie=page.headers.get('set-cookie').split(';')[0];
  const auth=await fetch(base[0]+'/authorize',{method:'POST',redirect:'manual',headers:{Origin:env.PUBLIC_URL,Cookie:cookie},body:new URLSearchParams({ticket,password:env.ADMIN_PASSWORD})});assert.equal(auth.status,303);
  const code=new URL(auth.headers.get('location')).searchParams.get('code');
  const body=()=>new URLSearchParams({grant_type:'authorization_code',client_id:'asystent-tcog',client_secret:env.OAUTH_CLIENT_SECRET,redirect_uri:q.get('redirect_uri'),code,code_verifier:verifier});
  const exchanged=await Promise.all(base.map(u=>fetch(u+'/token',{method:'POST',body:body()})));assert.deepEqual(exchanged.map(r=>r.status).sort(),[200,400]);
 }finally{for(const s of apps){s.closeAllConnections();await new Promise(r=>s.close(r));}await db.close();}
});
