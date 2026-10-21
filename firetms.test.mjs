import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFiretms,projectFiretms,firetmsTransport} from './firetms.mjs';
test('FireTMS uses bounded read endpoints and strips financial and unknown fields',async()=>{
 const calls=[];
 const client=createFiretms({FIRETMS_API_KEY:'fake'},async(url,key)=>{
  calls.push(url);assert.equal(key,'fake');
  return {items:[{id:'1',regNumber:'TKI7539R',price:'SECRET',bankAccount:'SECRET',routePoints:[{address:{streetWithNumber:'Street 1',zipcode:'12345',city:'Test'},completionTimestamp:'2026-10-21T10:00:00Z',price:100}]}],paging:{pageNumber:1,pageSize:2},futureFinancialField:123};
 });
 const r=await client.run('firetms_list',{resource:'trucks',filter:'TKI7539R',size:2});
 assert.equal(calls[0].pathname,'/api/internal-trucks');assert.equal(calls[0].searchParams.get('page'),'1');
 assert.equal(calls[0].searchParams.get('query'),'regNumber=="TKI7539R"');
 assert.equal(r.data.items[0].routePoints[0].address.streetWithNumber,'Street 1');
 assert.equal(JSON.stringify(r).includes('SECRET'),false);assert.equal(r.data.futureFinancialField,undefined);
 await client.run('firetms_order',{id:'abc-123'});assert.equal(calls[1].pathname,'/api/orders/abc-123');
 const count=calls.length;
 for(const a of [{resource:'payments'},{resource:'orders',size:500},{resource:'trucks',filter:'a";price>0'},{resource:'orders',url:'https://evil.example'}])await assert.rejects(client.run('firetms_list',a));
 await assert.rejects(client.run('firetms_order',{id:'../invoices'}));
 await assert.rejects(client.run('firetms_create',{}));assert.equal(calls.length,count);
});
test('FireTMS fails closed without credentials or with arbitrary upstream',async()=>{
 await assert.rejects(createFiretms({}).run('firetms_list',{resource:'trucks'}));
 assert.throws(()=>createFiretms({FIRETMS_BASE_URL:'https://evil.example/api'}));
 assert.throws(()=>firetmsTransport(new URL('https://evil.example/api/trucks'),'fake'));
 assert.deepEqual(projectFiretms({price:1,totalExpenses:2,items:[{id:'1',newField:3}]}),{items:[{id:'1'}]});
});

import {createHmac} from 'node:crypto';
import {createApp} from './server.mjs';
test('FireTMS scope is isolated from accounting and old tokens cannot invoke it',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const server=createApp(env);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:'http://127.0.0.1/mcp',scope,exp:Date.now()+10000,sub:'1785731'})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 const rpc=async(scope,method,params)=> (await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 try{
  const names=(await rpc('firetms:read','tools/list')).result.tools.map(t=>t.name);
  assert.ok(names.includes('firetms_list'));assert.ok(!names.includes('wfirma_list'));
  assert.equal((await rpc('wfirma:read','tools/call',{name:'firetms_list',arguments:{resource:'trucks'}})).result.isError,true);
  assert.equal((await rpc('firetms:read','tools/call',{name:'wfirma_company'})).error.code,-32602);
  assert.equal((await rpc('firetms:read','tools/call',{name:'firetms_list',arguments:{resource:'trucks'}})).result.isError,true);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
