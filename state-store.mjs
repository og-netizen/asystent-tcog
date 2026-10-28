import {createHash} from 'node:crypto';
import pg from 'pg';
const keyOf=(namespace,key)=>createHash('sha256').update(namespace+'\0'+String(key)).digest('hex');
const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));

// Memory adapter remains for existing Render/tests. Cloud startup requires SQL.
export function createMemoryStateStore({now=Date.now}={}){
 const records=new Map(), memory=new Map(), agentConfigs=new Map(), jobs=new Map(), modelOps=new Map(), modelBudgets=new Map(), operatorMail=new Map();
 const id=(n,k)=>n+':'+keyOf(n,k);
 const live=(n,k)=>{const r=records.get(id(n,k));if(r&&r.expires>now())return r;records.delete(id(n,k));};
 return {
  async initialize(){},async close(){},
  async operatorMailReserve(t,k,p){const id=t+':'+k;if(operatorMail.has(id))return {created:false,record:copy(operatorMail.get(id))};const record={state:'SENDING',payload:copy(p)};operatorMail.set(id,record);return {created:true,record:copy(record)};},
  async operatorMailFinish(t,k,state,p){const id=t+':'+k;if(operatorMail.get(id)?.state!=='SENDING')throw Error('Mail state conflict');operatorMail.set(id,{state,payload:copy(p)});},
  async operatorMailGet(t,k){return copy(operatorMail.get(t+':'+k));},
  async modelOperation(t,k){return copy(modelOps.get(t+':'+k));},
  async modelOperations(t,taskId,offset){return copy([...modelOps.entries()].filter(([k,r])=>k.startsWith(t+':')&&(!taskId||r.payload.task_id===taskId)).map(([k,r])=>({id:k.slice(t.length+1),...r})).sort((a,b)=>a.id.localeCompare(b.id)).slice(offset,offset+25));},
  async modelReserve(t,k,day,limit,payload){payload={...payload,budget_day:day};const key=t+':'+k,existing=modelOps.get(key);if(existing&&!(existing.state==='DAILY_LIMIT'&&existing.payload.budget_day!==day))return {allowed:false,operation:copy(existing)};const op={state:'RUNNING',payload:copy(payload)};modelOps.set(key,op);const budgetKey=t+':'+day,count=modelBudgets.get(budgetKey)||0;if(count>=limit){op.state='DAILY_LIMIT';return {allowed:false,operation:copy(op)};}modelBudgets.set(budgetKey,count+1);return {allowed:true,operation:copy(op)};},
  async modelFinish(t,k,state,payload){const key=t+':'+k;if(modelOps.get(key)?.state!=='RUNNING')throw Error('AI operation state conflict');modelOps.set(key,{state,payload:copy(payload)});},
  async agentGetConfig(t){return copy(agentConfigs.get(t));},
  async agentConfig(t,expected,data){if((agentConfigs.get(t)?.revision??0)!==expected)throw Error('Agent revision conflict');const r={...copy(data),revision:expected+1};agentConfigs.set(t,r);return copy(r);},
  async agentTask(t,k){return copy(jobs.get(t+':'+k));},
  async agentThread(t,thread,except,mailbox){return copy([...jobs.entries()].filter(([k,r])=>k.startsWith(t+':')&&r.source.thread_id===thread&&r.source.mailbox===mailbox&&r.id!==except).map(([,r])=>r).sort((a,b)=>b.source.received_at.localeCompare(a.source.received_at))[0]);},
  async agentTasks(t,state,offset){return copy([...jobs.entries()].filter(([k,r])=>k.startsWith(t+':')&&(!state||r.state===state)).map(([,r])=>r).sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id)).slice(offset,offset+25));},
  async agentEnqueue(t,task){const key=t+':'+task.id,old=jobs.get(key);if(old)return {inserted:false,task:copy(old)};const r={...copy(task),revision:1};jobs.set(key,r);return {inserted:true,task:copy(r)};},
  async memoryLatest(t,k){return copy(memory.get(t+':'+k)?.at(-1));},
  async memoryHistory(t,k,o){return copy([...(memory.get(t+':'+k)||[])].reverse().slice(o,o+25));},
  async memoryRules(t,c,o){return copy([...memory.entries()].filter(([k])=>k.startsWith(t+':')).map(([,v])=>v.at(-1)).filter(r=>r.kind==='rule'&&r.client_key===c&&r.operation!=='retract').sort((a,b)=>a.key.localeCompare(b.key)).slice(o,o+25));},
  async memoryAppend(t,k,expected,p){const items=memory.get(t+':'+k)||[],last=items.at(-1);if(last?.digest===p.digest)return copy(last);if((last?.revision??0)!==expected)throw Error('Memory revision conflict');const r={...copy(p),key:k,revision:expected+1,created_at:new Date(now()).toISOString()};items.push(r);memory.set(t+':'+k,items);return copy(r);},
  async put(n,k,data,expires){records.set(id(n,k),{data:copy(data),expires});},
  async get(n,k){return copy(live(n,k)?.data);},
  async take(n,k){const r=live(n,k);records.delete(id(n,k));return copy(r?.data);},
  async claim(n,k,expected,state){const r=live(n,k);if(!r||r.data.state!==expected)return undefined;r.data.state=state;return copy(r.data);},
  async prune(n){for(const [key,r]of records)if(key.startsWith(n+':')&&r.expires<=now())records.delete(key);},
  async count(n){return [...records].filter(([key,r])=>key.startsWith(n+':')&&r.expires>now()).length;}
 };
}

