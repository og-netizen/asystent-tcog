import {PDFDocument,StandardFonts,rgb,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib';

const text=v=>typeof v==='string'?v.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,600):'';
const money=v=>v&&Number.isFinite(v.price)&&v.price>=0&&/^[A-Z]{3}$/.test(v.currency)?{price:v.price,currency:v.currency}:null;
const latlon=p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Math.abs(p[0])<=180&&Number.isFinite(p[1])&&Math.abs(p[1])<=85.051129;
export function parseGeometry(value){
 try{const g=typeof value==='string'?JSON.parse(value):value;
  if(g?.type!=='LineString'||!Array.isArray(g.coordinates)||g.coordinates.length<2||g.coordinates.length>200000||!g.coordinates.every(latlon))return null;
  return {type:'LineString',coordinates:g.coordinates.map(p=>p.slice(0,2))};
 }catch{return null;}
}
export function routeDetails(data,args){
 const geometry=parseGeometry(data.polyline),events=Array.isArray(data.events)?data.events:[];
 const turns=events.filter(e=>e.maneuver&&Number.isFinite(e.distanceFromStart)).map(e=>({distance_from_start_m:e.distanceFromStart,country:text(e.countryCode),latitude:e.latitude,longitude:e.longitude,type:text(e.maneuver.type),road_number:text(e.maneuver.roadAhead?.number),road_name:text(e.maneuver.roadAhead?.name),signposted_directions:text(e.maneuver.directionSignText),description:text(e.maneuver.description)}));
 // Only roads actually entered (roadAhead), never roads mentioned on a signpost.
 const runs=[];
 for(let i=0;i<turns.length;i++){
  const t=turns[i],end=turns[i+1]?.distance_from_start_m??data.distance,meters=Math.max(0,end-t.distance_from_start_m);
  if(!t.road_number)continue;
  const prev=runs.at(-1);
  if(prev&&prev.number===t.road_number&&prev.country===t.country&&prev.end_m===t.distance_from_start_m){prev.distance_m+=meters;prev.end_m=end;}
  else runs.push({number:t.road_number,country:t.country,from_m:t.distance_from_start_m,end_m:end,distance_m:meters});
 }
 const main=runs.filter(r=>r.distance_m>=5000||/^A\s?\d/i.test(r.number)).map(r=>({...r,distance_km:Math.round(r.distance_m/100)/10}));
 const requested=args.include_tolls===true,raw=data.toll,costs=raw?.costs;
 const prices=Array.isArray(costs?.prices)?costs.prices.map(money).filter(Boolean):[];
 const countryRows=Array.isArray(costs?.countries)?costs.countries.map(c=>({country:text(c.countryCode),price:money(c.price),converted_price:money(c.convertedPrice)})).filter(c=>c.price):[];
 const available=requested&&prices.length>0&&prices.length===costs.prices.length&&Array.isArray(costs.countries)&&countryRows.length===costs.countries.length;
 const missing=requested?['height','width','length','emptyWeight','loadWeight','totalPermittedWeight','totalTechnicallyPermittedWeight','numberOfAxles','emissionStandard','co2EmissionClass'].filter(k=>args.vehicle?.[k]===undefined):[];
 const sections=Array.isArray(raw?.sections)?raw.sections.map(s=>({country:text(s.countryCode),name:text(s.displayName),type:text(s.tollRoadType),system_index:s.tollSystemIndex,distance_m:s.calculatedDistance,approximated:s.approximated===true,prices:Array.isArray(s.costs)?s.costs.map(c=>({price:money(c),converted_price:money(c.convertedPrice)})).filter(c=>c.price):[]})):[];
 const systems=Array.isArray(raw?.systems)?raw.systems.map(s=>({name:text(s.name),operator:text(s.operatorName),tariff_version:text(s.tariffVersion),valid_from:text(s.tariffVersionValidFrom)})):[];
 return {route_id:text(data.routeId),geometry,geometry_available:!!geometry,geometry_point_count:geometry?.coordinates.length??0,
  main_roads:main,road_sequence:main.map(r=>r.number),maneuvers:turns.slice(0,1500),maneuvers_truncated:turns.length>1500,
  directions_note:'signposted_directions to kierunki ze znaków, nie lista miast odwiedzanych przez trasę.',
  toll:{requested,available,estimated:true,requires_review:requested&&(!available||missing.length>0||!args.departure||costs?.containsApproximatedSections===true),missing_vehicle_parameters:missing,
   departure_requires_confirmation:requested&&!args.departure,pricing_time:args.departure??null,currency:args.currency??'EUR',prices:available?prices:null,converted_total:available?money(costs.convertedPrice):null,countries:available?countryRows:[],sections,systems,
   approximated:costs?.containsApproximatedSections===true,note:!requested?'Opłaty nie były zamawiane.':!available?'Brak kompletnej odpowiedzi PTV o opłatach; nie oznacza 0 EUR.':'Szacunek taryfowy dla podanych parametrów auta i daty; nie potwierdzenie należności.'}};
}

