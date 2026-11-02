import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { base64url, decode64, randomToken, sha256, utf8 } from '../shared/crypto';
import { displayNameSchema } from '../shared/protocol';
import {
  audit,
  asJson,
  db,
  ensure,
  HubError,
  nowSeconds,
  origin,
  owner,
  publicOwner,
  rateLimit,
  rateLimitRefund,
  rateLimitUsed,
  requireBrowserOrigin,
  sessionCookieName,
  type HubBindings,
  type HubContext,
} from './common';
import type { Statement } from './storage';

const router = new Hono<{ Bindings: HubBindings }>();
type Kind = 'register' | 'login' | 'add_passkey' | 'recover';
type Challenge = { token_hash: string; kind: Kind; challenge: string; data_json: string };
type CredentialRow = { id: string; user_id: string; public_key: string; counter: number };
const algorithms = [-7, -8, -257];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function registrationResponse(value: unknown): value is RegistrationResponseJSON {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.rawId === 'string' &&
    value.type === 'public-key' &&
    record(value.clientExtensionResults) &&
    record(value.response) &&
    typeof value.response.clientDataJSON === 'string' &&
    typeof value.response.attestationObject === 'string' &&
    (value.authenticatorAttachment === undefined ||
      ['platform', 'cross-platform'].includes(String(value.authenticatorAttachment))) &&
    (value.response.transports === undefined ||
      (Array.isArray(value.response.transports) &&
        value.response.transports.every((v) => typeof v === 'string')))
  );
}
function authenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    value.id.length < 2048 &&
    typeof value.rawId === 'string' &&
    value.type === 'public-key' &&
    (value.clientExtensionResults === undefined || record(value.clientExtensionResults)) &&
    record(value.response) &&
    typeof value.response.clientDataJSON === 'string' &&
    typeof value.response.authenticatorData === 'string' &&
    typeof value.response.signature === 'string' &&
    (value.response.userHandle == null || typeof value.response.userHandle === 'string')
  );
}

function challengeCookie(c: HubContext): string {
  return origin(c.env).protocol === 'https:'
    ? '__Host-agent-hub-challenge'
    : 'agent-hub-local-challenge';
}
function cookieOptions(c: HubContext, maxAge: number) {
  return {
    httpOnly: true,
    secure: origin(c.env).protocol === 'https:',
    sameSite: 'Lax' as const,
    path: '/',
    maxAge,
  };
}
async function saveChallenge(c: HubContext, kind: Kind, challenge: string, data: unknown) {
  const token = randomToken();
  await db(c.env)
    .prepare(
      'INSERT INTO auth_challenges(token_hash,kind,challenge,data_json,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(await sha256(token), kind, challenge, JSON.stringify(data), nowSeconds() + 300)
    .run();
  setCookie(c, challengeCookie(c), token, cookieOptions(c, 300));
}
async function consumeChallenge(c: HubContext, kind: Kind): Promise<Challenge> {
  const token = getCookie(c, challengeCookie(c));
  ensure(
    token && /^[A-Za-z0-9_-]{43}$/.test(token),
    'challenge_expired',
    400,
    'The verification expired. Please start again.',
  );
  const result = await db(c.env)
    .prepare(
      'DELETE FROM auth_challenges WHERE token_hash=? AND kind=? AND expires_at>? RETURNING *',
    )
    .bind(await sha256(token), kind, nowSeconds())
    .first<Challenge>();
  deleteCookie(c, challengeCookie(c), { path: '/', secure: origin(c.env).protocol === 'https:' });
  ensure(
    result,
    'challenge_expired',
    400,
    'The verification expired or was already used. Please start again.',
  );
  return result;
}
async function createSession(c: HubContext, userId: string): Promise<void> {
  const token = randomToken(),
    csrf = randomToken(),
    at = nowSeconds(),
    connection = db(c.env);
  await connection.batch([
    connection
      .prepare(
        'INSERT INTO browser_sessions(token_hash,user_id,csrf_hash,authenticated_at,expires_at) VALUES(?,?,?,?,?)',
      )
      .bind(await sha256(token), userId, await sha256(csrf), at, at + 86400),
    audit(connection, 'owner_authenticated', userId, { owner: userId }, {}, at),
  ]);
  setCookie(c, sessionCookieName(c.env), token, cookieOptions(c, 86400));
  // CSRF is separate from the HttpOnly session secret and intentionally readable by the UI.
  setCookie(c, 'agent-hub-csrf', csrf, { ...cookieOptions(c, 86400), httpOnly: false });
}
async function ownerView(c: HubContext, userId: string) {
  const user = await db(c.env)
    .prepare('SELECT id,display_name FROM users WHERE id=?')
    .bind(userId)
    .first<{ id: string; display_name: string }>();
  ensure(user, 'login_required', 401, 'Your login has expired.');
  return publicOwner(user);
}

async function creationOptions(c: HubContext, userId: string, name: string) {
  const existing = (
    await db(c.env)
      .prepare('SELECT id FROM passkeys WHERE user_id=?')
      .bind(userId)
      .all<{ id: string }>()
  ).results;
  return generateRegistrationOptions({
    rpName: 'Agent Hub',
    rpID: origin(c.env).hostname,
    // Discoverable passkeys need no username; the display name labels the credential.
    userName: name,
    userDisplayName: name,
    userID: utf8(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: algorithms,
  });
}
async function verifyCreation(c: HubContext, response: unknown, challenge: string) {
  ensure(registrationResponse(response), 'invalid_credential', 400, 'Invalid passkey.');
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin(c.env).origin,
      expectedRPID: origin(c.env).hostname,
      requireUserVerification: true,
      supportedAlgorithmIDs: algorithms,
    });
  } catch {
    throw new HubError(
      'passkey_verification_failed',
      400,
      'Passkey verification failed. Please start again.',
    );
  }
  ensure(result.verified, 'passkey_verification_failed', 400, 'Passkey verification failed.');
  return result.registrationInfo;
}
function insertPasskey(
  c: HubContext,
  userId: string,
  info: Awaited<ReturnType<typeof verifyCreation>>,
): Statement {
  return db(c.env)
    .prepare(
      'INSERT INTO passkeys(id,user_id,public_key,counter,transports_json,device_type,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      info.credential.id,
      userId,
      base64url(new Uint8Array(info.credential.publicKey)),
      info.credential.counter,
      JSON.stringify(info.credential.transports ?? []),
      info.credentialDeviceType,
      Number(info.credentialBackedUp),
      nowSeconds(),
    );
}

