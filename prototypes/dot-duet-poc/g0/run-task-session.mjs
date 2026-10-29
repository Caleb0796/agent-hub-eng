import {TimedG0Store} from './timed-store.mjs';
import {startServers} from '../src/server.mjs';
import {timingSafeEqual} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const directory=resolve(process.argv[2] || '.state/dot-muse-task-session');
if(!directory.startsWith(resolve('.state')+'/'))throw new Error('Expected an experiment state directory');
mkdirSync(directory,{recursive:true,mode:0o700});
const prior=JSON.parse(readFileSync(resolve('.state/dot-muse/g0-relay.json'),'utf8'));
const tokenFile=join(directory,'connection-tokens.json');if(!existsSync(tokenFile))writeFileSync(tokenFile,readFileSync(resolve('.state/dot-muse/connection-tokens.json')),{mode:0o600});
const tokens=JSON.parse(readFileSync(tokenFile,'utf8'));
const store=new TimedG0Store(directory);
if(!Object.keys(store.data.registrations).length){
 if(!['dot','muse'].every(r=>prior.registrations[r]?.status==='claimed'))throw new Error('Verified identities missing');
 store.data.registrations=structuredClone(prior.registrations);
 store.data.require_reconfirmation=true;
 store.data.native_task_id='agent-hub-chat-'+store.data.run_id.slice(0,8);
 store.record('owner','task_scoped_session_prepared');
}
store.connectionTokens=tokens;store.authenticate=token=>Object.entries(tokens).find(([,v])=>v.length===token.length&&timingSafeEqual(Buffer.from(v),Buffer.from(token)))?.[0];
const running=await startServers({directory,storeOverride:store});
console.log(JSON.stringify({local_console:'http://127.0.0.1:8788/g0',run_id:store.data.run_id,native_task_id:store.data.native_task_id,phase:'awaiting_authenticated_preflight'}));
setTimeout(async()=>{await running.stop();process.exit(0)},Math.max(1,store.data.expires-Date.now()));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await running.stop();process.exit(0)});
