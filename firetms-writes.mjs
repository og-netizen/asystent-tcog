import {memoryKey} from './operational-memory.mjs';
import {createMemoryStateStore} from './state-store.mjs';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
const schemas=JSON.parse(readFileSync(new URL('./firetms-schemas.json',import.meta.url),'utf8'));
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const id={type:'string',pattern:'^[A-Za-z0-9-]{1,80}$'};
const canonicalContext=x=>Array.isArray(x)?x.map(canonicalContext):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonicalContext(x[k])])):x;
const transportSchema=obj({truckId:id,loadIds:{type:'array',items:id,minItems:1,maxItems:30}},['truckId','loadIds']);
const operations=[
 ['firetms_create_load','Utwórz zlecenie KLIENTA (load). Zgodnie z zasadą TCOG przychód tymczasowy wynosi 1 EUR i jest oznaczony do zmiany przy zamknięciu. Najpierw firetms_preview_create_load, potem to narzędzie z otrzymanym review_token. Nie zakłada jeszcze zlecenia na auto. API może utworzyć szkic DRAFT; sprawdź wynik. Nie podawaj dowolnych cen, płatności ani faktur; serwer dodaje tylko uzgodnione tymczasowe 1 EUR.',obj({data:schemas.createLoad,review_token:{type:'string',maxLength:100}},['data'])],
 ['firetms_create_transport_order','Utwórz zlecenie TRANSPORTOWE na istniejące auto własne lub zewnętrzne z istniejących loadIds. Dla auta zewnętrznego powstaje zlecenie spedycyjne z żądaniem potwierdzenia; sprawdź faktyczny status i numer w wyniku. FireTMS może potwierdzić transport własny i dobrać domyślną naczepę/kierowców oraz policzyć koszt z ustawień auta. Nie wysyła planu kierowcy. Najpierw firetms_preview_create_transport_order, potem to narzędzie z review_token. Sprawdź zestaw i status w wyniku.',obj({data:transportSchema,review_token:{type:'string',maxLength:100}},['data'])],
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
 else if(['number','integer'].includes(s.type)){
  if(typeof value!=='number'||!Number.isFinite(value)||(s.type==='integer'&&!Number.isInteger(value)))fail('expected finite '+s.type);
  if(s.minimum!==undefined&&value<s.minimum)fail('must be at least '+s.minimum);
  if(s.exclusiveMinimum!==undefined&&value<=s.exclusiveMinimum)fail('must be greater than '+s.exclusiveMinimum);
 }
 if(s.enum&&!s.enum.includes(value))fail('allowed values: '+s.enum.join(', '));
}
function invalid(path,reason){throw Error('FireTMS validation failed at arguments.data.'+path+': '+reason);}
function nonBlank(value,path){if(typeof value!=='string'||!value.trim())invalid(path,'nonblank string required');}
function validateZip(zip,path){
 nonBlank(zip,path);
 // The API expects its normalized country-prefixed form, not the driver-facing DE-23570.
 if(!/^[A-Z]{2}[A-Z0-9]+$/.test(zip))invalid(path,'expected country prefix without spaces or separators; example DE23570');
 const country=zip.slice(0,2),postal=zip.slice(2);
 const lengths={DE:5,IT:5,PL:5,FR:5,ES:5,SE:5,FI:5,CZ:5,SK:5,AT:4,BE:4,CH:4,DK:4,NO:4,HU:4,PT:7};
 if(lengths[country]&&!new RegExp('^\\d{'+lengths[country]+'}$').test(postal))invalid(path,'invalid postal code for '+country);
 if(country==='NL'&&!/^\d{4}[A-Z]{2}$/.test(postal))invalid(path,'expected NL followed by four digits and two letters');
}
function validateLoad(d){
 if(!d.client||![d.client.id,d.client.taxId,d.client.vatEuId].some(v=>typeof v==='string'&&v.trim()))throw Error('FireTMS invalid client');
 const points=d.cargoHandlings;
 if(!Array.isArray(points)||points.length<2||points.length>30)throw Error('FireTMS invalid route');
 const start=points.findIndex(p=>['LOADING','ATTACH_SEMITRAILER'].includes(p.cargoHandlingType));
 if(start<0||!points.some((p,i)=>i>start&&['UNLOADING','LEAVE_SEMITRAILER'].includes(p.cargoHandlingType)))throw Error('FireTMS invalid route pair');
 let previous=-Infinity;
 for(const [index,p]of points.entries()){
  if(!p.term||!p.cargoHandlingType||!p.address)throw Error('FireTMS invalid route point');
  const time=Date.parse(p.term);if(time<previous)throw Error('FireTMS invalid route chronology');previous=time;
  const a=p.address;if(!a.addressType)throw Error('FireTMS invalid address');
  for(const k of a.addressType==='ID'?['placeId']:a.addressType==='FULL'?['zipCode','city','streetWithNumber','companyName']:['zipCode','city'])nonBlank(a[k],'cargoHandlings.'+index+'.address.'+k);
  if(a.addressType!=='ID')validateZip(a.zipCode,'cargoHandlings.'+index+'.address.zipCode');
  if(a.coordinate&&(Math.abs(a.coordinate.latitude)>90||Math.abs(a.coordinate.longitude)>180||!Number.isFinite(a.coordinate.latitude)||!Number.isFinite(a.coordinate.longitude)))throw Error('FireTMS invalid coordinate');
  if(p.cargos?.length&&!['LOADING','UNLOADING'].includes(p.cargoHandlingType))throw Error('FireTMS invalid cargo at terminal');
  for(const [ci,c]of (p.cargos||[]).entries()){
   const cp='cargoHandlings.'+index+'.cargos.'+ci;
   nonBlank(c.cargoName,cp+'.cargoName');nonBlank(c.unitName,cp+'.unitName');
   if(c.quantity===undefined||c.quantity<=0)invalid(cp+'.quantity','must be greater than zero');
   if(c.adr&&!c.adrClass?.trim())invalid(cp+'.adrClass','required when adr is true');
  }
  if(p.timeWindow?.enabled&&(!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(p.timeWindow.start||'')||!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(p.timeWindow.end||'')))throw Error('FireTMS invalid time window');
 }
 if(d.temperatureRange&&(typeof d.temperatureRange.from!=='number'||typeof d.temperatureRange.to!=='number'||d.temperatureRange.from>d.temperatureRange.to))throw Error('FireTMS invalid temperature range');
}
// Cloud receipts use SQL atomic claims; Render fallback remains in-memory.
// Unknown/in-progress writes are never retried after a restart or lost response.
export function createFiretmsWrites(env,request,stateStore=createMemoryStateStore()){
 const ns='firetms-receipts';
 const save=(token,r)=>stateStore.put(ns,token,r,r.expires);
 const provisionalNote='KWOTY TYMCZASOWE: przychód 1 EUR i koszt 1 EUR do ustalenia i zmiany przez agenta zamykającego zlecenie po wykonaniu przewozu. Nie są stawką ostateczną.';
 function payloadFor(name,a,context){
  if(name==='firetms_create_load')return {...a.data,price:{amount:1,currencyCode:'EUR'},internalNote:[a.data.internalNote,provisionalNote].filter(Boolean).join('\n')};
  if(name==='firetms_create_transport_order'&&context.target==='/forwarding-order')return {...a.data,carrierId:context.carrierId,departmentId:context.departmentId,paymentTerm:context.paymentTerm,cost:{fixedAmount:1,currencyCode:'EUR'},notes:provisionalNote+'\n'+context.paymentNote};
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
 async function verifyUnits(d){
  const needed=new Set(d.cargoHandlings.flatMap(p=>(p.cargos||[]).map(c=>c.unitName)));
  if(!needed.size)return;
  for(let page=1;page<=20;page++){
   const r=await request('/unit-of-measure',{page:String(page),size:'50'});
   if(!Array.isArray(r.items))throw Error('FireTMS invalid units response');
   for(const unit of r.items)needed.delete(unit.defaultName);
   if(!needed.size)return;
   if(r.items.length<50||r.maxPageNumber<=page)throw Error('FireTMS validation failed at arguments.data.cargoHandlings.cargos.unitName: unit not found in tenant dictionary');
  }
  throw Error('FireTMS unit lookup exceeded bounded search; inspect dictionary before retry');
 }
 async function verifyCarrier(carrierId){
  if(typeof carrierId!=='string'||!carrierId.trim())throw Error('FireTMS external truck has no carrierId; repair vehicle carrier before retry');
  for(let page=1;page<=20;page++){
   const r=await request('/contractors',{page:String(page),pageSize:'50',deleted:'false'});
   if(!Array.isArray(r.items))throw Error('FireTMS invalid contractors response');
   const c=r.items.find(x=>x.id===carrierId);
   if(c){
    if(c.carrier!==true||c.deleted===true)throw Error('FireTMS contractor is not an active carrier');
    if(!['SOLID','NEUTRAL','DELAYS_IN_PAYMENT','UNRELIABLE'].includes(c.grade))throw Error('FireTMS carrier grade blocked or unverified; inspect contractor before retry');
    return;
   }
   if(r.items.length<50||r.maxPageNumber<=page)throw Error('FireTMS carrier not found in active contractors');
  }
  throw Error('FireTMS carrier lookup exceeded bounded search; inspect contractor before retry');
 }
 async function forwardingSettings(carrierId){
  const {key}=memoryKey({kind:'rule',client_key:'firetms-forwarding',context:{topic:'carrier-payment-policy'}});
  const record=await stateStore.memoryLatest(env.WFIRMA_COMPANY_ID,key);
  if(!record||record.operation==='retract')throw Error('FireTMS forwarding policy missing');
  let policy;try{policy=JSON.parse(record.content.rule);}catch{throw Error('FireTMS forwarding policy invalid');}
  const carrier=policy.carriers?.find(c=>c.id===carrierId);
  if(policy.version!==1||!carrier||!Number.isInteger(carrier.days)||carrier.days<1||carrier.days>365||typeof policy.departmentId!=='string'||! /^[A-Za-z0-9-]{1,80}$/.test(policy.departmentId)||typeof policy.receiptDescription!=='string'||policy.receiptDescription.length>200||/[\r\n]/.test(policy.receiptDescription))throw Error('FireTMS forwarding policy invalid or carrier missing');
  if(!['INVOICE_CREATION','INVOICE_ISSUANCE','INVOICE_RECEIPT','SELL_DATE'].includes(policy.apiBasePoint))throw Error('FireTMS payment receipt basis requires operator decision');
  let found=false;for(let page=1;page<=20;page++){const d=await request('/departments',{page:String(page),size:'50'});if(!Array.isArray(d.items))throw Error('FireTMS invalid departments response');if(d.items.some(x=>x.id===policy.departmentId)){found=true;break;}if(d.items.length<50||d.maxPageNumber<=page)break;}
  if(!found)throw Error('FireTMS configured department not found');
  return {departmentId:policy.departmentId,paymentTerm:{basePoint:policy.apiBasePoint,daysOffset:carrier.days,offsetType:'SET_AMOUNT_OF_DAYS'},paymentNote:'Termin płatności: '+carrier.days+' dni '+policy.receiptDescription+'.',policyRevision:record.revision};
 }
 async function preflight(name,a){
  if(name!=='firetms_create_transport_order')await verifyUnits(a.data);
  if(name==='firetms_create_load'&&a.data.clientOrderNumber){
   const ref=a.data.clientOrderNumber;
   if(/["\\]/.test(ref))throw Error('FireTMS invalid reference');
   const r=await request('/loads',{page:'1',size:'2',query:'clientSideOrderNumber=="'+ref+'"'});
   if(!Array.isArray(r.items))throw Error('FireTMS invalid loads response');
   if(r.items.length)throw Error('FireTMS duplicate client reference');
  }
  if(name==='firetms_create_transport_order'){
   let foundTruck=false,external=false,carrierId;
   for(const source of ['/internal-trucks','/external-trucks']){for(let page=1;page<=20;page++){const trucks=await request(source,{page:String(page),size:'50'});if(!Array.isArray(trucks.items))throw Error('FireTMS invalid trucks response');if(trucks.items.some(t=>t.id===a.data.truckId)){foundTruck=true;external=source==='/external-trucks';carrierId=trucks.items.find(t=>t.id===a.data.truckId)?.carrierId;break;}if(trucks.items.length<50||trucks.maxPageNumber<=page)break;}if(foundTruck)break;}
   if(!foundTruck)throw Error('FireTMS truck not found');
   if(new Set(a.data.loadIds).size!==a.data.loadIds.length)throw Error('FireTMS invalid duplicate load ids');
   if(external)await verifyCarrier(carrierId);
   for(const loadId of a.data.loadIds){
    const l=await findLoad(loadId);if(l.carrierOrderNumber?.trim()||l.truckRegistrationNumber?.trim())throw Error('FireTMS load already assigned');
    // The API returns statusDescription, not a documented eligibility enum. Unknown/localized values remain vendor-validated.
    if(/^(DRAFT|REMOVABLE_DRAFT|SZKIC)$/i.test(l.statusDescription?.trim()||''))throw Error('FireTMS load is draft; complete client load before assignment');
   }
   return {target:external?'/forwarding-order':'/transport-order',...(external?{carrierId,confirm:true,checkTransportSetConflicts:true,...await forwardingSettings(carrierId)}:{})};
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
   await stateStore.prune(ns);
   if(await stateStore.count(ns)>=500)throw Error('FireTMS too many pending operations');
   const context=await preflight(name,a)||{target:path};
   const target=context.target;
   const review_token=randomBytes(24).toString('base64url');
   await save(review_token,{hash:fingerprint(name,a),expires:Date.now()+900000,state:'prepared',target,context});
   return {status:'preview_only',written:false,method,path:target,...(target==='/forwarding-order'?{query:{confirm:'true',checkTransportSetConflicts:'true'}}:{}),data:payloadFor(name,a,context),review_token,expires_in_seconds:900,
    execution_enabled:name!=='firetms_update_load'||env.FIRETMS_OPERATIONAL_PUT_VERIFIED==='true',
    warning:name==='firetms_update_load'?'Wykonanie PUT domyślnie zablokowane: niepotwierdzone zachowanie pominiętych pól i ceny.':name==='firetms_create_transport_order'?'Sprawdzono auto, przypisanie load i aktywnego przewoźnika dla auta zewnętrznego. Pozostałe warunki statusu sprawdza FireTMS. Zestaw domyślny wymaga kontroli po zapisie.':'Podgląd nie potwierdza walidacji po stronie FireTMS, w tym geokodowania i limitów klienta. Bez referencji klienta nie gwarantuje wykrycia duplikatów. Po utracie odpowiedzi sprawdź listę przed ponowną próbą.'};
  }
  if(name==='firetms_update_load'&&env.FIRETMS_OPERATIONAL_PUT_VERIFIED!=='true')throw Error('FireTMS update blocked: omitted price semantics not verified');
  let r=await stateStore.get(ns,a.review_token);
  if(!r||r.expires<Date.now()||r.hash!==fingerprint(name,a))throw Error('FireTMS invalid or expired review token');
  if(r.state==='done')return r.result;
  if(r.state==='rejected'){const e=Error(r.errorMessage||'FireTMS rejected operation');if(r.errorDiagnostic)e.firetms=r.errorDiagnostic;throw e;}
  if(r.state!=='prepared')throw Error('FireTMS write outcome unknown or in progress; inspect system before retry');
  r=await stateStore.claim(ns,a.review_token,'prepared','checking');
  if(!r)throw Error('FireTMS write outcome unknown or in progress; inspect system before retry');
  try{const context=await preflight(name,a)||{target:path};if(JSON.stringify(canonicalContext(context))!==JSON.stringify(canonicalContext(r.context)))throw Error('FireTMS truck type or carrier changed; prepare again');}catch(e){r.state='prepared';await save(a.review_token,r);throw e;}
  r.state='in_progress';await save(a.review_token,r);
  try{
   const data=await request(r.target,r.target==='/forwarding-order'?{confirm:'true',checkTransportSetConflicts:'true'}:params,method,payloadFor(name,a,r.context));
   // Never call a status complete/confirmed unless the subsequent read says so.
   let verification=null;
   if(name==='firetms_create_transport_order'&&data?.id){try{verification=await request('/orders/'+data.id,{});}catch{verification={readback_failed:true};}}
   if(name==='firetms_create_load'&&a.data.clientOrderNumber){try{verification=await request('/loads',{page:'1',size:'2',query:'clientSideOrderNumber=="'+a.data.clientOrderNumber+'"'});}catch{verification={readback_failed:true};}}
   r.result={status:'api_accepted',written:true,data,verification,provisionalAmounts:name==='firetms_create_load'?{revenue_eur:1,final:false}:r.target==='/forwarding-order'?{cost_eur:1,final:false}:undefined,note:'Sprawdź status odpowiedzi i odczyt kontrolny. Nie oznacza wysłania planu kierowcy. Nie ponawiaj tworzenia po utracie odpowiedzi bez sprawdzenia FireTMS.'};r.state='done';await save(a.review_token,r);return r.result;
  }catch(e){r.state='unknown';if(/^FireTMS HTTP 4[0-9]{2}(?: [A-Za-z0-9 ._:;-]*)?$/.test(e.message)){r.state='rejected';r.errorMessage=e.message;if(e.firetms)r.errorDiagnostic=e.firetms;await save(a.review_token,r);throw e;}await save(a.review_token,r);const failure=Error('FireTMS write outcome unknown; '+(/^FireTMS HTTP [0-9]{3}/.test(e.message)?e.message:'inspect system before retry'));if(e.firetms)failure.firetms={...e.firetms,outcome:'unknown',retry:false};throw failure;}
 }};
}

