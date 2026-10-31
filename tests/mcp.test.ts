import { describe, expect, it, vi } from 'vitest';
import { handleMcp } from '../src/server/mcp';
import { ChatService } from '../src/server/chat';
import { sha256 } from '../src/shared/crypto';
import { friends } from './helpers';
import { env } from './runtime';

type Lane = 'legacy' | 'header' | 'metadata';
function client(
  props: { ownerId: string; agentId: string; authVersion: number },
  scope: string[] = ['agent:read', 'agent:message'],
  lane: Lane = 'legacy',
) {
  const context = {
    props,
    auth: { scope, token: 'test', clientId: 'test', audience: 'http://localhost:8789/mcp' },
  } as unknown as Parameters<typeof handleMcp>[2];
  /** Posts a raw body (a string is sent as is) and reads the reply, which may be empty. */
  const post = async (body: unknown) => {
    const response = await handleMcp(
      new Request('http://localhost:8789/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(lane === 'header' ? { 'MCP-Protocol-Version': '2026-07-28' } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env as Parameters<typeof handleMcp>[1],
      context,
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text ? JSON.parse(text) : null) as Record<string, any>,
    };
  };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    post({
      jsonrpc: '2.0',
      id: 'r1',
      method,
      params: {
        ...params,
        ...(lane === 'metadata'
          ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }
          : {}),
      },
    });
  return Object.assign(call, { post });
}
const tool = (call: ReturnType<typeof client>, name: string, args: Record<string, unknown> = {}) =>
  call('tools/call', { name, arguments: args }).then((r) => r.body.result);

