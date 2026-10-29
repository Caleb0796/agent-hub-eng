import { server } from './runtime';
import { describe, it, expect } from 'vitest';
import { base64url, randomToken } from '../src/shared/crypto';
import { seedOwner, ownerHeaders } from './helpers';
import { scopes } from '../src/shared/protocol';

const base = 'http://localhost:8789',
  resource = `${base}/mcp`,
  callback = 'http://localhost:45678/callback';
async function authorize(platform: 'dot' | 'muse' = 'dot', redirect = callback) {
  const callback = redirect;
  const u = await seedOwner('OAuthOwner');
  const create = await server.fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: ownerHeaders(u),
    body: JSON.stringify({ platform, label: 'Native ' + platform }),
  });
  const agent = await create.json<{ id: string }>();
  expect(create.status).toBe(201);
  const register = await server.fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Local OAuth test client',
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(register.status).toBe(201);
  const client = await register.json<{ client_id: string }>();
  const verifier = randomToken(48),
    challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: callback,
    response_type: 'code',
    resource,
    scope: Object.values(scopes).join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomToken(),
  });
  const page = await server.fetch(`${base}/authorize?${params}`, {
    headers: ownerHeaders(u),
    redirect: 'manual',
  });
  expect(page.status).toBe(200);
  const html = await page.text(),
    handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  expect(html).toContain('客户端名称由申请方提供');
  expect(html).toContain(new URL(callback).hostname);
  if (platform === 'muse') {
    expect(html).toContain('<option value="muse">');
    expect(html).not.toContain('<option value="dot">');
  }
  const cookies = page.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const form = new URLSearchParams({
    handle: handle!,
    csrf: u.csrf,
    decision: 'approve',
    agentId: agent.id,
    platform,
    label: 'Native ' + platform,
  });
  for (const scope of Object.values(scopes)) form.append('scope', scope);
  const consent = await server.fetch(`${base}/authorize`, {
    method: 'POST',
    headers: {
      Origin: base,
      Cookie: `${ownerHeaders(u).Cookie}; ${cookies}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get('Location')!);
  expect(location.origin).toBe(new URL(callback).origin);
  expect(location.searchParams.get('iss')).toBe(base);
  expect(location.searchParams.get('state')).toBe(params.get('state'));
  const code = location.searchParams.get('code')!;
  expect(code).toBeTruthy();
  const exchange = (overrides: Record<string, string> = {}) =>
    server.fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: callback,
        code,
        code_verifier: verifier,
        resource,
        ...overrides,
      }),
    });
  return { u, agent, client, exchange };
}

describe('native OAuth without copying API keys', () => {
  it('completes consent and PKCE with the native Muse callback and Muse-only choices', async () => {
    const flow = await authorize('muse', 'https://agent.meta.ai/api/hatch/oauth/callback');
    expect((await flow.exchange()).status).toBe(200);
  });

  it('accepts the observed native Muse callback and rejects neighboring Meta destinations', async () => {
    const callback = 'https://agent.meta.ai/api/hatch/oauth/callback';
    const register = (redirect: string) =>
      server.fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Muse callback compatibility',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'client_secret_basic',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });
    expect((await register(callback)).status).toBe(201);
    for (const redirect of [
      callback + '/other',
      callback + '?next=https://attacker.example',
      callback.replace('https:', 'http:'),
      callback.replace('agent.meta.ai', 'agent.meta.ai.attacker.example'),
      callback.replace('agent.meta.ai', 'other.meta.ai'),
      callback.replace('agent.meta.ai', 'agent.meta.ai:8443'),
    ])
      expect((await register(redirect)).status, redirect).toBe(400);
  });
  it('publishes protected-resource discovery and S256 support', async () => {
    const unauth = await server.fetch(resource, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    const metadata = await server.fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = await metadata.json<{
      code_challenge_methods_supported: string[];
      registration_endpoint: string;
      authorization_response_iss_parameter_supported: boolean;
    }>();
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('keeps CIMD enabled with the Node public-network policy and blocks private targets', async () => {
    const params = new URLSearchParams({
      client_id: 'https://169.254.169.254/client.json',
      redirect_uri: callback,
      response_type: 'code',
      resource,
    });
    const response = await server.fetch(`${base}/authorize?${params}`);
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe('client_metadata_unavailable');
  });

  it('completes DCR, consent and PKCE; binds the token to one Agent and forbids owner APIs', async () => {
    const flow = await authorize();
    expect((await flow.exchange({ code_verifier: randomToken(48) })).status).toBe(400);
    expect((await flow.exchange({ resource: 'https://wrong.example/mcp' })).status).toBe(400);
    const exchanged = await flow.exchange();
    expect(exchanged.status).toBe(200);
    const token = await exchanged.json<{ access_token: string; refresh_token: string }>();
    expect(token.access_token.length).toBeGreaterThan(20);
    const identity = await server.fetch(resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hub_identity', arguments: {} },
      }),
    });
    expect(identity.status).toBe(200);
    const identityBody = await identity.json<{
      result: { structuredContent: { agent_id: string; owner_id: string } };
    }>();
    expect(identityBody.result.structuredContent.agent_id).toBe(flow.agent.id);
    expect(identityBody.result.structuredContent.owner_id).toBe(flow.u.id);
    const forbidden = await server.fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Origin: base,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ platform: 'muse', label: 'Unauthorized' }),
    });
    expect(forbidden.status).toBe(401);
    const revoke = await server.fetch(`${base}/api/agents/${flow.agent.id}/revoke`, {
      method: 'POST',
      headers: ownerHeaders(flow.u),
    });
    expect(revoke.status).toBe(200);
    const stale = await server.fetch(resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(stale.status).toBe(401);
  });

  it('rejects authorization code replay', async () => {
    const flow = await authorize();
    expect((await flow.exchange()).status).toBe(200);
    expect((await flow.exchange()).status).toBe(400);
  });

  it('allows only one exchange of an authorization code under concurrent requests', async () => {
    const flow = await authorize();
    const responses = await Promise.all([flow.exchange(), flow.exchange()]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 400]);
  });

  it('rejects unapproved callback domains and public clients without PKCE', async () => {
    const forbidden = await server.fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Pretend Dot',
        redirect_uris: ['https://attacker.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(forbidden.status).toBe(400);
    const register = await server.fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test',
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
      }),
    });
    const client = await register.json<{ client_id: string }>();
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: 'code',
      resource,
    });
    const response = await server.fetch(`${base}/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe(
      'invalid_request',
    );
  });
});
