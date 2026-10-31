import { Hono } from 'hono';
import { z } from 'zod';
import api from './api';
import auth from './auth';
import { provider, oauthRoutes, AuthorizationError, CimdFetchError } from './oauth';
import {
  boundedRequest,
  db,
  HubError,
  nowSeconds,
  wrongOrigin,
  rateLimit,
  type HubBindings,
} from './common';
import onboarding from './onboarding';
import { defaultCsp } from './security';
import { chatService } from './services';

const app = new Hono<{ Bindings: HubBindings }>();
app.route('/api/auth', auth);
app.route('/api', api);
app.route('/', oauthRoutes);
app.route('/', onboarding);
app.get('/healthz', (c) => c.json({ ok: true, service: 'agent-hub', version: '0.3.0' }));
app.get('/api/cron/cleanup', async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || c.req.header('Authorization') !== `Bearer ${expected}`)
    return c.json({ error: 'unauthorized' }, 401);
  await cleanup(c.env);
  return c.json({ ok: true });
});
app.get('/.well-known/agent-hub.json', (c) =>
  c.json({
    version: 'agent-hub/2',
    name: 'Agent Hub',
    platforms: ['dot', 'muse', 'duet'],
    origin: c.env.PUBLIC_ORIGIN,
    mcp: `${c.env.PUBLIC_ORIGIN}/mcp`,
    protocol_versions: ['2026-07-28', '2025-03-26'],
    tools: ['hub_whoami', 'hub_chats', 'hub_inbox', 'hub_send'],
    oauth: {
      issuer: c.env.PUBLIC_ORIGIN,
      authorization_url: `${c.env.PUBLIC_ORIGIN}/authorize`,
      token_url: `${c.env.PUBLIC_ORIGIN}/oauth/token`,
      registration_url: `${c.env.PUBLIC_ORIGIN}/oauth/register`,
      resource: `${c.env.PUBLIC_ORIGIN}/mcp`,
      scopes: ['agent:read', 'agent:message'],
      public_clients_require_pkce_s256: true,
    },
    data: {
      end_to_end_encrypted: false,
      hub_can_decrypt: true,
      retention_days: 30,
      agent_messages_reviewed_by_default: false,
    },
    guides: {
      dot: `${c.env.PUBLIC_ORIGIN}/connect/dot`,
      muse: `${c.env.PUBLIC_ORIGIN}/connect/muse`,
      duet: `${c.env.PUBLIC_ORIGIN}/connect/duet`,
    },
  }),
);
app.all('/api/*', (c) => c.json({ error: 'not_found', message: '接口不存在' }, 404));
app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));
app.get('*', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status !== 404) return response;
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url), c.req.raw));
});
app.onError((error, c) => errorResponse(error, c.env));

export function errorResponse(error: unknown, env: Env): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return Response.json({ error: error.code, message: error.description }, { status: 400 });
  }
  if (error instanceof CimdFetchError)
    return Response.json(
      { error: 'client_metadata_unavailable', message: '无法核验客户端元数据，请稍后重试' },
      { status: 400 },
    );
  if (error instanceof HubError)
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return Response.json({ error: 'invalid_request', message: '请求格式不正确' }, { status: 400 });
  const requestId = crypto.randomUUID();
  console.error(
    JSON.stringify({
      event: 'request_failed',
      request_id: requestId,
      error_type: error instanceof Error ? error.name : 'unknown',
      environment: env.APP_ENV,
    }),
  );
  return Response.json(
    { error: 'internal_error', message: '暂时无法完成请求', request_id: requestId },
    { status: 500 },
  );
}

export function headers(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  if (!result.headers.has('Referrer-Policy')) result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!result.headers.has('Content-Security-Policy'))
    result.headers.set('Content-Security-Policy', defaultCsp);
  if (!result.headers.has('Cache-Control')) result.headers.set('Cache-Control', 'no-store');
  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (wrongOrigin(request, env))
        return headers(Response.json({ error: 'wrong_origin' }, { status: 421 }));
      const bounded = await boundedRequest(request);
      if (new URL(request.url).pathname === '/oauth/register')
        await rateLimit(env, `dcr:${request.headers.get('X-Forwarded-For') ?? 'local'}`, 30, 3600);
      return headers(await provider(env, app).fetch(bounded, env as HubBindings, ctx));
    } catch (error) {
      return headers(errorResponse(error, env));
    }
  },
} satisfies ExportedHandler<Env>;

export async function cleanup(env: Env): Promise<void> {
  const at = nowSeconds(),
    connection = db(env);
  await chatService(env).cleanup();
  await connection.batch([
    connection.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').bind(at),
    connection.prepare('DELETE FROM browser_sessions WHERE expires_at<=?').bind(at),
    connection.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(at),
    connection.prepare('DELETE FROM oauth_records WHERE expires_at<=?').bind(at),
  ]);
  await provider(env, app).purgeExpiredData(env as HubBindings, { batchSize: 100 });
}
