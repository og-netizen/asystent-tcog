// Explicit, one-shot migration check. Never imported by the production entrypoint.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cloudEnvironment} from './cloud-start.mjs';
import {openCloudStateStore} from './state-store.mjs';
import {createGmailOAuth} from './gmail-oauth.mjs';
import {createFiretms} from './firetms.mjs';
import {createPtv} from './ptv.mjs';

let stage='configuration',store;
const ok=()=>console.log('TCOG_MIGRATION_CHECK '+JSON.stringify({stage,status:'ok'}));
try {
 const config=await cloudEnvironment(process.env);
 assert.equal(config.PUBLIC_URL,'https://tcog-staging-rcz56sj3hq-ey.a.run.app');
 assert.equal(config.PGUSER,'tcog_app');
 stage='database-reconnect';
 store=await openCloudStateStore(config);
 const key=randomUUID(),namespace='migration-check';
 await store.put(namespace,key,{state:'ready',probe:key},Date.now()+60000);
 await store.close();store=await openCloudStateStore(config);
 assert.equal((await store.take(namespace,key))?.probe,key);
 assert.equal(await store.take(namespace,key),undefined);
 await store.close();store=undefined;ok();
 stage='gmail-read-only';
 const profile=await createGmailOAuth(config).checkSaved();
 assert.equal(profile.emailAddress.toLowerCase(),(config.GOOGLE_GMAIL_EXPECTED_EMAIL||'og@tcog.pl').toLowerCase());ok();
 stage='firetms-read-only';
 await createFiretms(config).run('firetms_list',{resource:'trucks',page:1,size:1});ok();
 stage='ptv-geocoding';
 const ptv=createPtv(config);
 const address=await ptv.run('ptv_geocode',{address:'Mjr. Sucharskiego 70, 80-601 Gdańsk, Poland',country:'PL'});
 assert(address.candidates.length>0);ok();
 stage='ptv-routing';
 const route=await ptv.run('ptv_route',{waypoints:[{latitude:54.40374,longitude:18.68134},{latitude:54.5189,longitude:18.5305}]});
 assert(Number.isFinite(route.distance_km)&&route.distance_km>0);ok();
 console.log('TCOG_MIGRATION_READ_CHECKS_OK');
}catch{
 // Do not reflect vendor bodies, credentials, email content or business records.
 console.error('TCOG_MIGRATION_CHECK '+JSON.stringify({stage,status:'failed'}));
 process.exitCode=1;
}finally{await store?.close();}
