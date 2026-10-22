import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {PDFDocument} from 'pdf-lib';
import {parseGeometry,routeDetails,mapLayout} from './ptv-report.mjs';
import {createPtv} from './ptv.mjs';
import {createApp} from './server.mjs';
const points=[{latitude:53.94,longitude:10.85,label:'Sample start'},{latitude:46.69,longitude:14.00,label:'Sample destination'}];
// Synthetic fixture: no customer order, real toll quote or recommended itinerary.
const fixture={distance:1172652,travelTime:55273,violated:false,routeId:'sample-route',polyline:JSON.stringify({type:'LineString',coordinates:[[10.85,53.94],[10.1,52.1],[11.0,50.1],[12.1,48.1],[13.1,47.7],[14,46.69]]}),events:[
 {distanceFromStart:0,countryCode:'DE',maneuver:{type:'DEPART',roadAhead:{number:'A1',name:'Autobahn'},directionSignText:'Hamburg / A24'}},
 {distanceFromStart:150000,countryCode:'DE',maneuver:{type:'CHANGE',roadAhead:{number:'A9'},directionSignText:'Munchen'}},
 {distanceFromStart:950000,countryCode:'AT',maneuver:{type:'CHANGE',roadAhead:{number:'A10'},directionSignText:'Villach'}}
],toll:{costs:{prices:[{price:188.42,currency:'EUR'}],convertedPrice:{price:188.42,currency:'EUR'},countries:[{countryCode:'DE',price:{price:140,currency:'EUR'}},{countryCode:'AT',price:{price:48.42,currency:'EUR'}}]},sections:[{countryCode:'AT',displayName:'Sample toll section',tollRoadType:'HIGHWAY',costs:[{price:48.42,currency:'EUR'}],calculatedDistance:110000}],systems:[{name:'Sample system',tariffVersion:'test',tariffVersionValidFrom:'2026-01-01'}]}};
const vehicle={height:400,width:255,length:1650,emptyWeight:15000,loadWeight:23625,totalPermittedWeight:40000,totalTechnicallyPermittedWeight:44000,numberOfAxles:5,emissionStandard:'EURO_6',co2EmissionClass:1};
const args={waypoints:points,vehicle,include_tolls:true,departure:'2026-10-26T08:00:00+01:00'};
const env={NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1',ADMIN_PASSWORD:'a'.repeat(40),OAUTH_CLIENT_SECRET:'s'.repeat(40),WFIRMA_COMPANY_ID:'999999',WFIRMA_ACCESS_KEY:'fake',WFIRMA_SECRET_KEY:'fake',WFIRMA_APP_KEY:'fake',PTV_API_KEY:'test-secret-never-in-output'};
const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACv0lEQVR4nO3TsQkAMAzAsPx/cSkdekYGC3SAF8+5D7JmvQAWGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaR/YLSvz0R89KAAAAABJRU5ErkJggg==','base64');

test('roads are actual roadAhead numbers in route order, never signposted alternatives; tolls keep currencies',()=>{
 const r=routeDetails(fixture,args);assert.deepEqual(r.road_sequence,['A1','A9','A10']);assert.ok(!r.road_sequence.includes('A24'));assert.equal(r.toll.available,true);assert.equal(r.toll.converted_total.price,188.42);assert.equal(r.toll.requires_review,false);assert.equal(r.toll.sections[0].prices[0].price.currency,'EUR');
 const multi=structuredClone(fixture);multi.toll.costs.prices.push({price:10,currency:'CHF'});assert.equal(routeDetails(multi,args).toll.prices.length,2);
 for(const raw of [{},{toll:{}},{toll:{costs:{prices:[{price:-1,currency:'EUR'}]}}}]){const t=routeDetails({...fixture,toll:raw.toll},args).toll;assert.equal(t.available,false);assert.equal(t.prices,null);assert.equal(t.requires_review,true);}
 const zero=structuredClone(fixture);zero.toll.costs.prices=[{price:0,currency:'EUR'}];assert.equal(routeDetails(zero,args).toll.prices[0].price,0);
 const noVehicle=routeDetails(fixture,{include_tolls:true});assert.equal(noVehicle.toll.requires_review,true);assert.ok(noVehicle.toll.missing_vehicle_parameters.includes('co2EmissionClass'));
});
test('geometry rejects malformed and out-of-bounds coordinates; tile requests bounded for long routes',()=>{
 for(const x of ['not-json',{type:'Point',coordinates:[1,2]},{type:'LineString',coordinates:[[1,2],[999,3]]},{type:'LineString',coordinates:[[1,2],[3,Infinity]]}])assert.equal(parseGeometry(x),null);
 const g=parseGeometry(fixture.polyline);assert.ok(g);assert.ok(mapLayout(g).tiles.length<=16);
});
test('PDF snapshots reuse identical routing result, private URLs and raster keys do not leak; no route recalculation',async()=>{
 const calls=[];const api=createPtv(env,async(url,key)=>{calls.push(url);assert.equal(key,env.PTV_API_KEY);if(url.pathname.includes('image-tiles'))return tinyPng;return fixture;});
 const r=await api.run('ptv_route',args);assert.equal(r.geometry,undefined);assert.equal(r.geometry_available,true);assert.equal(r.requires_review,false);
 const query=calls[0].searchParams;for(const flag of ['POLYLINE','MANEUVER_EVENTS','TOLL_COSTS','TOLL_SECTIONS','TOLL_SYSTEMS'])assert.ok(query.get('results').includes(flag));assert.equal(query.get('vehicle[co2EmissionClass]'),'1');assert.equal(query.get('options[currency]'),'EUR');
 fixture.distance=999; // A snapshot must not change even if the upstream mock is mutated.
 const report=await api.run('ptv_route_report',{route_token:r.route_token,title:'TEST ONLY - sample route and tolls'});fixture.distance=1172652;
 assert.equal(report.map_kind,'ptv_raster');assert.equal(calls.filter(u=>u.pathname==='/routing/v1/routes').length,1);assert.ok(calls.length<=17);assert.equal(JSON.stringify(report).includes(env.PTV_API_KEY),false);
 const token=new URL(report.download_url).pathname.split('/').at(-1).slice(0,-4),bytes=api.getReport(token);assert.equal(bytes.subarray(0,4).toString(),'%PDF');const doc=await PDFDocument.load(bytes);assert.ok(doc.getPageCount()>=1);
 await mkdir('tmp',{recursive:true});await writeFile('tmp/report-test.pdf',bytes);
 assert.deepEqual(await api.run('ptv_route_report',{route_token:r.route_token,title:'TEST ONLY - sample route and tolls'}),report);
 assert.equal(api.getReport('bad'),null);await assert.rejects(api.run('ptv_route_report',{route_token:'x'.repeat(43)}),/expired or unknown/);
 const old=Date.now;try{Date.now=()=>old()+31*60000;assert.equal(api.getReport(token),null);await assert.rejects(api.run('ptv_route_report',{route_token:r.route_token}),/expired/);}finally{Date.now=old;}
});
test('PDF is explicit about unavailable map entitlement, missing geometry and missing toll data',async()=>{
 const api=createPtv(env,async url=>{if(url.pathname.includes('image-tiles'))throw Error('PTV HTTP 403');return {...fixture,toll:undefined};});
 const route=await api.run('ptv_route',args);const pdf=await api.run('ptv_route_report',{route_token:route.route_token});assert.equal(pdf.map_kind,'route_schematic');assert.ok(pdf.map_warning);
 const noGeometry=createPtv(env,async()=>({...fixture,polyline:null}));const r=await noGeometry.run('ptv_route',args);await assert.rejects(noGeometry.run('ptv_route_report',{route_token:r.route_token}),/requires route geometry/);
 const untolled=await api.run('ptv_route',{waypoints:points});await assert.rejects(api.run('ptv_route_report',{route_token:untolled.route_token}),/include_tolls/);
});
test('MCP report tool enforces PTV OAuth scope and HTTP download serves only opaque live capability',async()=>{
 const server=createApp(env,undefined,{ptvTransport:async u=>u.pathname.includes('image-tiles')?tinyPng:fixture});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 function token(scope){const v=Buffer.from(JSON.stringify({aud:env.PUBLIC_URL+'/mcp',scope,exp:Date.now()+60000,sub:env.WFIRMA_COMPANY_ID})).toString('base64url');return v+'.'+createHmac('sha256',env.OAUTH_CLIENT_SECRET).update(v).digest('base64url');}
 const rpc=async(scope,name,arguments_)=>{const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token(scope)},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})});return (await r.json()).result;};
 try{assert.equal((await rpc('firetms:read','ptv_route_report',{route_token:'x'.repeat(43)})).isError,true);
  const r=JSON.parse((await rpc('ptv:read','ptv_route',args)).content[0].text);const report=JSON.parse((await rpc('ptv:read','ptv_route_report',{route_token:r.route_token})).content[0].text);
  const res=await fetch(base+new URL(report.download_url).pathname);assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'application/pdf');assert.equal(res.headers.get('cache-control'),'no-store, private');assert.equal((await res.arrayBuffer()).byteLength>1000,true);
  assert.equal((await fetch(base+'/ptv-reports/'+'x'.repeat(43)+'.pdf')).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
