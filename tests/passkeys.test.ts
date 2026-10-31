import { env, server } from './runtime';
import { describe, it, expect } from 'vitest';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { randomToken, sha256 } from '../src/shared/crypto';
import { Browser, authenticator } from './support/passkey-device';
const makeBrowser = () => new Browser((input, init) => server.fetch(input, init));

async function register(
  browser: Browser,
  device: Awaited<ReturnType<typeof authenticator>>,
  name: string,
) {
  const options = await browser.post('/api/auth/register/options', { name });
  expect(options.status).toBe(200);
  const setup = await options.json<{ options: PublicKeyCredentialCreationOptionsJSON }>();
  const verified = await browser.post('/api/auth/register/verify', {
    response: device.register(setup.options.challenge),
  });
  return { setup, verified };
}

describe('passkey owner authentication', () => {
  it('registers with only a name, rejects replay, and logs back in with the discoverable passkey', async () => {
    const browser = makeBrowser(),
      device = await authenticator();
    const { setup, verified } = await register(browser, device, '小林');
    expect(verified.status).toBe(201);
    const first = await verified.json<{ owner: { id: string; name: string } }>();
    expect(first.owner.name).toBe('小林');
    expect(setup.options.authenticatorSelection?.residentKey).toBe('required');
    const replay = await browser.post('/api/auth/register/verify', {
      response: device.register(setup.options.challenge),
    });
    expect(replay.status).toBe(400);
    const other = await register(makeBrowser(), await authenticator(), '小林');
    // Names are not unique; identities are.
    expect((await other.verified.json<{ owner: { id: string } }>()).owner.id).not.toBe(
      first.owner.id,
    );
    await browser.post('/api/auth/logout', {});
    const login = await (
      await browser.post('/api/auth/login/options', {})
    ).json<{
      options: { challenge: string };
    }>();
    const logged = await browser.post(
      '/api/auth/login/verify',
      await device.login(login.options.challenge, setup.options.user.id),
    );
    expect(logged.status).toBe(200);
    expect((await logged.json<{ owner: { id: string } }>()).owner.id).toBe(first.owner.id);
  });

  it('refuses an otherwise valid authenticator response from the wrong origin', async () => {
    const browser = makeBrowser(),
      device = await authenticator();
    const setup = await (
      await browser.post('/api/auth/register/options', { name: 'Origin' })
    ).json<{
      options: { challenge: string };
    }>();
    const result = await browser.post('/api/auth/register/verify', {
      response: device.register(setup.options.challenge, 'https://evil.example'),
    });
    expect(result.status).toBe(400);
    expect((await result.json<{ error: string }>()).error).toBe('passkey_verification_failed');
  });

  it('adds a second passkey for a signed-in owner', async () => {
    const browser = makeBrowser(),
      device = await authenticator(),
      second = await authenticator();
    const { verified } = await register(browser, device, 'Two devices');
    const owner = (await verified.json<{ owner: { id: string } }>()).owner;
    const options = await (
      await browser.post('/api/auth/passkeys/options', {})
    ).json<{
      options: PublicKeyCredentialCreationOptionsJSON;
    }>();
    expect(options.options.excludeCredentials).toHaveLength(1);
    const added = await browser.post('/api/auth/passkeys/verify', {
      response: second.register(options.options.challenge),
    });
    expect(added.status).toBe(200);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id=?')
      .bind(owner.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('recovers through a one-time operator link and invalidates old passkeys and sessions', async () => {
    const browser = makeBrowser(),
      lost = await authenticator(),
      fresh = await authenticator();
    const { setup, verified } = await register(browser, lost, 'Lost device');
    const owner = (await verified.json<{ owner: { id: string } }>()).owner;
    const token = randomToken(),
      at = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT INTO recovery_links(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
    )
      .bind(await sha256(token), owner.id, at, at + 3600)
      .run();
    const recovering = makeBrowser();
    const options = await (
      await recovering.post('/api/auth/recover/options', { token })
    ).json<{
      options: { challenge: string };
    }>();
    const recovered = await recovering.post('/api/auth/recover/verify', {
      response: fresh.register(options.options.challenge),
    });
    expect(recovered.status).toBe(200);
    expect((await recovering.post('/api/auth/recover/options', { token })).status).toBe(410);
    // The old browser session and the old passkey no longer work.
    expect((await browser.post('/api/auth/logout', {})).status).toBe(401);
    const login = await (
      await browser.post('/api/auth/login/options', {})
    ).json<{
      options: { challenge: string };
    }>();
    const old = await browser.post(
      '/api/auth/login/verify',
      await lost.login(login.options.challenge, setup.options.user.id),
    );
    expect(old.status).toBe(401);
  });
});
