import {createMemoryStateStore} from './state-store.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFiretms,projectFiretms,firetmsTransport} from './firetms.mjs';

function forwardingStore(basePoint='INVOICE_RECEIPT',days=35){const store=createMemoryStateStore();store.memoryLatest=async()=>({operation:'upsert',revision:1,content:{rule:JSON.stringify({version:1,departmentId:'department',receiptDescription:'od otrzymania dokumentów',apiBasePoint:basePoint,carriers:['carrier-1','carrier-a','carrier-b'].map(id=>({id,days}))})}});return store;}
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

const loadData=()=>({receptionDate:'2026-10-21T12:00:00+02:00',client:{id:'client-1'},clientOrderNumber:'REF-TEST',cargoHandlings:[{cargoHandlingType:'ATTACH_SEMITRAILER',term:'2026-10-22T07:00:00+02:00',address:{addressType:'FULL',companyName:'Port',city:'Travemunde',zipCode:'DE23570',streetWithNumber:'Zum Hafenplatz 1'}},{cargoHandlingType:'UNLOADING',term:'2026-10-23T10:30:00+02:00',address:{addressType:'FULL',companyName:'Warehouse',city:'Ennery',zipCode:'FR57365',streetWithNumber:'Rue Marcel Dassault'}}]});
const updateLoadData=()=>{const {receptionDate,...data}=loadData();return data;};
test('Create load: preview does not write, financial keys rejected, payload-bound token, duplicate preflight, one execution',async()=>{
 let created=false;const calls=[];
 const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,key,method='GET',body)=>{
  calls.push({u,method,body});
  if(method==='GET')return {items:created?[{id:'load-1',clientSideOrderNumber:'REF-TEST',statusDescription:'DRAFT',price:200}]:[]};
  created=true;assert.deepEqual(body.price,{amount:1,currencyCode:'EUR'});assert.ok(body.internalNote.includes('KWOTY TYMCZASOWE'));assert.equal(u.pathname,'/api/loads');assert.equal(u.searchParams.get('allowClientOrderNumberDuplicates'),'false');return {id:'load-1',price:200};
 });
 const data=loadData();const p=await c.run('firetms_preview_create_load',{data});
 assert.equal(p.written,false);assert.equal(calls.some(c=>c.method!=='GET'),false);
 await assert.rejects(c.run('firetms_preview_create_load',{data:{...data,price:{amount:200,currencyCode:'EUR'}}}));
 await assert.rejects(c.run('firetms_create_load',{data:{...data,clientOrderNumber:'CHANGED'},review_token:p.review_token}));
 const a={data,review_token:p.review_token};const r=await c.run('firetms_create_load',a);
 assert.equal(r.written,true);assert.equal(r.data.id,'load-1');assert.equal(r.data.price,undefined);
 assert.equal(r.verification.items[0].statusDescription,'DRAFT');
 await c.run('firetms_create_load',a);assert.equal(calls.filter(c=>c.method==='POST').length,1);
 await assert.rejects(c.run('firetms_preview_create_load',{data}),/duplicate/);
});
test('No automatic retries after ambiguous writes, no execution without a preview',async()=>{
 let posts=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{if(m==='GET')return {items:[]};posts++;throw Error('timeout');});
 const data=loadData();await assert.rejects(c.run('firetms_create_load',{data}));
 const p=await c.run('firetms_preview_create_load',{data});
 for(let i=0;i<2;i++)await assert.rejects(c.run('firetms_create_load',{data,review_token:p.review_token}),/unknown/);
 assert.equal(posts,1);
});
test('Load update is a complete operational body; PUT is blocked by default without contacting write endpoint',async()=>{
 const methods=[];const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{methods.push(m);return {items:[{id:'load-1'}]};});
 const data=updateLoadData();const p=await c.run('firetms_preview_update_load',{loadId:'load-1',data});
 assert.equal(p.execution_enabled,false);
 await assert.rejects(c.run('firetms_update_load',{loadId:'load-1',data,review_token:p.review_token}),/omitted price/);
 assert.ok(methods.every(m=>m==='GET'));
 await assert.rejects(c.run('firetms_preview_update_load',{loadId:'load-1',data:{clientOrderNumber:'new'}}));
});
test('Transport creation validates real truck, load assignment and returns actual status from readback',async()=>{
 let posts=0;let assigned=false;
 const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET',body)=>{
  if(m==='POST'){posts++;assert.deepEqual(body,{truckId:'truck-1',loadIds:['load-1']});return {id:'order-1',orderNumber:'1/26'};}
  if(u.pathname==='/api/internal-trucks')return {items:[{id:'truck-1',regNumber:'TEST'}]};
  if(u.pathname==='/api/external-trucks')return {items:[]};
  if(u.pathname==='/api/loads')return {items:[{id:'load-1',carrierOrderNumber:assigned?'EXISTING':''}]};
  return {id:'order-1',status:'NEEDS_CONFIRMATION',transportSet:{truckId:'truck-1'},price:200};
 });
 const data={truckId:'truck-1',loadIds:['load-1']};
 await assert.rejects(c.run('firetms_preview_create_transport_order',{data:{...data,truckId:'missing'}}),/truck not found/);
 const p=await c.run('firetms_preview_create_transport_order',{data});const r=await c.run('firetms_create_transport_order',{data,review_token:p.review_token});
 assert.equal(r.verification.status,'NEEDS_CONFIRMATION');assert.equal(r.verification.price,undefined);assert.equal(posts,1);
 assigned=true;await assert.rejects(c.run('firetms_preview_create_transport_order',{data}),/already assigned/);
});
test('Invalid route chronology, incomplete addresses, terminal cargos, ADR and arbitrary writes fail before HTTP',async()=>{
 let count=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async()=>{count++;return {};});
 const variants=[];let d=loadData();d.cargoHandlings.reverse();variants.push(d);
 d=loadData();delete d.cargoHandlings[0].address.city;variants.push(d);
 d=loadData();d.cargoHandlings[0].cargos=[{cargoName:'x'}];variants.push(d);
 d=loadData();d.cargoHandlings[1].cargos=[{adr:true}];variants.push(d);
 d=loadData();d.cargoHandlings[1].cargos=[{price:123}];variants.push(d);
 for(const data of variants)await assert.rejects(c.run('firetms_preview_create_load',{data}));
 assert.equal(count,0);
 for(const [url,method]of [['https://app.firetms.com/api/payments','POST'],['https://app.firetms.com/api/loads','DELETE'],['https://app.firetms.com/api/orders/123','PUT']])assert.throws(()=>firetmsTransport(new URL(url),'fake',method,{}));
});
test('Read-only tokens discover scoped write descriptors but cannot execute; write scope does not grant accounting or DBK',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake'};
 const server=createApp(env);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:'http://127.0.0.1/mcp',scope,exp:Date.now()+10000,sub:'1785731'})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 const rpc=async(scope,method,params)=> (await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 try{
  const read=(await rpc('firetms:read','tools/list')).result.tools.map(t=>t.name);assert.deepEqual(read.filter(n=>n.startsWith('firetms_')),['firetms_list','firetms_order','firetms_preview_create_load','firetms_preview_create_transport_order','firetms_preview_update_load','firetms_create_load','firetms_create_transport_order','firetms_update_load']);
  assert.ok(read.includes('memory_lookup'));
  const write=(await rpc('firetms:read firetms:write','tools/list')).result.tools;
  assert.ok(write.some(t=>t.name==='firetms_create_load'&&!t.annotations.readOnlyHint));assert.ok(!write.some(t=>t.name.startsWith('wfirma_')||t.name.startsWith('dbk_')));
  const rejected=await rpc('firetms:read','tools/call',{name:'firetms_create_load',arguments:{data:loadData()}});assert.equal(rejected.result.isError,true);assert.ok(rejected.result._meta['mcp/www_authenticate'][0].includes('firetms:write'));
  assert.equal((await rpc('firetms:write','tools/call',{name:'firetms_create_load',arguments:{data:loadData()}})).result.isError,true);
  const q=new URLSearchParams({client_id:'asystent-tcog',redirect_uri:'https://chatgpt.com/connector_platform/oauth_redirect',response_type:'code',scope:'firetms:read firetms:write',code_challenge:'v'.repeat(43),code_challenge_method:'S256'});
  const html=await(await fetch('http://127.0.0.1:'+server.address().port+'/authorize?'+q)).text();assert.ok(html.includes('Zezwól na odczyt i zapis'));assert.ok(!html.includes('To połączenie nie zmienia danych'));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Verified PUT code path sends only validated operational fields to the client-load endpoint',async()=>{
 const writes=[];const c=createFiretms({FIRETMS_API_KEY:'fake',FIRETMS_OPERATIONAL_PUT_VERIFIED:'true'},async(u,k,m='GET',body)=>{
  if(m==='GET')return {items:[{id:'load-1'}]};writes.push({u,m,body});return {};
 });
 const data=updateLoadData();data.cargoHandlings[1].address.streetWithNumber='Updated street 2';
 const p=await c.run('firetms_preview_update_load',{loadId:'load-1',data});assert.equal(p.execution_enabled,true);
 const r=await c.run('firetms_update_load',{loadId:'load-1',data,review_token:p.review_token});
 assert.equal(r.written,true);assert.equal(writes.length,1);assert.equal(writes[0].m,'PUT');assert.equal(writes[0].u.pathname,'/api/loads/load-1');assert.deepEqual(writes[0].body,data);assert.equal(writes[0].body.price,undefined);
});
test('External carrier truck creates an unconfirmed forwarding order and is discoverable by registration',async()=>{
 const writes=[];const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET',body)=>{
  if(m==='POST'){writes.push({u,body});return {id:'forward-1'};}
  if(u.pathname==='/api/internal-trucks')return {items:[]};
  if(u.pathname==='/api/external-trucks')return {items:[{id:'external-1',regNumber:'WPR1810T',carrierId:'carrier-1'}]};
  if(u.pathname==='/api/departments')return {items:[{id:'department'}]};
  if(u.pathname==='/api/loads')return {items:[{id:'load-1'}]};
  if(u.pathname==='/api/contractors')return {items:[{id:'carrier-1',carrier:true,deleted:false,grade:'NEUTRAL'}]};
  return {id:'forward-1',status:'NEW'};
 },forwardingStore());
 const read=await c.run('firetms_list',{resource:'trucks',filter:'WPR1810T'});assert.equal(read.data.items[0].id,'external-1');
 const data={truckId:'external-1',loadIds:['load-1']};const p=await c.run('firetms_preview_create_transport_order',{data});assert.equal(p.path,'/forwarding-order');
 const r=await c.run('firetms_create_transport_order',{data,review_token:p.review_token});assert.equal(r.verification.status,'NEW');assert.equal(writes[0].u.pathname,'/api/forwarding-order');assert.equal(writes[0].u.searchParams.get('confirm'),'false');assert.deepEqual(writes[0].body,{...data,carrierId:'carrier-1',departmentId:'department',paymentTerm:{basePoint:'INVOICE_RECEIPT',daysOffset:35,offsetType:'SET_AMOUNT_OF_DAYS'},cost:{fixedAmount:1,currencyCode:'EUR'},notes:writes[0].body.notes});assert.ok(writes[0].body.notes.includes('KWOTY TYMCZASOWE'));
});
test('Definite vendor validation rejection reports HTTP and field names and never repeats the attempt',async()=>{
 let posts=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{if(m==='GET')return {items:[]};posts++;throw Error('FireTMS HTTP 400 fields price');});
 const data=loadData();const p=await c.run('firetms_preview_create_load',{data});
 for(let i=0;i<2;i++)await assert.rejects(c.run('firetms_create_load',{data,review_token:p.review_token}),/HTTP 400 fields price/);
 assert.equal(posts,1);
});


