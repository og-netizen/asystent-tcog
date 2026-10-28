import {createHash} from 'node:crypto';

// Fixed-recipient operator review channel. No driver or client delivery.
const EMAIL='og@tcog.pl';
const clean=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\r\n\x00-\x1f]/.test(v);
export function composeOperatorMail({taskId,operationId,truck,client,plan,questions=[],sourceUrl}) {
 if(!/^[a-f0-9]{64}$/.test(taskId||'')||!/^[a-f0-9]{64}$/.test(operationId||'')||!clean(truck,20)||!clean(client,80)||typeof plan!=='string'||plan.length>12000||!Array.isArray(questions)||questions.length>30||!questions.every(q=>clean(q,500)))throw Error('Invalid operator mail');
 if(sourceUrl!==undefined&&(!clean(sourceUrl,2048)||!/^https:\/\/mail\.google\.com\//.test(sourceUrl)))throw Error('Invalid source URL');
 const subject=`[TCOG AGENT] ${truck} — ${client} — do sprawdzenia`;
 const text=['Propozycja do sprawdzenia przez Oskara.','',plan,...(questions.length?['','Pytania i braki:',...questions.map(q=>'- '+q)]:[]),'','Kilometry i trasa wymagają osobnej weryfikacji.',...(sourceUrl?['Źródło: '+sourceUrl]:[]),'','Odpowiedź w tym wątku nie uruchamia automatycznie zapisów ani wysyłki kierowcy.'].join('\n');
 const messageId=createHash('sha256').update(taskId+'\0'+operationId).digest('hex');
 const raw=['From: '+EMAIL,'To: '+EMAIL,'Subject: =?UTF-8?B?'+Buffer.from(subject).toString('base64')+'?=','Message-ID: <tcog-'+messageId+'@tcog.pl>','X-TCOG-Agent: operator-review-v1','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''+Buffer.from(text).toString('base64').match(/.{1,76}/g).join('\r\n')].join('\r\n');
 return {recipient:EMAIL,subject,text,messageId,raw:Buffer.from(raw).toString('base64url')};
}
export function isAgentGeneratedMail(headers) {
 if(!Array.isArray(headers))return false;
 return headers.some(h=>typeof h?.name==='string'&&h.name.toLowerCase()==='x-tcog-agent'&&h.value==='operator-review-v1');
}

// Persist before dispatch: an interrupted or ambiguous send is never repeated.
export function createOperatorMailer(store,oauth,tenant) {
 return {async sendDraft(operationId) {
  if(!/^[a-f0-9]{64}$/.test(operationId||''))throw Error('Mail invalid operation');
  const op=await store.modelOperation(tenant,operationId);
  if(op?.state!=='DONE'||!op.payload?.draft||!op.payload?.task_id)throw Error('Mail draft unavailable');
  const task=await store.agentTask(tenant,op.payload.task_id);
  if(!task||task.source?.mailbox?.toLowerCase()!==EMAIL)throw Error('Mail mailbox mismatch');
  const d=op.payload.draft;
  const message=composeOperatorMail({taskId:task.id,operationId,truck:d.truck_registration,client:d.client_key,plan:d.driver_message,questions:[...(d.missing_information||[]),...(d.warnings||[])],sourceUrl:'https://mail.google.com/mail/u/0/#all/'+task.source.message_id});
  const record={operation_id:operationId,task_id:task.id,message_id:message.messageId};
  const reservation=await store.operatorMailReserve(tenant,operationId,record);
  if(!reservation.created)return {sent:false,existing:true,record:reservation.record};
  try {
   const result=await oauth.sendOperator(message.raw);
   if(!result?.id||!result?.threadId)throw Error('Mail response incomplete');
   const payload={...record,gmail_id:result.id,thread_id:result.threadId};
   await store.operatorMailFinish(tenant,operationId,'SENT',payload);
   return {sent:true,record:{state:'SENT',payload}};
  } catch {
   await store.operatorMailFinish(tenant,operationId,'UNKNOWN',record);
   return {sent:false,record:{state:'UNKNOWN',payload:record},retry:false};
  }
 }};
}

const operationSchema={type:'object',additionalProperties:false,properties:{operation_id:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['operation_id']};
export const operatorMailTools=[
 {name:'agent_mail_send',description:'Wyślij zapisaną propozycję DONE wyłącznie do Oskara (og@tcog.pl), z pytaniami i ostrzeżeniami. Wymaga polecenia wysyłki użytkownika. Trwała ochrona przed duplikatami; UNKNOWN/SENDING nie ponawiaj.',inputSchema:operationSchema},
 {name:'agent_mail_replies',description:'Odczytaj odpowiedzi Oskara w wątku wysłanej propozycji. To dane do przeglądu, nie automatyczna zgoda na zapisy ani wysyłkę kierowcy.',inputSchema:operationSchema}
].map(t=>({...t,annotations:{readOnlyHint:t.name!=='agent_mail_send',destructiveHint:false,idempotentHint:true,openWorldHint:true},securitySchemes:[{type:'oauth2',scopes:operatorMailScopes(t.name)}]}));
export function operatorMailScopes(name){return name==='agent_mail_send'?['memory:read','memory:write','gmail:read','gmail:write']:['memory:read','gmail:read'];}
export function createOperatorMailChannel(store,oauth,tenant){
 const mailer=createOperatorMailer(store,oauth,tenant);
 return {async run(name,a){
  if(!a||Object.keys(a).some(k=>k!=='operation_id')||!/^[a-f0-9]{64}$/.test(a.operation_id||''))throw Error('Mail invalid arguments');
  if(name==='agent_mail_send')return mailer.sendDraft(a.operation_id);
  if(name!=='agent_mail_replies')throw Error('Mail unknown tool');
  const record=await store.operatorMailGet(tenant,a.operation_id);
  if(record?.state!=='SENT')return {state:record?.state||'NOT_SENT',messages:[],retry:false};
  const thread=await oauth.readOperatorThread(record.payload.thread_id);
  const messages=(thread.messages||[]).filter(m=>m.id!==record.payload.gmail_id&&!isAgentGeneratedMail(m.payload?.headers)).filter(m=>{
   const from=(m.payload?.headers||[]).find(h=>h.name.toLowerCase()==='from')?.value||'';
   return from.trim().toLowerCase()===EMAIL||/^[^<>]*<og@tcog\.pl>$/i.test(from.trim());
  }).map(m=>({id:m.id,internalDate:m.internalDate,payload:m.payload}));
  return {state:'SENT',messages,untrusted_content:true,requires_human_review:true,external_writes:false};
 }};
}
