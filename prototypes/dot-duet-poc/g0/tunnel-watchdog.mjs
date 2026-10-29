// Bounded cleanup for this experiment's current tunnel; never reuse a bare PID.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
const pid=Number(process.argv[2]);
if (!Number.isSafeInteger(pid)||pid<=1) throw new Error('Expected current tunnel PID');
const identity=()=>execFileSync('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const original=identity();
if(!original.endsWith('.tools/cloudflared tunnel --no-autoupdate --config /dev/null --url http://127.0.0.1:8787 --protocol http2')) throw new Error('Unexpected process');
const directory=resolve(process.argv[3] || '.state/dot-muse');
if(!directory.startsWith(resolve('.state')+'/'))throw new Error('Expected an experiment state directory');
const file=resolve(directory,'tunnel-watchdog.json');
const id=randomUUID(), deadline=Date.now()+30*60_000;
writeFileSync(file,JSON.stringify({id,pid,armed:true,deadline:new Date(deadline).toISOString()}),{mode:0o600});
console.log(JSON.stringify({cleanup_deadline:new Date(deadline).toISOString()}));
setTimeout(()=>{
 if(!existsSync(file))return;
 const current=JSON.parse(readFileSync(file,'utf8'));
 if(current.id!==id||!current.armed)return;
 let same=false;try{same=identity()===original}catch{}
 if(same)process.kill(pid,'SIGTERM');
 writeFileSync(file,JSON.stringify({...current,armed:false,closed_at:new Date().toISOString(),same_process:same}),{mode:0o600});
 const base=resolve(directory,'public-base.txt');if(same&&existsSync(base))unlinkSync(base);
},Math.max(1,deadline-Date.now()));
