import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApp} from './server.mjs';

test('OAuth, PKCE, token replay, read-only routing and input validation',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const calls=[];
 const server=createApp(env,async(...args)=>{calls.push(args);return {status:{code:'OK'},companies:{0:{company:{id:'1785731'}}}};});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const req=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
 try{
  assert.equal((await req('/mcp',{method:'POST',body:'{}'})).status,401);
  assert.equal((await req('/health',{headers:{Origin:'https://evil.example'}})).status,403);
  const meta=await(await req('/.well-known/oauth-authorization-server')).json();assert.ok(meta.code_challenge_methods_supported.includes('S256'));
  const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({client_id:'asystent-tcog',redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',response_type:'code',scope:'wfirma:read',code_challenge:challenge,code_challenge_method:'S256',state:'abc'});
  const bad=new URLSearchParams(params);bad.set('redirect_uri','https://evil.example');assert.equal((await req('/authorize?'+bad)).status,400);
  const page=await req('/authorize?'+params);assert.equal(page.status,200);assert.equal(page.headers.get('referrer-policy'),'same-origin');const html=await page.text();const ticket=html.match(/name="ticket" value="([^"]+)"/)[1];
  const cookie=page.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/authorize',{method:'POST',body:new URLSearchParams({ticket,password:env.ADMIN_PASSWORD})})).status,400);
  const auth=await req('/authorize',{method:'POST',headers:{Cookie:cookie,Origin:env.PUBLIC_URL},body:new URLSearchParams({ticket,password:env.ADMIN_PASSWORD})});assert.equal(auth.status,303);
  const back=new URL(auth.headers.get('location'));assert.equal(back.searchParams.get('state'),'abc');
  const tokenParams={grant_type:'authorization_code',client_id:'asystent-tcog',client_secret:env.OAUTH_CLIENT_SECRET,redirect_uri:params.get('redirect_uri'),code:back.searchParams.get('code'),code_verifier:verifier};
  assert.equal((await req('/token',{method:'POST',body:new URLSearchParams({...tokenParams,code_verifier:'bad'})})).status,400);
  const tokenResponse=await req('/token',{method:'POST',body:new URLSearchParams(tokenParams)});assert.equal(tokenResponse.status,200);const {access_token:token}=await tokenResponse.json();
  assert.equal((await req('/token',{method:'POST',body:new URLSearchParams(tokenParams)})).status,400);
  const rpc=async(method,params)=>{const r=await req('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);return r.json();};
  assert.equal((await rpc('initialize',{})).result.protocolVersion,'2025-03-26');
  const listing=await rpc('tools/list');assert.equal(listing.result.tools.length,5);assert.ok(listing.result.tools.every(t=>t.annotations.readOnlyHint));
  await rpc('tools/call',{name:'wfirma_company'});assert.equal(calls[0][1],'companies');assert.equal(calls[0][2],'1785731');
  await rpc('tools/call',{name:'wfirma_list',arguments:{resource:'expenses',page:2,limit:5}});assert.deepEqual(calls[1].slice(1),['expenses',undefined,2,5]);
  for(const args of [{name:'wfirma_delete'},{name:'wfirma_get',arguments:{resource:'expenses',id:'../delete/1'}},{name:'wfirma_list',arguments:{resource:'expenses',company_id:'2'}},{name:'wfirma_list',arguments:{resource:'expenses',limit:500}}])assert.equal((await rpc('tools/call',args)).error.code,-32602);
  assert.equal((await rpc('tools/call',{name:'dbk_vehicles'})).result.isError,true);
  assert.equal(calls.length,2);
  assert.equal((await req('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token+'x'},body:'{}'})).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Fails closed when required configuration is absent',()=>{assert.throws(()=>createApp({}));});
test('Signed form survives a new server process state; tampering and missing cookie are rejected',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const servers=[createApp(env),createApp(env)];
 for(const s of servers)await new Promise(r=>s.listen(0,'127.0.0.1',r));
 const bases=servers.map(s=>'http://127.0.0.1:'+s.address().port);
 try{
  const q=new URLSearchParams({client_id:'asystent-tcog',redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',response_type:'code',code_challenge:'a'.repeat(43),code_challenge_method:'S256'});
  const r=await fetch(bases[0]+'/authorize?'+q);const html=await r.text();
  const ticket=html.match(/name="ticket" value="([^"]+)"/)[1];const cookie=r.headers.get('set-cookie').split(';')[0];
  const post=(t,c)=>fetch(bases[1]+'/authorize',{method:'POST',redirect:'manual',headers:{Origin:env.PUBLIC_URL,...(c?{Cookie:c}:{})},body:new URLSearchParams({ticket:t,password:env.ADMIN_PASSWORD})});
  assert.equal((await post(ticket+'tamper',cookie)).status,400);
  assert.equal((await post(ticket,undefined)).status,400);
  assert.equal((await post(ticket,'tcog_auth=wrong')).status,400);
  assert.equal((await post(ticket,cookie)).status,303);
 }finally{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}}
});


import {createDbk,dbkSignature,dbkUrl} from './server.mjs';
test('DBK signature matches vendor example; unsafe destinations rejected',()=>{
 assert.equal(dbkSignature('e31d0445-dfa0-47f8-924b-8e60002f8030','sekretny-token','https://example.com/webapi/auth-sessions','1507549270000000'),'09a1a19f6260fd81204b63fc6cba8b1a5cfbb449bb0a0d768fd311a9562c7198');
 for(const url of [undefined,'http://gps.grupadbk.com/webapi/','https://evil.example/webapi/','https://gps.grupadbk.com/other','https://gps.grupadbk.com/webapi/?token=x'])assert.throws(()=>dbkUrl(url));
});
test('DBK history discovery, auth, field projection, bounds and session cleanup',async()=>{
 const calls=[];
 const base='https://gps.grupadbk.com/webapi';
 const transport=async(url,method,headers,body)=>{
  calls.push({url,method});
  if(method==='DELETE')return {};
  if(url===base+'/auth-sessions'){
   assert.equal(headers['X-Auth-Signature'],dbkSignature('fake-key','fake-secret',url,body.nonce));
   return {data:{token:'fake-session'}};
  }
  assert.equal(headers.Authorization,'token fake-session');
  if(url===base+'/')return {links:{cars:base+'/cars-root',dataframes:base+'/dataframes'}};
  if(url===base+'/cars-root')return {links:{history_cars:base+'/cars',cars_list:base+'/cars'}};
  if(url===base+'/cars')return {cars:[{device_id:'123',plate_number:'TEST'}]};
  if(url===base+'/dataframes')return {links:{query:{url:base+'/dataframes/search'}}};
  if(url===base+'/dataframes/search'){assert.equal(method,'POST');assert.equal(body.devices,'123');return {items:[base+'/dataframes/list']};}
  if(url===base+'/dataframes/list')return {items:[{date:'2026-09-07T11:15:00Z',lat:54,lng:18,logistics:{'total_distance:can':{raw:12345},'total_fuel:can':{raw:2345}},token:'must-not-return',tachograph:{slot1:{mode:'drive',driver:{name:'Test',card_number:'not-needed'}}}}]};
  throw Error('Unexpected call');
 };
 const dbk=createDbk({DBK_API_KEY:'fake-key',DBK_API_SECRET:'fake-secret'},transport);
 const result=await dbk.run('dbk_history',{device_id:'123',oldest:'2026-09-07T11:00:00Z',newest:'2026-09-07T12:00:00Z'});
 assert.equal(result.sample_count,1);assert.equal(result.samples[0].odometer_can_km,12345);assert.equal(result.samples[0].total_fuel_can_l,2345);
 assert.equal(JSON.stringify(result).includes('must-not-return'),false);assert.equal(JSON.stringify(result).includes('card_number'),false);
 assert.equal(calls.at(-1).method,'DELETE');
 const n=calls.length;
 await assert.rejects(dbk.run('dbk_history',{device_id:'123',oldest:'2026-09-07T11:00:00',newest:'2026-09-07T12:00:00Z'}));
 await assert.rejects(dbk.run('dbk_history',{device_id:'123',oldest:'2026-09-07T10:00:00Z',newest:'2026-09-07T12:00:00Z'}));assert.equal(calls.length,n);
 await assert.rejects(dbk.run('dbk_history',{device_id:'999',oldest:'2026-09-07T11:00:00Z',newest:'2026-09-07T12:00:00Z'}));assert.equal(calls.at(-1).method,'DELETE');
});
