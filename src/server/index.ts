import { Hono } from 'hono';
import { z } from 'zod';
import api from './api';
import auth from './auth';
import { provider, oauthApi, oauthRoutes, AuthorizationError, CimdFetchError } from './oauth';
import {
  boundedRequest,
  db,
  HubError,
  nowSeconds,
  origin,
  rateLimit,
  type HubBindings,
} from './common';
import { Hub } from './hub';
import { idSchema, signatureSchema } from '../shared/protocol';
import onboarding from './onboarding';
import { defaultCsp } from './security';
import { NativeEvents } from './events';

const app = new Hono<{ Bindings: HubBindings }>();
app.route('/api/auth', auth);
app.route('/api', api);
app.route('/', oauthRoutes);
app.route('/', onboarding);
app.get('/healthz', (c) => c.json({ ok: true, service: 'agent-hub', version: '0.2.0' }));
app.get('/api/cron/cleanup', async (c) => {
  const expected = c.env.CRON_SECRET;
  if (!expected || c.req.header('Authorization') !== `Bearer ${expected}`)
    return c.json({ error: 'unauthorized' }, 401);
  await cleanup(c.env);
  return c.json({ ok: true });
});
app.get('/.well-known/agent-hub.json', (c) =>
  c.json({
    version: 'agent-hub/1',
    name: 'Agent Hub',
    platforms: ['dot', 'muse'],
    origin: c.env.PUBLIC_ORIGIN,
    mcp: `${c.env.PUBLIC_ORIGIN}/mcp`,
    protocol_versions: ['2026-07-28', '2025-03-26'],
    oauth: {
      issuer: c.env.PUBLIC_ORIGIN,
      authorization_url: `${c.env.PUBLIC_ORIGIN}/authorize`,
      token_url: `${c.env.PUBLIC_ORIGIN}/oauth/token`,
      registration_url: `${c.env.PUBLIC_ORIGIN}/oauth/register`,
      resource: `${c.env.PUBLIC_ORIGIN}/mcp`,
      scopes: ['agent:read', 'agent:enroll', 'agent:message'],
      public_clients_require_pkce_s256: true,
    },
    enrollment: {
      owner_claim_required: true,
      endpoint_private_keys_stay_local: true,
      agent_cannot_approve_for_owner: true,
    },
    guides: {
      dot: `${c.env.PUBLIC_ORIGIN}/connect/dot`,
      muse: `${c.env.PUBLIC_ORIGIN}/connect/muse`,
    },
    receiving: {
      requests_tool: 'hub_requests',
      heartbeat_tool: 'hub_receiver_heartbeat',
      events: ['hub.request.created', 'hub.session.authorized'],
      event_methods: ['events/list', 'events/subscribe', 'events/unsubscribe'],
      first_native_setup_required: true,
      notification_is_not_execution_permission: true,
    },
  }),
);
app.post('/api/endpoint/cleanup', async (c) => {
  await rateLimit(c.env, `cleanup:${c.req.header('X-Forwarded-For') ?? 'local'}`, 30);
  const value = z
    .object({
      agentId: idSchema,
      conversationId: idSchema,
      proof: z
        .object({ payload: z.record(z.string(), z.unknown()), signature: signatureSchema })
        .strict(),
    })
    .strict()
    .parse(await c.req.json());
  // This narrowly scoped, signature-only receipt remains available after OAuth revocation.
  // It cannot read messages, reopen a grant or change any owner's approval.
  return c.json(
    await new Hub(db(c.env), c.env.PUBLIC_ORIGIN).reportCleanup(
      value.agentId,
      value.conversationId,
      value.proof,
    ),
  );
});
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
      if (new URL(request.url).origin !== origin(env).origin)
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

export function nativeEvents(env: Env): NativeEvents {
  const api = oauthApi(env);
  return new NativeEvents(
    new Hub(db(env), env.PUBLIC_ORIGIN),
    undefined,
    async (agentId, grantId, clientId) => {
      if (!(await api.lookupClient(clientId))) return false;
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await api.listUserGrants(agentId, { limit: 100, cursor });
        const grant = result.items.find((g) => g.id === grantId && g.clientId === clientId);
        if (grant)
          return (
            grant.scope.includes('agent:read') &&
            (!grant.expiresAt || grant.expiresAt > nowSeconds()) &&
            (Array.isArray(grant.resource) ? grant.resource : [grant.resource]).includes(
              `${env.PUBLIC_ORIGIN}/mcp`,
            )
          );
        cursor = result.cursor;
        if (!cursor) return false;
      }
      return false;
    },
  );
}

export async function cleanup(env: Env): Promise<void> {
  const at = nowSeconds(),
    connection = db(env);
  await connection.batch([
    connection
      .prepare(
        "UPDATE conversations SET status='expired',closed_at=COALESCE(deadline,expires_at),close_reason='deadline_reached' WHERE status NOT IN ('closed','expired','revoked') AND (expires_at<=? OR (deadline IS NOT NULL AND deadline<=?))",
      )
      .bind(at, at),
    connection
      .prepare(
        "UPDATE pairings SET status='expired' WHERE status IN ('invited','confirming','awaiting_endpoints') AND expires_at<=?",
      )
      .bind(at),
    connection.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').bind(at),
    connection.prepare('DELETE FROM browser_sessions WHERE expires_at<=?').bind(at),
    connection.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(at),
    connection.prepare('DELETE FROM oauth_records WHERE expires_at<=?').bind(at),
  ]);
  // Actual native task state is never invented by this cleanup job.
  await provider(env, app).purgeExpiredData(env as HubBindings, { batchSize: 100 });
  await nativeEvents(env).flush();
  await connection.batch([
    connection
      .prepare(
        'DELETE FROM event_deliveries WHERE delivered_at<? OR failed_at<? OR subscription_id IN (SELECT id FROM event_subscriptions WHERE expires_at<? OR disabled_at<?)',
      )
      .bind(at - 604800, at - 604800, at - 86400, at - 86400),
    connection
      .prepare('DELETE FROM event_subscriptions WHERE expires_at<? OR disabled_at<?')
      .bind(at - 86400, at - 86400),
  ]);
}
