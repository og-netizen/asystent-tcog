import {createHash} from 'node:crypto';
import pg from 'pg';
const keyOf=(namespace,key)=>createHash('sha256').update(namespace+'\0'+String(key)).digest('hex');
const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));

// Memory adapter remains for existing Render/tests. Cloud startup requires SQL.
export function createMemoryStateStore({now=Date.now}={}){
 const records=new Map();
 const id=(n,k)=>n+':'+keyOf(n,k);
 const live=(n,k)=>{const r=records.get(id(n,k));if(r&&r.expires>now())return r;records.delete(id(n,k));};
 return {
  async initialize(){},async close(){},
  async put(n,k,data,expires){records.set(id(n,k),{data:copy(data),expires});},
  async get(n,k){return copy(live(n,k)?.data);},
  async take(n,k){const r=live(n,k);records.delete(id(n,k));return copy(r?.data);},
  async claim(n,k,expected,state){const r=live(n,k);if(!r||r.data.state!==expected)return undefined;r.data.state=state;return copy(r.data);},
  async prune(n){for(const [key,r]of records)if(key.startsWith(n+':')&&r.expires<=now())records.delete(key);},
  async count(n){return [...records].filter(([key,r])=>key.startsWith(n+':')&&r.expires>now()).length;}
 };
}

export function createPostgresStateStore(pool){
 const out=r=>r.rows[0]?{...r.rows[0].payload,...(r.rows[0].state?{state:r.rows[0].state}:{})}:undefined;
 const query=async(sql,params=[])=>{try{return await pool.query(sql,params);}catch{throw Error('State storage unavailable');}};
 return {
  async initialize(){await query(`CREATE TABLE IF NOT EXISTS tcog_state (
   namespace text NOT NULL, key_hash text NOT NULL, payload jsonb NOT NULL,
   state text NOT NULL DEFAULT '', expires_at timestamptz NOT NULL,
   PRIMARY KEY(namespace,key_hash));`);
   await query('CREATE INDEX IF NOT EXISTS tcog_state_expiry ON tcog_state(expires_at)');},
  async close(){await pool.end?.();},
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
