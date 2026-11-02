import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  OAuthProvider,
  type OAuthProviderOptions,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { sha256 } from '../shared/crypto';
import { platformNames, platformSchema, scopes, type Platform } from '../shared/protocol';
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
import { chatService } from './services';
import { agentTokenPropsSchema, handleMcp, type AgentTokenProps } from './mcp';
import { defaultCsp } from './security';

// Observed from Muse's native DCR flow on 2026-10-29. Keep this callback exact;
// other Meta domains, paths, ports and query strings are not enrollment targets.
const museNativeCallback = 'https://agent.meta.ai/api/hatch/oauth/callback';
// The only redirect_uri in Claude's CIMD document (https://claude.ai/oauth/mcp-oauth-client-metadata),
// used by Duet's connector settings. Keep it exact like the Muse callback.
const duetCallback = 'https://claude.ai/api/mcp/auth_callback';

export function permittedRedirect(uri: string, env: Env): boolean {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (uri === museNativeCallback || uri === duetCallback) return true;
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
  if (uri === duetCallback) return 'duet';
  const host = new URL(uri).hostname;
  return host === 'chatgpt.com'
    ? 'dot'
    : host === 'muse.ai' || host.endsWith('.muse.ai')
      ? 'muse'
      : undefined;
}
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const oauthRoutes = new Hono<{ Bindings: HubBindings }>();
oauthRoutes.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const parsed = await oauth.parseAuthRequest(c.req.raw);
  ensure(
    permittedRedirect(parsed.redirectUri, c.env),
    'unsupported_client',
    400,
    'This callback address is not supported yet.',
  );
  let user;
  try {
    user = await owner(c, { fresh: true });
  } catch (error) {
    // No account yet: sign up (or log in) and come straight back here. A signed-in owner
    // whose login is stale only confirms the passkey again (reauth=1 opens login, not sign-up).
    if (error instanceof HubError && error.status === 401) {
      const reauth = error.code === 'reauthentication_required' ? 'reauth=1&' : '';
      return c.redirect(
        `/login?${reauth}returnTo=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`,
      );
    }
    throw error;
  }
  const platform = clientPlatform(parsed.redirectUri),
    details = await oauth.describeConsent(parsed),
    transaction = await oauth.beginConsent(parsed);
  const service = chatService(c.env);
  const eligible = (await service.agentsOf(user.id)).filter(
    (a) =>
      a.status === 'active' && a.runner === 'platform' && (!platform || a.platform === platform),
  );
  // With an existing same-platform Agent the owner must choose explicitly; never default to a
  // binding, so one connection cannot silently take over another Agent's identity.
  const choice = eligible.length
    ? `<fieldset><legend>Choose which Agent to connect</legend>${eligible
        .map(
          (a) =>
            `<label class="scope"><input type="radio" name="agentId" value="${escape(a.id)}" required><span>Reconnect "${escape(a.label)}" · ${escape(platformNames[a.platform])} · ID ${escape(a.id.slice(0, 8))}</span></label>`,
        )
        .join(
          '',
        )}<label class="scope"><input type="radio" name="agentId" value="new" required><span>Create a new Agent</span></label></fieldset>`
    : '<input type="hidden" name="agentId" value="new">';
  const platformField = platform
    ? `<input type="hidden" name="platform" value="${platform}">`
    : `<label>Platform (local testing)<select name="platform">${(['dot', 'muse', 'duet'] as const)
        .map((p) => `<option value="${p}">${platformNames[p]}</option>`)
        .join('')}</select></label>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize connection · Agent Hub</title><link rel="stylesheet" href="/consent.css"><script src="/consent.js" defer></script></head><body>
    <main><a class="brand" href="/">AGENT HUB</a><p class="eyebrow">Connection authorization</p><h1>Connect your Agent<br>to Agent Hub.</h1>
    <p>Current owner: <strong>${escape(user.display_name)}</strong></p>
    <div class="client"><strong>${escape(details.clientName)}</strong><p>${details.clientDomain ? `The client declares it is published at ${escape(details.clientDomain)}.` : 'The client name is provided by the requester and does not prove who the vendor is.'}</p><p>Authorization returns to <strong>${escape(details.redirectHost)}</strong>.${details.redirectIsLoopback ? ' This is a local test client on your computer.' : ''}</p></div>
    <form method="post" action="/authorize" data-callback-origin="${escape(new URL(parsed.redirectUri).origin)}" data-callback-path="${escape(new URL(parsed.redirectUri).pathname)}"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><input type="hidden" name="csrf" value="${escape(getCookie(c, 'agent-hub-csrf') ?? '')}">
    ${choice}${platformField}
    <p class="note">Once connected, this Agent can view your chats, receive messages and send messages for you directly (you can ask to see them first in a chat's settings). It cannot add friends, approve chats or change any settings.</p>
    <p role="alert" id="consent-error" hidden></p><noscript>Please enable JavaScript to complete the authorization redirect safely.</noscript>
    <div class="actions"><button name="decision" value="deny" class="secondary" formnovalidate>Reject</button><button name="decision" value="approve">Authorize connection</button></div></form></main></body></html>`;
  transaction.headers.set('Content-Type', 'text/html; charset=utf-8');
  transaction.headers.set('Cache-Control', 'no-store');
  // Native form POSTs under no-referrer can carry Origin:null. Send only the
  // origin as referrer so the browser preserves Origin for our strict CSRF check.
  transaction.headers.set('Referrer-Policy', 'origin');
  transaction.headers.set('Content-Security-Policy', defaultCsp);
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
    'This authorization page has expired. Please start again.',
  );
  const handle = z.string().min(20).max(2048).parse(form.get('handle')),
    oauth = c.env.OAUTH_PROVIDER;
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(c.req.raw, handle);
    return consentReply(c.req.header('Accept'), denied.redirectTo, denied.headers);
  }
  const existing = String(form.get('agentId') ?? '');
  ensure(
    existing === 'new' || z.uuid().safeParse(existing).success,
    'agent_selection_required',
    400,
    'Choose the Agent to reconnect, or explicitly choose to create a new one.',
  );
  const granted = [scopes.read, scopes.message];
  const approved = await oauth.approveConsent(c.req.raw, handle, { scope: granted });
  ensure(
    permittedRedirect(approved.request.redirectUri, c.env),
    'unsupported_client',
    400,
    'This client is not supported.',
  );
  const service = chatService(c.env),
    declared = platformSchema.parse(form.get('platform')),
    native = clientPlatform(approved.request.redirectUri);
  ensure(
    !native || native === declared,
    'platform_mismatch',
    400,
    'The selected platform does not match the authorization callback.',
  );
  const agent =
    existing === 'new'
      ? await service.createAgent(user.id, declared)
      : await service.ownAgent(user.id, existing);
  ensure(
    agent.platform === declared,
    'platform_mismatch',
    400,
    'The connection platform does not match.',
  );
  const connected = await service.onAuthorized(user.id, agent.id, approved.request.clientId);
  // completeAuthorization looks the client up again (a fresh CIMD fetch). Any failure here
  // must be a 5xx so the runtime rolls back the Agent changes and the consumed consent above,
  // leaving nothing half-done for the owner's retry.
  const { redirectTo } = await oauth
    .completeAuthorization({
      request: approved.request,
      userId: agent.id,
      metadata: { agent_id: agent.id, platform: agent.platform },
      scope: granted,
      props: {
        ownerId: user.id,
        agentId: agent.id,
        authVersion: connected.auth_version,
      } satisfies AgentTokenProps,
    })
    .catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'authorization_incomplete',
          error_type: error instanceof Error ? error.name : 'unknown',
        }),
      );
      throw new HubError(
        'authorization_incomplete',
        503,
        'Authorization could not be completed right now. Please try again later.',
      );
    });
  return consentReply(c.req.header('Accept'), redirectTo, approved.headers);
});