router.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method !== 'GET') {
    requireBrowserOrigin(c);
    await rateLimit(c.env, `auth:${c.req.header('X-Forwarded-For') ?? 'local'}`, 30);
  }
  await next();
});

// The daily cap counts completed sign-ups only. It is also checked, read-only, before the
// device creates a passkey, so nobody is left with a passkey that has no account.
const signupDayKey = () => `signup-day:${Math.floor(nowSeconds() / 86400)}`;
const signupFull = async (env: Env) =>
  (await rateLimitUsed(env, signupDayKey(), 86400)) >= env.SIGNUP_DAILY_CAP;
const signupFullMessage =
  "Today's sign-up limit has been reached. Please try again tomorrow; existing accounts are not affected.";

router.get('/signup-status', async (c) =>
  c.json({ open: c.env.SIGNUP_MODE === 'open' && !(await signupFull(c.env)) }),
);

router.post('/register/options', async (c) => {
  ensure(
    c.env.SIGNUP_MODE === 'open',
    'signup_closed',
    403,
    'Sign-up is temporarily closed. Existing accounts can still log in.',
  );
  ensure(!(await signupFull(c.env)), 'signup_closed', 403, signupFullMessage);
  const { name } = z
    .object({ name: displayNameSchema })
    .strict()
    .parse(await c.req.json());
  await rateLimit(c.env, `signup-ip:${c.req.header('X-Forwarded-For') ?? 'local'}`, 10, 3600);
  const userId = crypto.randomUUID(),
    options = await creationOptions(c, userId, name);
  await saveChallenge(c, 'register', options.challenge, { name, userId });
  return c.json({ options });
});

router.post('/register/verify', async (c) => {
  ensure(c.env.SIGNUP_MODE === 'open', 'signup_closed', 403, 'Sign-up is temporarily closed.');
  const body = await c.req.json<{ response: unknown }>();
  const challenge = await consumeChallenge(c, 'register'),
    data = asJson<{ name: string; userId: string }>(challenge.data_json);
  const info = await verifyCreation(c, body?.response, challenge.challenge);
  // Spend atomically here so concurrent sign-ups stay capped; a conflict gives the slot back.
  const dayKey = signupDayKey();
  await rateLimit(c.env, dayKey, c.env.SIGNUP_DAILY_CAP, 86400).catch(() => {
    throw new HubError('signup_closed', 403, signupFullMessage);
  });
  const connection = db(c.env),
    at = nowSeconds();
  try {
    await connection.batch([
      connection
        .prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)')
        .bind(data.userId, data.name, at),
      insertPasskey(c, data.userId, info),
      audit(connection, 'owner_registered', data.userId, { owner: data.userId }, {}, at),
    ]);
  } catch {
    await rateLimitRefund(c.env, dayKey, 86400);
    throw new HubError(
      'registration_conflict',
      409,
      'The sign-up details changed. Please start again.',
    );
  }
  await createSession(c, data.userId);
  return c.json({ owner: await ownerView(c, data.userId) }, 201);
});

router.post('/login/options', async (c) => {
  const options = await generateAuthenticationOptions({
    rpID: origin(c.env).hostname,
    userVerification: 'required',
  });
  await saveChallenge(c, 'login', options.challenge, {});
  return c.json({ options });
});

