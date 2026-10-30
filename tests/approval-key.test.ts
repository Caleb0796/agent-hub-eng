import { describe, expect, it, vi } from 'vitest';
import { env, server } from './runtime';
import { keyPair, registeredAgent, seedOwner, type TestOwner } from './helpers';
import { Browser } from './support/passkey-device';
import { db } from '../src/server/common';
import { Hub } from '../src/server/hub';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { safetyCode, signPayload, verifySignature } from '../src/shared/crypto';
import { approvalKeyFromPrf } from '../src/web/prf';
import { claimChoices } from '../src/web/claim';

const hub = () => new Hub(db(env), 'http://localhost:8789');

function browserFor(u: TestOwner) {
  const browser = new Browser((input, init) => server.fetch(input, init));
  browser.cookies.set('agent-hub-local-session', u.cookie);
  browser.cookies.set('agent-hub-csrf', u.csrf);
  return browser;
}

async function replacement(
  u: TestOwner,
  options: {
    keyKind?: 'browser' | 'passkey-prf';
    credentialId?: string | null;
    skew?: number;
  } = {},
) {
  const key = await keyPair(),
    keyKind = options.keyKind ?? 'browser',
    credentialId = options.credentialId ?? null,
    issuedAt = Math.floor(Date.now() / 1000) + (options.skew ?? 0);
  const signature = await signPayload(key.privateKey, {
    kind: 'owner-approval-key',
    user_id: u.id,
    signing_key: key.publicKey,
    key_kind: keyKind,
    credential_id: credentialId,
    issued_at: issuedAt,
  });
  return { key, body: { signingKey: key.publicKey, keyKind, credentialId, issuedAt, signature } };
}

// An Agent whose endpoint has registered (and pinned the owner key) but is not yet claimed.
async function pendingAgent(u: TestOwner) {
  const h = hub(),
    a = await h.createAgent(u.id, 'muse', 'Pending Muse');
  await h.authorizeConnection(u.id, a.id);
  const challenge = await h.enrollmentChallenge(a.id),
    key = await keyPair();
  const payload = {
    v: PROTOCOL_VERSION,
    kind: 'endpoint-registration' as const,
    agent_id: a.id,
    owner_id: u.id,
    owner_key: u.key.publicKey,
    nonce: challenge.nonce,
    keys: {
      sign: key.publicKey,
      age: 'age1rz2ts4g4ne8tzadm5zt8hu3lgnv06a4atvdmrjxn3ympdx7hyvfsn0jha6',
    },
  };
  await h.registerEndpoint(a.id, {
    payload,
    signature: await signPayload(key.privateKey, payload),
  });
  return h.agent(a.id);
}

