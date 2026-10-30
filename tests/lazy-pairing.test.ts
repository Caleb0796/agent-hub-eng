import { describe, expect, it } from 'vitest';
import { envelope, fixture } from './helpers';
import { Mailbox } from '../src/server/messages';
import { signPayload } from '../src/shared/crypto';
import { PROTOCOL_VERSION } from '../src/shared/protocol';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Endpoint = Fixture['a'];

async function pin(f: Fixture, endpoint: Endpoint) {
  const proof = {
    v: PROTOCOL_VERSION,
    kind: 'pairing-confirmation',
    pairing_id: f.pair.id,
    agent_id: endpoint.agent.id,
    pairing_hash: f.pair.fingerprint,
  };
  return f.h.acknowledgePairing(
    endpoint.agent.id,
    f.pair.id,
    await signPayload(endpoint.key.privateKey, proof),
  );
}

async function preflight(f: Fixture, endpoint: Endpoint) {
  const r = await f.h.connection
    .prepare('SELECT nonce FROM readiness WHERE conversation_id=? AND agent_id=?')
    .bind(f.c.id, endpoint.agent.id)
    .first<{ nonce: string }>();
  const proof = {
    v: PROTOCOL_VERSION,
    kind: 'session-preflight',
    conversation_id: f.c.id,
    agent_id: endpoint.agent.id,
    grant_hash: f.c.policy_hash,
    nonce: r!.nonce,
  };
  return f.h.preflight(
    endpoint.agent.id,
    f.c.id,
    await signPayload(endpoint.key.privateKey, proof),
    {
      kind: 'test-endpoint',
      taskReference: 'lazy-pairing-test',
      permission: 'test-only',
    },
  );
}

describe('pairing pinned lazily during the first session', () => {
  it('lets owners start a session before endpoints pin, but gates preflight and messages', async () => {
    const f = await fixture({ pin: false, ready: false });
    expect((await f.h.pair(f.pair.id)).status).toBe('awaiting_endpoints');
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    await f.h.approveConversation(
      f.bob.id,
      f.c.id,
      await signPayload(f.bob.key.privateKey, f.c.policy),
    );

    expect(await f.h.pendingActions(f.a.agent.id)).toEqual([
      {
        action: 'confirm_pairing',
        pairing_id: f.pair.id,
        expires_at: f.pair.descriptor!.expires_at,
      },
      { action: 'preflight', conversation_id: f.c.id },
    ]);
    await expect(preflight(f, f.a)).rejects.toMatchObject({ code: 'pairing_unconfirmed' });

    await pin(f, f.a);
    expect(await f.h.pendingActions(f.a.agent.id)).toEqual([
      { action: 'preflight', conversation_id: f.c.id },
    ]);
    await preflight(f, f.a);
    expect(await f.h.pendingActions(f.a.agent.id)).toEqual([]);

    const mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await expect(mail.send(f.a.agent.id, first, 'before-peer-pins')).rejects.toBeTruthy();

    await pin(f, f.b);
    expect((await f.h.pair(f.pair.id)).status).toBe('active');
    await preflight(f, f.b);
    expect((await mail.send(f.a.agent.id, first, 'after-both-pin')).status).toBe('accepted');
  });

  it('keeps an owner-approved pairing confirmable well past the one-day invite window', async () => {
    const f = await fixture({ pin: false, ready: false });
    expect(f.pair.descriptor!.expires_at - f.clock.now).toBeGreaterThanOrEqual(29 * 86400);
    f.clock.now += 25 * 3600;
    expect((await pin(f, f.a)).endpoint_confirmations).toMatchObject({ a: true });
  });
});
