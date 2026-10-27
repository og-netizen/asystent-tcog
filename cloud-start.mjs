import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createApp} from './server.mjs';
import {openCloudStateStore} from './state-store.mjs';

const configKeys=new Set(['PUBLIC_URL','ADMIN_PASSWORD','OAUTH_CLIENT_SECRET','OAUTH_REDIRECT_URIS','WFIRMA_COMPANY_ID','WFIRMA_ACCESS_KEY','WFIRMA_SECRET_KEY','WFIRMA_APP_KEY','FIRETMS_API_KEY','FIRETMS_BASE_URL','FIRETMS_OPERATIONAL_PUT_VERIFIED','PTV_API_KEY','DBK_API_KEY','DBK_API_SECRET','GOOGLE_GMAIL_CLIENT_ID','GOOGLE_GMAIL_CLIENT_SECRET','GOOGLE_GMAIL_EXPECTED_EMAIL','GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED','PGHOST','PGDATABASE','PGUSER','PGPASSWORD']);
export async function cloudEnvironment(env){
 if(!env.TCOG_ENV_FILE)return {...env};
 const raw=await readFile(env.TCOG_ENV_FILE,'utf8');if(raw.length>65536)throw Error('Cloud configuration too large');
 const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data)||Object.entries(data).some(([k,v])=>!configKeys.has(k)||typeof v!=='string'))throw Error('Invalid cloud configuration');
 return {...env,...data};
}

export async function createCloudServer(env,{openStore=openCloudStateStore}={}){
 const setup=env.TCOG_SETUP_MODE==='true';
 const config=setup?env:await cloudEnvironment(env);
 let store,app;
 if(!setup){
  if(config.NODE_ENV==='test'||!config.PUBLIC_URL?.startsWith('https://'))throw Error('Cloud HTTPS origin required');
  store=await openStore(config);
  try{app=createApp(config,undefined,{stateStore:store});}catch(e){await store.close();throw e;}
 }
 const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(['/health','/ready'].includes(path)){
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
   if(req.method!=='GET'){res.writeHead(405);return res.end('{}');}
   let ready=!setup;if(ready){try{await store.count('__health__');}catch{ready=false;}}
   res.writeHead(path==='/ready'&&!ready?503:200);
   return res.end(JSON.stringify({service:'TCOG',version:'0.9.0',configuration:setup?'awaiting-secrets-and-database':ready?'configured':'database-unavailable',operational:ready,state_storage:setup?'not-connected':'postgresql'}));
  }
  if(setup){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({error:'migration_setup_only'}));}
  app.emit('request',req,res);
 });
 return {server,async close(){if(server.listening)await new Promise(r=>server.close(r));await store?.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const instance=await createCloudServer(process.env);
  instance.server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('TCOG_CLOUD_STARTED'));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await instance.close();});
 }catch{console.error('TCOG_CLOUD_CONFIGURATION_FAILED');process.exitCode=1;}
}
