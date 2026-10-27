import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCloudServer} from './cloud-start.mjs';
test('Cloud setup starts without keys but exposes no tools or false operational readiness',async()=>{
 const app=await createCloudServer({TCOG_SETUP_MODE:'true'},{openStore:()=>{throw Error('Must not connect');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).operational,false);
  assert.equal((await fetch(base+'/ready')).status,503);
  assert.equal((await fetch(base+'/mcp',{method:'POST',body:'{}'})).status,503);
  assert.equal((await fetch(base+'/google/oauth/start')).status,503);
 }finally{app.server.closeAllConnections();await app.close();}
});
test('Cloud production refuses missing database and insecure origin',async()=>{
 await assert.rejects(createCloudServer({PUBLIC_URL:'http://localhost'}),/HTTPS/);
 await assert.rejects(createCloudServer({PUBLIC_URL:'https://test.example'}),/Cloud SQL/);
});