function consentReply(accept: string | undefined, redirectTo: string, headers: Headers): Response {
  headers.set('Cache-Control', 'no-store');
  if (accept?.includes('application/json')) {
    headers.delete('Location');
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ redirectTo }), { headers });
  }
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

export function provider(
  env: Env,
  defaultHandler: ExportedHandler<HubBindings>,
): OAuthProvider<HubBindings> {
  return new OAuthProvider<HubBindings>(providerOptions(env, defaultHandler));
}

function providerOptions(
  env: Env,
  defaultHandler: ExportedHandler<HubBindings>,
): OAuthProviderOptions<HubBindings> {
  const issuer = origin(env).origin;
  return {
    apiRoute: '/mcp',
    apiHandler: {
      fetch: (request, bindings, ctx) =>
        handleMcp(request, bindings, ctx as OAuthResourceContext<AgentTokenProps>),
    },
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [scopes.read, scopes.message, 'offline_access'],
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
            'Only verified Dot/Muse/Duet callbacks are supported so far (and loopback in local development).',
        };
    },
    tokenExchangeCallback: async (options) => {
      const parsed = agentTokenPropsSchema.safeParse(options.props);
      if (!parsed.success)
        throw new OAuthError('invalid_grant', { description: 'Connection metadata is invalid' });
      const a = await db(options.env)
        .prepare(
          "SELECT a.id FROM agents a JOIN users u ON u.id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.auth_version=? AND a.status='active' AND u.disabled_at IS NULL",
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
  };
}

export { AuthorizationError, CimdFetchError };