router.post('/login/verify', async (c) => {
  const response: unknown = await c.req.json();
  // Check the shape before the challenge is spent.
  ensure(authenticationResponse(response), 'invalid_credential', 400, 'Invalid passkey.');
  const challenge = await consumeChallenge(c, 'login'),
    connection = db(c.env);
  const credential = await connection
    .prepare(
      'SELECT p.* FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.disabled_at IS NULL',
    )
    .bind(response.id)
    .first<CredentialRow>();
  ensure(credential, 'passkey_verification_failed', 401, 'Passkey verification failed.');
  ensure(
    !response.response.userHandle ||
      response.response.userHandle === base64url(utf8(credential.user_id)),
    'passkey_verification_failed',
    401,
    'The passkey does not match this account.',
  );
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin(c.env).origin,
      expectedRPID: origin(c.env).hostname,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: decode64(credential.public_key),
        counter: credential.counter,
      },
    });
  } catch {
    throw new HubError('passkey_verification_failed', 401, 'Passkey verification failed.');
  }
  ensure(result.verified, 'passkey_verification_failed', 401, 'Passkey verification failed.');
  const changed = await connection
    .prepare('UPDATE passkeys SET counter=? WHERE id=? AND counter=?')
    .bind(result.authenticationInfo.newCounter, credential.id, credential.counter)
    .run();
  ensure(
    changed.meta.changes === 1,
    'authentication_conflict',
    409,
    'The verification state changed. Please try logging in again.',
  );
  await createSession(c, credential.user_id);
  return c.json({ owner: await ownerView(c, credential.user_id) });
});

// A second passkey (for example on another device) for a signed-in owner.
router.post('/passkeys/options', async (c) => {
  const user = await owner(c, { write: true, fresh: true });
  const options = await creationOptions(c, user.id, user.display_name);
  await saveChallenge(c, 'add_passkey', options.challenge, { userId: user.id });
  return c.json({ options });
});
router.post('/passkeys/verify', async (c) => {
  const user = await owner(c, { write: true, fresh: true });
  const challenge = await consumeChallenge(c, 'add_passkey'),
    data = asJson<{ userId: string }>(challenge.data_json);
  ensure(
    data.userId === user.id,
    'challenge_expired',
    400,
    'The verification expired. Please start again.',
  );
  const body = await c.req.json<{ response: unknown }>();
  const info = await verifyCreation(c, body?.response, challenge.challenge);
  const connection = db(c.env);
  await connection.batch([
    insertPasskey(c, user.id, info),
    audit(connection, 'passkey_added', user.id, { owner: user.id }),
  ]);
  return c.json({ ok: true });
});

// Operator-issued recovery (scripts/create-recovery.mjs): registers a new passkey and
// invalidates every previous passkey and session of that owner.
async function recoveryLink(c: HubContext, token: string) {
  const link = await db(c.env)
    .prepare(
      `SELECT r.token_hash,r.user_id,u.display_name FROM recovery_links r JOIN users u ON u.id=r.user_id
        WHERE r.token_hash=? AND r.consumed_at IS NULL AND r.expires_at>? AND u.deleted_at IS NULL`,
    )
    .bind(await sha256(token), nowSeconds())
    .first<{ token_hash: string; user_id: string; display_name: string }>();
  ensure(
    link,
    'recovery_unavailable',
    410,
    'The recovery link is invalid or has expired. Please contact the operator.',
  );
  return link;
}
const recoveryInput = z.object({ token: z.string().min(20).max(100) }).strict();
router.post('/recover/options', async (c) => {
  const { token } = recoveryInput.parse(await c.req.json());
  const link = await recoveryLink(c, token);
  const options = await creationOptions(c, link.user_id, link.display_name);
  await saveChallenge(c, 'recover', options.challenge, {
    tokenHash: link.token_hash,
    userId: link.user_id,
  });
  return c.json({ options, name: link.display_name });
});
router.post('/recover/verify', async (c) => {
  const body = await c.req.json<{ response: unknown }>();
  const challenge = await consumeChallenge(c, 'recover'),
    data = asJson<{ tokenHash: string; userId: string }>(challenge.data_json);
  const info = await verifyCreation(c, body?.response, challenge.challenge);
  const connection = db(c.env),
    at = nowSeconds();
  // Consume first so a replayed ceremony can never add a passkey.
  const used = await connection
    .prepare(
      'UPDATE recovery_links SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?',
    )
    .bind(at, data.tokenHash, at)
    .run();
  ensure(
    used.meta.changes === 1,
    'recovery_unavailable',
    410,
    'The recovery link has already been used.',
  );
  await connection.batch([
    connection.prepare('DELETE FROM passkeys WHERE user_id=?').bind(data.userId),
    connection.prepare('DELETE FROM browser_sessions WHERE user_id=?').bind(data.userId),
    insertPasskey(c, data.userId, info),
    audit(connection, 'owner_recovered', data.userId, { owner: data.userId }, {}, at),
  ]);
  await createSession(c, data.userId);
  return c.json({ owner: await ownerView(c, data.userId) });
});

router.post('/logout', async (c) => {
  const user = await owner(c, { write: true });
  await db(c.env)
    .prepare('DELETE FROM browser_sessions WHERE token_hash=?')
    .bind(user.session_hash)
    .run();
  deleteCookie(c, sessionCookieName(c.env), {
    path: '/',
    secure: origin(c.env).protocol === 'https:',
  });
  deleteCookie(c, 'agent-hub-csrf', { path: '/' });
  return c.json({ ok: true });
});

export default router;
