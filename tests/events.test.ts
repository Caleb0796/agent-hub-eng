import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { fixture } from './helpers';
import { env } from './runtime';
import { signPayload } from '../src/shared/crypto';
import { CallbackEndpointError, NativeEvents as RuntimeEvents } from '../src/server/events';
import { webhookUrl } from '../src/server/public-fetch';
import { handleMcp } from '../src/server/mcp';

class NativeEvents extends RuntimeEvents {
  constructor(hub: Awaited<ReturnType<typeof fixture>>['h'], send: typeof transport) {
    super(hub, send, async () => true);
  }
  subscribe(agentId: string, raw: unknown) {
    return super.subscribe(agentId, raw, { id: 'unit-grant', clientId: 'unit-client' });
  }
  unsubscribe(agentId: string, raw: unknown) {
    return super.unsubscribe(agentId, raw, 'unit-grant');
  }
}
const transport = vi.hoisted(() => vi.fn());
const secret = () =>
  `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
const input = (name = 'hub.request.created', key = secret()) => ({
  name,
  arguments: {},
  delivery: { mode: 'webhook', url: 'https://callbacks.example/events/one', secret: key },
});
const deliveries = () =>
  transport.mock.calls.filter(([, init]) => JSON.parse(init.body).type !== 'verification');
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM event_deliveries').run();
  await env.DB.prepare('DELETE FROM event_subscriptions').run();
  transport.mockReset();
  transport.mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    return body.type === 'verification'
      ? Response.json({ challenge: body.challenge })
      : new Response(null, { status: 202 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('native MCP event subscriptions', () => {
  it('does not reactivate an unsubscribed callback while verification is in flight', async () => {
    const f = await fixture(),
      events = new NativeEvents(f.h, transport),
      request = input();
    let release: (() => void) | undefined;
    transport.mockImplementationOnce(
      (_url, init) =>
        new Promise((resolve) => {
          release = () => resolve(Response.json({ challenge: JSON.parse(init.body).challenge }));
        }),
    );
    const pending = events.subscribe(f.a.agent.id, request);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await events.unsubscribe(f.a.agent.id, {
      name: request.name,
      arguments: {},
      delivery: { mode: 'webhook', url: request.delivery.url },
    });
    release!();
    await expect(pending).rejects.toMatchObject({ code: 'subscription_cancelled' });
    await events.flush();
    expect(deliveries()).toEqual([]);
  });

  it('leases concurrent publishers so one event is dispatched once', async () => {
    const f = await fixture(),
      events = new NativeEvents(f.h, transport);
    await events.subscribe(f.a.agent.id, input('hub.session.authorized'));
    await Promise.all([events.flush(), events.flush()]);
    expect(deliveries()).toHaveLength(1);
  });
  it('verifies the receiver, advertises native events, and does not disclose callback secrets', async () => {
    const f = await fixture({ ready: false }),
      events = new NativeEvents(f.h, transport),
      request = input();
    const sub = await events.subscribe(f.b.agent.id, request);
    expect(new Date(sub.refreshBefore).getTime()).toBe((f.clock.now + 3600) * 1000);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(request.delivery.url);
    expect(new Webhook(request.delivery.secret).verify(init.body, init.headers)).toHaveProperty(
      'type',
      'verification',
    );
    expect(JSON.stringify(sub)).not.toContain(request.delivery.secret);
    const context = {
      props: { ownerId: f.bob.id, agentId: f.b.agent.id, authVersion: f.b.agent.auth_version },
      auth: { scope: ['agent:read'], clientId: 'unit-client' },
    } as unknown as Parameters<typeof handleMcp>[2];
    const call = (method: string, params?: unknown) =>
      handleMcp(
        new Request('http://localhost:8789/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
        {
          ...env,
          OAUTH_PROVIDER: {
            unwrapToken: async () => ({
              userId: f.b.agent.id,
              grant: { clientId: 'unit-client' },
              grantId: 'unit-grant',
            }),
          },
        } as unknown as Parameters<typeof handleMcp>[1],
        context,
      );
    expect(
      (
        (await (await call('server/discover')).json()) as {
          result: { capabilities: { events: unknown } };
        }
      ).result.capabilities.events,
    ).toEqual({});
    expect(
      ((await (await call('events/list')).json()) as { result: { events: unknown[] } }).result
        .events,
    ).toHaveLength(2);
    const bad = await (
      await call('events/subscribe', {
        ...request,
        delivery: { ...request.delivery, url: 'http://127.0.0.1/' },
      })
    ).json();
    expect((bad as { error: unknown }).error).toMatchObject({
      code: -32015,
      data: { reason: 'invalid_url' },
    });
    expect(JSON.stringify(bad)).not.toContain(request.delivery.secret);
  });

  it('requires an echoed challenge and blocks unsafe callback addresses before any request', async () => {
    const f = await fixture(),
      events = new NativeEvents(f.h, transport);
    for (const url of [
      'http://public.example/',
      'https://127.0.0.1/',
      'https://2130706433/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://user:pass@public.example/',
      'https://public.example:444/',
      'https://localhost/',
    ]) {
      expect(() => webhookUrl(url)).toThrow();
      await expect(
        events.subscribe(f.a.agent.id, { ...input(), delivery: { ...input().delivery, url } }),
      ).rejects.toBeInstanceOf(CallbackEndpointError);
    }
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValue(Response.json({ challenge: 'wrong' }));
    await expect(events.subscribe(f.a.agent.id, input())).rejects.toMatchObject({
      reason: 'challenge_failed',
    });
    expect((await env.DB.prepare('SELECT * FROM event_subscriptions').all()).results).toEqual([]);
  });

  it('delivers a pending request only to its addressed Agent, with stable retry IDs and no chat start', async () => {
    const f = await fixture({ ready: false }),
      events = new NativeEvents(f.h, transport);
    const receiver = input(),
      sub = await events.subscribe(f.b.agent.id, receiver);
    await events.subscribe(f.a.agent.id, {
      ...input(),
      delivery: { ...input().delivery, url: 'https://callbacks.example/sender' },
    });
    await events.flush();
    expect(deliveries()).toHaveLength(0);
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    transport.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await events.flush();
    f.clock.now += 3;
    await events.flush();
    const sent = deliveries();
    expect(sent).toHaveLength(2);
    expect(sent[0][1].headers['webhook-id']).toBe(sent[1][1].headers['webhook-id']);
    expect(sent[1][1].headers['webhook-timestamp']).not.toBe(
      sent[0][1].headers['webhook-timestamp'],
    );
    expect(sent[1][1].headers['X-MCP-Subscription-Id']).toBe(sub.id);
    const body = new Webhook(receiver.delivery.secret).verify(
      sent[1][1].body,
      sent[1][1].headers,
    ) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      conversation_id: f.c.id,
      recipient_agent_id: f.b.agent.id,
      duration_seconds: 600,
      max_messages: 40,
    });
    expect(body.data).not.toHaveProperty('approvals');
    expect(body.data).not.toHaveProperty('ciphertext');
    await events.flush();
    expect(deliveries()).toHaveLength(2);
    expect(await f.h.conversation(f.c.id)).toMatchObject({
      started_at: null,
      deadline: null,
      message_count: 0,
      status: 'awaiting_approval',
    });
  });

  it('stops stale invitations after acceptance and emits authorization only after both signatures', async () => {
    const f = await fixture({ ready: false }),
      events = new NativeEvents(f.h, transport);
    await events.subscribe(f.b.agent.id, input());
    await events.subscribe(f.b.agent.id, input('hub.session.authorized'));
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    transport.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await events.flush();
    await f.h.approveConversation(
      f.bob.id,
      f.c.id,
      await signPayload(f.bob.key.privateKey, f.c.policy),
    );
    f.clock.now += 3;
    await events.flush();
    expect(deliveries().map(([, init]) => JSON.parse(init.body).name)).toEqual([
      'hub.request.created',
      'hub.session.authorized',
    ]);
    expect((await f.h.conversation(f.c.id)).status).toBe('authorized');
  });

  it('caches verification for a bounded period and rotates secrets on the same subscription', async () => {
    const f = await fixture({ ready: false }),
      events = new NativeEvents(f.h, transport),
      request = input();
    const first = await events.subscribe(f.b.agent.id, request);
    f.clock.now += 100;
    expect((await events.subscribe(f.b.agent.id, request)).id).toBe(first.id);
    expect(transport).toHaveBeenCalledTimes(1);
    f.clock.now += 201;
    await events.subscribe(f.b.agent.id, request);
    expect(transport).toHaveBeenCalledTimes(2);
    const newKey = secret();
    expect(
      (
        await events.subscribe(f.b.agent.id, {
          ...request,
          delivery: { ...request.delivery, secret: newKey },
        })
      ).id,
    ).toBe(first.id);
    await events.subscribe(f.b.agent.id, {
      ...request,
      delivery: { ...request.delivery, secret: newKey },
    });
    await f.h.approveConversation(
      f.alice.id,
      f.c.id,
      await signPayload(f.alice.key.privateKey, f.c.policy),
    );
    await events.flush();
    vi.spyOn(Date, 'now').mockReturnValue(f.clock.now * 1000);
    const [, sent] = deliveries()[0];
    expect(new Webhook(newKey).verify(sent.body, sent.headers)).toHaveProperty('eventId');
    expect(new Webhook(request.delivery.secret).verify(sent.body, sent.headers)).toHaveProperty(
      'eventId',
    );
  });

  it('makes unsubscribe idempotent, applies filters, and rejects foreign pairings', async () => {
    const f = await fixture(),
      other = await fixture(),
      events = new NativeEvents(f.h, transport),
      request = input();
    await expect(
      events.subscribe(f.a.agent.id, { ...request, arguments: { pairing_id: other.pair.id } }),
    ).rejects.toMatchObject({ code: 'pairing_not_found' });
    await events.subscribe(f.a.agent.id, { ...request, arguments: { pairing_id: f.pair.id } });
    await events.unsubscribe(f.a.agent.id, {
      name: request.name,
      arguments: { pairing_id: f.pair.id },
      delivery: { mode: 'webhook', url: request.delivery.url },
    });
    await events.unsubscribe(f.a.agent.id, {
      name: request.name,
      arguments: { pairing_id: f.pair.id },
      delivery: { mode: 'webhook', url: request.delivery.url },
    });
    await events.flush();
    expect(deliveries()).toEqual([]);
  });

  it('does not retry terminal callbacks or deliver after revocation or subscription expiry', async () => {
    const f = await fixture(),
      events = new NativeEvents(f.h, transport);
    await events.subscribe(f.a.agent.id, { ...input('hub.session.authorized'), ttlMs: 60_000 });
    transport.mockImplementationOnce(async () => new Response(null, { status: 413 }));
    await events.flush();
    f.clock.now += 10;
    await events.flush();
    expect(deliveries()).toHaveLength(1);
    await events.subscribe(f.b.agent.id, { ...input('hub.session.authorized'), ttlMs: 60_000 });
    f.clock.now += 61;
    await events.flush();
    expect(deliveries()).toHaveLength(1);
    await events.subscribe(f.b.agent.id, input('hub.session.authorized'));
    await f.h.revokeAgent(f.bob.id, f.b.agent.id);
    await events.flush();
    expect(deliveries()).toHaveLength(1);
  });

  it('records receiver heartbeats as expiring reports, never as permission or platform proof', async () => {
    const f = await fixture();
    expect(
      await f.h.receiverHeartbeat(f.a.agent.id, 'scheduled-task', 'native-task-1'),
    ).toMatchObject({ evidence: 'agent-reported', execution_permission_granted: false });
    expect((await f.h.dashboard(f.alice.id)).polling_receivers).toHaveLength(1);
    expect((await f.h.dashboard(f.bob.id)).polling_receivers).toHaveLength(0);
    f.clock.now += 301;
    expect((await f.h.dashboard(f.alice.id)).polling_receivers).toHaveLength(0);
  });

  it('lets only a conversation owner retry transient failures with the original event ID', async () => {
    const f = await fixture(),
      other = await fixture(),
      events = new NativeEvents(f.h, transport);
    await events.subscribe(f.a.agent.id, input('hub.session.authorized'));
    transport.mockImplementation(async () => new Response(null, { status: 503 }));
    for (let attempt = 0; attempt < 5; attempt++) {
      await events.flush();
      f.clock.now += 70;
    }
    expect(deliveries()).toHaveLength(5);
    await expect(events.retry(other.alice.id, f.c.id)).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
    expect(await events.retry(f.alice.id, f.c.id)).toEqual({ queued: 1 });
    transport.mockImplementation(async () => new Response(null, { status: 202 }));
    await events.flush();
    expect(deliveries()).toHaveLength(6);
    expect(deliveries()[5][1].headers['webhook-id']).toBe(deliveries()[0][1].headers['webhook-id']);
    expect(await f.h.conversation(f.c.id)).toMatchObject({
      started_at: null,
      deadline: null,
      message_count: 0,
    });
  });

  it('stops delivery when the OAuth grant is disconnected even while the Agent remains active', async () => {
    const f = await fixture();
    let valid = true;
    const events = new RuntimeEvents(f.h, transport, async () => valid);
    await events.subscribe(f.a.agent.id, input('hub.session.authorized'), {
      id: 'revocable-grant',
      clientId: 'unit-client',
    });
    valid = false;
    await events.flush();
    expect(deliveries()).toEqual([]);
    expect((await f.h.agent(f.a.agent.id)).status).toBe('active');
    expect((await f.h.dashboard(f.alice.id)).event_receivers).toEqual([]);
  });
});
