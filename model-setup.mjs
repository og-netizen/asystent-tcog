import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {gmailVault} from './gmail-oauth.mjs';
const hash=x=>createHash('sha256').update(String(x)).digest();
const equal=(a,b)=>timingSafeEqual(hash(a),hash(b));
export function createModelSetup(env,store,{now=Date.now}={}){
 const origin=new URL(env.PUBLIC_URL||env.RENDER_EXTERNAL_URL).origin,tenant=env.WFIRMA_COMPANY_ID,ns='ai-config:'+tenant;
 const vault=gmailVault(env.OAUTH_CLIENT_SECRET,origin);const purpose='ai-model:'+tenant;
 const read=async()=>{const r=await store.get(ns,'active');return r?vault.open(purpose,r.sealed):null;};
 let attempts=[];
 return {read,async status(){const c=await read();return {configured:!!c?.key,model:c?.model??null,daily_call_limit:c?.dailyLimit??null,max_output_tokens:c?.outputLimit??null,setup_url:origin+'/ai/setup',live_tested:false};},async handle(req,res,url){
  if(url.pathname!=='/ai/setup')return false;
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const page=(status,html)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TCOG — model AI</title><main>'+html+'</main></html>');return true;};
  if(req.method==='GET'){
   const csrf=vault.seal('ai-setup-form',{tenant,exp:now()+900000,nonce:randomBytes(24).toString('hex')});
   return page(200,`<h1>Model AI dla TCOG</h1><p>Klucz zapisujemy zaszyfrowany w prywatnej bazie serwera. Zapis nie wywołuje modelu, nie pobiera maili i nie uruchamia harmonogramu.</p><form method="post" action="/ai/setup"><input type="hidden" name="csrf" value="${csrf}"><p><label>Hasło integracji TCOG <input type="password" name="password" required autocomplete="current-password"></label></p><p><label>Klucz API OpenAI <input type="password" name="api_key" required autocomplete="new-password" maxlength="512"></label></p><p><label>Model <select name="model"><option value="gpt-6.1-terra">gpt-6.1-terra</option></select></label></p><p><label>Limit wywołań dziennie <input name="daily_limit" type="number" value="20" min="1" max="100"></label></p><p><label>Maksymalna liczba tokenów wyjściowych na wywołanie <input name="output_limit" type="number" value="4000" min="1000" max="6000"></label></p><button>Zapisz konfigurację</button></form><p>To limit wywołań i tokenów, nie kwoty w EUR/PLN. Nie wklejaj klucza do czatu.</p>`);
  }
  if(req.method!=='POST')return page(405,'<h1>Niedozwolona metoda</h1>');
  try{
   if(req.headers.origin!==origin)return page(403,'<h1>Nieprawidłowe źródło żądania</h1>');
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>12000)return page(413,'<h1>Zbyt duże żądanie</h1>');}
   const q=new URLSearchParams(raw),ticket=vault.open('ai-setup-form',q.get('csrf'));
   if(!ticket||ticket.tenant!==tenant||ticket.exp<=now()||ticket.exp>now()+900000)return page(400,'<h1>Formularz wygasł</h1><p>Otwórz stronę ponownie.</p>');
   attempts=attempts.filter(t=>t>now()-900000);if(attempts.length>=10)return page(429,'<h1>Odczekaj 15 minut</h1>');
   if(!equal(q.get('password')||'',env.ADMIN_PASSWORD)){attempts.push(now());return page(403,'<h1>Nieprawidłowe hasło integracji</h1>');}
   const key=q.get('api_key')||'',model=q.get('model'),dailyLimit=Number(q.get('daily_limit')),outputLimit=Number(q.get('output_limit'));
   if(!/^sk-[A-Za-z0-9_-]{20,508}$/.test(key)||model!=='gpt-6.1-terra'||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>100||!Number.isInteger(outputLimit)||outputLimit<1000||outputLimit>6000)return page(400,'<h1>Sprawdź klucz, model i limity</h1>');
   const value={key,model,dailyLimit,outputLimit,revision:randomBytes(16).toString('hex'),savedAt:new Date(now()).toISOString()};
   await store.put(ns,'active',{sealed:vault.seal(purpose,value)},Date.parse('2099-01-01T00:00:00Z'));
   return page(200,'<h1>Konfiguracja zapisana</h1><p>Klucz jest zaszyfrowany. Połączenie z OpenAI nie było jeszcze testowane. Harmonogram pozostaje wyłączony. Możesz zamknąć tę stronę i wrócić do ChatGPT.</p>');
  }catch{return page(400,'<h1>Nie udało się zapisać konfiguracji</h1><p>Nie wysyłaj klucza w czacie.</p>');}
 }};
}
