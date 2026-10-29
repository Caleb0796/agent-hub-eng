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
import { base64url, decode64, randomToken, sha256, utf8, verifySignature } from '../shared/crypto';
import { keySchema, signatureSchema } from '../shared/protocol';
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
  requireBrowserOrigin,
  sessionCookieName,
  type HubBindings,
  type HubContext,
} from './common';

const router = new Hono<{ Bindings: HubBindings }>();
const registerInput = z
  .object({
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{2,29}$/),
    name: z.string().trim().min(1).max(60),
    signingKey: keySchema,
    invite: z.string().max(100).optional(),
  })
  .strict();
type RegistrationData = z.infer<typeof registerInput> & {
  userId: string;
  inviteHash: string | null;
};
type Challenge = {
  token_hash: string;
  kind: string;
  challenge: string;
  data_json: string;
  expires_at: number;
};
type CredentialRow = {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports_json: string;
  device_type: string;
  backed_up: number;
};

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
async function saveChallenge(
  c: HubContext,
  kind: 'register' | 'login',
  challenge: string,
  data: unknown,
): Promise<void> {
  const token = randomToken();
  await db(c.env)
    .prepare(
      'INSERT INTO auth_challenges(token_hash,kind,challenge,data_json,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(await sha256(token), kind, challenge, JSON.stringify(data), nowSeconds() + 300)
    .run();
  setCookie(c, challengeCookie(c), token, cookieOptions(c, 300));
}
async function consumeChallenge(c: HubContext, kind: 'register' | 'login'): Promise<Challenge> {
  const token = getCookie(c, challengeCookie(c));
  ensure(
    token && /^[A-Za-z0-9_-]{43}$/.test(token),
    'challenge_expired',
    400,
    '验证已过期，请重新开始',
  );
  const result = await db(c.env)
    .prepare(
      'DELETE FROM auth_challenges WHERE token_hash=? AND kind=? AND expires_at>? RETURNING *',
    )
    .bind(await sha256(token), kind, nowSeconds())
    .first<Challenge>();
  deleteCookie(c, challengeCookie(c), { path: '/', secure: origin(c.env).protocol === 'https:' });
  ensure(result, 'challenge_expired', 400, '验证已过期或已使用，请重新开始');
  return result;
}
async function createSession(c: HubContext, userId: string): Promise<string> {
  const token = randomToken(),
    csrf = randomToken(),
    at = nowSeconds();
  const connection = db(c.env);
  await connection.batch([
    connection
      .prepare(
        'INSERT INTO browser_sessions(token_hash,user_id,csrf_hash,authenticated_at,expires_at) VALUES(?,?,?,?,?)',
      )
      .bind(await sha256(token), userId, await sha256(csrf), at, at + 86400),
    audit(connection, 'owner_authenticated', userId, { owner: userId }, {}, at),
  ]);
  setCookie(c, sessionCookieName(c.env), token, cookieOptions(c, 86400));
  // CSRF is separate from the HttpOnly authentication secret and is intentionally readable by the UI.
  setCookie(c, 'agent-hub-csrf', csrf, { ...cookieOptions(c, 86400), httpOnly: false });
  return csrf;
}

router.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method !== 'GET') {
    requireBrowserOrigin(c);
    await rateLimit(c.env, `auth:${c.req.header('CF-Connecting-IP') ?? 'local'}`, 30);
  }
  await next();
});

router.post('/register/options', async (c) => {
  const input = registerInput.parse(await c.req.json());
  const connection = db(c.env);
  ensure(
    !(await connection.prepare('SELECT id FROM users WHERE handle=?').bind(input.handle).first()),
    'handle_unavailable',
    409,
    '这个用户名已经被使用',
  );
  let inviteHash: string | null = null;
  if (c.env.SIGNUP_MODE !== 'open') {
    ensure(input.invite, 'invitation_required', 403, '当前为邀请测试，请使用邀请链接注册');
    inviteHash = await sha256(input.invite);
    ensure(
      await connection
        .prepare(
          'SELECT token_hash FROM signup_invites WHERE token_hash=? AND consumed_by IS NULL AND expires_at>?',
        )
        .bind(inviteHash, nowSeconds())
        .first(),
      'invalid_invitation',
      403,
      '邀请链接无效或已使用',
    );
  }
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: 'Agent Hub',
    rpID: origin(c.env).hostname,
    userName: input.handle,
    userDisplayName: input.name,
    userID: utf8(userId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -8, -257],
  });
  await saveChallenge(c, 'register', options.challenge, {
    ...input,
    invite: undefined,
    userId,
    inviteHash,
  });
  return c.json({
    options,
    signingChallenge: {
      kind: 'owner-registration',
      challenge: options.challenge,
      user_id: userId,
      signing_key: input.signingKey,
    },
  });
});

