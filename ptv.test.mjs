import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createPtv,ptvTransport} from './ptv.mjs';
import {createApp} from './server.mjs';
const points=[{latitude:54.40374,longitude:18.68134,label:'Gdansk'},{latitude:54.5189,longitude:18.5305,label:'Gdynia'}];
const response={distance:33000,travelTime:2000,violated:false,legs:[{distance:33000,travelTime:2000,violated:false}],events:[]};
test('PTV uses fixed host, header key, correct units, leg conversion and caches identical calculations',async()=>{
 const calls=[];const api=createPtv({PTV_API_KEY:'unit-test-secret'},async(url,key)=>{calls.push({url,key});return response;});
 const args={waypoints:points,vehicle:{height:400,length:1650,width:255,emptyWeight:15000,loadWeight:25000,totalPermittedWeight:40000},departure:'2026-10-23T08:00:00+02:00'};
 const r=await api.run('ptv_route',args);assert.equal(r.distance_km,33);assert.equal(r.legs[0].distance_km,33);assert.equal(r.requires_review,false);assert.equal(r.travel_time_minutes,33.3);
 const {url,key}=calls[0];assert.equal(key,'unit-test-secret');assert.equal(url.origin,'https://api.myptv.com');assert.equal(url.searchParams.get('profile'),'EUR_TRAILER_TRUCK');assert.equal(url.searchParams.get('vehicle[height]'),'400');assert.equal(url.searchParams.get('vehicle[loadWeight]'),'25000');assert.equal(url.searchParams.get('options[startTime]'),args.departure);assert.equal(url.searchParams.get('options[avoid]'),'FERRIES,RAIL_SHUTTLES');assert.equal(url.href.includes(key),false);
 await api.run('ptv_route',args);assert.equal(calls.length,1);
 for(const invalid of [{...args,url:'https://evil.test'},{...args,vehicle:{height:4.1}},{...args,departure:'2026-10-23T08:00:00'},{...args,waypoints:[{latitude:200,longitude:10},points[1]]},{...args,vehicle:{emptyWeight:15000,loadWeight:30000,totalPermittedWeight:40000}}])await assert.rejects(api.run('ptv_route',invalid));
 assert.equal(calls.length,1);
});
test('PTV exposes violations, warnings, ferries and unconfirmed profile defaults for review',async()=>{
 const api=createPtv({PTV_API_KEY:'fake'},async()=>({...response,violated:true,warnings:[{warningCode:'TEST'}],events:[{distanceFromStart:100,violation:{type:'VEHICLE_PROPERTY'}},{countryCode:'AT',combinedTransport:{type:'BOAT',name:'Ferry'}}]}));
 const r=await api.run('ptv_route',{waypoints:points});assert.equal(r.requires_review,true);assert.equal(r.violated,true);assert.equal(r.violations.length,1);assert.equal(r.combined_transports.length,1);assert.deepEqual(r.countries,['AT']);assert.equal(r.vehicle_defaults_require_confirmation,true);
 const plain=createPtv({PTV_API_KEY:'fake'},async()=>response);assert.equal((await plain.run('ptv_route',{waypoints:points})).requires_review,true);
});
test('PTV geocoding retains candidates and quality without selecting an uncertain address',async()=>{
 const api=createPtv({PTV_API_KEY:'fake-secret'},async(url)=>{assert.equal(url.searchParams.get('countryFilter'),'PL');return {locations:[{formattedAddress:'Address',address:{city:'Gdansk',countryCode:'PL',postalCode:'80-601',street:'Sucharskiego',houseNumber:'70'},locationType:'EXACT_ADDRESS',quality:{totalScore:95},referencePosition:{latitude:54,longitude:18},roadAccessPosition:{latitude:54.1,longitude:18.1},feedbackId:'fake-secret'}]};});
 const r=await api.run('ptv_geocode',{address:'Sucharskiego 70, Gdansk',country:'PL'});assert.equal(r.selection_required,true);assert.equal(r.candidates[0].score,95);assert.equal(r.candidates[0].road_access_position.latitude,54.1);assert.equal(JSON.stringify(r).includes('fake-secret'),false);
});
test('PTV rejects key forwarding, redirects, malformed upstream results and leaked transport errors',async()=>{
 for(const url of ['https://evil.test/routing/v1/routes','https://api.myptv.com/other','https://api.myptv.com/routing/v1/routes?apiKey=x'])assert.throws(()=>ptvTransport(new URL(url),'fake'));
 const api=createPtv({PTV_API_KEY:'fake-secret'},async()=>{throw Error('https://evil.test/?apiKey=fake-secret');});
 await assert.rejects(api.run('ptv_geocode',{address:'test'}),{message:'PTV request failed'});
 const bad=createPtv({PTV_API_KEY:'fake'},async()=>({violated:false}));await assert.rejects(bad.run('ptv_route',{waypoints:points}),/invalid routing/);
});
test('PTV requests require explicit OAuth scope; existing read tokens cannot use key',async()=>{
 const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'999999',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake',PTV_API_KEY:'secret-test-value'};
 let calls=0;const server=createApp(env,undefined,{ptvTransport:async()=>{calls++;return response;}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const token=scope=>{const v=Buffer.from(JSON.stringify({aud:env.PUBLIC_URL+'/mcp',scope,exp:Date.now()+60000,sub:env.WFIRMA_COMPANY_ID})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');};
 const rpc=async(scope,method,params)=>{const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);return r.json();};
 try{
  const listing=await rpc('ptv:read','tools/list');assert.deepEqual(listing.result.tools.map(t=>t.name),['ptv_status','ptv_geocode','ptv_route','ptv_route_report']);
  const oldConnection=await rpc('firetms:read','tools/list');assert.equal(oldConnection.result.tools.filter(t=>t.name.startsWith('ptv_')).length,4);assert.ok(oldConnection.result.tools.filter(t=>t.name.startsWith('ptv_')).every(t=>t.securitySchemes[0].scopes.includes('ptv:read')));
  assert.equal((await rpc('firetms:read','tools/call',{name:'ptv_route',arguments:{waypoints:points}})).result.isError,true);assert.equal(calls,0);
  const ok=await rpc('ptv:read','tools/call',{name:'ptv_route',arguments:{waypoints:points}});assert.equal(JSON.parse(ok.result.content[0].text).distance_km,33);assert.equal(calls,1);assert.equal(JSON.stringify(ok).includes(env.PTV_API_KEY),false);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
