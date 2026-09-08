import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyse,validateOrder,mergeSamples} from './logic.mjs';
import {createPilot} from './server.mjs';
const start=Date.parse('2026-09-08T10:00:00Z');
const order={reference:'TEST',start:new Date(start).toISOString(),end:new Date(start+3600000).toISOString(),load:{address:'Magazyn A',lat:52,lng:21,radius:300},unload:{address:'Magazyn B',lat:53,lng:21,radius:300},revenue:1000,currency:'PLN'};
const sample=(minutes,lat,km,fuel=100)=>({date:new Date(start+minutes*60000).toISOString(),lat,lng:21,speed:0,odometer_can_km:km,odometer_gps_km:null,total_fuel_can_l:fuel});
test('Detect stops, use departure odometer and deduplicate overlapping windows',()=>{
 const samples=[sample(0,52,100),sample(5,52,100),sample(6,52.01,101),sample(12,52.5,150,110),sample(18,53,200,120),sample(23,53,200,120)];
 const a=analyse({...order,samples:mergeSamples(samples,[samples[0]])});
 assert.equal(a.sample_count,6);assert.equal(a.km,99);assert.equal(a.fuel_l,20);assert.equal(a.source,'CAN');assert.ok(a.unload);
});
test('Passing the warehouse and sparse observations do not confirm a visit',()=>{
 assert.equal(analyse({...order,samples:[sample(0,52,100),sample(1,52.1,101)]}).load,null);
 assert.equal(analyse({...order,samples:[sample(0,52,100),sample(30,52,100)]}).load,null);
});
test('Gap after confirmed stop cannot create a precise departure; reset odometer is not distance',()=>{
 const a=analyse({...order,samples:[sample(0,52,100),sample(5,52,100),sample(30,53,200)]});
 assert.equal(a.load.departure,null);assert.equal(a.km,null);assert.equal(a.load.uncertain,true);
 const b=analyse({...order,samples:[sample(0,52,100),sample(5,52,100),sample(6,52.01,101),sample(12,53,5),sample(17,53,5)]});assert.equal(b.km,null);
});
test('Validation bounds dates, amount and coordinates',()=>{
 assert.equal(validateOrder(order,start).reference,'TEST');
 assert.throws(()=>validateOrder({...order,load:{...order.load,lat:NaN}},start));
 assert.throws(()=>validateOrder({...order,start:new Date(start-49*3600000).toISOString()},start));
});
test('Authenticated pilot persists one vehicle and sync cursor across restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tcog-test-'));
 const env={PILOT_PASSWORD:'test-password-32-characters-long!',PILOT_DATA_DIR:dir};
 const now=Date.now();let calls=0;
 const client={async run(name,a){if(name==='dbk_vehicles')return {vehicles:[{device_id:'car1',plate_number:'TEST'}]};calls++;assert.ok(Date.parse(a.newest)-Date.parse(a.oldest)<=3600000);return {samples:[{date:a.oldest,lat:52,lng:21,speed:0,odometer_can_km:100}]};}};
 let app;try{
  app=await createPilot(env,client);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));let base='http://127.0.0.1:'+app.server.address().port,cookie='';
  const request=async(path,data)=>fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'X-TCOG-Pilot':'1','Content-Type':'application/json',Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)});
  assert.equal((await request('state')).status,401);
  const login=await request('login',{password:env.PILOT_PASSWORD});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('vehicles')).status,200);
  assert.equal((await request('vehicle',{device_id:'car1'})).status,200);
  const o={...order,start:new Date(now-3600000).toISOString(),end:new Date(now+3600000).toISOString()};
  assert.equal((await request('orders',o)).status,200);
  assert.equal((await request('orders',o)).status,400);
  await app.tick();assert.equal(calls,1);
  const saved=await (await request('export')).json();assert.equal(saved.orders[0].samples.length,1);
  assert.ok(saved.orders[0].cursor>Date.parse(o.start)-7200000);
  assert.equal(JSON.stringify(saved).includes(env.PILOT_PASSWORD),false);
  await app.close();app=null;
  app=await createPilot(env,client);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;
  assert.equal((await request('state')).status,401);
  const again=await request('login',{password:env.PILOT_PASSWORD});cookie=again.headers.get('set-cookie').split(';')[0];
  const persisted=await (await request('state')).json();assert.equal(persisted.orders[0].cursor,saved.orders[0].cursor);assert.equal(persisted.vehicle.device_id,'car1');
 }finally{if(app)await app.close();await rm(dir,{recursive:true,force:true});}
});
