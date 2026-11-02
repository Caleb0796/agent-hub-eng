import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { sha256, utf8 } from '../shared/crypto';
import type { Connection, Statement } from './storage';
export type { Connection } from './storage';

export type HubBindings = Env & { OAUTH_PROVIDER: OAuthHelpers };
export type HubContext = Context<{ Bindings: HubBindings }>;
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 503;

export class HubError extends Error {
  constructor(
    public code: string,
    public status: HttpStatus,
    message: string,
  ) {
    super(message);
  }
}

export function ensure(
  value: unknown,
  code: string,
  status: HttpStatus,
  message: string,
): asserts value {
  if (!value) throw new HubError(code, status, message);
}

export function db(env: Env): Connection {
  return env.DB;
}
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
export function secretEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(utf8(a), utf8(b));
}
export function asJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
export function origin(env: Env): URL {
  const value = new URL(env.PUBLIC_ORIGIN);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname);
  ensure(
    value.origin === env.PUBLIC_ORIGIN && !value.username && !value.password,
    'bad_configuration',
    503,
    'The service address is misconfigured.',
  );
  ensure(
    value.protocol === 'https:' || (local && env.APP_ENV !== 'production'),
    'bad_configuration',
    503,
    'Production requires HTTPS.',
  );
  return value;
}

/**
 * Everything is bound to the fixed origin except the cleanup: Vercel calls crons on the
 * deployment's own URL, and that route needs only its secret, not cookies, passkeys or OAuth.
 */
export function wrongOrigin(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  return url.origin !== origin(env).origin && url.pathname !== '/api/cron/cleanup';
}

export function requireBrowserOrigin(c: HubContext): void {
  ensure(
    c.req.header('Origin') === origin(c.env).origin,
    'invalid_origin',
    403,
    'Please do this from the Agent Hub page.',
  );
  const site = c.req.header('Sec-Fetch-Site');
  ensure(
    !site || site === 'same-origin' || site === 'none',
    'invalid_origin',
    403,
    'Cross-site requests are not accepted.',
  );
}

export interface Owner {
  id: string;
  display_name: string;
  authenticated_at: number;
  session_hash: string;
  csrf_hash: string;
}

export function publicOwner(value: Pick<Owner, 'id' | 'display_name'>) {
  return { id: value.id, name: value.display_name };
}

export function sessionCookieName(env: Env): string {
  return origin(env).protocol === 'https:' ? '__Host-agent-hub-session' : 'agent-hub-local-session';
}

export async function owner(
  c: HubContext,
  options: { write?: boolean; fresh?: boolean } = {},
): Promise<Owner> {
  const cookie = getCookie(c, sessionCookieName(c.env));
  ensure(
    cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie),
    'login_required',
    401,
    'Please log in with your passkey.',
  );
  const sessionHash = await sha256(cookie);
  const row = await db(c.env)
    .prepare(
      `SELECT u.id,u.display_name,s.authenticated_at,s.token_hash AS session_hash,s.csrf_hash
    FROM browser_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`,
    )
    .bind(sessionHash, nowSeconds())
    .first<Owner>();
  ensure(row, 'login_required', 401, 'Your login has expired. Please log in again.');
  if (options.write) {
    requireBrowserOrigin(c);
    const csrf = c.req.header('X-CSRF-Token');
    ensure(
      csrf && secretEqual(await sha256(csrf), row.csrf_hash),
      'csrf_failed',
      403,
      'This page has expired. Please refresh and try again.',
    );
  }
  if (options.fresh)
    ensure(
      nowSeconds() - row.authenticated_at <= 900,
      'reauthentication_required',
      401,
      "Please confirm it's you with your passkey again.",
    );
  return row;
}

export function audit(
  connection: Connection,
  eventType: string,
  entityId: string,
  actor: { owner?: string; agent?: string },
  metadata: Record<string, string | number | boolean | null> = {},
  at = nowSeconds(),
  eventId: string = crypto.randomUUID(),
): Statement {
  return connection
    .prepare(
      'INSERT OR IGNORE INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(
      eventId,
      eventType,
      actor.owner ?? null,
      actor.agent ?? null,
      entityId,
      JSON.stringify(metadata),
      at,
    );
}

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  interval = 60,
): Promise<void> {
  const bucket = Math.floor(nowSeconds() / interval),
    keyHash = await sha256(key);
  const row = await db(env)
    .prepare(
      `INSERT INTO rate_limits(key_hash,bucket,count,expires_at) VALUES(?,?,1,?)
    ON CONFLICT(key_hash,bucket) DO UPDATE SET count=MIN(count+1,?) RETURNING count`,
    )
    .bind(keyHash, bucket, (bucket + 2) * interval, limit + 1)
    .first<{ count: number }>();
  ensure(
    row && row.count <= limit,
    'rate_limited',
    429,
    'Too many requests. Please try again later.',
  );
}
/** The current count of a rateLimit bucket, without spending from it. */
export async function rateLimitUsed(env: Env, key: string, interval = 60): Promise<number> {
  const row = await db(env)
    .prepare('SELECT count FROM rate_limits WHERE key_hash=? AND bucket=?')
    .bind(await sha256(key), Math.floor(nowSeconds() / interval))
    .first<{ count: number }>();
  return row?.count ?? 0;
}
/** Gives back one rateLimit slot spent on work that did not complete. */
export async function rateLimitRefund(env: Env, key: string, interval = 60): Promise<void> {
  await db(env)
    .prepare('UPDATE rate_limits SET count=count-1 WHERE key_hash=? AND bucket=? AND count>0')
    .bind(await sha256(key), Math.floor(nowSeconds() / interval))
    .run();
}

export async function boundedRequest(request: Request, maximum = 96 * 1024): Promise<Request> {
  if (!request.body) return request;
  const stated = Number(request.headers.get('Content-Length'));
  ensure(
    !Number.isFinite(stated) || stated <= maximum,
    'body_too_large',
    413,
    'The request exceeds the size limit.',
  );
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new HubError('body_too_large', 413, 'The request exceeds the size limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body: bytes });
}
