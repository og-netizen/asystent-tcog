// Explicit, disposable manual test mode. Never used for durable production data.
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApp} from '../server.mjs';
import {createPilot} from './server.mjs';
export async function createFreePilot(env,dbk){
 const origin=new URL(env.PUBLIC_URL||env.RENDER_EXTERNAL_URL).origin;
 if(!origin.startsWith('https://')&&env.NODE_ENV!=='test')throw Error('Panel wymaga HTTPS.');
 const dir=await mkdtemp(join(tmpdir(),'tcog-pilot-'));
 let pilot;
 try{
  const mcp=createApp(env);
  pilot=await createPilot({...env,PILOT_PASSWORD:env.ADMIN_PASSWORD,PILOT_ORIGIN:origin,PILOT_EPHEMERAL:'1',PILOT_DATA_DIR:dir},dbk);
  const server=http.createServer((req,res)=>{
   const path=new URL(req.url,origin).pathname;
   if(path==='/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({status:'running',pilot:'manual-temporary',version:'0.3.2'}));}
   (['/mcp','/authorize','/token'].includes(path)||path.startsWith('/.well-known/')?mcp:pilot.server).emit('request',req,res);
  });
  return {server,async close(){if(server.listening)await new Promise(r=>server.close(r));await pilot.close();await rm(dir,{recursive:true,force:true});}};
 }catch(e){if(pilot)await pilot.close();await rm(dir,{recursive:true,force:true});throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=await createFreePilot(process.env);
 app.server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('TCOG 0.3.2: pilot testowy, zapis tymczasowy, pobieranie wyłącznie ręczne.'));
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
