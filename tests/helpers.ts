import { env } from 'cloudflare:workers';
import {
  base64url,
  canonical,
  fingerprint,
  randomToken,
  sha256,
  signPayload,
} from '../src/shared/crypto';
import { PROTOCOL_VERSION, type MessageEnvelope, type Platform } from '../src/shared/protocol';
import { Hub, type AgentRow, type ConversationRow } from '../src/worker/hub';
import { db } from '../src/worker/common';

export async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    privateKey: pair.privateKey,
    publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
  };
}
export async function seedOwner(name: string) {
  const key = await keyPair(),
    id = crypto.randomUUID(),
    handle = name.toLowerCase() + id.slice(0, 8),
    at = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO users(id,handle,display_name,signing_key,created_at) VALUES(?,?,?,?,?)',
  )
    .bind(id, handle, name, key.publicKey, at)
    .run();
  const cookie = randomToken(),
    csrf = randomToken();
  await env.DB.prepare(
    'INSERT INTO browser_sessions(token_hash,user_id,csrf_hash,authenticated_at,expires_at) VALUES(?,?,?,?,?)',
  )
    .bind(await sha256(cookie), id, await sha256(csrf), at, at + 86400)
    .run();
  return { id, handle, name, key, cookie, csrf };
}
export type TestOwner = Awaited<ReturnType<typeof seedOwner>>;
export async function registeredAgent(h: Hub, u: TestOwner, platform: Platform) {
  const a = await h.createAgent(u.id, platform, `${u.name} ${platform}`);
  await h.authorizeConnection(u.id, a.id);
  const challenge = await h.enrollmentChallenge(a.id),
    key = await keyPair();
  const keys = {
    sign: key.publicKey,
    age:
      platform === 'dot'
        ? 'age13cq0n0cqgp3xude0vgxr8fpgs7nz3r96n9k4g6erhx7zt4m9f99s00m8zh'
        : 'age1rz2ts4g4ne8tzadm5zt8hu3lgnv06a4atvdmrjxn3ympdx7hyvfsn0jha6',
  };
  const payload = {
    v: PROTOCOL_VERSION,
    kind: 'endpoint-registration' as const,
    agent_id: a.id,
    owner_id: u.id,
    owner_key: u.key.publicKey,
    nonce: challenge.nonce,
    keys,
  };
  await h.registerEndpoint(a.id, {
    payload,
    signature: await signPayload(key.privateKey, payload),
  });
  const detail = await h.agentDetail(u.id, a.id);
  await h.ownerClaim(u.id, a.id, await signPayload(u.key.privateKey, detail.claim_payload));
  const claimed = await h.agent(a.id),
    cert = JSON.parse(claimed.claim_json!);
  const proof = {
    v: PROTOCOL_VERSION,
    kind: 'claim-confirmation',
    agent_id: a.id,
    claim_hash: await fingerprint(cert),
  };
  await h.confirmClaim(a.id, {
    payload: proof,
    signature: await signPayload(key.privateKey, proof),
  });
  return { agent: await h.agent(a.id), key };
}
export async function fixture(
  options: { duration?: number; maxMessages?: number; ready?: boolean } = {},
) {
  const clock = { now: Math.floor(Date.now() / 1000) },
    h = new Hub(db(env), 'http://localhost:8789', () => clock.now);
  const alice = await seedOwner('Alice'),
    bob = await seedOwner('Bob');
  const a = await registeredAgent(h, alice, 'dot'),
    b = await registeredAgent(h, bob, 'muse');
  const invite = await h.createPairing(alice.id, a.agent.id),
    token = new URL(invite.invite_url).hash.slice('#invite='.length);
  const joined = await h.joinPairing(bob.id, token, b.agent.id);
  await h.approvePairing(
    alice.id,
    joined.id,
    await signPayload(alice.key.privateKey, joined.descriptor),
  );
  await h.approvePairing(
    bob.id,
    joined.id,
    await signPayload(bob.key.privateKey, joined.descriptor),
  );
  for (const endpoint of [a, b]) {
    const proof = {
      v: PROTOCOL_VERSION,
      kind: 'pairing-confirmation',
      pairing_id: joined.id,
      agent_id: endpoint.agent.id,
      pairing_hash: joined.fingerprint,
    };
    await h.acknowledgePairing(
      endpoint.agent.id,
      joined.id,
      await signPayload(endpoint.key.privateKey, proof),
    );
  }
  const c = await h.createConversation(
    alice.id,
    joined.id,
    options.duration ?? 600,
    options.maxMessages ?? 40,
  );
  if (options.ready !== false) {
    await h.approveConversation(alice.id, c.id, await signPayload(alice.key.privateKey, c.policy));
    await h.approveConversation(bob.id, c.id, await signPayload(bob.key.privateKey, c.policy));
    for (const endpoint of [a, b]) {
      const r = await h.connection
        .prepare('SELECT nonce FROM readiness WHERE conversation_id=? AND agent_id=?')
        .bind(c.id, endpoint.agent.id)
        .first<{ nonce: string }>();
      const proof = {
        v: PROTOCOL_VERSION,
        kind: 'session-preflight',
        conversation_id: c.id,
        agent_id: endpoint.agent.id,
        grant_hash: c.policy_hash,
        nonce: r!.nonce,
      };
      await h.preflight(
        endpoint.agent.id,
        c.id,
        await signPayload(endpoint.key.privateKey, proof),
        { kind: 'test-endpoint', taskReference: 'local-state-test', permission: 'test-only' },
      );
    }
  }
  return { h, clock, alice, bob, a, b, pair: joined, c };
}

// A deliberately opaque fixture for server state-machine tests. Real age
// encryption/decryption is covered separately by the Python endpoint E2E suite.
export async function envelope(
  c: { id: string; policy_hash: string },
  from: { agent: AgentRow; key: Awaited<ReturnType<typeof keyPair>> },
  to: AgentRow,
  at: number,
  sequence = 1,
  replyTo: string | null = null,
): Promise<MessageEnvelope> {
  const prefix = new TextEncoder().encode('age-encryption.org/v1\n'),
    raw = new Uint8Array(200);
  raw.set(prefix);
  crypto.getRandomValues(raw.subarray(prefix.length));
  const payload = {
    v: PROTOCOL_VERSION,
    kind: 'encrypted-message' as const,
    id: crypto.randomUUID(),
    conversation_id: c.id,
    grant_hash: c.policy_hash,
    from: from.agent.id,
    to: to.id,
    sequence,
    expires_at: at + 900,
    reply_to: replyTo,
    ciphertext: base64url(raw),
  };
  return { payload, signature: await signPayload(from.key.privateKey, payload) };
}
export function ownerHeaders(u: TestOwner, csrf = true) {
  return {
    Origin: 'http://localhost:8789',
    Cookie: `agent-hub-local-session=${u.cookie}; agent-hub-csrf=${u.csrf}`,
    ...(csrf ? { 'X-CSRF-Token': u.csrf } : {}),
    'Content-Type': 'application/json',
  };
}
