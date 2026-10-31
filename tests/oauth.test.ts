import { env, server } from './runtime';
import { describe, it, expect, vi } from 'vitest';
import { base64url, randomToken } from '../src/shared/crypto';
import { seedOwner, ownerHeaders, service } from './helpers';
import { scopes } from '../src/shared/protocol';
import { CimdFetchError } from '../src/server/oauth';
import { runtimeFromEnvironment } from '../src/server/host';

const base = 'http://localhost:8789',
  resource = `${base}/mcp`,
  callback = 'http://localhost:45678/callback';
/** Registers a public client for `callback` and builds a PKCE authorization request. */
async function consentRequest(callback: string) {
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
  return { client, params, verifier };
}
async function authorize(
  platform: 'dot' | 'muse' | 'duet' = 'dot',
  redirect = callback,
  probeSelection = false,
) {
  const u = await seedOwner('OAuthOwner');
  const agent = await service().chats.createAgent(u.id, platform, 'Native ' + platform);
  const { client, params, verifier } = await consentRequest(redirect);
  const page = await server.fetch(`${base}/authorize?${params}`, {
    headers: ownerHeaders(u),
    redirect: 'manual',
  });
  expect(page.status).toBe(200);
  expect(page.headers.get('Referrer-Policy')).toBe('origin');
  const csp = page.headers.get('Content-Security-Policy');
  expect(csp).toContain("form-action 'self'");
  expect(csp).not.toContain(new URL(redirect).origin);
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  const html = await page.text(),
    handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  expect(html).toContain('客户端名称由申请方提供');
  expect(html).toContain(new URL(redirect).hostname);
  if (redirect !== callback) {
    // A known native callback fixes the platform; only loopback tests may choose one.
    expect(html).toContain(`name="platform" value="${platform}"`);
    expect(html).not.toContain('<select name="platform">');
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
  if (probeSelection) {
    for (const value of [undefined, '']) {
      const missing = new URLSearchParams(form);
      if (value === undefined) missing.delete('agentId');
      else missing.set('agentId', value);
      const rejected = await server.fetch(`${base}/authorize`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Origin: base,
          Cookie: `${ownerHeaders(u).Cookie}; ${cookies}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: missing,
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json<{ error: string }>()).error).toBe('agent_selection_required');
    }
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM agents WHERE owner_id=?')
        .bind(u.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  }
  const nullOrigin = await server.fetch(`${base}/authorize`, {
    method: 'POST',
    headers: {
      Origin: 'null',
      Cookie: `${ownerHeaders(u).Cookie}; ${cookies}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  expect(nullOrigin.status).toBe(403);
  const consent = await server.fetch(`${base}/authorize`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Origin: base,
      Cookie: `${ownerHeaders(u).Cookie}; ${cookies}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  expect(consent.status).toBe(200);
  expect(consent.headers.has('Location')).toBe(false);
  const location = new URL((await consent.json<{ redirectTo: string }>()).redirectTo);
  expect(location.origin).toBe(new URL(redirect).origin);
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
        redirect_uri: redirect,
        code,
        code_verifier: verifier,
        resource,
        ...overrides,
      }),
    });
  return { u, agent, client, exchange, html };
}

describe('native OAuth without copying API keys', () => {
  it('requires an explicit connection choice and reconnects the original identity', async () => {
    const flow = await authorize('dot', callback, true);
    expect(flow.html).toContain(`name="agentId" value="${flow.agent.id}" required`);
    expect(flow.html).toContain('name="agentId" value="new" required');
    expect(flow.html).not.toContain('checked');
    expect(flow.html).toContain(`ID ${flow.agent.id.slice(0, 8)}`);
    expect(flow.html).toContain('formnovalidate');
    const token = await (await flow.exchange()).json<{ access_token: string }>();
    const response = await server.fetch(resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hub_whoami', arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty(
      'result.structuredContent.agent_id',
      flow.agent.id,
    );
  });

  it('completes consent and PKCE with the native Muse callback and Muse-only choices', async () => {
    const flow = await authorize('muse', 'https://agent.meta.ai/api/hatch/oauth/callback');
    expect((await flow.exchange()).status).toBe(200);
  });

  it('completes consent and PKCE with the Duet (Claude) callback', async () => {
    const flow = await authorize('duet', 'https://claude.ai/api/mcp/auth_callback');
    expect((await flow.exchange()).status).toBe(200);
  });

  it('accepts only the exact Duet (Claude) callback', async () => {
    const callback = 'https://claude.ai/api/mcp/auth_callback';
    const register = (redirect: string) =>
      server.fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Duet callback compatibility',
          redirect_uris: [redirect],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });
    expect((await register(callback)).status).toBe(201);
    for (const redirect of [
      callback + '/other',
      callback + '?next=https://attacker.example',
      callback.replace('https:', 'http:'),
      callback.replace('claude.ai', 'claude.ai.attacker.example'),
      callback.replace('claude.ai', 'evil.claude.ai'),
      callback.replace('claude.ai', 'claude.ai:8443'),
    ])
      expect((await register(redirect)).status, redirect).toBe(400);
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
        params: { name: 'hub_whoami', arguments: {} },
      }),
    });
    expect(identity.status).toBe(200);
    const identityBody = await identity.json<{
      result: { structuredContent: { agent_id: string; owner_name: string } };
    }>();
    expect(identityBody.result.structuredContent.agent_id).toBe(flow.agent.id);
    expect(identityBody.result.structuredContent.owner_name).toBe('OAuthOwner');
    // An Agent token can never call owner administration.
    for (const [method, path] of [
      ['GET', '/api/dashboard'],
      ['POST', '/api/invites'],
      ['POST', `/api/agents/${flow.agent.id}/reset`],
    ]) {
      const forbidden = await server.fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Origin: base,
          'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : '{}',
      });
      expect(forbidden.status, path).toBe(401);
    }
    const revoke = await server.fetch(`${base}/api/agents/${flow.agent.id}/reset`, {
      method: 'POST',
      headers: ownerHeaders(flow.u),
    });
    expect(revoke.status).toBe(200);
    const stale = await server.fetch(resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        Origin: 'https://chatgpt.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(stale.status).toBe(401);
    // The reset token gets the same challenge as an unknown one, with CORS for browser clients.
    expect(stale.headers.get('WWW-Authenticate')).toBe(
      `Bearer realm="OAuth", error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(stale.headers.get('Access-Control-Allow-Origin')).toBe('https://chatgpt.com');
    expect(stale.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
  });

  it('sends a stale login back to passkey login, not sign-up, before consent', async () => {
    const u = await seedOwner('StaleOwner');
    const { params } = await consentRequest(callback);
    const location = async (headers: Record<string, string> = {}) =>
      new URL(
        (
          await server.fetch(`${base}/authorize?${params}`, { headers, redirect: 'manual' })
        ).headers.get('Location')!,
        base,
      );
    const anonymous = await location();
    expect(anonymous.pathname).toBe('/login');
    expect(anonymous.searchParams.has('reauth')).toBe(false);
    expect(anonymous.searchParams.get('returnTo')).toBe(`/authorize?${params}`);
    await env.DB.prepare(
      'UPDATE browser_sessions SET authenticated_at=authenticated_at-901 WHERE user_id=?',
    )
      .bind(u.id)
      .run();
    const stale = await location(ownerHeaders(u));
    expect(stale.pathname).toBe('/login');
    expect(stale.searchParams.get('reauth')).toBe('1');
    expect(stale.searchParams.get('returnTo')).toBe(`/authorize?${params}`);
  });

  it('rolls back the Agent changes when the authorization cannot be completed', async () => {
    const u = await seedOwner('RetryOwner');
    const agent = await service().chats.createAgent(u.id, 'dot', 'Retry dot');
    const { params } = await consentRequest(callback);
    const page = await server.fetch(`${base}/authorize?${params}`, {
      headers: ownerHeaders(u),
      redirect: 'manual',
    });
    const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1];
    const cookies = page.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const approve = (agentId: string) =>
      server.fetch(`${base}/authorize`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Origin: base,
          Cookie: `${ownerHeaders(u).Cookie}; ${cookies}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          handle,
          csrf: u.csrf,
          decision: 'approve',
          agentId,
          platform: 'dot',
        }),
      });
    const agents = () =>
      env.DB.prepare('SELECT id,auth_version FROM agents WHERE owner_id=?')
        .bind(u.id)
        .all<{ id: string; auth_version: number }>()
        .then((r) => r.results);
    const before = await agents();
    // e.g. the CIMD metadata fetch inside completeAuthorization times out.
    const helpers = Object.getPrototypeOf(
      (env as unknown as { OAUTH_PROVIDER: object }).OAUTH_PROVIDER,
    );
    const failing = vi
      .spyOn(helpers, 'completeAuthorization')
      .mockRejectedValue(
        new CimdFetchError('https://client.example/oauth.json', new Error('timeout')),
      );
    try {
      for (const choice of [agent.id, 'new']) {
        const failed = await approve(choice);
        expect(failed.status, choice).toBe(503);
        expect(await agents(), choice).toEqual(before);
      }
    } finally {
      failing.mockRestore();
    }
    // Nothing was consumed, so the same consent page can be retried.
    const retried = await approve(agent.id);
    expect(retried.status).toBe(200);
    expect((await agents())[0].auth_version).toBe(before[0].auth_version + 1);
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

describe('hosted runtime startup', () => {
  it('starts with any message key version, so a rotated-out MESSAGE_KEY_V1 can be removed', () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('TURSO_DATABASE_URL', ':memory:');
    vi.stubEnv('PUBLIC_ORIGIN', base);
    vi.stubEnv('MESSAGE_KEY_V1', '');
    vi.stubEnv('MESSAGE_KEY_V2', Buffer.alloc(32, 7).toString('base64url'));
    try {
      expect(runtimeFromEnvironment().env.MESSAGE_KEYS).toEqual({
        2: Buffer.alloc(32, 7).toString('base64url'),
      });
      vi.stubEnv('MESSAGE_KEY_V2', '');
      expect(() => runtimeFromEnvironment()).toThrow('MESSAGE_KEY_V');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
