import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
const schemas=JSON.parse(readFileSync(new URL('./firetms-schemas.json',import.meta.url),'utf8'));
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const id={type:'string',pattern:'^[A-Za-z0-9-]{1,80}$'};
const transportSchema=obj({truckId:id,loadIds:{type:'array',items:id,minItems:1,maxItems:30}},['truckId','loadIds']);
const operations=[
 ['firetms_create_load','Utwórz zlecenie KLIENTA (load). Zgodnie z zasadą TCOG przychód tymczasowy wynosi 1 EUR i jest oznaczony do zmiany przy zamknięciu. Najpierw firetms_preview_create_load, potem to narzędzie z otrzymanym review_token. Nie zakłada jeszcze zlecenia na auto. API może utworzyć szkic DRAFT; sprawdź wynik. Nie podawaj dowolnych cen, płatności ani faktur; serwer dodaje tylko uzgodnione tymczasowe 1 EUR.',obj({data:schemas.createLoad,review_token:{type:'string',maxLength:100}},['data'])],
 ['firetms_create_transport_order','Utwórz zlecenie TRANSPORTOWE na istniejące auto własne lub zewnętrzne z istniejących loadIds. Dla auta zewnętrznego powstaje zlecenie spedycyjne NEW bez potwierdzenia. FireTMS może potwierdzić transport własny i dobrać domyślną naczepę/kierowców oraz policzyć koszt z ustawień auta. Nie wysyła planu kierowcy. Najpierw firetms_preview_create_transport_order, potem to narzędzie z review_token. Sprawdź zestaw i status w wyniku.',obj({data:transportSchema,review_token:{type:'string',maxLength:100}},['data'])],
 ['firetms_update_load','Wykonaj edycję zlecenia KLIENTA (loadId, nie ID zlecenia transportowego). data jest kompletnym zestawem pól operacyjnych, nie częściową łatką. Najpierw firetms_preview_update_load; wykonanie PUT jest domyślnie zablokowane, dopóki nie potwierdzimy z FireTMS zachowania pominiętej ceny. Nie zmienia przypisania auta. Nie obiecuj zapisu na podstawie samego podglądu.',obj({loadId:id,data:schemas.updateLoad,review_token:{type:'string',maxLength:100}},['loadId','data'])]
];
// Separate public contracts: preview never accepts an execution switch.
export const firetmsPreviewTools=operations.map(([name,,schema])=>({
 name:name.replace('firetms_','firetms_preview_'),
 description:'Sprawdź i pokaż podgląd operacji '+name+'. Nie zapisuje danych w FireTMS. Zwraca review_token ważny 15 minut, związany z dokładnymi danymi. Wykonanie wymaga osobnego narzędzia zapisu i firetms:write. Dla edycji podgląd nie odblokowuje PUT.',
 inputSchema:obj(Object.fromEntries(Object.entries(schema.properties).filter(([key])=>key!=='review_token')),schema.required),
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true},
 securitySchemes:[{type:'oauth2',scopes:['firetms:read']}]
}));
export const firetmsWriteTools=operations.map(([name,description,schema])=>({
 name,
 description:description+' Wymagany review_token z odpowiedniego firetms_preview_* oraz identyczne dane. To narzędzie wykonuje zapis i nie przyjmuje apply.',
 inputSchema:obj(schema.properties,[...schema.required,'review_token']),
 annotations:{readOnlyHint:false,destructiveHint:name==='firetms_update_load',idempotentHint:false,openWorldHint:true},
 securitySchemes:[{type:'oauth2',scopes:['firetms:read','firetms:write']}]
}));
export function validate(value,s,path='data'){
 const fail=(reason='value does not match schema')=>{throw Error('FireTMS validation failed at '+path+': '+reason);};
 if(s.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('expected object');
  for(const k of Object.keys(value))if(!Object.hasOwn(s.properties,k))throw Error('FireTMS validation failed at '+path+'.'+k+': unknown field; accepted fields: '+Object.keys(s.properties).join(', '));
  for(const k of s.required||[])if(!Object.hasOwn(value,k))throw Error('FireTMS validation failed at '+path+'.'+k+': required field missing');
  for(const [k,v]of Object.entries(value))validate(v,s.properties[k],path+'.'+k);
 }else if(s.type==='array'){
  if(!Array.isArray(value)||value.length<(s.minItems??0)||value.length>(s.maxItems??100))fail('expected array with '+(s.minItems??0)+' to '+(s.maxItems??100)+' items');
  value.forEach((v,i)=>validate(v,s.items,path+'.'+i));
 }else if(s.type==='string'){
  if(typeof value!=='string'||value.length>(s.maxLength??2000)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)||(s.pattern&&!new RegExp(s.pattern).test(value)))fail('expected string'+(s.pattern?' matching '+s.pattern:'')+'; maximum length '+(s.maxLength??2000));
  if(s.format==='date-time'&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))fail();
  if(s.format==='date-time'){const [y,m,d]=value.slice(0,10).split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==m-1||dt.getUTCDate()!==d)fail();}
 }else if(s.type==='boolean'){if(typeof value!=='boolean')fail();}
 else if(['number','integer'].includes(s.type)){if(typeof value!=='number'||!Number.isFinite(value)||(s.type==='integer'&&!Number.isInteger(value)))fail();}
 if(s.enum&&!s.enum.includes(value))fail('allowed values: '+s.enum.join(', '));
}
function validateLoad(d){
 if(!d.client||![d.client.id,d.client.taxId,d.client.vatEuId].some(v=>typeof v==='string'&&v.trim()))throw Error('FireTMS invalid client');
 const points=d.cargoHandlings;
 if(!Array.isArray(points)||points.length<2||points.length>30)throw Error('FireTMS invalid route');
 const start=points.findIndex(p=>['LOADING','ATTACH_SEMITRAILER'].includes(p.cargoHandlingType));
 if(start<0||!points.some((p,i)=>i>start&&['UNLOADING','LEAVE_SEMITRAILER'].includes(p.cargoHandlingType)))throw Error('FireTMS invalid route pair');
 let previous=-Infinity;
 for(const p of points){
  if(!p.term||!p.cargoHandlingType||!p.address)throw Error('FireTMS invalid route point');
  const time=Date.parse(p.term);if(time<previous)throw Error('FireTMS invalid route chronology');previous=time;
  const a=p.address;if(!a.addressType)throw Error('FireTMS invalid address');
  for(const k of a.addressType==='ID'?['placeId']:a.addressType==='FULL'?['zipCode','city','streetWithNumber','companyName']:['zipCode','city'])if(!a[k]?.trim())throw Error('FireTMS invalid address');
  if(a.coordinate&&(Math.abs(a.coordinate.latitude)>90||Math.abs(a.coordinate.longitude)>180||!Number.isFinite(a.coordinate.latitude)||!Number.isFinite(a.coordinate.longitude)))throw Error('FireTMS invalid coordinate');
  if(p.cargos?.length&&!['LOADING','UNLOADING'].includes(p.cargoHandlingType))throw Error('FireTMS invalid cargo at terminal');
  for(const c of p.cargos||[]){if(c.adr&&!c.adrClass?.trim())throw Error('FireTMS invalid ADR class');for(const k of ['weight','quantity','length','width','height','ldm'])if(c[k]!==undefined&&c[k]<0)throw Error('FireTMS invalid cargo amount');}
  if(p.timeWindow?.enabled&&(!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(p.timeWindow.start||'')||!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(p.timeWindow.end||'')))throw Error('FireTMS invalid time window');
 }
 if(d.temperatureRange&&(typeof d.temperatureRange.from!=='number'||typeof d.temperatureRange.to!=='number'||d.temperatureRange.from>d.temperatureRange.to))throw Error('FireTMS invalid temperature range');
}
// Receipts are single-process, expire after 15 minutes, and are never retried after an uncertain write.
// Restart invalidates every receipt. For recovery inspect FireTMS before preparing another operation.
export function createFiretmsWrites(env,request){
 const receipts=new Map();
 const truckCarriers=new Map();
 const provisionalNote='KWOTY TYMCZASOWE: przychód 1 EUR i koszt 1 EUR do ustalenia i zmiany przez agenta zamykającego zlecenie po wykonaniu przewozu. Nie są stawką ostateczną.';
 function payloadFor(name,a,target){
  if(name==='firetms_create_load')return {...a.data,price:{amount:1,currencyCode:'EUR'},internalNote:[a.data.internalNote,provisionalNote].filter(Boolean).join('\n')};
  if(name==='firetms_create_transport_order'&&target==='/forwarding-order')return {...a.data,...(truckCarriers.get(a.data.truckId)?{carrierId:truckCarriers.get(a.data.truckId)}:{}),cost:{fixedAmount:1,currencyCode:'EUR'},notes:provisionalNote};
  return a.data;
 }
 const fingerprint=(n,a)=>createHash('sha256').update(JSON.stringify([n,a.loadId,a.data])).digest('hex');
 async function findLoad(loadId){
  for(let page=1;page<=20;page++){
   const r=await request('/loads',{page:String(page),size:'50'});
   if(!Array.isArray(r.items))throw Error('FireTMS invalid loads response');
   const found=r.items.find(x=>x.id===loadId);if(found)return found;
   if(r.items.length<50||r.maxPageNumber<=page)break;
  }
  throw Error('FireTMS load not found within bounded search');
 }
 async function preflight(name,a){
  if(name==='firetms_create_load'&&a.data.clientOrderNumber){
   const ref=a.data.clientOrderNumber;
   if(/["\\]/.test(ref))throw Error('FireTMS invalid reference');
   const r=await request('/loads',{page:'1',size:'2',query:'clientSideOrderNumber=="'+ref+'"'});
   if(!Array.isArray(r.items))throw Error('FireTMS invalid loads response');
   if(r.items.length)throw Error('FireTMS duplicate client reference');
  }
  if(name==='firetms_create_transport_order'){
   let foundTruck=false,external=false;
   for(const source of ['/internal-trucks','/external-trucks']){for(let page=1;page<=20;page++){const trucks=await request(source,{page:String(page),size:'50'});if(!Array.isArray(trucks.items))throw Error('FireTMS invalid trucks response');if(trucks.items.some(t=>t.id===a.data.truckId)){foundTruck=true;external=source==='/external-trucks';const carrierId=trucks.items.find(t=>t.id===a.data.truckId)?.carrierId;if(external&&carrierId)truckCarriers.set(a.data.truckId,carrierId);break;}if(trucks.items.length<50||trucks.maxPageNumber<=page)break;}if(foundTruck)break;}
   if(!foundTruck)throw Error('FireTMS truck not found');
   if(new Set(a.data.loadIds).size!==a.data.loadIds.length)throw Error('FireTMS invalid duplicate load ids');
   for(const loadId of a.data.loadIds){const l=await findLoad(loadId);if(l.carrierOrderNumber?.trim()||l.truckRegistrationNumber?.trim())throw Error('FireTMS load already assigned');}
   return external?'/forwarding-order':'/transport-order';
  }
  if(name==='firetms_update_load')await findLoad(a.loadId);
 }
 return {async run(name,a){
  const tool=[...firetmsPreviewTools,...firetmsWriteTools].find(t=>t.name===name);if(!tool)throw Error('FireTMS unknown tool');
  validate(a,tool.inputSchema,'arguments');
  const preview=firetmsPreviewTools.some(t=>t.name===name);
  name=name.replace('firetms_preview_','firetms_');
  if(JSON.stringify(a.data).length>50000)throw Error('FireTMS invalid payload size');
  if(name!=='firetms_create_transport_order')validateLoad(a.data);
  const path=name==='firetms_create_load'?'/loads':name==='firetms_update_load'?'/loads/'+a.loadId:'/transport-order';
  const method=name==='firetms_update_load'?'PUT':'POST';
  const params=name==='firetms_create_transport_order'?{}:{allowClientOrderNumberDuplicates:'false'};
  if(preview){
   for(const [k,v]of receipts)if(v.expires<Date.now())receipts.delete(k);
   if(receipts.size>=500)throw Error('FireTMS too many pending operations');
   const target=await preflight(name,a)||path;
   const review_token=randomBytes(24).toString('base64url');
   receipts.set(review_token,{hash:fingerprint(name,a),expires:Date.now()+900000,state:'prepared',target});
   return {status:'preview_only',written:false,method,path:target,data:payloadFor(name,a,target),review_token,expires_in_seconds:900,
    execution_enabled:name!=='firetms_update_load'||env.FIRETMS_OPERATIONAL_PUT_VERIFIED==='true',
    warning:name==='firetms_update_load'?'PUT zastępuje dane zlecenia klienta. Wykonanie domyślnie zablokowane: niepotwierdzone zachowanie pominiętej ceny.':name==='firetms_create_transport_order'?'FireTMS dobiera domyślny zestaw i oblicza koszt z ustawień auta. Sprawdź auto, naczepę i kierowców.':'Możliwy szkic DRAFT bez ceny. Bez referencji klienta API nie gwarantuje wykrycia duplikatów. Po utracie odpowiedzi sprawdź listę przed ponowną próbą.'};
  }
  if(name==='firetms_update_load'&&env.FIRETMS_OPERATIONAL_PUT_VERIFIED!=='true')throw Error('FireTMS update blocked: omitted price semantics not verified');
  const r=receipts.get(a.review_token);
  if(!r||r.expires<Date.now()||r.hash!==fingerprint(name,a))throw Error('FireTMS invalid or expired review token');
  if(r.state==='done')return r.result;
  if(r.state==='rejected')throw Error(r.error);
  if(r.state!=='prepared')throw Error('FireTMS write outcome unknown or in progress; inspect system before retry');
  r.state='checking';
  try{const target=await preflight(name,a)||path;if(target!==r.target)throw Error('FireTMS truck type changed; prepare again');}catch(e){r.state='prepared';throw e;}
  r.state='in_progress';
  try{
   const data=await request(r.target,r.target==='/forwarding-order'?{confirm:'false'}:params,method,payloadFor(name,a,r.target));
   // Never call a status complete/confirmed unless the subsequent read says so.
   let verification=null;
   if(name==='firetms_create_transport_order'&&data?.id){try{verification=await request('/orders/'+data.id,{});}catch{verification={readback_failed:true};}}
   if(name==='firetms_create_load'&&a.data.clientOrderNumber){try{verification=await request('/loads',{page:'1',size:'2',query:'clientSideOrderNumber=="'+a.data.clientOrderNumber+'"'});}catch{verification={readback_failed:true};}}
   r.result={status:'api_accepted',written:true,data,verification,provisionalAmounts:name==='firetms_create_load'?{revenue_eur:1,final:false}:r.target==='/forwarding-order'?{cost_eur:1,final:false}:undefined,note:'Sprawdź status odpowiedzi i odczyt kontrolny. Nie oznacza wysłania planu kierowcy. Nie ponawiaj tworzenia po utracie odpowiedzi bez sprawdzenia FireTMS.'};r.state='done';return r.result;
  }catch(e){r.state='unknown';if(/^FireTMS HTTP 4[0-9]{2}(?: [A-Za-z0-9 ._:;-]*)?$/.test(e.message)){r.state='rejected';r.error=e.message;throw e;}throw Error('FireTMS write outcome unknown; '+(/^FireTMS HTTP [0-9]{3}/.test(e.message)?e.message:'inspect system before retry'));}
 }};
}

