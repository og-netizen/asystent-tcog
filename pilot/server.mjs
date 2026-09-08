import http from 'node:http';
import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createDbk} from '../server.mjs';
import {validateOrder,mergeSamples,analyse} from './logic.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const hash=x=>createHash('sha256').update(String(x)).digest();
const equal=(a,b)=>timingSafeEqual(hash(a),hash(b));
export async function createPilot(env,client=createDbk(env)){
 const temporary=env.PILOT_EPHEMERAL==='1';
 if((env.PILOT_PASSWORD||'').length<24)throw Error('PILOT_PASSWORD: minimum 24 znaki.');
 if(!env.PILOT_DATA_DIR)throw Error('Ustaw PILOT_DATA_DIR na trwały katalog danych.');
 if(env.RENDER&&!temporary&&!env.RENDER_DISK_MOUNT_PATH)throw Error('Na Render wymagany jest trwały dysk.');
 const dir=resolve(env.PILOT_DATA_DIR),file=resolve(dir,'pilot.json');
 if(env.RENDER&&!temporary&&dir!==resolve(env.RENDER_DISK_MOUNT_PATH)&&!dir.startsWith(resolve(env.RENDER_DISK_MOUNT_PATH)+'/'))throw Error('Dane muszą znajdować się na trwałym dysku.');
 await mkdir(dir,{recursive:true,mode:0o700});
 const lock=await open(resolve(dir,'pilot.lock'),'wx',0o600);await lock.writeFile(String(process.pid));
 let state;
 try{state=JSON.parse(await readFile(file,'utf8'));if(state.version!==1||!Array.isArray(state.orders))throw Error('Nieprawidłowy plik danych.');}catch(e){if(e.code!=='ENOENT'){await lock.close();await unlink(resolve(dir,'pilot.lock'));throw e;}state={version:1,vehicle:null,orders:[]};}
 let busy=false,saveQueue=Promise.resolve(),lastError=null,vehiclesCache=null;
 const sessions=new Map();let attempts=[];
 const save=()=>{const data=JSON.stringify(state);const job=saveQueue.then(async()=>{const tmp=file+'.tmp';await writeFile(tmp,data,{mode:0o600});const fd=await open(tmp,'r+');await fd.sync();await fd.close();await rename(tmp,file);});saveQueue=job.catch(()=>{});return job;};
 const publicState=()=>({temporary,vehicle:state.vehicle,busy,lastError,orders:state.orders.map(({samples,...o})=>({...o,analysis:analyse({...o,samples})}))});
 async function tick(){
  if(busy||!state.vehicle)return;busy=true;
  try{
   const now=Date.now()-120000;
   const order=state.orders.find(o=>!o.paused&&o.cursor<Math.min(Date.parse(o.end)+7200000,now));
   if(!order)return;
   const hi=Math.min(order.cursor+3600000,Date.parse(order.end)+7200000,now);
   const lo=Math.max(Date.parse(order.start)-7200000,order.cursor-900000);
   // One vendor request per tick, at most one hour including overlap.
   const end=Math.min(hi,lo+3600000);
   if(end<=order.cursor)return;
   const data=await client.run('dbk_history',{device_id:state.vehicle.device_id,oldest:new Date(lo).toISOString(),newest:new Date(end).toISOString()});
   const before={samples:order.samples,cursor:order.cursor,lastSync:order.lastSync,emptyWindows:order.emptyWindows};
   order.samples=mergeSamples(order.samples,data.samples);order.cursor=end;order.lastSync=new Date().toISOString();if(!data.samples.length)order.emptyWindows++;
   try{await save();}catch(e){Object.assign(order,before);throw e;}lastError=null;
  }catch{lastError=temporary?'Nie udało się pobrać lub zapisać danych. Spróbuj ponownie przyciskiem.':'Pobranie lub zapis nie powiodły się. Następna próba za minutę.';}
  finally{busy=false;}
 }
 const server=http.createServer(async(req,res)=>{
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(req.method==='GET'&&['/','/app.js','/style.css'].includes(pathname)){
    const name=pathname==='/'?'index.html':pathname.slice(1);
    res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');return res.end(await readFile(resolve(here,name)));
   }
   if(!pathname.startsWith('/api/'))return json(404,{error:'Nie znaleziono.'});
   // Custom header and exact Origin check prevent cross-site form submissions.
   if(req.headers['x-tcog-pilot']!=='1')return json(403,{error:'Niedozwolone żądanie.'});
   if(env.PILOT_ORIGIN&&req.headers.origin&&req.headers.origin!==env.PILOT_ORIGIN)return json(403,{error:'Niedozwolony adres strony.'});
   let input={};if(req.method==='POST'){let body='';for await(const c of req){body+=c;if(Buffer.byteLength(body)>(pathname==='/api/import'?2000000:12000))return json(413,{error:'Za duże żądanie.'});}input=JSON.parse(body||'{}');}
   if(pathname==='/api/login'&&req.method==='POST'){
    attempts=attempts.filter(t=>Date.now()-t<600000);if(attempts.length>=10)return json(429,{error:'Zbyt wiele prób. Spróbuj za 10 minut.'});
    if(typeof input.password!=='string'||!equal(input.password,env.PILOT_PASSWORD)){attempts.push(Date.now());return json(401,{error:'Niepoprawne hasło panelu.'});}
    const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+8*3600000);
    res.setHeader('Set-Cookie',`pilot=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${env.PILOT_ORIGIN?.startsWith('https:')?'; Secure':''}`);return json(200,{ok:true});
   }
   for(const [key,expiry]of sessions)if(expiry<Date.now())sessions.delete(key);
   const token=req.headers.cookie?.match(/(?:^|;\s*)pilot=([a-f0-9]{64})(?:;|$)/)?.[1];
   if(!token||!sessions.has(token))return json(401,{error:'Zaloguj się do panelu.'});
   if(pathname==='/api/logout'&&req.method==='POST'){sessions.delete(token);res.setHeader('Set-Cookie','pilot=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(200,{ok:true});}
   if(pathname==='/api/state'&&req.method==='GET')return json(200,publicState());
   if(pathname==='/api/export'&&req.method==='GET')return json(200,state);
   if(pathname==='/api/vehicles'&&req.method==='GET'){
    if(busy)return json(409,{error:'Trwa pobieranie historii. Spróbuj za chwilę.'});busy=true;
    try{vehiclesCache=(await client.run('dbk_vehicles',{history_only:true})).vehicles;return json(200,{vehicles:vehiclesCache});}finally{busy=false;}
   }
   if(req.method!=='POST')return json(405,{error:'Niedozwolona metoda.'});
   if(busy)return json(409,{error:'Trwa pobieranie. Spróbuj za chwilę.'});
   if(pathname==='/api/sync'){void tick();return json(202,{ok:true});}
   // Serialize changes while writing the durable snapshot.
   busy=true;const before=JSON.stringify(state);
   try{
    if(pathname==='/api/vehicle'){
     if(state.orders.length)throw Error('W pilotażu auto jest stałe po zapisaniu pierwszego zlecenia.');
     const v=vehiclesCache?.find(v=>v.device_id===input.device_id);if(!v)throw Error('Najpierw pobierz listę aut i wybierz pojazd.');state.vehicle=v;
    }else if(pathname==='/api/import'){
     if(!state.vehicle||input.vehicle?.device_id!==state.vehicle.device_id)throw Error('Wybierz najpierw auto zgodne z kopią danych.');
     if(state.orders.length)throw Error('Import jest dostępny w pustym panelu. Usuń zlecenia lub użyj nowej sesji po restarcie.');
     if(input.version!==1||!Array.isArray(input.orders)||input.orders.length!==1)throw Error('W teście importujemy kopię z jednym zleceniem.');
     const raw=input.orders[0],o=validateOrder(raw),lo=Date.parse(o.start)-7200000,hi=Date.parse(o.end)+7200000;
     if(!Array.isArray(raw.samples)||raw.samples.length>10000)throw Error('Niepoprawna liczba próbek.');
     const samples=mergeSamples([],raw.samples.map(s=>{
      const t=Date.parse(s.date);if(!Number.isFinite(t)||t<lo||t>hi)throw Error('Próbka spoza okresu zlecenia.');
      const row={date:new Date(t).toISOString()};
      for(const k of ['lat','lng','speed','odometer_can_km','odometer_gps_km','total_fuel_can_l']){if(s[k]!=null&&(typeof s[k]!=='number'||!Number.isFinite(s[k])))throw Error('Niepoprawne pomiary w kopii.');row[k]=s[k]??null;}
      if(row.lat!==null&&Math.abs(row.lat)>90||row.lng!==null&&Math.abs(row.lng)>180)throw Error('Niepoprawne współrzędne w kopii.');
      return row;
     }));
     const cursor=typeof raw.cursor==='number'&&Number.isFinite(raw.cursor)?Math.max(lo,Math.min(raw.cursor,hi,Date.now())):lo;
     state.orders.push({...o,id:randomBytes(12).toString('hex'),samples,cursor,lastSync:null,emptyWindows:Number.isInteger(raw.emptyWindows)&&raw.emptyWindows>=0?Math.min(raw.emptyWindows,10000):0,paused:true});
    }else if(pathname==='/api/orders'){
     if(!state.vehicle)throw Error('Najpierw wybierz auto.');if(state.orders.length>=100)throw Error('Limit pilotażu: 100 zleceń.');
     const o=validateOrder(input);if(state.orders.some(x=>Date.parse(o.start)<=Date.parse(x.end)&&Date.parse(o.end)>=Date.parse(x.start)))throw Error('Terminy nakładają się na zapisane zlecenie.');
     state.orders.push({...o,id:randomBytes(12).toString('hex'),samples:[],cursor:Date.parse(o.start)-7200000,lastSync:null,emptyWindows:0,paused:false});
    }else if(pathname==='/api/orders/edit'){
     const previous=state.orders.find(o=>o.id===input.id);if(!previous)throw Error('Nie znaleziono zlecenia. Odśwież panel.');
     const updated=validateOrder(input);
     if(state.orders.some(x=>x.id!==previous.id&&Date.parse(updated.start)<=Date.parse(x.end)&&Date.parse(updated.end)>=Date.parse(x.start)))throw Error('Terminy nakładają się na inne zlecenie.');
     const changedDates=updated.start!==previous.start||updated.end!==previous.end;
     Object.assign(previous,updated);
     if(changedDates)Object.assign(previous,{samples:[],cursor:Date.parse(updated.start)-7200000,lastSync:null,emptyWindows:0});
    }else if(pathname==='/api/orders/delete'){
     const index=state.orders.findIndex(o=>o.id===input.id);if(index<0)throw Error('Nie znaleziono zlecenia. Odśwież panel.');
     state.orders.splice(index,1);
    }else if(pathname==='/api/pause'){
     const o=state.orders.find(o=>o.id===input.id);if(!o||typeof input.paused!=='boolean')throw Error('Niepoprawne zlecenie.');o.paused=input.paused;
    }else return json(404,{error:'Nie znaleziono.'});
    await save();return json(200,publicState());
   }catch(e){state=JSON.parse(before);throw e;}finally{busy=false;}
  }catch(e){return json(400,{error:e.message?.startsWith('DBK')?'Nie udało się pobrać danych DBK. Sprawdź konfigurację serwera.':e instanceof SyntaxError?'Niepoprawne dane.':e.code?'Nie udało się zapisać lub odczytać danych.':e.message});}
 });
 const timer=temporary?null:setInterval(()=>void tick(),60000);timer?.unref();
 return {server,tick,async close(){clearInterval(timer);if(server.listening)await new Promise(r=>server.close(r));while(busy)await new Promise(r=>setTimeout(r,50));await saveQueue;await lock.close();await unlink(resolve(dir,'pilot.lock'));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const app=await createPilot(process.env);
 const host=process.env.PILOT_HOST||'127.0.0.1';
 if(host!=='127.0.0.1'&&!process.env.PILOT_ORIGIN?.startsWith('https://')){await app.close();throw Error('Publiczny panel wymaga PILOT_ORIGIN z HTTPS.');}
 app.server.listen(Number(process.env.PORT||8787),host,()=>{console.log('TCOG Pilot uruchomiony. Pobieranie DBK co minutę, bez AI.');void app.tick();});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