describe('Agent MCP surface', () => {
  it.each(['legacy', 'header', 'metadata'] as const)(
    'exposes exactly four tools (%s protocol lane)',
    async (lane) => {
      const f = await friends();
      const call = client(
        { ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version },
        undefined,
        lane,
      );
      const listed = await call('tools/list');
      expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
        'hub_whoami',
        'hub_chats',
        'hub_inbox',
        'hub_send',
      ]);
      expect(listed.body.result.resultType).toBe(lane === 'legacy' ? undefined : 'complete');
      const whoami = await tool(call, 'hub_whoami');
      expect(whoami.structuredContent).toMatchObject({ agent_id: f.a.id, owner_name: 'Alice' });
      expect((await f.chats.dashboard(f.alice.id)).agents[0].connection).toBe('online');
    },
  );

  it('chats, sends, delivers and replays through the tools', async () => {
    const f = await friends();
    const alice = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    const bob = client({ ownerId: f.bob.id, agentId: f.b.id, authVersion: f.b.auth_version });
    const chats = (await tool(alice, 'hub_chats')).structuredContent;
    expect(chats.chats[0]).toMatchObject({
      chat_id: f.chatId,
      send_mode: 'direct',
      can_send: true,
    });
    expect(chats.review_url).toBe('http://localhost:8789/review');
    const args = { chat_id: f.chatId, text: '你好 Bob', idempotency_key: 'first-message-1' };
    const sent = (await tool(alice, 'hub_send', args)).structuredContent;
    expect(sent.status).toBe('sent');
    expect((await tool(alice, 'hub_send', args)).structuredContent).toEqual(sent);
    const inbox = (await tool(bob, 'hub_inbox')).structuredContent;
    expect(inbox.messages[0]).toMatchObject({
      text: '你好 Bob',
      untrusted: true,
      mentions_me: false,
    });
    expect(inbox.untrusted_notice).toContain('untrusted');
    expect((await tool(bob, 'hub_inbox')).structuredContent.messages).toHaveLength(0);
    const history = (await tool(bob, 'hub_inbox', { chat_id: f.chatId, after_seq: 0 }))
      .structuredContent;
    expect(history.messages).toHaveLength(1);
  });

  it('enforces scopes, argument formats and live connection state', async () => {
    const f = await friends();
    const props = { ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version };
    const readOnly = client(props, ['agent:read']);
    const denied = await readOnly('tools/call', {
      name: 'hub_send',
      arguments: { chat_id: f.chatId, text: 'x', idempotency_key: 'scope-check-1' },
    });
    expect(denied.status).toBe(403);
    const bad = await tool(client(props), 'hub_send', {
      chat_id: f.chatId,
      text: '',
      idempotency_key: 'k',
    });
    expect(bad.isError).toBe(true);
    const tooLong = await tool(client(props), 'hub_send', {
      chat_id: f.chatId,
      text: 'x'.repeat(4001),
      idempotency_key: 'long-text-1',
    });
    expect(tooLong.isError).toBe(true);
    await f.chats.resetConnection(f.alice.id, f.a.id);
    const revoked = await client(props)('tools/list');
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe('invalid_token');
    expect(revoked.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="OAuth", error="invalid_token", resource_metadata="http://localhost:8789/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('ends a hub_inbox take with the 401 challenge when the connection is reset mid-call', async () => {
    const f = await friends();
    const alice = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    await f.chats.ownerSend(f.bob.id, f.chatId, '重置之后');
    // The request-start check passes on the old row; the reset lands while the take runs.
    const before = await f.chats.agent(f.a.id);
    await f.chats.resetConnection(f.alice.id, f.a.id);
    const spy = vi.spyOn(ChatService.prototype, 'agent').mockResolvedValueOnce(before);
    const taken = await alice('tools/call', { name: 'hub_inbox', arguments: {} });
    spy.mockRestore();
    expect(taken.status).toBe(401);
    expect(taken.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    // Nothing was consumed for the revoked token: the reconnected Agent still gets it.
    expect((await f.chats.inboxTake(f.a.id)).messages.map((m) => m.text)).toEqual(['重置之后']);
  });

  it('answers malformed JSON-RPC with JSON-RPC errors', async () => {
    const f = await friends();
    const call = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    const parse = await call.post('{"jsonrpc":');
    expect(parse.status).toBe(400);
    expect(parse.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    for (const body of ['"tools/list"', { jsonrpc: '1.0', id: 1, method: 'tools/list' }]) {
      const invalid = await call.post(body);
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ id: null, error: { code: -32600 } });
    }
    const params = await call.post({ jsonrpc: '2.0', id: 9, method: 'tools/call' });
    expect(params.status).toBe(200);
    expect(params.body).toMatchObject({ id: 9, error: { code: -32602 } });
  });

  it('answers ping on the 2025-03-26 lane', async () => {
    const f = await friends();
    const call = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    expect((await call('ping')).body).toEqual({ jsonrpc: '2.0', id: 'r1', result: {} });
  });

  it('accepts JSON-RPC batches on the 2025-03-26 lane only, one rate-limit slot per message', async () => {
    const f = await friends();
    const props = { ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version };
    const call = client(props);
    const batch = await call.post([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hub_whoami' } },
      'not a message',
    ]);
    expect(batch.status).toBe(200);
    expect(batch.body.map((r: { id: unknown }) => r.id)).toEqual([2, 3, 4, null]);
    expect(batch.body[0].result.tools).toHaveLength(4);
    expect(batch.body[2].result.structuredContent.agent_id).toBe(f.a.id);
    expect(batch.body[3].error.code).toBe(-32600);
    const used = await env.DB.prepare('SELECT SUM(count) AS n FROM rate_limits WHERE key_hash=?')
      .bind(await sha256(`mcp:${f.a.id}`))
      .first<{ n: number }>();
    expect(used?.n).toBe(5);
    const notifications = await call.post([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(notifications.status).toBe(202);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    for (const rejected of [
      await call.post([]),
      await call.post(Array(21).fill(ping)),
      await client(props, undefined, 'header').post([ping]),
    ]) {
      expect(rejected.status).toBe(400);
      expect(rejected.body).toMatchObject({ id: null, error: { code: -32600 } });
    }
    const readOnly = await client(props, ['agent:read']).post([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hub_inbox', arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hub_send',
          arguments: { chat_id: f.chatId, text: 'x', idempotency_key: 'batch-scope-1' },
        },
      },
    ]);
    expect(readOnly.status).toBe(403);
  });

  it('batched takes do not long-poll, and a reset mid-batch keeps replies already taken', async () => {
    const f = await friends();
    const call = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    await f.chats.ownerSend(f.bob.id, f.chatId, '批量之前');
    const take = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'hub_inbox', arguments: {} },
    });
    const inboxTake = ChatService.prototype.inboxTake;
    const spy = vi.spyOn(ChatService.prototype, 'inboxTake').mockImplementationOnce(async function (
      this: ChatService,
      ...args
    ) {
      const taken = await inboxTake.apply(this, args);
      await f.chats.resetConnection(f.alice.id, f.a.id);
      return taken;
    });
    const batch = await call.post([take(1), take(2), take(3)]);
    expect(spy.mock.calls[0][3]).toBe(0);
    spy.mockRestore();
    expect(batch.status).toBe(200);
    expect(
      batch.body[0].result.structuredContent.messages.map((m: { text: string }) => m.text),
    ).toEqual(['批量之前']);
    expect(batch.body.slice(1)).toMatchObject([
      { id: 2, error: { code: -32001 } },
      { id: 3, error: { code: -32001 } },
    ]);
  });

  it('answers the rate limit with a JSON-RPC 429 instead of throwing', async () => {
    const f = await friends();
    const call = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    const bucket = Math.floor(Date.now() / 60_000);
    for (const b of [bucket, bucket + 1])
      await env.DB.prepare(
        'INSERT INTO rate_limits(key_hash,bucket,count,expires_at) VALUES(?,?,120,?)',
      )
        .bind(await sha256(`mcp:${f.a.id}`), b, (b + 2) * 60)
        .run();
    const limited = await call('ping');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.body).toMatchObject({ id: null, error: { code: -32000 } });
  });
});
