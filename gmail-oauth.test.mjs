import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from './server.mjs';
import {createFreePilot} from './pilot/free-start.mjs';
import {createGmailOAuth,gmailVault,GMAIL_SCOPES} from './gmail-oauth.mjs';

const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake',GOOGLE_GMAIL_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_GMAIL_CLIENT_SECRET:'test-client-secret'};
const jar=r=>r.headers.get('set-cookie')?.split(';')[0]||'';
async function start(config=env,vendor=async()=>{throw Error('Unexpected vendor request');}) {
 const server=createApp(config,undefined,{gmailOAuth:{fetchImpl:vendor}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 return {server,request:(path,options={})=>fetch(base+path,{redirect:'manual',...options}),close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
async function connect(app){
 const page=await app.request('/google/oauth/start');assert.equal(page.status,200);
 const html=await page.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 const response=await app.request('/google/oauth/start',{method:'POST',headers:{Origin:env.PUBLIC_URL,Cookie:jar(page)},body:new URLSearchParams({csrf,password:env.ADMIN_PASSWORD,action:'connect'})});
 assert.equal(response.status,303);assert.ok(response.headers.get('content-security-policy').includes("form-action 'self' https://accounts.google.com;"));return {cookie:jar(response),url:new URL(response.headers.get('location'))};
}
test('Google encryption is tamper, origin and purpose bound',()=>{
 const v=gmailVault(env.OAUTH_CLIENT_SECRET,env.PUBLIC_URL),sealed=v.seal('refresh-token',{refreshToken:'sensitive'});
 assert.equal(sealed.includes('sensitive'),false);assert.equal(v.open('refresh-token',sealed).refreshToken,'sensitive');
 assert.equal(v.open('authorization',sealed),null);assert.equal(v.open('refresh-token',sealed+'x'),null);
 assert.equal(gmailVault('other',env.PUBLIC_URL).open('refresh-token',sealed),null);
 assert.equal(gmailVault(env.OAUTH_CLIENT_SECRET,'https://other.example').open('refresh-token',sealed),null);
});
test('Google OAuth disabled without credentials; existing health still works',async()=>{
 const app=await start({...env,GOOGLE_GMAIL_CLIENT_SECRET:''});
 try{assert.equal((await app.request('/health')).status,200);assert.equal((await app.request('/google/oauth/start')).status,503);}finally{await app.close();}
});
test('Render npm-start wrapper forwards Google routes instead of the temporary pilot',async()=>{
 const app=await createFreePilot({...env,GOOGLE_GMAIL_CLIENT_SECRET:''},{run:async()=>({vehicles:[]})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try {
  const base='http://127.0.0.1:'+app.server.address().port;
  const r=await fetch(base+'/google/oauth/start');assert.equal(r.status,503);assert.ok((await r.text()).includes('GOOGLE_GMAIL_CLIENT_ID'));
 } finally {app.server.closeAllConnections();await app.close();}
});
test('Google requires admin, same origin and CSRF; emits PKCE/offline and rejects unsolicited callback',async()=>{
 const app=await start();
 try{
  assert.equal((await app.request('/google/oauth/callback?code=secret')).status,400);
  const page=await app.request('/google/oauth/start');assert.equal(page.headers.get('referrer-policy'),'same-origin');assert.ok(page.headers.get('content-security-policy').includes("form-action 'self' https://accounts.google.com;"));const html=await page.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  const post=(origin,cookie,password,token=csrf)=>app.request('/google/oauth/start',{method:'POST',headers:{...(origin?{Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},body:new URLSearchParams({csrf:token,password,action:'connect'})});
  assert.equal((await post('https://evil.example',jar(page),env.ADMIN_PASSWORD)).status,403);
  assert.equal((await post('null',jar(page),env.ADMIN_PASSWORD)).status,403);
  assert.equal((await post(undefined,jar(page),env.ADMIN_PASSWORD)).status,403);
  assert.equal((await post(env.PUBLIC_URL,undefined,env.ADMIN_PASSWORD,'')).status,400);
  assert.equal((await post(env.PUBLIC_URL,undefined,'bad')).status,403);
  const anotherPage=await app.request('/google/oauth/start');
  assert.equal(anotherPage.headers.get('set-cookie'),null);
  const independent=await post(env.PUBLIC_URL,undefined,env.ADMIN_PASSWORD);
  assert.equal(independent.status,303); // Older form still works after another tab opens.
  assert.equal((await post(env.PUBLIC_URL,jar(page),env.ADMIN_PASSWORD,'bad')).status,400);
  assert.equal((await post(env.PUBLIC_URL,jar(page),'bad')).status,403);
  const flow=await connect(app);assert.equal(flow.url.origin,'https://accounts.google.com');
  assert.equal(flow.url.searchParams.get('access_type'),'offline');assert.equal(flow.url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(flow.url.searchParams.get('redirect_uri'),env.PUBLIC_URL+'/google/oauth/callback');
  assert.equal(flow.url.searchParams.get('login_hint'),'og@tcog.pl');
  assert.equal((await app.request('/google/oauth/callback?state=wrong&code=secret',{headers:{Cookie:flow.cookie}})).status,400);
 }finally{await app.close();}
});
test('Google callback verifies account/scopes, exports only encrypted refresh token and survives server restart',async()=>{
 const calls=[];
 const vendor=async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'error');
  if(url==='https://oauth2.googleapis.com/token'){
   const p=options.body;assert.equal(p.get('client_secret'),env.GOOGLE_GMAIL_CLIENT_SECRET);
   if(p.get('grant_type')==='authorization_code')assert.ok(p.get('code_verifier'));
   else assert.equal(p.get('refresh_token'),'raw-refresh-secret');
   return new Response(JSON.stringify({access_token:'raw-access-secret',refresh_token:'raw-refresh-secret',scope:GMAIL_SCOPES.join(' ')}));
  }
  assert.equal(options.headers.Authorization,'Bearer raw-access-secret');return new Response(JSON.stringify({emailAddress:'og@tcog.pl'}));
 };
 const app=await start(env,vendor);const flow=await connect(app);await app.close();
 const restarted=await start(env,vendor);
 try{
  const back='/google/oauth/callback?state='+flow.url.searchParams.get('state')+'&code=test-code';
  const response=await restarted.request(back,{headers:{Cookie:flow.cookie}});assert.equal(response.status,200);
  const html=await response.text();assert.equal(html.includes('raw-refresh-secret'),false);assert.equal(html.includes('raw-access-secret'),false);
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  const sealed=html.match(/<textarea[^>]+>([^<]+)<\/textarea>/)[1];
  assert.equal(gmailVault(env.OAUTH_CLIENT_SECRET,env.PUBLIC_URL).open('refresh-token',sealed).email,'og@tcog.pl');
  assert.equal((await restarted.request(back,{headers:{Cookie:flow.cookie}})).status,400);assert.equal(calls.length,2);
  const saved=createGmailOAuth({...env,GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED:sealed},{fetchImpl:vendor});
  assert.equal((await saved.checkSaved()).emailAddress,'og@tcog.pl');
 }finally{await restarted.close();}
});
test('Google rejects wrong mailbox, missing scopes and vendor-secret error bodies',async()=>{
 for(const failure of ['wrong_account','missing_scopes','vendor']){
  const app=await start(env,async url=>{
   if(failure==='vendor')return new Response('RAW_SECRET',{status:400});
   if(url.includes('/token'))return new Response(JSON.stringify({access_token:'TOKEN',refresh_token:'REFRESH',scope:failure==='missing_scopes'?GMAIL_SCOPES[0]:GMAIL_SCOPES.join(' ')}));
   return new Response(JSON.stringify({emailAddress:'wrong@example.com'}));
  });
  try{const flow=await connect(app);const r=await app.request('/google/oauth/callback?state='+flow.url.searchParams.get('state')+'&code=secret',{headers:{Cookie:flow.cookie}});assert.equal(r.status,400);const h=await r.text();assert.equal(h.includes('RAW_SECRET'),false);assert.equal(h.includes('<textarea'),false);if(failure!=='vendor')assert.ok(h.includes(failure));}finally{await app.close();}
 }
});

test('Stored Gmail credential only reaches fixed profile, label and filter endpoints; empty DELETE works',async()=>{
 const configured={...env,GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED:gmailVault(env.OAUTH_CLIENT_SECRET,env.PUBLIC_URL).seal('refresh-token',{clientId:env.GOOGLE_GMAIL_CLIENT_ID,email:'og@tcog.pl',refreshToken:'fake-refresh',scope:GMAIL_SCOPES.join(' ')})};
 const calls=[];const oauth=createGmailOAuth(configured,{fetchImpl:async(url,o)=>{calls.push({url,method:o.method||'GET'});if(url.endsWith('/token'))return new Response(JSON.stringify({access_token:'fake-access',scope:GMAIL_SCOPES.join(' ')}));if(url.endsWith('/profile'))return new Response(JSON.stringify({emailAddress:'og@tcog.pl'}));assert.equal(o.headers.Authorization,'Bearer fake-access');if(o.method==='DELETE')return new Response(null,{status:204});return new Response(JSON.stringify(url.endsWith('/labels')?{labels:[]}:{filter:[]}));}});
 assert.deepEqual(await oauth.request('GET','labels'),{labels:[]});assert.deepEqual(await oauth.request('DELETE','settings/filters/abc-123'),{});
 const before=calls.filter(c=>!c.url.endsWith('/token')&&!c.url.endsWith('/profile')).length;
 for(const [m,p]of [['POST','messages/send'],['GET','../../evil'],['DELETE','messages/123'],['POST','labels']])await assert.rejects(oauth.request(m,p),/google_destination/);
 assert.equal(calls.filter(c=>!c.url.endsWith('/token')&&!c.url.endsWith('/profile')).length,before);
});
