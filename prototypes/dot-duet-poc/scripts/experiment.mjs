import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startServers } from '../src/server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const state = join(root, '.state');
const logs = join(root, '.logs');
mkdirSync(state, { recursive: true, mode: 0o700 });
mkdirSync(logs, { recursive: true, mode: 0o700 });
const binary = process.env.CLOUDFLARED_BIN || join(root, '.tools/cloudflared');
if (!existsSync(binary)) throw new Error('Install cloudflared and set CLOUDFLARED_BIN, or place it in .tools/cloudflared. See README.md.');
const stopFile = join(state, 'stop-requested');
const baseFile = join(state, 'public-base.txt');
rmSync(stopFile, { force: true });
rmSync(baseFile, { force: true });
const running = await startServers({ directory: state });
if (running.store.status().expired) {
  await running.stop();
  throw new Error('The previous round expired. Run npm run reset, then npm run experiment.');
}
const logFile = join(logs, 'tunnel.log');
writeFileSync(logFile, '', { mode: 0o600 });
const tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--config', '/dev/null', '--url', `http://127.0.0.1:${running.port}`, '--protocol', 'http2'], { stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '';
let ready = false;
let closing = false;
let stopWatcher;
let expiryTimer;
let readyTimer;

async function close(code = 0) {
  if (closing) return;
  closing = true;
  clearInterval(stopWatcher); clearTimeout(expiryTimer); clearTimeout(readyTimer);
  tunnel.kill('SIGTERM');
  rmSync(baseFile, { force: true });
  await running.stop();
  console.log('PoC server and temporary tunnel stopped.');
  process.exitCode = code;
}

function onOutput(chunk) {
  const output = chunk.toString();
  appendFileSync(logFile, output);
  buffer = (buffer + output).slice(-8000);
  const hostname = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!ready && hostname) {
    ready = true;
    clearTimeout(readyTimer);
    writeFileSync(baseFile, `${hostname[0]}\n`, { mode: 0o600 });
    console.log(`Setup page: http://127.0.0.1:${running.adminPort}`);
    console.log('Temporary HTTPS tunnel allocated. Per-agent connection addresses are shown only on the local setup page.');
    console.log(`Experiment expires: ${running.store.data.expires_at}. Stop early with npm run stop.`);
  }
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('error', error => { console.error(`Tunnel could not start: ${error.message}`); void close(1); });
tunnel.on('exit', code => { if (!closing) { console.error(`Tunnel exited (${code}); see .logs/tunnel.log.`); void close(1); } });
readyTimer = setTimeout(() => { console.error('Tunnel setup timed out; see .logs/tunnel.log.'); void close(1); }, 45_000);
stopWatcher = setInterval(() => { if (existsSync(stopFile)) { rmSync(stopFile, { force: true }); void close(); } }, 1000);
expiryTimer = setTimeout(() => { console.log('Two-hour experiment ended.'); void close(); }, Math.max(1, Date.parse(running.store.data.expires_at) - Date.now()));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
