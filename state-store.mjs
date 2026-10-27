import {createHash} from 'node:crypto';
import pg from 'pg';
const keyOf=(namespace,key)=>createHash('sha256').update(namespace+'\0'+String(key)).digest('hex');
const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));

// Memory adapter remains for existing Render/tests. Cloud startup requires SQL.
export function createMemoryStateStore({now=Date.now}={}){
 const records=new Map(), memory=new Map();
 const id=(n,k)=>n+':'+keyOf(n,k);
 const live=(n,k)=>{const r=records.get(id(n,k));if(r&&r.expires>now())return r;records.delete(id(n,k));};
 return {
  async initialize(){},async close(){},
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
   await query("CREATE INDEX IF NOT EXISTS tcog_memory_client ON tcog_memory (tenant, (payload->>'kind'), (payload->>'client_key'))");},
  async close(){await pool.end?.();},
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
