import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { handleMcp } from '../src/server/mcp';
import { fixture } from './helpers';
import { env } from './runtime';

const completeResult = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.literal('request-1'),
  result: z.object({ resultType: z.literal('complete') }).passthrough(),
});

describe('MCP response revision compatibility', () => {
  it.each(['header', 'metadata'] as const)(
    'completes modern tool, discovery and event results using %s version negotiation',
    async (lane) => {
      const f = await fixture({ ready: false });
      const context = {
        props: { ownerId: f.alice.id, agentId: f.a.agent.id, authVersion: f.a.agent.auth_version },
        auth: { scope: ['agent:read'] },
      } as unknown as Parameters<typeof handleMcp>[2];
      const call = (method: string, params: Record<string, unknown> = {}) =>
        handleMcp(
          new Request('http://localhost:8789/mcp', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(lane === 'header' ? { 'MCP-Protocol-Version': '2026-07-28' } : {}),
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'request-1',
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
      for (const method of ['server/discover', 'tools/list', 'events/list']) {
        const response = await call(method);
        expect(response.status).toBe(200);
        completeResult.parse(await response.json());
      }
      const identity = completeResult.parse(
        await (await call('tools/call', { name: 'hub_identity', arguments: {} })).json(),
      );
      expect(identity.result.structuredContent).toMatchObject({ agent_id: f.a.agent.id });
      const invalid = completeResult.parse(
        await (
          await call('tools/call', {
            name: 'hub_receiver_heartbeat',
            arguments: { kind: 'invalid', taskReference: 'test-receiver' },
          })
        ).json(),
      );
      expect(invalid.result.isError).toBe(true);
      expect(invalid.result.structuredContent).toMatchObject({ error: 'invalid_arguments' });
      const unknown = await (await call('unsupported/method')).json();
      expect(unknown).toHaveProperty('error.code', -32601);
      expect(unknown).not.toHaveProperty('result');
    },
  );

  it('preserves legacy results and empty notification acknowledgments', async () => {
    const f = await fixture({ ready: false });
    const context = {
      props: { ownerId: f.alice.id, agentId: f.a.agent.id, authVersion: f.a.agent.auth_version },
      auth: { scope: ['agent:read'] },
    } as unknown as Parameters<typeof handleMcp>[2];
    const call = (body: unknown) =>
      handleMcp(
        new Request('http://localhost:8789/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-03-26' },
          body: JSON.stringify(body),
        }),
        env as Parameters<typeof handleMcp>[1],
        context,
      );
    const identity = await (
      await call({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hub_identity', arguments: {} },
      })
    ).json();
    expect(identity).toHaveProperty('result.structuredContent.agent_id', f.a.agent.id);
    expect(identity).not.toHaveProperty('result.resultType');
    const notification = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
  });
});
