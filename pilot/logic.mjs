const HOUR=3600000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function validateOrder(x,now=Date.now()){
 const text=(v,n)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error('Uzupełnij nazwę zlecenia i adresy.');return v.trim();};
 const stop=s=>{if(!s||!finite(s.lat)||Math.abs(s.lat)>90||!finite(s.lng)||Math.abs(s.lng)>180||!finite(s.radius)||s.radius<50||s.radius>2000)throw Error('Sprawdź współrzędne i promień (50–2000 m).');return {address:text(s.address,300),lat:s.lat,lng:s.lng,radius:s.radius};};
 const start=Date.parse(x.start),end=Date.parse(x.end);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<now-48*HOUR||end<=start||end-start>48*HOUR||end>now+30*24*HOUR)throw Error('Załadunek: najwyżej 2 dni wstecz. Rozładunek musi być później; trasa maksymalnie 48 godzin.');
 if(!finite(x.revenue)||x.revenue<0||x.revenue>1000000||!['PLN','EUR'].includes(x.currency))throw Error('Sprawdź przychód i walutę.');
 return {reference:text(x.reference,100),start:new Date(start).toISOString(),end:new Date(end).toISOString(),load:stop(x.load),unload:stop(x.unload),revenue:x.revenue,currency:x.currency};
}
export function metres(a,b){
 const r=Math.PI/180,dlat=(b.lat-a.lat)*r,dlng=(b.lng-a.lng)*r;
 const v=Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlng/2)**2;
 return 6371000*2*Math.asin(Math.sqrt(Math.min(1,v)));
}
export function mergeSamples(old,added){
 const map=new Map();for(const s of [...old,...added])if(Number.isFinite(Date.parse(s.date)))map.set(new Date(s.date).toISOString(),{...s,date:new Date(s.date).toISOString()});
 return [...map.values()].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
}
// A visit needs two low-speed samples at least five minutes apart. A gap
// over ten minutes breaks evidence; an outside sample establishes departure.
function visit(rows,stop,after){
 let first=null,last=null,confirmed=false;
 for(const s of rows){
  const t=Date.parse(s.date);if(t<after)continue;
  if(!finite(s.lat)||!finite(s.lng))continue;
  const inside=metres(s,stop)<=stop.radius;
  if(first&&t-Date.parse(last.date)>600000){if(confirmed)return {arrival:first,departure:null,uncertain:true};first=null;last=null;}
  if(!inside){if(confirmed)return {arrival:first,departure:s,uncertain:false};first=null;last=null;continue;}
  if(finite(s.speed)&&s.speed<=3){first??=s;last=s;if(t-Date.parse(first.date)>=300000)confirmed=true;}
  else if(!confirmed){first=null;last=null;}
  else last=s;
 }
 return confirmed?{arrival:first,departure:null,uncertain:false}:null;
}
function delta(a,b,key){
 if(!a||!b||!finite(a[key])||!finite(b[key]))return null;
 const d=b[key]-a[key];return d>=0?Math.round(d*100)/100:null;
}
export function analyse(order){
 const rows=mergeSamples([],order.samples||[]),warnings=[];
 const load=visit(rows,order.load,Date.parse(order.start)-2*HOUR);
 const unload=load?.departure?visit(rows,order.unload,Date.parse(load.departure.date)):null;
 const a=load?.departure,b=unload?.arrival;
 let source='CAN',km=delta(a,b,'odometer_can_km');
 if(km===null){source='GPS';km=delta(a,b,'odometer_gps_km');}
 if(km===null)source=null;
 const fuel=delta(a,b,'total_fuel_can_l');
 let gaps=0;for(let i=1;i<rows.length;i++)if(Date.parse(rows[i].date)-Date.parse(rows[i-1].date)>600000)gaps++;
 if(gaps)warnings.push(`${gaps} przerw w próbkach dłuższych niż 10 minut.`);
 if(order.emptyWindows)warnings.push(`${order.emptyWindows} pobranych okien bez danych. Brak danych nie oznacza postoju.`);
 if(load?.uncertain||unload?.uncertain)warnings.push('Brak ciągłych danych do ustalenia wyjazdu.');
 if(a&&b&&km===null)warnings.push('Brak porównywalnych liczników albo cofnięcie licznika.');
 if(source==='GPS')warnings.push('Przebieg z licznika GPS — brak porównywalnych odczytów CAN.');
 warnings.push('Godziny i liczniki dotyczą próbek w pobliżu zdarzeń; nie są potwierdzeniem obsługi towaru.');
 return {load,unload,km,source,fuel_l:fuel,litres_per_100km:km>0&&fuel!==null?Math.round(fuel/km*10000)/100:null,revenue_per_km:km>0?Math.round(order.revenue/km*100)/100:null,sample_count:rows.length,first_sample:rows[0]?.date??null,last_sample:rows.at(-1)?.date??null,warnings,status:unload?'Wykryto postój przy rozładunku':load?.departure?'W trasie':load?'Postój przy załadunku':'Oczekiwanie na dane / załadunek'};
}