router.post('/register/verify', async (c) => {
  const input = z
    .object({
      response: z.custom<RegistrationResponseJSON>(registrationResponse),
      signingProof: signatureSchema,
    })
    .strict()
    .parse(await c.req.json());
  const challenge = await consumeChallenge(c, 'register'),
    data = asJson<RegistrationData>(challenge.data_json);
  ensure(
    c.env.SIGNUP_MODE === 'open' || data.inviteHash,
    'invitation_required',
    403,
    '当前注册需要有效邀请',
  );
  ensure(
    await verifySignature(
      data.signingKey,
      {
        kind: 'owner-registration',
        challenge: challenge.challenge,
        user_id: data.userId,
        signing_key: data.signingKey,
      },
      input.signingProof,
    ),
    'invalid_signing_proof',
    400,
    '授权密钥证明不匹配',
  );
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin(c.env).origin,
      expectedRPID: origin(c.env).hostname,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -8, -257],
    });
  } catch {
    throw new HubError('passkey_verification_failed', 400, '通行密钥验证失败，请重新开始');
  }
  ensure(result.verified, 'passkey_verification_failed', 400, '通行密钥验证失败');
  const info = result.registrationInfo,
    connection = db(c.env),
    at = nowSeconds();
  const statements = [
    connection
      .prepare(
        `INSERT INTO users(id,handle,display_name,signing_key,created_at)
    SELECT ?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM signup_invites WHERE token_hash=? AND consumed_by IS NULL AND expires_at>?)`,
      )
      .bind(
        data.userId,
        data.handle,
        data.name,
        data.signingKey,
        at,
        data.inviteHash,
        data.inviteHash,
        at,
      ),
  ];
  statements.push(
    connection
      .prepare(
        'INSERT INTO passkeys(id,user_id,public_key,counter,transports_json,device_type,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        info.credential.id,
        data.userId,
        base64url(new Uint8Array(info.credential.publicKey)),
        info.credential.counter,
        JSON.stringify(info.credential.transports ?? []),
        info.credentialDeviceType,
        Number(info.credentialBackedUp),
        at,
      ),
  );
  if (data.inviteHash)
    statements.push(
      connection
        .prepare(
          'UPDATE signup_invites SET consumed_by=? WHERE token_hash=? AND consumed_by IS NULL',
        )
        .bind(data.userId, data.inviteHash),
    );
  statements.push(
    audit(connection, 'owner_registered', data.userId, { owner: data.userId }, {}, at),
  );
  try {
    await connection.batch(statements);
  } catch {
    throw new HubError('registration_conflict', 409, '注册信息已变化，请重新开始');
  }
  await createSession(c, data.userId);
  return c.json(
    {
      owner: { id: data.userId, handle: data.handle, name: data.name, signingKey: data.signingKey },
    },
    201,
  );
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
  const response = await c.req.json<AuthenticationResponseJSON>();
  ensure(
    typeof response.id === 'string' && response.id.length < 2048,
    'invalid_credential',
    400,
    '无效的通行密钥',
  );
  const challenge = await consumeChallenge(c, 'login'),
    connection = db(c.env);
  const credential = await connection
    .prepare(
      'SELECT p.* FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.disabled_at IS NULL',
    )
    .bind(response.id)
    .first<CredentialRow>();
  ensure(credential, 'passkey_verification_failed', 401, '通行密钥验证失败');
  ensure(
    !response.response.userHandle ||
      response.response.userHandle === base64url(utf8(credential.user_id)),
    'passkey_verification_failed',
    401,
    '通行密钥账号不匹配',
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
    throw new HubError('passkey_verification_failed', 401, '通行密钥验证失败');
  }
  ensure(result.verified, 'passkey_verification_failed', 401, '通行密钥验证失败');
  const changed = await connection
    .prepare('UPDATE passkeys SET counter=? WHERE id=? AND counter=?')
    .bind(result.authenticationInfo.newCounter, credential.id, credential.counter)
    .run();
  ensure(changed.meta.changes === 1, 'authentication_conflict', 409, '验证状态变化，请重试登录');
  await createSession(c, credential.user_id);
  const user = await connection
    .prepare(
      'SELECT id,handle,display_name AS name,signing_key AS signingKey FROM users WHERE id=?',
    )
    .bind(credential.user_id)
    .first();
  return c.json({ owner: user });
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
