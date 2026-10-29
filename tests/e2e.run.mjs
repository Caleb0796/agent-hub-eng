import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { Browser, authenticator } from './support/passkey-device.ts';
import { base64url, randomToken, signPayload, fingerprint } from '../src/shared/crypto.ts';

const root = resolve('.'),
  base = 'http://localhost:8789',
  resource = `${base}/mcp`,
  callback = 'http://localhost:45678/callback';
const temporary = await mkdtemp(join(tmpdir(), 'agent-hub-e2e-'));
const python =
  process.env.AGENT_HUB_PYTHON ??
  (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const bundleRoot = join(root, '.output/worker');
const moduleFiles = ['index.js', ...(await readdir(bundleRoot)).filter((f) => f.endsWith('.py'))];
const modules = await Promise.all(
  moduleFiles.map(async (file) => ({
    type: file.endsWith('.py') ? 'Text' : 'ESModule',
    path: join(bundleRoot, file),
    contents: await readFile(join(bundleRoot, file), 'utf8'),
  })),
);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: 'agent-hub-e2e',
    modules,
    modulesRoot: bundleRoot,
    compatibilityDate: '2026-10-28',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    d1Databases: ['DB'],
    kvNamespaces: ['OAUTH_KV'],
    bindings: { APP_ENV: 'test', PUBLIC_ORIGIN: base, SIGNUP_MODE: 'open' },
    serviceBindings: { ASSETS: () => new Response('API test', { status: 404 }) },
  }),
);

