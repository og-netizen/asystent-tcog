// Optional combined entry point: existing MCP/OAuth routes and the pilot UI.
import http from 'node:http';
import {createApp} from '../server.mjs';
import {createPilot} from './server.mjs';
const env=process.env;
if(!env.PILOT_ORIGIN?.startsWith('https://'))throw Error('PILOT_ORIGIN musi używać HTTPS.');
if(new URL(env.PILOT_ORIGIN).origin!==new URL(env.PUBLIC_URL||env.RENDER_EXTERNAL_URL).origin)throw Error('Panel i integracja muszą mieć ten sam adres.');
const mcp=createApp(env),pilot=await createPilot(env);
const server=http.createServer((req,res)=>{
 const path=new URL(req.url,env.PILOT_ORIGIN).pathname;
 (['/mcp','/authorize','/token','/health'].includes(path)||path.startsWith('/.well-known/')?mcp:pilot.server).emit('request',req,res);
});
server.listen(Number(env.PORT||10000),'0.0.0.0',()=>{console.log('TCOG: panel pilota i integracja uruchomione.');void pilot.tick();});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await new Promise(r=>server.close(r));await pilot.close();process.exit(0);});
