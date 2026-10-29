import { describe, expect, it } from 'vitest';
import { fixture, registeredAgent, seedOwner } from './helpers';
import { signPayload } from '../src/shared/crypto';

describe('invitation metadata for the owner App and addressed Agent', () => {
  it('exposes the same request after the sender signs, without granting or delivering a chat', async () => {
    const f = await fixture({ ready: false });
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toEqual([]);
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    const inbox = await f.h.pendingRequests(f.b.agent.id);
    expect(inbox.requires_owner_approval).toBe(true);
    expect(inbox.execution_permission_granted).toBe(false);
    expect(inbox.requests).toHaveLength(1);
    expect(inbox.requests[0]).toMatchObject({
      id: f.c.id,
      kind: 'conversation-invitation',
      from: { agent_id: f.a.agent.id, owner_name: 'Alice', platform: 'dot' },
      scope: 'public-qa',
      duration_seconds: 600,
      max_messages: 40,
      review_url: `http://localhost:8789/sessions/${f.c.id}`,
    });
    expect(inbox.requests[0]).not.toHaveProperty('policy');
    expect(inbox.requests[0]).not.toHaveProperty('approvals');
    expect(inbox.requests[0]).not.toHaveProperty('envelope');
    const app = await f.h.dashboard(f.bob.id);
    expect(app.conversations.some((c) => c.id === inbox.requests[0].id)).toBe(true);
    expect((await f.h.endpointState(f.b.agent.id)).conversations).toEqual([]);
    await f.h.pendingRequests(f.b.agent.id);
    expect(await f.h.conversation(f.c.id)).toMatchObject({
      status: 'awaiting_approval',
      started_at: null,
      deadline: null,
      message_count: 0,
    });
  });

  it('isolates requests to the addressed connection, including other Agents of the same owner', async () => {
    const f = await fixture({ ready: false });
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    const other = await registeredAgent(f.h, await seedOwner('Unrelated'), 'muse');
    const sibling = await registeredAgent(f.h, f.bob, 'muse');
    expect((await f.h.pendingRequests(other.agent.id)).requests).toEqual([]);
    expect((await f.h.pendingRequests(sibling.agent.id)).requests).toEqual([]);
    expect((await f.h.pendingRequests(f.a.agent.id)).requests).toEqual([]);
  });

  it('removes an invitation from the Agent inbox when the owner accepts it in the App', async () => {
    const f = await fixture({ ready: false });
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toHaveLength(1);
    await f.h.approveConversation(
      f.bob.id,
      f.c.id,
      await signPayload(f.bob.key.privateKey, f.c.policy),
    );
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toEqual([]);
    expect(await f.h.conversation(f.c.id)).toMatchObject({
      status: 'authorized',
      started_at: null,
      deadline: null,
      message_count: 0,
    });
  });

  it('does not return expired or revoked invitations', async () => {
    const f = await fixture({ ready: false });
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    f.clock.now += 1801;
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toEqual([]);
    f.clock.now -= 1801;
    await f.h.revokePairing(f.alice.id, f.pair.id);
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toEqual([]);
    await f.h.revokeAgent(f.bob.id, f.b.agent.id);
    await expect(f.h.pendingRequests(f.b.agent.id)).rejects.toMatchObject({
      code: 'agent_not_ready',
    });
  });

  it('routes invitations in the reverse direction and removes a declined request', async () => {
    const f = await fixture({ ready: false });
    await f.h.closeConversation(f.c.id, { owner: f.alice.id });
    const reverse = await f.h.createConversation(f.bob.id, f.pair.id);
    await f.h.approveConversation(
      f.bob.id,
      reverse.id,
      await signPayload(f.bob.key.privateKey, reverse.policy),
    );
    expect((await f.h.pendingRequests(f.a.agent.id)).requests[0]).toMatchObject({
      id: reverse.id,
      from: { agent_id: f.b.agent.id, platform: 'muse' },
    });
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toEqual([]);
    await f.h.closeConversation(reverse.id, { owner: f.alice.id }, 'owner-declined');
    expect((await f.h.pendingRequests(f.a.agent.id)).requests).toEqual([]);
  });

  it('hides invitations from a disabled sender account', async () => {
    const f = await fixture({ ready: false });
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    await f.h.connection
      .prepare('UPDATE users SET disabled_at=? WHERE id=?')
      .bind(f.clock.now, f.alice.id)
      .run();
    expect((await f.h.pendingRequests(f.b.agent.id)).requests).toEqual([]);
  });
});