function endpoint(state, command, input, expectFailure = false) {
  const output = spawnSync(
    python,
    [join(root, 'endpoint/agent_hub.py'), '--state', state, command],
    { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 256 * 1024 },
  );
  if (expectFailure) {
    assert.notEqual(output.status, 0, `Endpoint ${command} unexpectedly succeeded`);
    return;
  }
  assert.equal(output.status, 0, `Endpoint ${command} failed: ${output.stderr}`);
  return JSON.parse(output.stdout);
}
async function json(response, expected = 200) {
  assert.equal(response.status, expected, `Unexpected HTTP status ${response.status}`);
  return response.json();
}
async function ownerAccount(name) {
  const browser = new Browser((input, init) => mf.dispatchFetch(input, init)),
    device = await authenticator();
  const signing = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = base64url(
    new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey)),
  );
  const setup = await json(
    await browser.post('/api/auth/register/options', {
      handle: 'owner' + crypto.randomUUID().slice(0, 8),
      name,
      signingKey: publicKey,
    }),
  );
  const created = await json(
    await browser.post('/api/auth/register/verify', {
      response: device.register(setup.options.challenge),
      signingProof: await signPayload(signing.privateKey, setup.signingChallenge),
    }),
    201,
  );
  return { ...created.owner, browser, signing };
}
async function get(owner, path) {
  return json(
    await mf.dispatchFetch(base + path, {
      headers: { Cookie: [...owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    }),
  );
}
async function post(owner, path, body, expected = 200) {
  return json(await owner.browser.post(path, body), expected);
}
async function oauth(owner, agent) {
  const registered = await json(
    await mf.dispatchFetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: `${agent.platform} protocol test`,
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
    scope: 'agent:read agent:enroll agent:message',
    resource,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomToken(),
  });
  const cookie = [...owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const page = await mf.dispatchFetch(`${base}/authorize?${params}`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  const html = await page.text(),
    handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle);
  const bound = page.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  const form = new URLSearchParams({
    handle,
    csrf: owner.browser.cookies.get('agent-hub-csrf'),
    decision: 'approve',
    agentId: agent.id,
    platform: agent.platform,
    label: agent.label,
  });
  for (const scope of ['agent:read', 'agent:enroll', 'agent:message']) form.append('scope', scope);
  const approved = await mf.dispatchFetch(`${base}/authorize`, {
    method: 'POST',
    headers: {
      Origin: base,
      Cookie: `${cookie}; ${bound}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get('Location'));
  assert.equal(location.searchParams.get('iss'), base);
  return json(
    await mf.dispatchFetch(`${base}/oauth/token`, {
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
}
async function tool(client, name, args = {}) {
  const body = await json(
    await mf.dispatchFetch(resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.access_token}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
  assert.equal(
    body.result?.isError,
    false,
    `MCP ${name} failed: ${body.result?.structuredContent?.error ?? body.error?.code ?? 'unknown'}`,
  );
  return body.result.structuredContent;
}
async function enroll(owner, platform) {
  const agent = await post(
      owner,
      '/api/agents',
      { platform, label: `${owner.name} ${platform}` },
      201,
    ),
    client = await oauth(owner, agent),
    state = join(temporary, platform);
  const bundle = await tool(client, 'hub_endpoint_bundle');
  const source = await readFile(join(root, 'endpoint/agent_hub.py'), 'utf8');
  assert.equal(bundle.source, source);
  assert.equal(bundle.execution_permission_granted, false);
  const challenge = await tool(client, 'hub_enrollment_challenge'),
    registration = endpoint(state, 'prepare', { challenge });
  const submitted = await tool(client, 'hub_register_endpoint', {
    registration: registration.registration,
  });
  assert.equal(submitted.status, 'awaiting_claim');
  const detail = await get(owner, `/api/agents/${agent.id}`);
  assert.equal(detail.fingerprint, registration.fingerprint);
  assert.equal(detail.safety_code, registration.safety_code);
  await post(owner, `/api/agents/${agent.id}/claim`, {
    signature: await signPayload(owner.signing.privateKey, detail.claim_payload),
  });
  const native = await tool(client, 'hub_state'),
    confirmation = endpoint(state, 'claim', { certificate: native.claim_certificate });
  await tool(client, 'hub_confirm_claim', confirmation);
  assert.equal((await tool(client, 'hub_identity')).status, 'active');
  return { agent, client, state };
}

try {
  const database = await mf.getD1Database('DB'),
    migrations = await readD1Migrations(join(root, 'migrations'));
  await database.batch(migrations.flatMap((m) => m.queries.map((q) => database.prepare(q))));
  const alice = await ownerAccount('测试主人甲'),
    bob = await ownerAccount('测试主人乙');
  // Handles are ASCII; names intentionally exercise UTF-8 in signed certificates.
  assert.notEqual(alice.id, bob.id);
  const a = await enroll(alice, 'dot'),
    b = await enroll(bob, 'muse');
  const invite = await post(alice, '/api/pairings', { agentId: a.agent.id }, 201),
    token = new URL(invite.invite_url).hash.slice(8);
  const invitation = await post(bob, '/api/pairing-invitation', { token });
  assert.equal(invitation.inviter.owner_id, alice.id);
  const pair = await post(bob, '/api/pairings/join', { token, agentId: b.agent.id });
  const aliceView = (await get(alice, '/api/dashboard')).pairings.find((x) => x.id === pair.id);
  assert.equal(aliceView.fingerprint, pair.fingerprint);
  await post(alice, `/api/pairings/${pair.id}/approve`, {
    signature: await signPayload(alice.signing.privateKey, pair.descriptor),
  });
  assert.equal(
    (
      await alice.browser.post('/api/conversations', {
        pairingId: pair.id,
        duration: 60,
        maxMessages: 4,
      })
    ).status,
    409,
  );
  await post(bob, `/api/pairings/${pair.id}/approve`, {
    signature: await signPayload(bob.signing.privateKey, pair.descriptor),
  });
  for (const e of [a, b]) {
    const certificate = (await tool(e.client, 'hub_state')).pairings.find((x) => x.id === pair.id);
    await tool(
      e.client,
      'hub_confirm_pairing',
      endpoint(e.state, 'pair', { pairing: certificate }),
    );
  }
  const conversation = await post(
    alice,
    '/api/conversations',
    { pairingId: pair.id, duration: 60, maxMessages: 4 },
    201,
  );
  await post(alice, `/api/conversations/${conversation.id}/approve`, {
    signature: await signPayload(alice.signing.privateKey, conversation.policy),
  });
  assert.equal(
    (await tool(b.client, 'hub_state')).conversations.length,
    0,
    'Agent must not see a conversation until both owners approve',
  );
  await post(bob, `/api/conversations/${conversation.id}/approve`, {
    signature: await signPayload(bob.signing.privateKey, conversation.policy),
  });
  for (const e of [a, b]) {
    const state = await tool(e.client, 'hub_state'),
      view = state.conversations.find((x) => x.id === conversation.id),
      nonce = state.readiness.find((x) => x.conversation_id === conversation.id).nonce;
    const ready = endpoint(e.state, 'preflight', { conversation: view, nonce });
    await tool(e.client, 'hub_preflight', {
      ...ready,
      nativeContext: {
        kind: 'test-endpoint',
        permission: 'test-only',
        taskReference: 'isolated-e2e-process',
      },
    });
  }
  const texts = [
    '如果给一座海边图书馆起名，你会选择什么？',
    '我会叫它潮页。你希望窗外看到日出还是日落？',
    '我会选择日落，让读者在暖色的光里读书。你会收藏哪些地图？',
    '我会收藏航海图与星图，把远方和夜空放在同一个书架。',
  ];
  let replyTo = null;
  const cursors = new Map([
    [a.agent.id, 0],
    [b.agent.id, 0],
  ]);
  let deadline = null;
  for (let i = 0; i < texts.length; i++) {
    const sender = i % 2 === 0 ? a : b,
      recipient = i % 2 === 0 ? b : a;
    const state = await tool(sender.client, 'hub_state'),
      view = state.conversations.find((x) => x.id === conversation.id);
    const sealed = endpoint(sender.state, 'seal', {
      conversation: view,
      text: texts[i],
      idempotencyKey: `${conversation.id}:turn-${i}`,
      reply_to: replyTo,
    });
    assert.ok(!JSON.stringify(sealed).includes(texts[i]));
    const accepted = await tool(sender.client, 'hub_send', sealed);
    endpoint(sender.state, 'sent', { conversation_id: conversation.id, receipt: accepted });
    if (i === 0) assert.equal(accepted.conversation.started_at, null);
    const inbox = await tool(recipient.client, 'hub_inbox', {
      conversationId: conversation.id,
      after: cursors.get(recipient.agent.id),
    });
    assert.equal(inbox.messages.length, 1);
    cursors.set(recipient.agent.id, inbox.next_cursor);
    if (deadline === null) deadline = inbox.conversation.deadline;
    else assert.equal(inbox.conversation.deadline, deadline);
    const opened = endpoint(recipient.state, 'open', {
      conversation: inbox.conversation,
      envelope: inbox.messages[0].envelope,
    });
    assert.equal(opened.text, texts[i]);
    await tool(recipient.client, 'hub_acknowledge', { receipt: opened.receipt });
    replyTo = opened.message_id;
  }
  const final = (await tool(a.client, 'hub_state')).conversations.find(
    (x) => x.id === conversation.id,
  );
  assert.equal(final.message_count, 4);
  assert.equal(final.conversation_closed, true);
  assert.equal(final.close_reason, 'message_limit');
  endpoint(
    a.state,
    'seal',
    {
      conversation: final,
      text: 'This must never be sent',
      idempotencyKey: 'after-limit',
      reply_to: replyTo,
    },
    true,
  );
  const manifestA = endpoint(a.state, 'manifest', { conversation_id: conversation.id }),
    manifestB = endpoint(b.state, 'manifest', { conversation_id: conversation.id });
  const indexed = (entries) => {
    const map = Object.fromEntries(entries.map((x) => [x.id, x.sha256]));
    assert.equal(Object.keys(map).length, entries.length, 'Duplicate native receipt ID');
    return map;
  };
  assert.deepEqual(indexed(manifestA.sent), indexed(manifestB.received));
  assert.deepEqual(indexed(manifestB.sent), indexed(manifestA.received));
  const rows = await database
    .prepare('SELECT envelope_json FROM messages WHERE conversation_id=?')
    .bind(conversation.id)
    .all();
  const storage = JSON.stringify(rows.results);
  for (const text of texts) assert.ok(!storage.includes(text));
  for (const marker of [
    'AGE-SECRET-KEY-',
    'sign_private',
    'age_private',
    '"text":',
    '"n":',
    '"t":',
  ])
    assert.ok(!storage.includes(marker));
  for (const e of [a, b]) {
    const cleanup = endpoint(e.state, 'cleanup', {
      conversation_id: conversation.id,
      result: 'complete',
      task_reference: 'isolated-e2e-process',
    });
    await tool(e.client, 'hub_report_cleanup', {
      conversationId: cleanup.conversationId,
      proof: cleanup.proof,
    });
  }
  const unrelated = await mf.dispatchFetch(`${base}/api/agents/${a.agent.id}`, {
    headers: { Cookie: [...bob.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  assert.equal(unrelated.status, 404);
  const report = {
    result: 'passed',
    checked_at: new Date().toISOString(),
    independent_owner_identities: 2,
    passkey_registration_verified: true,
    oauth: 'DCR + owner consent + S256 PKCE',
    owner_claims: 2,
    pairing_owner_signatures: 2,
    pairing_endpoint_confirmations: 2,
    conversation_owner_signatures: 2,
    native_crypto_endpoints: 2,
    messages: 4,
    all_native_plaintext_package_digests_match: true,
    hub_plaintext_and_private_key_scan: 'passed',
    quota_stop: true,
    owner_isolation: true,
    native_ui_compatibility_verified: false,
    scope:
      'Two isolated protocol clients with synthetic passkey authenticators and the actual Python endpoint; not a live two-human Dot/Muse acceptance test.',
  };
  await mkdir(join(root, '.output'), { recursive: true });
  await writeFile(join(root, '.output/e2e-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await mf.dispose();
  await rm(temporary, { recursive: true, force: true });
}
