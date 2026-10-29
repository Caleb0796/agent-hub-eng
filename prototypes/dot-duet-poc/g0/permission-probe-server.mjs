// Public synthetic-only endpoint for native task-permission capability checks.
// No account data, credentials, agent keys, file serving, or peer messaging.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const directory=resolve('.state/permission-probe');mkdirSync(directory,{recursive:true,mode:0o700});
const state={probe_id:randomUUID(),created_at:new Date().toISOString(),expires_at:new Date(Date.now()+15*60000).toISOString(),requests:[]};
const save=()=>writeFileSync(join(directory,'probe.json'),JSON.stringify(state,null,2),{mode:0o600});save();
const reply=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
const server=http.createServer(async(req,res)=>{
 req.setTimeout(15000);const path=new URL(req.url,'http://localhost').pathname;
 if(req.method==='GET'&&path==='/healthz')return reply(res,200,{service:'public-synthetic-permission-probe',probe_id:state.probe_id,expires_at:state.expires_at});
 if(req.method!=='POST'||path!=='/probe')return reply(res,404,{error:'Not found'});
 if(state.requests.length>=20||Date.now()>=Date.parse(state.expires_at))return reply(res,410,{error:'Probe closed'});
 let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024)return reply(res,413,{error:'Too large'});}
 let data;try{data=JSON.parse(body)}catch{return reply(res,400,{error:'Expected synthetic probe JSON'})}
 if(data.probe_id!==state.probe_id||![1,2].includes(data.step)||data.message!=='synthetic permission probe')return reply(res,400,{error:'Only the declared synthetic payload is accepted'});
 const receipt={step:data.step,at:new Date().toISOString()};state.requests.push(receipt);save();reply(res,200,{probe_id:state.probe_id,...receipt});
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(8791,'127.0.0.1',ok)});
const tunnel=spawn(resolve('.tools/cloudflared'),['tunnel','--no-autoupdate','--config','/dev/null','--url','http://127.0.0.1:8791','--protocol','http2'],{stdio:['ignore','pipe','pipe']});
let announced=false,closing=false,buffer='';
function output(chunk){appendFileSync(join(directory,'tunnel.log'),chunk,{mode:0o600});buffer=(buffer+chunk).slice(-8000);const m=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(m&&!announced){announced=true;state.base=m[0];save();console.log(JSON.stringify({base:state.base,probe_id:state.probe_id,expires_at:state.expires_at}));}}
tunnel.stdout.on('data',output);tunnel.stderr.on('data',output);
async function close(){if(closing)return;closing=true;clearTimeout(timer);tunnel.kill('SIGTERM');await new Promise(r=>{server.close(r);server.closeAllConnections()});state.closed_at=new Date().toISOString();save();}
const timer=setTimeout(()=>void close(),15*60000);
tunnel.on('error',()=>void close());tunnel.on('exit',()=>void close());for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>void close());
