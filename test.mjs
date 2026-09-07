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
  const page=await req('/authorize?'+params);assert.equal(page.status,200);const html=await page.text();const ticket=html.match(/name="ticket" value="([^"]+)"/)[1];
  const cookie=page.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/authorize',{method:'POST',body:new URLSearchParams({ticket,password:env.ADMIN_PASSWORD})})).status,400);
  const auth=await req('/authorize',{method:'POST',headers:{Cookie:cookie},body:new URLSearchParams({ticket,password:env.ADMIN_PASSWORD})});assert.equal(auth.status,303);
  const back=new URL(auth.headers.get('location'));assert.equal(back.searchParams.get('state'),'abc');
  const tokenParams={grant_type:'authorization_code',client_id:'asystent-tcog',client_secret:env.OAUTH_CLIENT_SECRET,redirect_uri:params.get('redirect_uri'),code:back.searchParams.get('code'),code_verifier:verifier};
  assert.equal((await req('/token',{method:'POST',body:new URLSearchParams({...tokenParams,code_verifier:'bad'})})).status,400);
  const tokenResponse=await req('/token',{method:'POST',body:new URLSearchParams(tokenParams)});assert.equal(tokenResponse.status,200);const {access_token:token}=await tokenResponse.json();
  assert.equal((await req('/token',{method:'POST',body:new URLSearchParams(tokenParams)})).status,400);
  const rpc=async(method,params)=>{const r=await req('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);return r.json();};
  assert.equal((await rpc('initialize',{})).result.protocolVersion,'2025-03-26');
  const listing=await rpc('tools/list');assert.equal(listing.result.tools.length,3);assert.ok(listing.result.tools.every(t=>t.annotations.readOnlyHint));
  await rpc('tools/call',{name:'wfirma_company'});assert.equal(calls[0][1],'companies');assert.equal(calls[0][2],'1785731');
  await rpc('tools/call',{name:'wfirma_list',arguments:{resource:'expenses',page:2,limit:5}});assert.deepEqual(calls[1].slice(1),['expenses',undefined,2,5]);
  for(const args of [{name:'wfirma_delete'},{name:'wfirma_get',arguments:{resource:'expenses',id:'../delete/1'}},{name:'wfirma_list',arguments:{resource:'expenses',company_id:'2'}},{name:'wfirma_list',arguments:{resource:'expenses',limit:500}}])assert.equal((await rpc('tools/call',args)).error.code,-32602);
  assert.equal(calls.length,2);
  assert.equal((await req('/mcp',{method:'POST',headers:{Authorization:'Bearer '+token+'x'},body:'{}'})).status,401);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Fails closed when required configuration is absent',()=>{assert.throws(()=>createApp({}));});