const memoryRow=(r,key)=>r?{...r.payload,key,revision:r.revision,created_at:new Date(r.created_at).toISOString()}:undefined;

export function createPostgresStateStore(pool){
 const out=r=>r.rows[0]?{...r.rows[0].payload,...(r.rows[0].state?{state:r.rows[0].state}:{})}:undefined;
 const query=async(sql,params=[])=>{try{return await pool.query(sql,params);}catch{throw Error('State storage unavailable');}};
 return {
  async initialize(){await query(`CREATE TABLE IF NOT EXISTS tcog_state (
   namespace text NOT NULL, key_hash text NOT NULL, payload jsonb NOT NULL,
   state text NOT NULL DEFAULT '', expires_at timestamptz NOT NULL,
   PRIMARY KEY(namespace,key_hash));`);
   await query('CREATE INDEX IF NOT EXISTS tcog_state_expiry ON tcog_state(expires_at)');
   await query(`CREATE TABLE IF NOT EXISTS tcog_memory (
    tenant text NOT NULL, key_hash text NOT NULL, revision integer NOT NULL,
    payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant,key_hash,revision));`);
   await query("CREATE INDEX IF NOT EXISTS tcog_memory_client ON tcog_memory (tenant, (payload->>'kind'), (payload->>'client_key'))");
   await query('CREATE TABLE IF NOT EXISTS tcog_agent_config (tenant text PRIMARY KEY,revision integer NOT NULL,payload jsonb NOT NULL)');
   await query('CREATE TABLE IF NOT EXISTS tcog_agent_jobs(tenant text NOT NULL,id text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant,id))');
   await query('CREATE INDEX IF NOT EXISTS tcog_agent_jobs_list ON tcog_agent_jobs(tenant,created_at DESC,id)');
   await query("CREATE INDEX IF NOT EXISTS tcog_agent_jobs_thread ON tcog_agent_jobs(tenant, (payload->'source'->>'thread_id'))");
   await query('CREATE TABLE IF NOT EXISTS tcog_model_operations(tenant text NOT NULL,id text NOT NULL,state text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(tenant,id))');
   await query('CREATE TABLE IF NOT EXISTS tcog_model_budget(tenant text NOT NULL,day date NOT NULL,calls integer NOT NULL,PRIMARY KEY(tenant,day))');
   await query('CREATE TABLE IF NOT EXISTS tcog_operator_mail(tenant text NOT NULL,id text NOT NULL,state text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(tenant,id))');},
  async close(){await pool.end?.();},
  async operatorMailReserve(t,k,p){const r=await query("INSERT INTO tcog_operator_mail(tenant,id,state,payload) VALUES($1,$2,'SENDING',$3::jsonb) ON CONFLICT DO NOTHING RETURNING state,payload",[t,k,JSON.stringify(p)]);return r.rows[0]?{created:true,record:r.rows[0]}:{created:false,record:await this.operatorMailGet(t,k)};},
  async operatorMailFinish(t,k,state,p){const r=await query("UPDATE tcog_operator_mail SET state=$3,payload=$4::jsonb WHERE tenant=$1 AND id=$2 AND state='SENDING' RETURNING id",[t,k,state,JSON.stringify(p)]);if(!r.rows.length)throw Error('Mail state conflict');},
  async operatorMailGet(t,k){return (await query('SELECT state,payload FROM tcog_operator_mail WHERE tenant=$1 AND id=$2',[t,k])).rows[0];},
  async modelOperation(t,k){return (await query('SELECT state,payload FROM tcog_model_operations WHERE tenant=$1 AND id=$2',[t,k])).rows[0];},
  async modelOperations(t,taskId,offset){return (await query("SELECT id,state,payload FROM tcog_model_operations WHERE tenant=$1 AND ($2::text IS NULL OR payload->>'task_id'=$2) ORDER BY id LIMIT 25 OFFSET $3",[t,taskId??null,offset])).rows;},
  async modelReserve(t,k,day,limit,payload){
   payload={...payload,budget_day:day};
   let insert=await query("INSERT INTO tcog_model_operations(tenant,id,state,payload) VALUES($1,$2,'RUNNING',$3::jsonb) ON CONFLICT DO NOTHING RETURNING state,payload",[t,k,JSON.stringify(payload)]);
   if(!insert.rows[0]){insert=await query("UPDATE tcog_model_operations SET state='RUNNING',payload=$4::jsonb WHERE tenant=$1 AND id=$2 AND state='DAILY_LIMIT' AND payload->>'budget_day'<>$3 RETURNING state,payload",[t,k,day,JSON.stringify(payload)]);if(!insert.rows[0])return {allowed:false,operation:await this.modelOperation(t,k)};}
   const budget=await query('INSERT INTO tcog_model_budget(tenant,day,calls) VALUES($1,$2::date,1) ON CONFLICT(tenant,day) DO UPDATE SET calls=tcog_model_budget.calls+1 WHERE tcog_model_budget.calls<$3 RETURNING calls',[t,day,limit]);
   if(!budget.rows[0]){await this.modelFinish(t,k,'DAILY_LIMIT',payload);return {allowed:false,operation:{state:'DAILY_LIMIT',payload}};}
   return {allowed:true,operation:insert.rows[0]};
  },
  async modelFinish(t,k,state,payload){const r=await query("UPDATE tcog_model_operations SET state=$3,payload=$4::jsonb WHERE tenant=$1 AND id=$2 AND state='RUNNING' RETURNING id",[t,k,state,JSON.stringify(payload)]);if(!r.rows.length)throw Error('AI operation state conflict');},
  async agentGetConfig(t){const r=await query('SELECT payload,revision FROM tcog_agent_config WHERE tenant=$1',[t]);return r.rows[0]?{...r.rows[0].payload,revision:r.rows[0].revision}:undefined;},
  async agentConfig(t,expected,data){const r=await query(`INSERT INTO tcog_agent_config(tenant,revision,payload) SELECT $1,1,$3::jsonb WHERE $2::integer=0
   ON CONFLICT(tenant) DO UPDATE SET payload=EXCLUDED.payload,revision=tcog_agent_config.revision+1 WHERE tcog_agent_config.revision=$2::integer RETURNING payload,revision`,[t,expected,JSON.stringify(data)]);
   // Update existing configurations when expected is nonzero; INSERT SELECT above intentionally handles only initialization.
   if(r.rows[0])return {...r.rows[0].payload,revision:r.rows[0].revision};
   const u=await query('UPDATE tcog_agent_config SET payload=$3::jsonb,revision=revision+1 WHERE tenant=$1 AND revision=$2 RETURNING payload,revision',[t,expected,JSON.stringify(data)]);
   if(!u.rows[0])throw Error('Agent revision conflict');return {...u.rows[0].payload,revision:u.rows[0].revision};},
  async agentTask(t,k){return (await query('SELECT payload FROM tcog_agent_jobs WHERE tenant=$1 AND id=$2',[t,k])).rows[0]?.payload;},
  async agentThread(t,thread,except,mailbox){return (await query("SELECT payload FROM tcog_agent_jobs WHERE tenant=$1 AND payload->'source'->>'thread_id'=$2 AND id<>$3 AND payload->'source'->>'mailbox'=$4 ORDER BY payload->'source'->>'received_at' DESC,id LIMIT 1",[t,thread,except,mailbox])).rows[0]?.payload;},
  async agentTasks(t,state,offset){return (await query("SELECT payload FROM tcog_agent_jobs WHERE tenant=$1 AND ($2::text IS NULL OR payload->>'state'=$2) ORDER BY created_at DESC,id LIMIT 25 OFFSET $3",[t,state??null,offset])).rows.map(r=>r.payload);},
  async agentEnqueue(t,task){const r=await query('INSERT INTO tcog_agent_jobs(tenant,id,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING payload',[t,task.id,JSON.stringify({...task,revision:1})]);return r.rows[0]?{inserted:true,task:r.rows[0].payload}:{inserted:false,task:await this.agentTask(t,task.id)};},
  async memoryLatest(t,k){const r=await query('SELECT payload,revision,created_at FROM tcog_memory WHERE tenant=$1 AND key_hash=$2 ORDER BY revision DESC LIMIT 1',[t,k]);return memoryRow(r.rows[0],k);},
  async memoryHistory(t,k,o){const r=await query('SELECT payload,revision,created_at FROM tcog_memory WHERE tenant=$1 AND key_hash=$2 ORDER BY revision DESC LIMIT 25 OFFSET $3',[t,k,o]);return r.rows.map(x=>memoryRow(x,k));},
  async memoryRules(t,c,o){const r=await query(`SELECT * FROM (SELECT DISTINCT ON(key_hash) key_hash,payload,revision,created_at FROM tcog_memory WHERE tenant=$1 AND payload->>'kind'='rule' AND payload->>'client_key'=$2 ORDER BY key_hash,revision DESC) latest WHERE payload->>'operation'<>'retract' ORDER BY key_hash LIMIT 25 OFFSET $3`,[t,c,o]);return r.rows.map(x=>memoryRow(x,x.key_hash));},
  async memoryAppend(t,k,expected,p){
   const latest=await this.memoryLatest(t,k);if(latest?.digest===p.digest)return latest;
   const r=await query(`INSERT INTO tcog_memory(tenant,key_hash,revision,payload)
    SELECT $1,$2,$3::integer+1,$4::jsonb WHERE COALESCE((SELECT max(revision) FROM tcog_memory WHERE tenant=$1 AND key_hash=$2),0)=$3::integer
    ON CONFLICT DO NOTHING RETURNING payload,revision,created_at`,[t,k,expected,JSON.stringify(p)]);
   if(r.rows[0])return memoryRow(r.rows[0],k);
   const current=await this.memoryLatest(t,k);if(current?.digest===p.digest)return current;
   throw Error('Memory revision conflict');
  },
  async put(n,k,data,expires){await query(`INSERT INTO tcog_state(namespace,key_hash,payload,state,expires_at) VALUES($1,$2,$3::jsonb,$4,$5)
   ON CONFLICT(namespace,key_hash) DO UPDATE SET payload=EXCLUDED.payload,state=EXCLUDED.state,expires_at=EXCLUDED.expires_at`,[n,keyOf(n,k),JSON.stringify(data),data.state||'',new Date(expires)]);},
  async get(n,k){return out(await query('SELECT payload,state FROM tcog_state WHERE namespace=$1 AND key_hash=$2 AND expires_at>now()',[n,keyOf(n,k)]));},
  async take(n,k){return out(await query('DELETE FROM tcog_state WHERE namespace=$1 AND key_hash=$2 AND expires_at>now() RETURNING payload,state',[n,keyOf(n,k)]));},
  async claim(n,k,expected,state){return out(await query('UPDATE tcog_state SET state=$4 WHERE namespace=$1 AND key_hash=$2 AND state=$3 AND expires_at>now() RETURNING payload,state',[n,keyOf(n,k),expected,state]));},
  async prune(n){await query('DELETE FROM tcog_state WHERE namespace=$1 AND expires_at<=now()',[n]);},
  async count(n){const r=await query('SELECT count(*)::integer AS count FROM tcog_state WHERE namespace=$1 AND expires_at>now()',[n]);return r.rows[0].count;}
 };
}

export async function openCloudStateStore(env){
 if(!env.PGHOST?.startsWith('/cloudsql/')||!env.PGDATABASE||!env.PGUSER||!env.PGPASSWORD)throw Error('Cloud SQL configuration required');
 const pool=new pg.Pool({host:env.PGHOST,database:env.PGDATABASE,user:env.PGUSER,password:env.PGPASSWORD,max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:10000,statement_timeout:10000,application_name:'tcog-operational'});
 pool.on('error',()=>console.error('TCOG_STATE_POOL_ERROR'));
 const store=createPostgresStateStore(pool);
 try{await store.initialize();return store;}catch(e){await pool.end();throw e;}
}