export function worldPoint(p){const [lon,lat]=p;return [(lon+180)/360,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];}
export function mapLayout(geometry){
 const pts=geometry.coordinates.map(worldPoint),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
 // Iterate instead of Math.min(...points), which overflows on long routes.
 let minX=1,maxX=0,minY=1,maxY=0;for(let i=0;i<xs.length;i++){minX=Math.min(minX,xs[i]);maxX=Math.max(maxX,xs[i]);minY=Math.min(minY,ys[i]);maxY=Math.max(maxY,ys[i]);}
 if(maxX-minX>0.5)throw Error('PTV map crosses unsupported date line');
 const padX=Math.max((maxX-minX)*.08,.0001),padY=Math.max((maxY-minY)*.08,.0001);minX=Math.max(0,minX-padX);maxX=Math.min(1,maxX+padX);minY=Math.max(0,minY-padY);maxY=Math.min(1,maxY+padY);
 for(let zoom=10;zoom>=0;zoom--){const n=2**zoom,loX=Math.max(0,Math.floor(minX*n)),hiX=Math.min(n-1,Math.floor(maxX*n)),loY=Math.max(0,Math.floor(minY*n)),hiY=Math.min(n-1,Math.floor(maxY*n));
  const count=(hiX-loX+1)*(hiY-loY+1);if(count>16)continue;
  const tiles=[];for(let y=loY;y<=hiY;y++)for(let x=loX;x<=hiX;x++)tiles.push({x,y});
  return {zoom,n,loX,hiX,loY,hiY,minX,maxX,minY,maxY,tiles,pts};
 }
 throw Error('PTV map bounds unavailable');
}
// PDF standard fonts do not support Polish characters. Transliterate them while
// retaining western European names. Untrusted strings never become PDF commands.
const printable=s=>String(s??'').replace(/[łŁ]/g,c=>c==='ł'?'l':'L').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e\xa0-\xff]/g,' ');
export async function renderRoutePdf(route,{title='Plan trasy',getTile}){
 if(!route.geometry)throw Error('PTV report requires route geometry');
 const layout=mapLayout(route.geometry),pdf=await PDFDocument.create();
 pdf.setTitle(printable(title));pdf.setProducer('TCOG route report');
 const font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const navy=rgb(.08,.17,.27),muted=rgb(.35,.4,.46),blue=rgb(.03,.38,.76);
 let page,y;const W=595.28,H=841.89,M=38,inner=W-2*M;
 const newPage=()=>{page=pdf.addPage([W,H]);y=H-M;page.drawRectangle({x:0,y:0,width:W,height:H,color:rgb(1,1,1)});};newPage();
 function lines(value,size,width){const out=[];for(const para of printable(value).split('\n')){let line='';for(const w of para.split(/\s+/)){const test=line?line+' '+w:w;if(font.widthOfTextAtSize(test,size)>width&&line){out.push(line);line=w;}else line=test;}out.push(line);}return out;}
 function write(value,{size=10,color=navy,strong=false,gap=5}={}){for(let line of lines(value,size,inner)){if(y-size<50)newPage();const f=strong?bold:font;while(f.widthOfTextAtSize(line,size)>inner){let cut=line.length;while(cut>1&&f.widthOfTextAtSize(line.slice(0,cut),size)>inner)cut--;page.drawText(line.slice(0,cut),{x:M,y:y-size,size,font:f,color});y-=size+4;line=line.slice(cut);if(y-size<50)newPage();}page.drawText(line,{x:M,y:y-size,size,font:f,color});y-=size+4;}y-=gap;}
 write('TCOG / PLAN TRASY',{size:10,strong:true,color:blue});write(title,{size:21,strong:true,gap:10});
 write(`${route.distance_km} km | Czas jazdy: ${Math.floor(route.travel_time_minutes/60)} h ${Math.round(route.travel_time_minutes%60)} min (bez pauz)` ,{size:13,strong:true});
 write(`Wyliczono: ${new Date(route.calculated_at).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})} | ${route.profile}`,{size:8,color:muted});
 if(route.requires_review)write('DO WERYFIKACJI: parametry auta, ostrzezenia lub dane o oplatach wymagaja sprawdzenia.',{size:10,strong:true,color:rgb(.7,.2,.08)});
 write('PRZEBIEG TRASY',{size:11,strong:true});
 const mapHeight=Math.min(340,y-65),mapY=y-mapHeight;
 const worldWidth=layout.maxX-layout.minX,worldHeight=layout.maxY-layout.minY,worldScale=Math.min(inner/worldWidth,mapHeight/worldHeight),scale=worldScale/layout.n,mapX=M+(inner-worldWidth*worldScale)/2,bottom=mapY+(mapHeight-worldHeight*worldScale)/2;
 const tiles=[];let mapWarning=null;
 // Sequential, bounded calls share the integration cache and hourly request cap.
 try{for(const t of layout.tiles){const raw=await getTile(layout.zoom,t.x,t.y);if(!Buffer.isBuffer(raw)||raw.length>2000000)throw Error('invalid tile');tiles.push({t,image:await pdf.embedPng(raw)});}}catch{tiles.length=0;mapWarning='Brak dostepu do podkladu mapowego PTV. Ponizej schemat rzeczywistego przebiegu bez podkladu.';}
 const mapKind=tiles.length?'ptv_raster':'route_schematic';
 page.drawRectangle({x:M,y:mapY,width:inner,height:mapHeight,color:rgb(.94,.96,.98)});
 page.pushOperators(pushGraphicsState(),rectangle(M,mapY,inner,mapHeight),clip(),endPath());
 if(tiles.length)for(const {t,image}of tiles)page.drawImage(image,{x:mapX+(t.x/layout.n-layout.minX)*worldScale,y:bottom+(layout.maxY-(t.y+1)/layout.n)*worldScale,width:scale,height:scale});
 const position=p=>({x:mapX+(p[0]-layout.minX)*worldScale,y:bottom+(layout.maxY-p[1])*worldScale});
 for(let i=1;i<layout.pts.length;i++){const start=position(layout.pts[i-1]),end=position(layout.pts[i]);page.drawLine({start,end,thickness:2,color:blue});}
 const a=position(layout.pts[0]),b=position(layout.pts.at(-1));for(const [p,label]of [[a,'A'],[b,'B']]){page.drawCircle({x:p.x,y:p.y,size:7,color:navy});page.drawText(label,{x:p.x-3.5,y:p.y-3.5,size:9,font:bold,color:rgb(1,1,1)});}page.pushOperators(popGraphicsState());
 y=mapY-12;write(tiles.length?'Podklad: PTV Logistics / dostawcy danych wskazani na mapie. Linia: wyliczona trasa.':mapWarning,{size:8,color:muted});
 write('PUNKTY',{size:11,strong:true});for(let i=0;i<route.waypoints.length;i++)write(`${i+1}. ${route.waypoints[i].label||route.waypoints[i].latitude+', '+route.waypoints[i].longitude}`,{size:10});
 write('GLOWNE DROGI',{size:11,strong:true});write(route.main_roads.length?route.main_roads.map(r=>`${r.country}: ${r.number}`).join(' > '):'Brak numerow drog w odpowiedzi PTV.');
 write('OPLATY DROGOWE / SZACUNEK',{size:11,strong:true});
 const toll=route.toll;
 if(!toll.available)write('Brak kompletnych danych o oplatach. Brak kwoty nie oznacza 0 EUR.',{strong:true});
 else{for(const c of toll.countries)write(`${c.country}: ${c.price.price.toFixed(2)} ${c.price.currency}${c.converted_price?' / '+c.converted_price.price.toFixed(2)+' '+c.converted_price.currency:''}`);
  for(const p of toll.prices)write(`Suma w walucie zrodlowej: ${p.price.toFixed(2)} ${p.currency}`,{strong:true});
  if(toll.converted_total)write(`Lacznie po przeliczeniu: ${toll.converted_total.price.toFixed(2)} ${toll.converted_total.currency}`,{strong:true});
 }
 write(toll.note,{size:9,color:muted});if(toll.departure_requires_confirmation)write('Brak planowanej daty wyjazdu - potwierdz date dla wyceny oplat.',{size:9,color:rgb(.7,.2,.08)});
 if(toll.missing_vehicle_parameters.length)write('Niepotwierdzone parametry: '+toll.missing_vehicle_parameters.join(', '),{size:9,color:rgb(.7,.2,.08)});
 if(y<145)newPage();write('PARAMETRY WYLICZENIA',{size:11,strong:true});const v=route.vehicle_overrides;write(`Wysokosc: ${v.height??'?'} cm / Szerokosc: ${v.width??'?'} cm / Dlugosc: ${v.length??'?'} cm`,{size:9,color:muted});write(`Masa wlasna: ${v.emptyWeight??'?'} kg / Ladunek: ${v.loadWeight??'?'} kg / DMC: ${v.totalPermittedWeight??'?'} kg`,{size:9,color:muted});write(`DMC techniczne: ${v.totalTechnicallyPermittedWeight??'?'} kg / Osie: ${v.numberOfAxles??'?'} / EURO: ${v.emissionStandard??'?'} / CO2: ${v.co2EmissionClass??'?'}`,{size:9,color:muted});
 write('Wymiary w cm, masy w kg. Czas nie obejmuje pauz ani obslugi punktow. Zakazy jazdy wymagaja osobnej weryfikacji.',{size:9,color:muted});
 if(route.warnings?.length||route.violations?.length)write('Ostrzezenia: '+JSON.stringify([...route.warnings,...route.violations]),{size:9,color:rgb(.7,.2,.08)});
 if(toll.systems.length){write('TARYFY',{size:11,strong:true});for(const s of toll.systems)write(`${s.name} / ${s.operator} / ${s.tariff_version} / od ${s.valid_from}`,{size:9});}
 if(toll.sections.length){write('PLATNE ODCINKI',{size:11,strong:true});for(const s of toll.sections){const p=s.prices[0]?.price;write(`${s.country} / ${s.name||s.type}${Number.isFinite(s.distance_m)?' / '+(s.distance_m/1000).toFixed(1)+' km':''} / ${p?p.price.toFixed(2)+' '+p.currency:'brak kwoty'}${s.approximated?' / przyblizenie':''}`,{size:9});}}
 const pages=pdf.getPages();for(let i=0;i<pages.length;i++)pages[i].drawText(`${i+1} / ${pages.length}`,{x:W-70,y:24,size:8,font,color:muted});
 return {bytes:await pdf.save(),map_kind:mapKind,map_warning:mapWarning};
}