test('Separate preview contracts reject execution flags before upstream access',async()=>{
 const {firetmsPreviewTools,firetmsWriteTools}=await import('./firetms-writes.mjs');
 let calls=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async()=>{calls++;return {items:[]};});
 assert.equal(firetmsPreviewTools.length,3);
 for(const t of firetmsPreviewTools){
  assert.equal(t.annotations.readOnlyHint,true);assert.equal(t.annotations.destructiveHint,false);
  assert.deepEqual(t.securitySchemes[0].scopes,['firetms:read']);
  assert.equal(t.inputSchema.properties.apply,undefined);assert.equal(t.inputSchema.properties.review_token,undefined);
  const a=t.name.includes('transport')?{data:{truckId:'truck-1',loadIds:['load-1']}}:{data:loadData(),...(t.name.includes('update')?{loadId:'load-1'}:{})};
  for(const apply of [true,false])await assert.rejects(c.run(t.name,{...a,apply}),/validation failed/);
  await assert.rejects(c.run(t.name,{...a,review_token:'unexpected'}),/validation failed/);
 }
 for(const t of firetmsWriteTools){
  assert.equal(t.annotations.readOnlyHint,false);assert.ok(t.inputSchema.required.includes('review_token'));
  assert.equal(t.inputSchema.properties.apply,undefined);
 }
 assert.equal(calls,0);
});

