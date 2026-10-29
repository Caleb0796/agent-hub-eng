import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  OAuthProvider,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { sha256 } from '../shared/crypto';
import { scopes, platformSchema, type Platform } from '../shared/protocol';
import {
  db,
  ensure,
  HubError,
  owner,
  origin,
  requireBrowserOrigin,
  secretEqual,
  type HubBindings,
} from './common';
import { Hub, type AgentRow } from './hub';
import { agentTokenPropsSchema, handleMcp, type AgentTokenProps } from './mcp';
import { consentCsp } from './security';

// Observed from Muse's native DCR flow on 2026-10-29. Keep this callback exact;
// other Meta domains, paths, ports and query strings are not enrollment targets.
const museNativeCallback = 'https://agent.meta.ai/api/hatch/oauth/callback';

export function permittedRedirect(uri: string, env: Env): boolean {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (uri === museNativeCallback) return true;
    if (
      env.APP_ENV !== 'production' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      return true;
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'chatgpt.com' ||
        url.hostname === 'muse.ai' ||
        url.hostname.endsWith('.muse.ai'))
    );
  } catch {
    return false;
  }
}
function clientPlatform(uri: string): Platform | undefined {
  if (uri === museNativeCallback) return 'muse';
  const host = new URL(uri).hostname;
  return host === 'chatgpt.com'
    ? 'dot'
    : host === 'muse.ai' || host.endsWith('.muse.ai')
      ? 'muse'
      : undefined;
}
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const scopeLabels: Record<string, string> = {
  [scopes.read]: '查看这个 Agent 的连接状态、配对和已授权会话',
  [scopes.enroll]: '提交本地公钥并确认主人已经批准的绑定和配对',
  [scopes.message]: '仅在双方主人批准后传递密文和回执',
};

