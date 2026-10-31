import { describe, expect, it } from 'vitest';
import { handleMcp } from '../src/server/mcp';
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
  return async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handleMcp(
      new Request('http://localhost:8789/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(lane === 'header' ? { 'MCP-Protocol-Version': '2026-07-28' } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'r1',
          method,
          params: {
            ...params,
            ...(lane === 'metadata'
              ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }
              : {}),
          },
        }),
      }),
      env as Parameters<typeof handleMcp>[1],
      context,
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
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

  it('chats, sends for review, delivers and replays through the tools', async () => {
    const f = await friends();
    const alice = client({ ownerId: f.alice.id, agentId: f.a.id, authVersion: f.a.auth_version });
    const bob = client({ ownerId: f.bob.id, agentId: f.b.id, authVersion: f.b.auth_version });
    const chats = (await tool(alice, 'hub_chats')).structuredContent;
    expect(chats.chats[0]).toMatchObject({
      chat_id: f.chatId,
      send_mode: 'review',
      can_send: true,
    });
    expect(chats.review_url).toBe('http://localhost:8789/review');
    const args = { chat_id: f.chatId, text: '你好 Bob', idempotency_key: 'first-message-1' };
    const sent = (await tool(alice, 'hub_send', args)).structuredContent;
    expect(sent.status).toBe('pending_review');
    expect((await tool(alice, 'hub_send', args)).structuredContent).toEqual(sent);
    expect((await tool(alice, 'hub_chats')).structuredContent.owner_pending).toBe(1);
    await f.chats.approveDraft(f.alice.id, sent.draft_id);
    const inbox = (await tool(bob, 'hub_inbox')).structuredContent;
    expect(inbox.messages[0]).toMatchObject({ text: '你好 Bob', untrusted: true });
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
    await expect(client(props)('tools/list')).rejects.toMatchObject({ code: 'connection_revoked' });
  });
});
