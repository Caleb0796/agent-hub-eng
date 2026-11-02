import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@libsql/client';
import { createRuntime } from '../.output/runtime.mjs';
import { migrate } from '../scripts/migrations.mjs';
import { Browser, authenticator } from './support/passkey-device.ts';
import { base64url, randomToken } from '../src/shared/crypto.ts';

// Two independent owners, three platform identities, real passkeys (synthetic authenticators),
// real OAuth (DCR + PKCE) and real HTTP: invite → chat → review → auto window → pause → reset.
const base = 'http://localhost:8789',
  resource = `${base}/mcp`,
  callback = 'http://localhost:45678/callback';
const temporary = await mkdtemp(join(tmpdir(), 'agent-hub-e2e-'));
const client = createClient({ url: `file:${join(temporary, 'test.db')}` });
const runtime = createRuntime(
  client,
  {
    APP_ENV: 'test',
    PUBLIC_ORIGIN: base,
    SIGNUP_MODE: 'open',
    SIGNUP_DAILY_CAP: 200,
    MESSAGE_KEYS: { 1: Buffer.alloc(32, 3).toString('base64url') },
  },
  { fetch: async () => new Response('E2E', { status: 404 }) },
);
const dispatch = runtime.fetch;
const steps = [];

async function json(response, expected = 200) {
  assert.equal(
    response.status,
    expected,
    `HTTP ${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}
const cookies = (owner) => [...owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
async function ownerAccount(name) {
  const browser = new Browser((input, init) => dispatch(input, init)),
    device = await authenticator();
  const setup = await json(await browser.post('/api/auth/register/options', { name }));
  const created = await json(
    await browser.post('/api/auth/register/verify', {
      response: device.register(setup.options.challenge),
    }),
    201,
  );
  return { ...created.owner, browser };
}
const get = async (owner, path) =>
  json(await dispatch(base + path, { headers: { Cookie: cookies(owner) } }));
const post = async (owner, path, body = {}, expected = 200) =>
  json(await owner.browser.post(path, body), expected);

/** Native-style OAuth: dynamic registration, owner consent creating a new Agent, PKCE exchange. */
async function connect(owner, platform) {
  const registered = await json(
    await dispatch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: `${platform} e2e`,
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    }),
    201,
  );
  const verifier = randomToken(48),
    challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
  const params = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: callback,
    response_type: 'code',
    scope: 'agent:read agent:message',
    resource,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomToken(),
  });
  const page = await dispatch(`${base}/authorize?${params}`, {
    headers: { Cookie: cookies(owner) },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(handle);
  const bound = page.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  const approved = await dispatch(`${base}/authorize`, {
    method: 'POST',
    headers: {
      Origin: base,
      Cookie: `${cookies(owner)}; ${bound}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      handle,
      csrf: owner.browser.cookies.get('agent-hub-csrf'),
      decision: 'approve',
      agentId: 'new',
      platform,
    }),
    redirect: 'manual',
  });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('Location'));
  const token = await json(
    await dispatch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code: location.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: callback,
        resource,
      }),
    }),
  );
  const agent = (await tool(token, 'hub_whoami')).structuredContent;
  assert.equal(agent.platform, platform);
  return { token, agent };
}
async function tool(token, name, args = {}, expected = 200) {
  const response = await dispatch(resource, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (expected !== 200) {
    assert.equal(response.status, expected);
    return null;
  }
  return (await json(response)).result;
}

try {
  await migrate(client);
  const alice = await ownerAccount('Alice'),
    bob = await ownerAccount('Bob');
  steps.push('two owners registered with name + passkey only');
  const dot = await connect(alice, 'dot'),
    muse = await connect(bob, 'muse'),
    duet = await connect(bob, 'duet');
  const dash = await get(bob, '/api/dashboard');
  assert.deepEqual(
    dash.agents.map((a) => a.connection),
    ['online', 'online'],
  );
  steps.push('Dot, Muse and Duet identities connected via OAuth and online after hub_whoami');

  const invite = await post(alice, '/api/invites', { agentId: dot.agent.agent_id }, 201);
  const token = new URL(invite.url).hash.slice(1);
  const preview = await json(
    await dispatch(`${base}/api/invites/preview`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );
  assert.equal(preview.inviter_name, 'Alice');
  const accepted = await post(bob, '/api/invites/accept', { token, agentId: muse.agent.agent_id });
  const chatId = accepted.chat_id;
  assert.ok(chatId);
  steps.push('invite accepted: contact, exposure and open chat in one click');

  const first = (
    await tool(dot.token, 'hub_send', {
      chat_id: chatId,
      text: 'Hello, Muse',
      idempotency_key: 'e2e-first-1',
    })
  ).structuredContent;
  assert.equal(first.status, 'pending_review');
  assert.equal((await tool(muse.token, 'hub_inbox')).structuredContent.messages.length, 0);
  await post(alice, `/api/drafts/${first.draft_id}/approve`);
  const delivered = (await tool(muse.token, 'hub_inbox')).structuredContent.messages;
  assert.deepEqual(
    delivered.map((m) => m.text),
    ['Hello, Muse'],
  );
  steps.push('Agent send held for owner review, then delivered once');

  await json(await alice.browser.post(`/api/chats/${chatId}/window`, { minutes: 10 }));
  const auto = (
    await tool(dot.token, 'hub_send', {
      chat_id: chatId,
      text: 'auto send',
      idempotency_key: 'e2e-auto-1',
    })
  ).structuredContent;
  assert.equal(auto.status, 'sent');
  const reply = (
    await tool(muse.token, 'hub_send', {
      chat_id: chatId,
      text: 'got it',
      idempotency_key: 'e2e-reply-1',
    })
  ).structuredContent;
  assert.equal(reply.status, 'pending_review', "Bob's side stays in review");
  steps.push('auto window applies to its own side only');

  await post(bob, `/api/chats/${chatId}/pause`);
  const paused = await tool(dot.token, 'hub_send', {
    chat_id: chatId,
    text: 'while paused',
    idempotency_key: 'e2e-paused-1',
  });
  assert.equal(paused.structuredContent.error, 'chat_paused');
  await post(bob, `/api/chats/${chatId}/resume`);
  assert.equal(
    (await tool(muse.token, 'hub_inbox')).structuredContent.messages[0].text,
    'auto send',
  );
  steps.push('pause froze both Agents; resume delivered the waiting message');

  const sameOwner = await post(
    bob,
    '/api/chats',
    { agentId: muse.agent.agent_id, peerAgentId: duet.agent.agent_id },
    201,
  );
  assert.equal(sameOwner.status, 'open');
  steps.push('same-owner chat opened without approval');

  await post(alice, `/api/agents/${dot.agent.agent_id}/reset`);
  await tool(dot.token, 'hub_chats', {}, 401);
  steps.push('connection reset invalidated the old token immediately');

  const rows = (await client.execute('SELECT ciphertext FROM messages')).rows;
  assert.ok(rows.length >= 2 && rows.every((r) => !String(r.ciphertext).includes('Hello, Muse')));
  steps.push('database holds ciphertext only');

  await mkdir('.output', { recursive: true });
  const report = {
    result: 'passed',
    checked_at: new Date().toISOString(),
    steps,
    native_platform_verified: false,
  };
  await writeFile('.output/e2e-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.close();
  await rm(temporary, { recursive: true, force: true });
}
