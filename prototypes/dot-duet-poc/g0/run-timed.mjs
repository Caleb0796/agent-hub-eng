import {TimedG0Store} from './timed-store.mjs';
import {startServers} from '../src/server.mjs';
import {timingSafeEqual} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const directory=resolve('.state/dot-muse-chat');
mkdirSync(directory,{recursive:true,mode:0o700});
const previous=JSON.parse(readFileSync(resolve('.state/dot-muse/g0-relay.json'),'utf8'));
const tokenFile=join(directory,'connection-tokens.json');
if(!existsSync(tokenFile))writeFileSync(tokenFile,readFileSync(resolve('.state/dot-muse/connection-tokens.json')),{mode:0o600});
const tokens=JSON.parse(readFileSync(tokenFile,'utf8'));
const store=new TimedG0Store(directory);
if(!Object.keys(store.data.registrations).length){
  if(!['dot','muse'].every(r=>previous.registrations[r]?.status==='claimed'))throw new Error('Verified identities missing');
  store.data.registrations=structuredClone(previous.registrations);
  store.data.previous_identity_run=previous.run_id;
  store.record('owner','existing_verified_identities_imported_for_new_user_authorized_timed_test');
}
store.connectionTokens=tokens;
store.authenticate=token=>Object.entries(tokens).find(([,v])=>v.length===token.length && timingSafeEqual(Buffer.from(v),Buffer.from(token)))?.[0];
const running=await startServers({directory,storeOverride:store});
console.log('Timed encrypted Dot–Muse relay ready on 127.0.0.1:8787; local owner console :8788/g0');
setTimeout(async()=>{await running.stop();process.exit(0)},Math.max(1,store.data.expires-Date.now()));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await running.stop();process.exit(0)});