test('MCP read scope prepares preview; only write scope can execute its bound receipt',async()=>{
 const calls=[];let created=false;
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'1785731',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake',FIRETMS_API_KEY:'fake'};
 const server=createApp(env,undefined,{firetmsTransport:async(u,k,m='GET',body)=>{
  calls.push(m);if(m==='GET')return {items:created?[{id:'load-1'}]:[]};created=true;return {id:'load-1'};
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:'http://127.0.0.1/mcp',scope,exp:Date.now()+10000,sub:'1785731'})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 const rpc=async(scope,name,args)=>(await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json();
 try{
  const data=loadData();
  const preview=await rpc('firetms:read','firetms_preview_create_load',{data});
  assert.notEqual(preview.result.isError,true);const p=JSON.parse(preview.result.content[0].text);
  assert.equal(p.written,false);assert.ok(p.review_token);assert.ok(calls.every(m=>m==='GET'));
  const execute={data,review_token:p.review_token};
  const denied=await rpc('firetms:read','firetms_create_load',execute);assert.equal(denied.result.isError,true);assert.ok(calls.every(m=>m==='GET'));
  const stale=await rpc('firetms:read firetms:write','firetms_create_load',{data,apply:false});assert.equal(stale.result.isError,true);assert.ok(calls.every(m=>m==='GET'));
  const accepted=await rpc('firetms:read firetms:write','firetms_create_load',execute);assert.equal(JSON.parse(accepted.result.content[0].text).written,true);
  await rpc('firetms:read firetms:write','firetms_create_load',execute);assert.equal(calls.filter(m=>m==='POST').length,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('Known vendor constraints fail before any HTTP: reception date, cargo fields and postal formats',async()=>{
 let calls=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async()=>{calls++;throw Error('unexpected HTTP');});
 const missing=loadData();delete missing.receptionDate;
 await assert.rejects(c.run('firetms_preview_create_load',{data:missing}),/arguments.data.receptionDate/);
 const cargo={cargoName:'Tools',quantity:2,unitName:'Box'};
 for(const field of ['cargoName','quantity','unitName']){
  const data=loadData();data.cargoHandlings[1].cargos=[{...cargo}];delete data.cargoHandlings[1].cargos[0][field];
  await assert.rejects(c.run('firetms_preview_create_load',{data}),new RegExp('cargoHandlings.1.cargos.0.'+field));
 }
 for(const bad of [{quantity:0},{quantity:-1},{cargoName:' '},{unitName:''}]){
  const data=loadData();data.cargoHandlings[1].cargos=[{...cargo,...bad}];
  await assert.rejects(c.run('firetms_preview_create_load',{data}),/cargoHandlings.1.cargos.0/);
 }
 for(const zipCode of ['23570','DE-23570','DE 23570','DE1234','IT123456','NL4004','FR57.365']){
  const data=loadData();data.cargoHandlings[0].address.zipCode=zipCode;
  await assert.rejects(c.run('firetms_preview_create_load',{data}),/cargoHandlings.0.address.zipCode/);
 }
 const incomplete=loadData();incomplete.cargoHandlings[0].address.coordinate={latitude:53};
 await assert.rejects(c.run('firetms_preview_create_load',{data:incomplete}),/coordinate.longitude/);
 assert.equal(calls,0);
});

test('Empty cargos are valid; actual units are verified in the paginated tenant dictionary before POST',async()=>{
 const calls=[];const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET',body)=>{
  calls.push({u,m,body});
  if(u.pathname==='/api/unit-of-measure')return u.searchParams.get('page')==='1'?{items:Array.from({length:50},(_,i)=>({defaultName:'other-'+i})),maxPageNumber:2}:{items:[{defaultName:'Verified box',id:'unit-1',price:'SECRET'}],maxPageNumber:2};
  if(m==='POST')return {id:'created'};
  return {items:[]};
 });
 const empty=loadData();for(const p of empty.cargoHandlings)p.cargos=[];
 await c.run('firetms_preview_create_load',{data:empty});assert.ok(!calls.some(x=>x.u.pathname==='/api/unit-of-measure'));
 const data=loadData();data.cargoHandlings[1].cargos=[{cargoName:'Tools',quantity:10,unitName:'fracht'}];
 await assert.rejects(c.run('firetms_preview_create_load',{data}),/unit not found/);assert.ok(!calls.some(x=>x.m==='POST'));
 data.cargoHandlings[1].cargos[0].unitName='Verified box';
 const p=await c.run('firetms_preview_create_load',{data});assert.equal(p.written,false);
 const written=await c.run('firetms_create_load',{data,review_token:p.review_token});assert.equal(written.written,true);
 assert.equal(calls.filter(x=>x.m==='POST').length,1);
 const units=await c.run('firetms_list',{resource:'units',page:2,filter:'Verified box'});
 assert.equal(units.data.items[0].defaultName,'Verified box');assert.equal(units.data.items[0].price,undefined);
 assert.equal(calls.at(-1).u.searchParams.get('query'),'searchField=="Verified box"');
});

test('External-order preflight blocks inactive carriers and drafts without any POST',async()=>{
 for(const variant of ['missingCarrier','notCarrier','deleted','blocked','unknownGrade','draft']){
  let posts=0;
  const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{
   if(m!=='GET'){posts++;throw Error('unexpected POST');}
   if(u.pathname==='/api/internal-trucks')return {items:[]};
   if(u.pathname==='/api/external-trucks')return {items:[{id:'truck',carrierId:variant==='missingCarrier'?null:'carrier'}]};
   if(u.pathname==='/api/contractors')return {items:[{id:'carrier',carrier:variant!=='notCarrier',deleted:variant==='deleted',grade:variant==='blocked'?'BLACKLISTED_BLOCKED':variant==='unknownGrade'?null:'NEUTRAL'}]};
   return {items:[{id:'load',statusDescription:variant==='draft'?'DRAFT':'READY'}]};
  });
  await assert.rejects(c.run('firetms_preview_create_transport_order',{data:{truckId:'truck',loadIds:['load']}}),/carrier|draft/);
  assert.equal(posts,0);
 }
});

test('Carrier resolution is bound to the preview; changing truck carrier cannot change a reviewed payload',async()=>{
 let carrier='carrier-a',posts=0;
 const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{
  if(m==='POST'){posts++;return {id:'order'};}
  if(u.pathname==='/api/internal-trucks')return {items:[]};
  if(u.pathname==='/api/external-trucks')return {items:[{id:'truck',carrierId:carrier}]};
  if(u.pathname==='/api/contractors')return {items:[{id:carrier,carrier:true,deleted:false,grade:'NEUTRAL'}]};
  if(u.pathname==='/api/departments')return {items:[{id:'department'}]};
  return {items:[{id:'load'}]};
 },forwardingStore());
 const data={truckId:'truck',loadIds:['load']};const p=await c.run('firetms_preview_create_transport_order',{data});
 assert.equal(p.data.carrierId,'carrier-a');carrier='carrier-b';
 await assert.rejects(c.run('firetms_create_transport_order',{data,review_token:p.review_token}),/carrier changed/);assert.equal(posts,0);
});

test('Structured vendor errors retain request_id, all errors and redaction across uncertain writes',async()=>{
 const {firetmsHttpFailure}=await import('./firetms.mjs');
 const errors=['Reception date is required',...Array.from({length:15},(_,i)=>'Field '+i+' has invalid value')];
 const raw=JSON.stringify({message:'Invalid body constraints',errors,request_id:'req-500',detail:'secret-api-key',apikey:'secret-api-key',unrelatedFinancialField:123});
 const failure=firetmsHttpFailure(raw,500,'secret-api-key',{method:'POST',path:'/api/forwarding-order',operationId:'local-op'});
 assert.equal(failure.firetms.body.request_id,'req-500');assert.deepEqual(failure.firetms.body.errors,errors);
 assert.equal(failure.firetms.body.detail,'REDACTED');assert.equal(failure.firetms.body.apikey,undefined);assert.equal(failure.firetms.body.unrelatedFinancialField,undefined);
 assert.ok(!JSON.stringify(failure.firetms).includes('secret-api-key'));
 let posts=0;const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{if(m==='GET')return {items:[]};posts++;throw failure;});
 const data=loadData();const p=await c.run('firetms_preview_create_load',{data});
 await assert.rejects(c.run('firetms_create_load',{data,review_token:p.review_token}),e=>e.firetms.body.request_id==='req-500'&&e.firetms.outcome==='unknown'&&e.firetms.retry===false);
 await assert.rejects(c.run('firetms_create_load',{data,review_token:p.review_token}),/unknown/);assert.equal(posts,1);
 const big=firetmsHttpFailure(JSON.stringify({errors:['x'.repeat(20000)]}),400,'key');assert.equal(big.firetms.body_truncated,true);
});

