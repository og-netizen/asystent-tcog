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

const loadData=()=>({client:{id:'client-1'},clientOrderNumber:'REF-TEST',cargoHandlings:[{cargoHandlingType:'ATTACH_SEMITRAILER',term:'2026-10-22T07:00:00+02:00',address:{addressType:'FULL',companyName:'Port',city:'Travemunde',zipCode:'DE23570',streetWithNumber:'Zum Hafenplatz 1'}},{cargoHandlingType:'UNLOADING',term:'2026-10-23T10:30:00+02:00',address:{addressType:'FULL',companyName:'Warehouse',city:'Ennery',zipCode:'FR57365',streetWithNumber:'Rue Marcel Dassault'}}]});
test('Create load: preview does not write, financial keys rejected, payload-bound token, duplicate preflight, one execution',async()=>{
 let created=false;const calls=[];
 const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,key,method='GET',body)=>{
  calls.push({u,method,body});
  if(method==='GET')return {items:created?[{id:'load-1',clientSideOrderNumber:'REF-TEST',statusDescription:'DRAFT',price:200}]:[]};
  created=true;assert.equal(u.pathname,'/api/loads');assert.equal(u.searchParams.get('allowClientOrderNumberDuplicates'),'false');return {id:'load-1',price:200};
 });
 const data=loadData();const p=await c.run('firetms_create_load',{data});
 assert.equal(p.written,false);assert.equal(calls.some(c=>c.method!=='GET'),false);
 await assert.rejects(c.run('firetms_create_load',{data:{...data,price:{amount:200,currencyCode:'EUR'}}}));
 await assert.rejects(c.run('firetms_create_load',{data:{...data,clientOrderNumber:'CHANGED'},apply:true,review_token:p.review_token}));
 const a={data,apply:true,review_token:p.review_token};const r=await c.run('firetms_create_load',a);
 assert.equal(r.written,true);assert.equal(r.data.id,'load-1');assert.equal(r.data.price,undefined);
 assert.equal(r.verification.items[0].statusDescription,'DRAFT');
 await c.run('firetms_create_load',a);assert.equal(calls.filter(c=>c.method==='POST').length,1);
 await assert.rejects(c.run('firetms_create_load',{data}),/duplicate/);
});
test('No automatic retries after ambiguous writes, no execution without a preview',async()=>{
 let posts=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{if(m==='GET')return {items:[]};posts++;throw Error('timeout');});
 const data=loadData();await assert.rejects(c.run('firetms_create_load',{data,apply:true}));
 const p=await c.run('firetms_create_load',{data});
 for(let i=0;i<2;i++)await assert.rejects(c.run('firetms_create_load',{data,apply:true,review_token:p.review_token}),/unknown/);
 assert.equal(posts,1);
});
test('Load update is a complete operational body; PUT is blocked by default without contacting write endpoint',async()=>{
 const methods=[];const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{methods.push(m);return {items:[{id:'load-1'}]};});
 const data=loadData();const p=await c.run('firetms_update_load',{loadId:'load-1',data});
 assert.equal(p.execution_enabled,false);
 await assert.rejects(c.run('firetms_update_load',{loadId:'load-1',data,apply:true,review_token:p.review_token}),/omitted price/);
 assert.ok(methods.every(m=>m==='GET'));
 await assert.rejects(c.run('firetms_update_load',{loadId:'load-1',data:{clientOrderNumber:'new'}}));
});
test('Transport creation validates real truck, load assignment and returns actual status from readback',async()=>{
 let posts=0;let assigned=false;
 const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET',body)=>{
  if(m==='POST'){posts++;assert.deepEqual(body,{truckId:'truck-1',loadIds:['load-1']});return {id:'order-1',orderNumber:'1/26'};}
  if(u.pathname==='/api/internal-trucks')return {items:[{id:'truck-1',regNumber:'TEST'}]};
  if(u.pathname==='/api/loads')return {items:[{id:'load-1',carrierOrderNumber:assigned?'EXISTING':''}]};
  return {id:'order-1',status:'NEEDS_CONFIRMATION',transportSet:{truckId:'truck-1'},price:200};
 });
 const data={truckId:'truck-1',loadIds:['load-1']};
 await assert.rejects(c.run('firetms_create_transport_order',{data:{...data,truckId:'missing'}}),/truck not found/);
 const p=await c.run('firetms_create_transport_order',{data});const r=await c.run('firetms_create_transport_order',{data,apply:true,review_token:p.review_token});
 assert.equal(r.verification.status,'NEEDS_CONFIRMATION');assert.equal(r.verification.price,undefined);assert.equal(posts,1);
 assigned=true;await assert.rejects(c.run('firetms_create_transport_order',{data}),/already assigned/);
});
test('Invalid route chronology, incomplete addresses, terminal cargos, ADR and arbitrary writes fail before HTTP',async()=>{
 let count=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async()=>{count++;return {};});
 const variants=[];let d=loadData();d.cargoHandlings.reverse();variants.push(d);
 d=loadData();delete d.cargoHandlings[0].address.city;variants.push(d);
 d=loadData();d.cargoHandlings[0].cargos=[{cargoName:'x'}];variants.push(d);
 d=loadData();d.cargoHandlings[1].cargos=[{adr:true}];variants.push(d);
 d=loadData();d.cargoHandlings[1].cargos=[{price:123}];variants.push(d);
 for(const data of variants)await assert.rejects(c.run('firetms_create_load',{data}));
 assert.equal(count,0);
 for(const [url,method]of [['https://app.firetms.com/api/payments','POST'],['https://app.firetms.com/api/loads','DELETE'],['https://app.firetms.com/api/orders/123','PUT']])assert.throws(()=>firetmsTransport(new URL(url),'fake',method,{}));
});
test('Read-only tokens discover scoped write descriptors but cannot execute; write scope does not grant accounting or DBK',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const server=createApp(env);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:'http://127.0.0.1/mcp',scope,exp:Date.now()+10000,sub:'1785731'})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 const rpc=async(scope,method,params)=> (await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 try{
  const read=(await rpc('firetms:read','tools/list')).result.tools.map(t=>t.name);assert.deepEqual(read,['firetms_list','firetms_order','firetms_create_load','firetms_create_transport_order','firetms_update_load']);
  const write=(await rpc('firetms:read firetms:write','tools/list')).result.tools;
  assert.ok(write.some(t=>t.name==='firetms_create_load'&&!t.annotations.readOnlyHint));assert.ok(!write.some(t=>t.name.startsWith('wfirma_')||t.name.startsWith('dbk_')));
  const rejected=await rpc('firetms:read','tools/call',{name:'firetms_create_load',arguments:{data:loadData(),apply:true}});assert.equal(rejected.result.isError,true);assert.ok(rejected.result._meta['mcp/www_authenticate'][0].includes('firetms:write'));
  assert.equal((await rpc('firetms:write','tools/call',{name:'firetms_create_load',arguments:{data:loadData()}})).result.isError,true);
  const q=new URLSearchParams({client_id:'asystent-tcog',redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',response_type:'code',scope:'firetms:read firetms:write',code_challenge:'v'.repeat(43),code_challenge_method:'S256'});
  const html=await(await fetch('http://127.0.0.1:'+server.address().port+'/authorize?'+q)).text();assert.ok(html.includes('Zezwól na odczyt i zapis'));assert.ok(!html.includes('To połączenie nie zmienia danych'));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Verified PUT code path sends only validated operational fields to the client-load endpoint',async()=>{
 const writes=[];const c=createFiretms({FIRETMS_API_KEY:'fake',FIRETMS_OPERATIONAL_PUT_VERIFIED:'true'},async(u,k,m='GET',body)=>{
  if(m==='GET')return {items:[{id:'load-1'}]};writes.push({u,m,body});return {};
 });
 const data=loadData();data.cargoHandlings[1].address.streetWithNumber='Updated street 2';
 const p=await c.run('firetms_update_load',{loadId:'load-1',data});assert.equal(p.execution_enabled,true);
 const r=await c.run('firetms_update_load',{loadId:'load-1',data,apply:true,review_token:p.review_token});
 assert.equal(r.written,true);assert.equal(writes.length,1);assert.equal(writes[0].m,'PUT');assert.equal(writes[0].u.pathname,'/api/loads/load-1');assert.deepEqual(writes[0].body,data);assert.equal(writes[0].body.price,undefined);
});
