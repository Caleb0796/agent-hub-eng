import { env, exports as workers } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { fixture, envelope, seedOwner, ownerHeaders, keyPair } from './helpers';
import { Mailbox } from '../src/worker/messages';
import { canonical, fingerprint, signPayload } from '../src/shared/crypto';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { validateOwnerPayload } from '../src/shared/authorization';

describe('two independent owners and bounded ciphertext sessions', () => {
  it('starts the immutable clock at first recipient delivery; both directions and exact cutoff', async () => {
    const f = await fixture(),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await mail.send(f.a.agent.id, first, 'first-message');
    expect((await f.h.conversation(f.c.id)).deadline).toBeNull();
    f.clock.now += 25;
    const received = await mail.inbox(f.b.agent.id, f.c.id, 0);
    expect(received.messages).toHaveLength(1);
    expect(received.conversation.deadline).toBe(f.clock.now + 600);
    const originalDeadline = received.conversation.deadline!;
    const reply = await envelope(f.c, f.b, f.a.agent, f.clock.now, 1, first.payload.id);
    await mail.send(f.b.agent.id, reply, 'reply-message');
    expect((await mail.inbox(f.a.agent.id, f.c.id, 0)).messages[0].id).toBe(reply.payload.id);
    const repeated = await mail.send(f.b.agent.id, reply, 'reply-message');
    expect(repeated.status).toBe('already_accepted');
    expect((await f.h.conversation(f.c.id)).message_count).toBe(2);
    f.clock.now = originalDeadline;
    await expect(
      mail.send(
        f.a.agent.id,
        await envelope(f.c, f.a, f.b.agent, f.clock.now, 2, reply.payload.id),
        'too-late-message',
      ),
    ).rejects.toMatchObject({ code: 'conversation_closed' });
    expect((await f.h.conversation(f.c.id)).deadline).toBe(originalDeadline);
    await expect(
      f.h.connection
        .prepare('UPDATE conversations SET deadline=deadline+1 WHERE id=?')
        .bind(f.c.id)
        .run(),
    ).rejects.toThrow(/clock cannot/);
  });

  it('does not authorize with one owner signature or before both endpoint preflights', async () => {
    const f = await fixture({ ready: false }),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    await expect(mail.send(f.a.agent.id, first, 'not-authorized')).rejects.toMatchObject({
      code: 'message_state_conflict',
    });
    await expect(
      f.h.approveConversation(
        f.bob.id,
        f.c.id,
        await signPayload(f.alice.key.privateKey, f.c.policy),
      ),
    ).rejects.toMatchObject({ code: 'invalid_owner_signature' });
    await f.h.approveConversation(
      f.bob.id,
      f.c.id,
      await signPayload(f.bob.key.privateKey, f.c.policy),
    );
    await expect(mail.send(f.a.agent.id, first, 'not-ready-yet')).rejects.toMatchObject({
      code: 'message_state_conflict',
    });
    const state = await f.h.endpointState(f.a.agent.id),
      r = state.readiness.find((r: Record<string, unknown>) => r.conversation_id === f.c.id)!;
    const proof = {
      v: PROTOCOL_VERSION,
      kind: 'session-preflight',
      conversation_id: f.c.id,
      agent_id: f.a.agent.id,
      grant_hash: f.c.policy_hash,
      nonce: r.nonce,
    };
    await f.h.preflight(f.a.agent.id, f.c.id, await signPayload(f.a.key.privateKey, proof), {
      kind: 'test-endpoint',
    });
    await expect(mail.send(f.a.agent.id, first, 'only-one-ready')).rejects.toMatchObject({
      code: 'message_state_conflict',
    });
  });

  it('rejects third-owner reads, wrong claim signatures and same-owner pairing', async () => {
    const f = await fixture(),
      eve = await seedOwner('Eve');
    await expect(f.h.agent(f.a.agent.id, eve.id)).rejects.toMatchObject({
      code: 'agent_not_found',
    });
    await expect(f.h.conversation(f.c.id, eve.id)).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
    await expect(f.h.pair(f.pair.id, eve.id)).rejects.toMatchObject({ code: 'pairing_not_found' });
    const invite = await f.h.createPairing(f.alice.id, f.a.agent.id),
      token = new URL(invite.invite_url).hash.slice(8);
    await expect(f.h.joinPairing(f.alice.id, token, f.a.agent.id)).rejects.toMatchObject({
      code: 'independent_owner_required',
    });
    await expect(
      f.h.ownerClaim(f.bob.id, f.a.agent.id, await signPayload(f.bob.key.privateKey, {})),
    ).rejects.toMatchObject({ code: 'agent_not_found' });
  });

  it('deduplicates concurrent identical requests and rejects changed idempotent content', async () => {
    const f = await fixture(),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    const replies = await Promise.all([
      mail.send(f.a.agent.id, first, 'same-intent'),
      mail.send(f.a.agent.id, first, 'same-intent'),
    ]);
    expect(replies.filter((x) => x.status === 'accepted')).toHaveLength(1);
    expect((await f.h.conversation(f.c.id)).message_count).toBe(1);
    const changed = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await expect(mail.send(f.a.agent.id, changed, 'same-intent')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('enforces exact reply chain, fixed recipient and quota under storage transactions', async () => {
    const f = await fixture({ maxMessages: 2 }),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    const wrong = { ...first, payload: { ...first.payload, to: f.a.agent.id } };
    wrong.signature = await signPayload(f.a.key.privateKey, wrong.payload);
    await expect(mail.send(f.a.agent.id, wrong, 'wrong-recipient')).rejects.toMatchObject({
      code: 'recipient_mismatch',
    });
    await mail.send(f.a.agent.id, first, 'first-quota');
    await mail.inbox(f.b.agent.id, f.c.id, 0);
    const bad = await envelope(f.c, f.b, f.a.agent, f.clock.now, 1, crypto.randomUUID());
    await expect(mail.send(f.b.agent.id, bad, 'wrong-reply')).rejects.toMatchObject({
      code: 'message_state_conflict',
    });
    const reply = await envelope(f.c, f.b, f.a.agent, f.clock.now, 1, first.payload.id);
    await mail.send(f.b.agent.id, reply, 'last-quota');
    expect((await f.h.conversation(f.c.id)).status).toBe('closed');
    expect((await mail.inbox(f.a.agent.id, f.c.id, 0)).messages).toHaveLength(1);
    await expect(
      mail.send(
        f.a.agent.id,
        await envelope(f.c, f.a, f.b.agent, f.clock.now, 2, reply.payload.id),
        'over-quota',
      ),
    ).rejects.toMatchObject({ code: 'conversation_closed' });
  });

  it('revocation prevents new send and delivery, including old credentials and old grants', async () => {
    const f = await fixture(),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await mail.send(f.a.agent.id, first, 'before-revocation');
    await f.h.revokePairing(f.alice.id, f.pair.id);
    await expect(mail.inbox(f.b.agent.id, f.c.id, 0)).rejects.toMatchObject({
      code: 'conversation_revoked',
    });
    await expect(
      mail.send(
        f.b.agent.id,
        await envelope(f.c, f.b, f.a.agent, f.clock.now, 1, first.payload.id),
        'after-revocation',
      ),
    ).rejects.toMatchObject({ code: 'pairing_revoked' });
    await expect(
      f.h.approveConversation(
        f.bob.id,
        f.c.id,
        await signPayload(f.bob.key.privateKey, f.c.policy),
      ),
    ).rejects.toMatchObject({ code: 'conversation_not_approvable' });
  });

  it('forbids plaintext fields, invalid signatures, changed endpoint identities and audit edits', async () => {
    const f = await fixture(),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await expect(
      mail.send(f.a.agent.id, { ...first, text: 'not allowed' }, 'plaintext-field'),
    ).rejects.toThrow();
    const evil = await keyPair();
    await expect(
      mail.send(
        f.a.agent.id,
        { ...first, signature: await signPayload(evil.privateKey, first.payload) },
        'forged-signature',
      ),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(
      f.h.connection
        .prepare('UPDATE agents SET signing_key=? WHERE id=?')
        .bind(evil.publicKey, f.a.agent.id)
        .run(),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      f.h.connection
        .prepare("UPDATE audit_events SET event_type='forged' WHERE entity_id=?")
        .bind(f.a.agent.id)
        .run(),
    ).rejects.toThrow(/append-only/);
    const rows = await f.h.connection
      .prepare('SELECT envelope_json FROM messages WHERE conversation_id=?')
      .bind(f.c.id)
      .all();
    expect(rows.results).toHaveLength(0);
  });

  it('requires authenticated browser sessions, same-origin and CSRF for owner actions', async () => {
    const alice = await seedOwner('Carol');
    const request = (headers: Record<string, string>) =>
      workers.default.fetch('http://localhost:8789/api/agents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform: 'dot', label: 'Owner-controlled Dot' }),
      });
    expect((await request({ 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await request(ownerHeaders(alice, false))).status).toBe(403);
    expect(
      (await request({ ...ownerHeaders(alice), Origin: 'https://attacker.example' })).status,
    ).toBe(403);
    expect((await request(ownerHeaders(alice))).status).toBe(201);
    const other = await seedOwner('Dana');
    const own = await workers.default.fetch('http://localhost:8789/api/dashboard', {
        headers: ownerHeaders(alice),
      }),
      unrelated = await workers.default.fetch('http://localhost:8789/api/dashboard', {
        headers: ownerHeaders(other),
      });
    expect((await own.json<{ agents: unknown[] }>()).agents).toHaveLength(1);
    expect((await unrelated.json<{ agents: unknown[] }>()).agents).toHaveLength(0);
  });

  it('permits only one open conversation for a pair under concurrent proposals', async () => {
    const f = await fixture();
    await f.h.closeConversation(f.c.id, { owner: f.alice.id });
    const results = await Promise.allSettled([
      f.h.createConversation(f.alice.id, f.pair.id),
      f.h.createConversation(f.bob.id, f.pair.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const row = await f.h.connection
      .prepare(
        "SELECT COUNT(*) AS n FROM conversations WHERE pairing_id=? AND status='awaiting_approval'",
      )
      .bind(f.pair.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('the owner signer rejects inconsistent fingerprints and broadened policies', async () => {
    const f = await fixture(),
      detail = await f.h.agentDetail(f.alice.id, f.a.agent.id);
    await expect(
      validateOwnerPayload(f.alice.id, f.alice.key.publicKey, detail.claim_payload),
    ).resolves.toBeUndefined();
    await expect(
      validateOwnerPayload(f.alice.id, f.alice.key.publicKey, {
        ...detail.claim_payload,
        fingerprint: '0'.repeat(64),
      }),
    ).rejects.toThrow(/公钥不一致/);
    await expect(
      validateOwnerPayload(f.alice.id, f.alice.key.publicKey, {
        ...f.c.policy,
        duration_seconds: 601,
      }),
    ).rejects.toThrow();
    await expect(
      validateOwnerPayload(f.alice.id, f.alice.key.publicKey, {
        ...f.c.policy,
        scope: 'private-files',
      }),
    ).rejects.toThrow();
  });

  it('closes the post-deadline receipt window without extending the session', async () => {
    const f = await fixture(),
      mail = new Mailbox(f.h),
      first = await envelope(f.c, f.a, f.b.agent, f.clock.now);
    await mail.send(f.a.agent.id, first, 'receipt-window');
    await mail.inbox(f.b.agent.id, f.c.id, 0);
    const p = {
      v: PROTOCOL_VERSION,
      kind: 'message-receipt',
      conversation_id: f.c.id,
      message_id: first.payload.id,
      receiver_id: f.b.agent.id,
      envelope_hash: await fingerprint(first),
      decrypted: true,
    };
    f.clock.now += 901;
    await expect(
      mail.acknowledge(f.b.agent.id, {
        payload: p,
        signature: await signPayload(f.b.key.privateKey, p),
      }),
    ).rejects.toMatchObject({ code: 'receipt_window_closed' });
    expect((await mail.inbox(f.b.agent.id, f.c.id, 0)).messages).toHaveLength(0);
  });
});
