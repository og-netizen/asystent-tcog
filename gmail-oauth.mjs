import {randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual} from 'node:crypto';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.settings.basic'];
const digest = value => createHash('sha256').update(String(value)).digest();
const equal = (a,b) => timingSafeEqual(digest(a),digest(b));
const random = () => randomBytes(32).toString('base64url');
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookieName = 'tcog_google_flow';

// Purpose-bound authenticated encryption. No plaintext Google tokens in HTML,
// cookies, application logs or the ephemeral Render filesystem.
export function gmailVault(secret,origin) {
 const key = digest('tcog-gmail-v1\0'+secret);
 return {
  seal(purpose,data) {
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
   cipher.setAAD(Buffer.from(origin+'\0'+purpose));
   const encrypted=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);
   return 'v1.'+Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  },
  open(purpose,value) {
   try {
    if(typeof value!=='string'||!/^v1\.[A-Za-z0-9_-]+$/.test(value)||value.length>16000)return null;
    const data=Buffer.from(value.slice(3),'base64url');if(data.length<29)return null;
    const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
    decipher.setAAD(Buffer.from(origin+'\0'+purpose));decipher.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString());
   } catch {return null;}
  }
 };
}

export function createGmailOAuth(env,{fetchImpl=fetch,now=Date.now}={}) {
 const origin=new URL(env.PUBLIC_URL||env.RENDER_EXTERNAL_URL).origin;
 const vault=gmailVault(env.OAUTH_CLIENT_SECRET,origin);
 const clientId=(env.GOOGLE_GMAIL_CLIENT_ID||'').trim();
 const clientSecret=(env.GOOGLE_GMAIL_CLIENT_SECRET||'').trim();
 const email=(env.GOOGLE_GMAIL_EXPECTED_EMAIL||'og@tcog.pl').trim().toLowerCase();
 const redirectUri=origin+'/google/oauth/callback';
 const configured=Boolean(clientId&&clientSecret);
 const binding=digest(clientId+'\0'+email).toString('base64url');
 const consumed=new Map();let attempts=[];
 const cookie=(res,value,maxAge=900)=>res.setHeader('Set-Cookie',`${cookieName}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/google; Max-Age=${maxAge}`);
 const readCookie=req=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const page=(res,status,title,content)=>{
  res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><main><h1>${escape(title)}</h1>${content}</main></html>`);
 };
 const form=(res,notice='')=>{
  // A sealed form ticket plus strict same-origin POST protects bootstrap.
  // Do not overwrite the OAuth callback cookie when another tab opens.
  const csrf=vault.seal('bootstrap',{nonce:random(),exp:now()+900000,binding});
  return page(res,200,'Połączenie Gmail TCOG',`${notice?'<p>'+escape(notice)+'</p>':''}<p>Skrzynka: <strong>${escape(email)}</strong>.</p><p>Dostęp obejmie odczyt poczty, nadawanie etykiet oraz zarządzanie filtrami. Ten etap nie uruchamia agenta, nie wysyła wiadomości i nie zmienia filtrów.</p><form action="/google/oauth/start" method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Hasło integracji TCOG (ADMIN_PASSWORD, nie hasło Google): <input name="password" type="password" required autocomplete="current-password"></label><button name="action" value="connect" type="submit">Połącz z Google</button><button name="action" value="check" type="submit">Sprawdź zapisane połączenie</button></form>`);
 };
 const liveFlow=(purpose,req)=>{
  const flow=vault.open(purpose,readCookie(req));
  return flow&&flow.binding===binding&&flow.exp>now()&&flow.exp<=now()+900000?flow:null;
 };
 async function google(url,options) {
  // Fixed destinations only. Never follow redirects with client secrets/tokens.
  const allowed=['https://oauth2.googleapis.com/token','https://gmail.googleapis.com/gmail/v1/users/me/profile'];
  const gmailPath=url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')?url.slice('https://gmail.googleapis.com/gmail/v1/users/me/'.length):'';
  const method=options.method||'GET';
  if(!allowed.includes(url)&&!((method==='GET'&&['labels','settings/filters'].includes(gmailPath))||(method==='POST'&&gmailPath==='settings/filters')||(method==='DELETE'&&/^settings\/filters\/[A-Za-z0-9_-]{1,256}$/.test(gmailPath))))throw Error('google_destination');
  const response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('google_http_'+response.status);
  if(response.status===204)return {};
  const data=await response.json();if(!data||typeof data!=='object'||Array.isArray(data))throw Error('google_response');return data;
 }
 async function profile(accessToken) {
  if(typeof accessToken!=='string'||!accessToken)throw Error('missing_access_token');
  const p=await google('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:'Bearer '+accessToken}});
  if(typeof p.emailAddress!=='string'||p.emailAddress.toLowerCase()!==email)throw Error('wrong_account');
  return p;
 }
 function validateScopes(scope) {
  if(typeof scope!=='string'||!GMAIL_SCOPES.every(s=>scope.split(' ').includes(s)))throw Error('missing_scopes');
 }
 async function accessSaved() {
  const data=vault.open('refresh-token',env.GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED);
  if(!data||data.clientId!==clientId||data.email!==email||typeof data.refreshToken!=='string')throw Error('no_saved_token');
  validateScopes(data.scope);
  const token=await google('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,client_secret:clientSecret,refresh_token:data.refreshToken})});
  if(token.scope)validateScopes(token.scope);
  await profile(token.access_token);return token.access_token;
 }
 async function checkSaved(){return profile(await accessSaved());}
 async function request(method,path,body){
  // The allowlist in google() bounds every call, including future callers.
  const access=await accessSaved();
  return google('https://gmail.googleapis.com/gmail/v1/users/me/'+path,{method,headers:{Authorization:'Bearer '+access,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 }
 async function handle(req,res,url) {
  if(!url.pathname.startsWith('/google/'))return false;
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');
  // no-referrer makes browser form POSTs send Origin: null. Keep the
  // login form same-origin while suppressing callback URL disclosure.
  res.setHeader('Referrer-Policy',url.pathname==='/google/oauth/start'?'same-origin':'no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'");
  try {
   for(const [id,exp]of consumed)if(exp<=now())consumed.delete(id);
   if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'origin_not_allowed'});
   if(!configured)return page(res,503,'Gmail — konfiguracja do uzupełnienia','<p>Dodaj w Renderze GOOGLE_GMAIL_CLIENT_ID i GOOGLE_GMAIL_CLIENT_SECRET. Opcjonalnie ustaw GOOGLE_GMAIL_EXPECTED_EMAIL (domyślnie og@tcog.pl). Następnie wybierz Save, rebuild, and deploy.</p>');
   if(req.method==='GET'&&url.pathname==='/google/oauth/start')return form(res);
   if(req.method==='POST'&&url.pathname==='/google/oauth/start') {
    if(req.headers.origin!==origin)return json(res,403,{error:'origin_required'});
    let raw='',size=0;for await(const chunk of req){size+=chunk.length;if(size>12000)return json(res,413,{error:'body_too_large'});raw+=chunk;}
    const fields=new URLSearchParams(raw),flow=vault.open('bootstrap',fields.get('csrf'));
    if(!flow||flow.binding!==binding||flow.exp<=now()||flow.exp>now()+900000)return page(res,400,'Sesja wygasła','<p>Otwórz ponownie <a href="/google/oauth/start">połączenie Gmail</a>.</p>');
    attempts=attempts.filter(t=>t>now()-900000);if(attempts.length>=10)return json(res,429,{error:'Odczekaj 15 minut.'});
    if(!equal(fields.get('password')||'',env.ADMIN_PASSWORD)){attempts.push(now());return page(res,403,'Niepoprawne hasło','<p>Użyj hasła integracji TCOG. <a href="/google/oauth/start">Wróć</a>.</p>');}
    if(fields.get('action')==='check') {
     const p=await checkSaved();cookie(res,'',0);
     return page(res,200,'Połączenie Gmail sprawdzone',`<p>Potwierdzono dostęp do ${escape(p.emailAddress)} z tokena zapisanego w konfiguracji Rendera. Automatyczne etykietowanie i agent nie są jeszcze uruchomione.</p>`);
    }
    if(fields.get('action')!=='connect')return json(res,400,{error:'invalid_action'});
    const state=random(),verifier=random();
    cookie(res,vault.seal('authorization',{state,verifier,binding,exp:now()+900000}));
    const target=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    target.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:GMAIL_SCOPES.join(' '),access_type:'offline',prompt:'consent',login_hint:email,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
    res.writeHead(303,{Location:target.href});return res.end();
   }
   if(req.method==='GET'&&url.pathname==='/google/oauth/callback') {
    const flow=liveFlow('authorization',req),state=url.searchParams.get('state')||'';
    if(!flow||!equal(state,flow.state)||consumed.has(state))return page(res,400,'Nieprawidłowa sesja Google','<p>Nie zapisano połączenia. Zacznij ponownie od <a href="/google/oauth/start">logowania TCOG</a>.</p>');
    consumed.set(state,flow.exp);cookie(res,'',0);
    if(url.searchParams.has('error'))return page(res,400,'Nie udzielono dostępu','<p>Nie zapisano połączenia. <a href="/google/oauth/start">Spróbuj ponownie</a>.</p>');
    const code=url.searchParams.get('code');if(!code||code.length>8000)throw Error('missing_code');
    const token=await google('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,code,code_verifier:flow.verifier})});
    validateScopes(token.scope);await profile(token.access_token);
    if(typeof token.refresh_token!=='string'||!token.refresh_token)throw Error('missing_refresh_token');
    const sealed=vault.seal('refresh-token',{clientId,email,scope:token.scope,refreshToken:token.refresh_token,createdAt:new Date(now()).toISOString()});
    // Render Free has no durable token store. The administrator persists this
    // encrypted envelope in Render secrets; do not claim connection is durable yet.
    return page(res,200,'Google zatwierdziło dostęp — zapisz połączenie',`<p>Zweryfikowano skrzynkę <strong>${escape(email)}</strong>. Dostęp NIE jest jeszcze trwale zapisany.</p><p>W Render → Environment dodaj zmienną <strong>GOOGLE_GMAIL_REFRESH_TOKEN_ENCRYPTED</strong> z poniższą wartością. Nie wysyłaj jej w czacie. Jest zaszyfrowana kluczem serwera; zachowaj również istniejący OAUTH_CLIENT_SECRET.</p><textarea readonly rows="8" cols="72" aria-label="Zaszyfrowany token połączenia">${escape(sealed)}</textarea><p>Wybierz Save, rebuild, and deploy. Następnie otwórz <a href="/google/oauth/start">stronę połączenia</a> i wybierz „Sprawdź zapisane połączenie”. Do tego czasu nie zamykaj tej strony. Nie uruchomiono filtrowania ani wysyłki maili.</p>`);
   }
   return json(res,404,{error:'not_found'});
  } catch(e) {
   // Never reflect vendor bodies, OAuth codes, passwords, or tokens.
   const code=['wrong_account','missing_scopes','missing_refresh_token','no_saved_token'].includes(e.message)?e.message:'google_connection_failed';
   const messages={wrong_account:'Wybrano inną skrzynkę. Połączenie nie zostało zapisane.',missing_scopes:'Nie przyznano obu wymaganych uprawnień Gmail.',missing_refresh_token:'Google nie zwróciło dostępu offline. Rozpocznij połączenie ponownie.',no_saved_token:'Brak poprawnego zapisanego tokena. Dokończ zapis w ustawieniach Rendera.'};
   return page(res,400,'Nie ukończono połączenia Gmail',`<p>${escape(messages[code]||'Połączenie z Google nie powiodło się. Sprawdź Gmail API, dane OAuth i dokładny adres przekierowania.')}</p><p>Kod: ${escape(code)}</p><p><a href="/google/oauth/start">Wróć do połączenia</a></p>`);
  }
 }
 return {handle,checkSaved,request,redirectUri};
}
