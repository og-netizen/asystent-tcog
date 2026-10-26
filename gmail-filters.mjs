import {randomBytes,createHash} from 'node:crypto';
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const change=schema({query:{type:'string',minLength:1,maxLength:2000},add_label_id:{type:'string'},remove_label_ids:{type:'array',items:{type:'string'},maxItems:10},replace_filter_id:{type:'string'}},['query','add_label_id']);
export const gmailTools=[
 {name:'gmail_connection_status',description:'Sprawdź zapisane połączenie serwera z Gmail i właściwą skrzynkę. Nie uruchamia automatyzacji.',inputSchema:schema({})},
 {name:'gmail_list_labels',description:'Odczytaj etykiety Gmail i ich identyfikatory. Nie zmienia wiadomości.',inputSchema:schema({})},
 {name:'gmail_list_filters',description:'Odczytaj aktywne natywne filtry Gmail. Ich kolejność nie oznacza pierwszeństwa; wiele filtrów może pasować do jednej wiadomości.',inputSchema:schema({})},
 {name:'gmail_preview_filter_change',description:'Podgląd utworzenia lub zastąpienia filtra. Tylko etykiety TCOG, bez wysyłki, archiwizacji i oznaczania jako przeczytane. Nie zapisuje. Zapytanie używa składni Gmail, bez regex i bez gwarancji odczytu PDF; nie uruchamia AI ani nie zmienia starych maili.',inputSchema:change},
 {name:'gmail_apply_filter_change',description:'Wykonaj zatwierdzoną zmianę filtra na podstawie review_token z podglądu. Wymaga gmail:write. Zastąpienie tworzy nowy filtr i usuwa stary; po niepewnym błędzie sprawdź listę, nie ponawiaj zapisu.',inputSchema:schema({review_token:{type:'string'}},['review_token'])}
].map(t=>({...t,annotations:{readOnlyHint:t.name!=='gmail_apply_filter_change',destructiveHint:t.name==='gmail_apply_filter_change',idempotentHint:t.name!=='gmail_apply_filter_change',openWorldHint:true},securitySchemes:[{type:'oauth2',scopes:t.name==='gmail_apply_filter_change'?['gmail:read','gmail:write']:['gmail:read']}]}));
const fingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
const filterBody=f=>({criteria:f.criteria||{},action:f.action||{}});
export function createGmailFilters(oauth,{now=Date.now}={}){
 const reviews=new Map();
 async function snapshot(){const [labels,filters]=await Promise.all([oauth.request('GET','labels'),oauth.request('GET','settings/filters')]);return {labels:labels.labels||[],filters:filters.filter||[]};}
 const tcogIds=s=>new Set(s.labels.filter(l=>l.type==='user'&&l.name?.startsWith('TCOG/')).map(l=>l.id));
 function allowedOld(f,ids){return !Object.keys(f.action||{}).some(k=>!['addLabelIds','removeLabelIds'].includes(k))&&[...(f.action?.addLabelIds||[]),...(f.action?.removeLabelIds||[])].every(id=>ids.has(id));}
 async function run(name,a={}){
  if(!a||typeof a!=='object'||Array.isArray(a))throw Error('Gmail invalid arguments');
  const allowed={gmail_connection_status:[],gmail_list_labels:[],gmail_list_filters:[],gmail_preview_filter_change:['query','add_label_id','remove_label_ids','replace_filter_id'],gmail_apply_filter_change:['review_token']}[name];
  if(!allowed||Object.keys(a).some(k=>!allowed.includes(k)))throw Error('Gmail invalid arguments');
  for(const [k,v]of reviews)if(v.expires<=now())reviews.delete(k);
  if(name==='gmail_connection_status'){const p=await oauth.checkSaved();return {connected:true,email:p.emailAddress,automatic_agent_running:false};}
  if(name==='gmail_list_labels')return oauth.request('GET','labels');
  if(name==='gmail_list_filters')return oauth.request('GET','settings/filters');
  if(name==='gmail_preview_filter_change'){
   if(typeof a.query!=='string'||!a.query.trim()||a.query.length>2000||typeof a.add_label_id!=='string'||(a.replace_filter_id!==undefined&&(typeof a.replace_filter_id!=='string'||! /^[A-Za-z0-9_-]{1,256}$/.test(a.replace_filter_id))))throw Error('Gmail invalid arguments');
   const remove=a.remove_label_ids??[];if(!Array.isArray(remove)||remove.length>10||remove.some(x=>typeof x!=='string')||remove.includes(a.add_label_id))throw Error('Gmail invalid labels');
   const s=await snapshot(),ids=tcogIds(s);
   if(!ids.has(a.add_label_id)||remove.some(id=>!ids.has(id)))throw Error('Gmail only existing TCOG labels allowed');
   const body={criteria:{query:a.query.trim()},action:{addLabelIds:[a.add_label_id],...(remove.length?{removeLabelIds:[...new Set(remove)].sort()}: {})}};
   const old=a.replace_filter_id?s.filters.find(f=>f.id===a.replace_filter_id):undefined;
   if(a.replace_filter_id&&(!old||!allowedOld(old,ids)))throw Error('Gmail replacement requires an existing TCOG-only filter');
   const token=randomBytes(32).toString('base64url');reviews.set(token,{body,old:old?structuredClone(old):undefined,expires:now()+900000,state:'ready'});
   return {written:false,review_token:token,expires_in:900,mailbox:(await oauth.checkSaved()).emailAddress,change:body,replaces:old||null,labels:s.labels.filter(l=>l.id===a.add_label_id||remove.includes(l.id)),note:'Dotyczy nowych maili. Nie wykonuje AI, nie przenosi starych wiadomości. Dopasowanie Gmail nie jest regex ani parserem PDF. Filtry nie mają kolejności priorytetów.'};
  }
  const r=reviews.get(a.review_token);if(!r)throw Error('Gmail review expired; preview again');
  if(r.state==='done')return r.result;
  if(r.state!=='ready')throw Error('Gmail write uncertain or already started; list filters before another preview');
  r.state='checking';let mutation=false,newId;
  try{
   const s=await snapshot(),ids=tcogIds(s);
   if([...r.body.action.addLabelIds,...(r.body.action.removeLabelIds||[])].some(id=>!ids.has(id)))throw Error('Gmail labels changed; preview again');
   if(r.old){const current=s.filters.find(f=>f.id===r.old.id);if(!current||fingerprint(filterBody(current))!==fingerprint(filterBody(r.old)))throw Error('Gmail filter changed; preview again');}
   const same=s.filters.find(f=>fingerprint(filterBody(f))===fingerprint(r.body));
   if(same)newId=same.id;
   else{mutation=true;const created=await oauth.request('POST','settings/filters',r.body);if(typeof created.id!=='string'||! /^[A-Za-z0-9_-]{1,256}$/.test(created.id))throw Error('Gmail create result uncertain');newId=created.id;}
   if(r.old&&r.old.id!==newId){mutation=true;await oauth.request('DELETE','settings/filters/'+encodeURIComponent(r.old.id));}
   const readback=await oauth.request('GET','settings/filters');const verified=(readback.filter||[]).some(f=>f.id===newId&&fingerprint(filterBody(f))===fingerprint(r.body));
   const oldRemoved=!r.old||r.old.id===newId||!(readback.filter||[]).some(f=>f.id===r.old.id);
   if(!verified||!oldRemoved)throw Error('Gmail verification uncertain');
   r.result={written:mutation,verified:true,filter_id:newId,replaced_filter_id:r.old?.id||null,applies_to:'new_incoming_messages'};r.state='done';return r.result;
  }catch(e){r.state=mutation?'uncertain':'failed';throw Error(mutation?'Gmail write uncertain; list filters before retry; new_filter_id='+String(newId||'unknown'):e.message);}
 }
 return {run};
}