export const oauthRoutes = new Hono<{ Bindings: HubBindings }>();
oauthRoutes.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const parsed = await oauth.parseAuthRequest(c.req.raw);
  ensure(
    permittedRedirect(parsed.redirectUri, c.env),
    'unsupported_client',
    400,
    '这个回调地址尚未列入 Dot/Muse 测试支持范围',
  );
  let user;
  try {
    user = await owner(c, { fresh: true });
  } catch (error) {
    if (error instanceof HubError && error.status === 401)
      return c.redirect(
        `/login?returnTo=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`,
      );
    throw error;
  }
  const platform = clientPlatform(parsed.redirectUri),
    details = await oauth.describeConsent(parsed),
    transaction = await oauth.beginConsent(parsed);
  const agents = await db(c.env)
    .prepare("SELECT * FROM agents WHERE owner_id=? AND status<>'revoked' ORDER BY created_at DESC")
    .bind(user.id)
    .all<AgentRow>();
  const choices = agents.results
    .filter((a) => !platform || a.platform === platform)
    .map(
      (a) => `<option value="${escape(a.id)}">${escape(a.label)} · ${escape(a.platform)}</option>`,
    )
    .join('');
  const scopeFields = Object.values(scopes)
    .map(
      (scope) =>
        `<label class="scope"><input type="checkbox" name="scope" value="${scope}" checked><span>${escape(scopeLabels[scope])}</span></label>`,
    )
    .join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权连接 · Agent Hub</title><link rel="stylesheet" href="/consent.css"></head><body>
    <main><a class="brand" href="/">AGENT HUB</a><p class="eyebrow">连接授权</p><h1>把你的 Agent<br>安全连接起来。</h1>
    <p>当前主人：<strong>${escape(user.display_name)}</strong>（${escape(user.handle)}）</p>
    <div class="client"><strong>${escape(details.clientName)}</strong><p>${details.clientDomain ? `客户端声明发布于 ${escape(details.clientDomain)}` : '客户端名称由申请方提供，不能单独证明厂商身份。'}</p><p>授权将返回 <strong>${escape(details.redirectHost)}</strong>。${details.redirectIsLoopback ? '这是你电脑上的本地测试客户端。' : ''}</p></div>
    <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><input type="hidden" name="csrf" value="${escape(getCookie(c, 'agent-hub-csrf') ?? '')}">
    <label>绑定到哪个 Agent<select name="agentId"><option value="new">创建新连接</option>${choices}</select></label>
    <div class="new-agent"><label>平台<select name="platform">${(platform ? [platform] : ['dot', 'muse']).map((p) => `<option value="${p}">${p === 'dot' ? 'Dot' : 'Muse'}</option>`).join('')}</select></label><label>新连接名称<input name="label" maxlength="60" value="${escape(`${user.display_name} 的 ${platform === 'muse' ? 'Muse' : 'Dot'}`)}" required></label></div>
    <fieldset><legend>允许这个连接</legend>${scopeFields}</fieldset><p class="note">这一步不允许 Agent 代替你认领密钥、批准配对或批准会话。聊天仍需要两位主人对具体对象、期限和额度分别授权。</p>
    <div class="actions"><button name="decision" value="deny" class="secondary">拒绝</button><button name="decision" value="approve">同意并连接</button></div></form></main></body></html>`;
  transaction.headers.set('Content-Type', 'text/html; charset=utf-8');
  transaction.headers.set('Cache-Control', 'no-store');
  // Native form POSTs under no-referrer can carry Origin:null. Send only the
  // origin as referrer so the browser preserves Origin for our strict CSRF check.
  transaction.headers.set('Referrer-Policy', 'origin');
  transaction.headers.set('Content-Security-Policy', consentCsp(parsed.redirectUri));
  return new Response(html, { headers: transaction.headers });
});

oauthRoutes.post('/authorize', async (c) => {
  requireBrowserOrigin(c);
  const user = await owner(c, { fresh: true }),
    form = await c.req.raw.formData();
  const csrf = String(form.get('csrf') ?? '');
  ensure(
    secretEqual(await sha256(csrf), user.csrf_hash),
    'csrf_failed',
    403,
    '授权页面已失效，请重新开始',
  );
  const handle = z.string().min(20).max(2048).parse(form.get('handle')),
    oauth = c.env.OAUTH_PROVIDER;
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(c.req.raw, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const selected = z
    .array(z.enum([scopes.read, scopes.enroll, scopes.message]))
    .min(1)
    .parse(form.getAll('scope').map(String));
  ensure(
    selected.includes(scopes.read),
    'read_scope_required',
    400,
    '连接至少需要读取自身状态的权限',
  );
  const approved = await oauth.approveConsent(c.req.raw, handle, { scope: selected });
  ensure(
    permittedRedirect(approved.request.redirectUri, c.env),
    'unsupported_client',
    400,
    '不支持这个客户端',
  );
  const h = new Hub(db(c.env), c.env.PUBLIC_ORIGIN),
    declared = platformSchema.parse(form.get('platform')),
    native = clientPlatform(approved.request.redirectUri);
  ensure(!native || native === declared, 'platform_mismatch', 400, '所选平台与授权回调不一致');
  const existing = String(form.get('agentId') ?? 'new');
  const agent =
    existing === 'new'
      ? await h.createAgent(
          user.id,
          declared,
          z.string().trim().min(1).max(60).parse(form.get('label')),
        )
      : await h.agent(z.uuid().parse(existing), user.id);
  ensure(agent.platform === declared, 'platform_mismatch', 400, '连接平台不匹配');
  const connected = await h.authorizeConnection(user.id, agent.id);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: agent.id,
    metadata: { agent_id: agent.id, platform: agent.platform },
    scope: selected,
    props: {
      ownerId: user.id,
      agentId: agent.id,
      authVersion: connected.auth_version,
    } satisfies AgentTokenProps,
  });
  approved.headers.set('Location', redirectTo);
  approved.headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 302, headers: approved.headers });
});

export function provider(
  env: Env,
  defaultHandler: ExportedHandler<HubBindings>,
): OAuthProvider<HubBindings> {
  const issuer = origin(env).origin;
  return new OAuthProvider<HubBindings>({
    apiRoute: '/mcp',
    apiHandler: {
      fetch: (request, bindings, ctx) =>
        handleMcp(request, bindings, ctx as OAuthResourceContext<AgentTokenProps>),
    },
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [scopes.read, scopes.enroll, scopes.message, 'offline_access'],
    requiredScopes: [scopes.read],
    resourceMetadata: { resource: `${issuer}/mcp`, authorization_servers: [issuer] },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 900,
    refreshTokenTTL: 7 * 86400,
    clientRegistrationTTL: 30 * 86400,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const redirects = clientMetadata.redirect_uris;
      if (
        !Array.isArray(redirects) ||
        !redirects.length ||
        redirects.length > 8 ||
        !redirects.every((v) => typeof v === 'string' && permittedRedirect(v, env))
      )
        return {
          code: 'invalid_redirect_uri',
          description:
            'This alpha only supports verified Dot/Muse callbacks (and loopback in local development).',
        };
    },
    tokenExchangeCallback: async (options) => {
      const parsed = agentTokenPropsSchema.safeParse(options.props);
      if (!parsed.success)
        throw new OAuthError('invalid_grant', { description: 'Connection metadata is invalid' });
      const a = await db(options.env)
        .prepare(
          "SELECT a.id FROM agents a JOIN users u ON u.id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.auth_version=? AND a.status<>'revoked' AND u.disabled_at IS NULL",
        )
        .bind(parsed.data.agentId, parsed.data.ownerId, parsed.data.authVersion)
        .first();
      if (!a)
        throw new OAuthError('invalid_grant', { description: 'This Agent connection was revoked' });
    },
    onError: (error) => {
      console.warn(
        JSON.stringify({
          event: 'oauth_rejected',
          category: error.internal.category,
          reason: error.internal.reason,
          status: error.status,
        }),
      );
    },
  });
}

export { AuthorizationError, CimdFetchError };