test('MCP exposes structured vendor rejection and preserves it on repeated rejected receipt without a second POST',async()=>{
 const {firetmsHttpFailure}=await import('./firetms.mjs');let posts=0;
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'999999',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake',FIRETMS_API_KEY:'fake'};
 const server=createApp(env,undefined,{firetmsTransport:async(u,k,m='GET')=>{if(m==='GET')return {items:[]};posts++;throw firetmsHttpFailure(JSON.stringify({message:'Invalid',errors:['quantity must be positive','unitName missing'],request_id:'req-400'}),400,'fake',{method:m,path:u.pathname});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const v=Buffer.from(JSON.stringify({aud:'http://127.0.0.1/mcp',scope:'firetms:read firetms:write',exp:Date.now()+10000,sub:'999999'})).toString('base64url');
 const token=v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');
 const rpc=async(name,args)=>(await fetch('http://127.0.0.1:'+server.address().port+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json();
 try{
  const data=loadData();const p=JSON.parse((await rpc('firetms_preview_create_load',{data})).result.content[0].text);
  for(let i=0;i<2;i++){
   const r=(await rpc('firetms_create_load',{data,review_token:p.review_token})).result;assert.equal(r.isError,true);
   const detail=JSON.parse(r.content[0].text);assert.equal(detail.http_status,400);assert.equal(detail.body.request_id,'req-400');assert.equal(detail.body.errors.length,2);
  }
  assert.equal(posts,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('External preview refuses unspecified receipt basis before any POST',async()=>{
 let posts=0;const store=forwardingStore(null);
 const c=createFiretms({FIRETMS_API_KEY:'fake'},async(u,k,m='GET')=>{if(m==='POST'){posts++;return {};}if(u.pathname.endsWith('/internal-trucks'))return {items:[]};if(u.pathname.endsWith('/external-trucks'))return {items:[{id:'truck',carrierId:'carrier-1'}]};if(u.pathname.endsWith('/contractors'))return {items:[{id:'carrier-1',carrier:true,deleted:false,grade:'NEUTRAL'}]};return {items:[{id:'load'}]};},store);
 await assert.rejects(c.run('firetms_preview_create_transport_order',{data:{truckId:'truck',loadIds:['load']}}),/receipt basis/);assert.equal(posts,0);
});