describe('owner approval key replacement', () => {
  it('replaces the key of an owner with nothing pinned and revokes pending connections', async () => {
    const u = await seedOwner('Rekey'),
      pending = await pendingAgent(u);
    expect(pending.status).toBe('awaiting_claim');
    const { key, body } = await replacement(u);
    const response = await browserFor(u).post('/api/auth/approval-key', body);
    expect(response.status).toBe(200);
    const view = (await response.json<{ owner: { signingKey: string; approvalKeyKind: string } }>())
      .owner;
    expect(view.signingKey).toBe(key.publicKey);
    expect(view.approvalKeyKind).toBe('browser');
    const revoked = await hub().agent(pending.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.auth_version).toBe(pending.auth_version + 1);
  });

  it('records a passkey-derived key only for the owner’s own credential', async () => {
    const u = await seedOwner('Prf'),
      other = await seedOwner('Other'),
      credential = 'cred' + crypto.randomUUID().replaceAll('-', '');
    await env.DB.prepare(
      'INSERT INTO passkeys(id,user_id,public_key,counter,transports_json,device_type,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
      .bind(credential, other.id, 'AA', 0, '[]', 'multiDevice', 1, 0)
      .run();
    const foreign = await replacement(u, { keyKind: 'passkey-prf', credentialId: credential });
    const rejected = await browserFor(u).post('/api/auth/approval-key', foreign.body);
    expect(rejected.status).toBe(400);
    expect((await rejected.json<{ error: string }>()).error).toBe('unknown_credential');
    await env.DB.prepare('UPDATE passkeys SET user_id=? WHERE id=?').bind(u.id, credential).run();
    const own = await replacement(u, { keyKind: 'passkey-prf', credentialId: credential });
    const accepted = await browserFor(u).post('/api/auth/approval-key', own.body);
    expect(accepted.status).toBe(200);
    expect(
      (await accepted.json<{ owner: { approvalKeyKind: string; approvalCredentialId: string } }>())
        .owner,
    ).toMatchObject({ approvalKeyKind: 'passkey-prf', approvalCredentialId: credential });
  });

  it('keeps a claim that completes between the replacement check and transaction', async () => {
    const u = await seedOwner('ClaimRace'),
      pending = await pendingAgent(u),
      { body } = await replacement(u);
    const enrollment = await env.DB.prepare(
      'SELECT claim_payload_json FROM enrollments WHERE agent_id=?',
    )
      .bind(pending.id)
      .first<{ claim_payload_json: string }>();
    const claimSignature = await signPayload(
      u.key.privateKey,
      JSON.parse(enrollment!.claim_payload_json),
    );
    const batch = env.DB.batch.bind(env.DB);
    const interleaving = vi
      .spyOn(env.DB, 'batch')
      .mockImplementationOnce(
        async <T = Record<string, unknown>>(statements: Parameters<typeof env.DB.batch>[0]) => {
          await hub().ownerClaim(u.id, pending.id, claimSignature);
          return batch<T>(statements);
        },
      );
    try {
      const response = await browserFor(u).post('/api/auth/approval-key', body);
      expect(response.status).toBe(409);
      expect((await response.json<{ error: string }>()).error).toBe('approval_key_locked');
      expect(await hub().agent(pending.id)).toMatchObject({
        status: 'awaiting_confirmation',
        auth_version: pending.auth_version,
      });
      const owner = await hub().user(u.id);
      expect(owner.signing_key).toBe(u.key.publicKey);
    } finally {
      interleaving.mockRestore();
    }
  });

  it('refuses once a claimed Agent has pinned the key, in the API and the database', async () => {
    const u = await seedOwner('Pinned');
    await registeredAgent(hub(), u, 'dot');
    const { body } = await replacement(u);
    const response = await browserFor(u).post('/api/auth/approval-key', body);
    expect(response.status).toBe(409);
    expect((await response.json<{ error: string }>()).error).toBe('approval_key_locked');
    await expect(
      env.DB.prepare('UPDATE users SET signing_key=? WHERE id=?').bind(body.signingKey, u.id).run(),
    ).rejects.toThrow(/pinned/);
  });

  it('rejects wrong proofs, stale proofs and sessions that are not fresh', async () => {
    const u = await seedOwner('Proof'),
      browser = browserFor(u);
    const forged = await replacement(u);
    forged.body.signingKey = (await keyPair()).publicKey;
    expect((await browser.post('/api/auth/approval-key', forged.body)).status).toBe(400);
    const stale = await replacement(u, { skew: -600 });
    expect((await browser.post('/api/auth/approval-key', stale.body)).status).toBe(400);
    await env.DB.prepare('UPDATE browser_sessions SET authenticated_at=? WHERE user_id=?')
      .bind(Math.floor(Date.now() / 1000) - 3600, u.id)
      .run();
    const late = await browser.post('/api/auth/approval-key', (await replacement(u)).body);
    expect(late.status).toBe(401);
    expect((await late.json<{ error: string }>()).error).toBe('reauthentication_required');
  });
});

describe('passkey PRF approval key derivation', () => {
  it('derives the same signing key from the same PRF output', async () => {
    const output = crypto.getRandomValues(new Uint8Array(32));
    const first = await approvalKeyFromPrf(output.slice()),
      second = await approvalKeyFromPrf(output.slice()),
      other = await approvalKeyFromPrf(crypto.getRandomValues(new Uint8Array(32)));
    expect(first.publicKey).toBe(second.publicKey);
    expect(other.publicKey).not.toBe(first.publicKey);
    const payload = { kind: 'owner-claim', n: 1 };
    expect(
      await verifySignature(
        first.publicKey,
        payload,
        await signPayload(second.privateKey, payload),
      ),
    ).toBe(true);
  });
});

describe('claim number matching', () => {
  it('offers the real code exactly once among three distinct, well-formed choices', () => {
    const real = safetyCode('ab'.repeat(32));
    for (let i = 0; i < 20; i++) {
      const choices = claimChoices(real);
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(3);
      expect(choices.filter((c) => c === real)).toHaveLength(1);
      for (const c of choices) expect(c).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){5}$/);
    }
  });
});
