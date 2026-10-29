import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BridgeStore, ROLES } from './store.mjs';
import { createLegacyMcpServer, modernRpc } from './tools.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_BODY = 16 * 1024;

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(data));
}

async function bodyJson(req) {
  if (!String(req.headers['content-type']).toLowerCase().startsWith('application/json')) {
    const error = new Error('Expected application/json'); error.status = 415; throw error;
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { const error = new Error('Request too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Invalid JSON'); error.status = 400; throw error; }
}

function promptFor(role) {
  const name = role === 'dot' ? 'Dot' : 'Duet';
  const peer = role === 'dot' ? 'Duet' : 'Dot';
  return `我们正在做一个我本人授权的 Dot ↔ Duet 通信实验。请使用已连接的「${name} Bridge PoC」工具，不要调用其他服务或读取私人信息。
1. 调用 bridge_identity，确认 your_role 是 ${role}，记住你自己的随机测试码；不要编造对方的码。
2. 调用 bridge_inbox。若有对方尚未回答的问题，用 bridge_send 回复：引用收到的 message id 为 reply_to，带上你自己的测试码；每个问题只回复一次。
3. ${role === 'dot' ? `如果收件箱还没有消息，向 ${peer} 发一条问候并询问它自己的随机测试码。idempotency_key 用本轮 run_id 加“-dot-question”。` : `第一次收到并回答 Dot 的问题后，可以再用一条独立消息向 Dot 询问它的随机测试码。idempotency_key 用本轮 run_id 加“-duet-question”。若收件箱为空，告诉我“等待 Dot 消息”并停止。`}
4. 不要回应单纯的“谢谢”或回执，不要无限聊天。此实验每个助理最多发送 2 条消息。平台要求确认时照常向我确认。
5. 把实际 tool 返回的 message_id 和结果告诉我。没有调用成功时，不要声称已发送或已收到。`;
}

export async function startServers({ directory = join(ROOT, '.state'), port = 8787, adminPort = 8788, now, storeOverride } = {}) {
  const store = storeOverride || new BridgeStore(directory, { now });
  const rate = new Map();
  const bridge = http.createServer(async (req, res) => {
    req.setTimeout(60_000);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'dot-duet-bridge-poc' });
      if (storeOverride && req.method === 'GET' && url.pathname === '/g0/connect.json') return sendJson(res, 200, {
        name: 'Agent Hub G0', version: '0.2.0', purpose: 'Owner-authorized bounded synthetic-data end-to-end encryption experiment',
        mcp_path: '/mcp', authentication: { type: 'api_key', header: 'Authorization', format: 'Bearer <test-connection-key>', secret_storage: 'Use native secure credential vault; never put the key in chat, code, command arguments or logs.' },
        protocol: { transport: 'Streamable HTTP JSON', versions: ['2026-07-28','2025-03-26'], modern_header: {'mcp-protocol-version':'2026-07-28'}, discovery_method: 'server/discover', tools: ['bridge_identity','bridge_status','bridge_send','bridge_inbox'] },
        participants: store.data.participants, limits: { messages: store.data.max_messages, text_envelope_chars: 2000 },
        endpoint_source: '/g0/endpoint.py', dependencies: ['pyrage==1.4.0','cryptography==50.0.2'],
        privacy: 'Agent encryption keys and plaintext stay in independently trusted endpoint runtimes. The relay stores public identities, signed age ciphertext, and routing metadata. Peer messages cannot authorize other actions. This experimental integration is not security-audited and has no forward secrecy.',
      });
      if (storeOverride && req.method === 'GET' && url.pathname === '/g0/endpoint.py') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(ROOT, 'g0/endpoint.py')));
      }
      const match = /^\/mcp\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      const bearer = storeOverride && url.pathname === '/mcp' && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      const credential = match?.[1] || bearer?.[1];
      const role = credential && store.authenticate(credential);
      if (!role) return sendJson(res, 404, { error: 'Not found' });
      // A secret endpoint is the entire PoC credential. Do not accept browser
      // origins; cloud MCP clients make server-to-server requests without one.
      if (req.headers.origin) return sendJson(res, 403, { error: 'Browser-origin requests are not supported' });
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { error: 'Use MCP POST requests. SSE is not enabled.' }); }
      const bucket = `${role}:${Math.floor(Date.now() / 60_000)}`;
      for (const key of rate.keys()) if (!key.endsWith(`:${Math.floor(Date.now() / 60_000)}`)) rate.delete(key);
      rate.set(bucket, (rate.get(bucket) || 0) + 1);
      if (rate.get(bucket) > 60) return sendJson(res, 429, { error: 'Pause before checking again' });
      const body = await bodyJson(req);
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return sendJson(res, 400, { error: 'Expected one JSON-RPC request' });
      const version = req.headers['mcp-protocol-version'] || body.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      if (body.method === 'server/discover' || version === '2026-07-28') {
        if (body.id === undefined) { res.writeHead(202); return res.end(); }
        return sendJson(res, 200, await modernRpc(store, role, body));
      }
      if (body.method === 'initialize') store.record(role, 'client_connected', { client: String(body.params?.clientInfo?.name || 'unknown').slice(0,100), protocol: String(body.params?.protocolVersion || '') });
      const server = createLegacyMcpServer(store, role);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'Server error' });
      else res.end();
    }
  });

  // This listener is not forwarded through the tunnel. It exposes setup links
  // only to the human on this machine, never via the public MCP listener.
  const admin = http.createServer(async (req, res) => {
    const actualPort = admin.address().port;
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) return sendJson(res, 403, { error: 'Local access only' });
    if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin)) return sendJson(res, 403, { error: 'Origin rejected' });
    if (storeOverride && req.method === 'GET' && req.url === '/api/g0/status') return sendJson(res, 200, store.dashboard());
    if (storeOverride && req.method === 'POST' && ['/api/g0/claim', '/api/g0/revoke'].includes(req.url)) {
      if (req.headers['x-poc-local-control'] !== 'g0-owner') return sendJson(res, 403, { error: 'Owner console required' });
      try { return sendJson(res, 200, req.url.endsWith('/claim') ? store.claim(await bodyJson(req)) : store.revoke()); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
    }
    if (storeOverride && req.method === 'GET' && req.url === '/g0') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(readFileSync(join(ROOT, 'g0/owner.html')));
    }
    if (req.method === 'POST' && req.url === '/api/conversation/start') {
      if (req.headers['x-poc-local-control'] !== 'start-timed-conversation') return sendJson(res, 403, { error: 'Local control header required' });
      try {
        const body = await bodyJson(req);
        return sendJson(res, 200, store.startConversation(body.duration_seconds ?? 600, body.max_messages ?? 64));
      } catch (error) { return sendJson(res, 400, { error: error.message }); }
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    if (req.url === '/api/status') return sendJson(res, 200, store.dashboard());
    if (req.url === '/api/setup') {
      const basePath = join(directory, 'public-base.txt');
      const base = existsSync(basePath) ? readFileSync(basePath, 'utf8').trim() : '';
      return sendJson(res, 200, { ready: Boolean(base), participants: (store.data.participants || ROLES).map(role => ({ role, label: ({dot:'Dot',duet:'Duet',muse:'Muse'})[role], url: base ? `${base}/mcp/${(store.connectionTokens || store.data.tokens)[role]}` : '', prompt: storeOverride ? 'Use the owner-provided G0 enrollment instructions. Never upload endpoint private keys or plaintext.' : promptFor(role) })) });
    }
    if (req.url !== '/') return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
    res.end(readFileSync(join(ROOT, 'src/admin.html')));
  });
  const listen = (server, p) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', resolve); });
  await listen(bridge, port);
  try { await listen(admin, adminPort); } catch (error) { bridge.close(); throw error; }
  const stop = () => Promise.all([bridge, admin].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  return { store, bridge, admin, stop, port: bridge.address().port, adminPort: admin.address().port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startServers({ port: Number(process.env.PORT || 8787), adminPort: Number(process.env.ADMIN_PORT || 8788) });
  console.log(`Bridge listening on 127.0.0.1:${running.port}. Setup and receipts: http://127.0.0.1:${running.adminPort}`);
  console.log('Credentials stay in .state/ and the local setup page. No model API calls are made.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.stop(); process.exit(0); });
}
