import { server } from './runtime';
import { describe, it, expect } from 'vitest';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { signPayload } from '../src/shared/crypto';
import { keyPair } from './helpers';
import { Browser, authenticator } from './support/passkey-device';
const makeBrowser = () => new Browser((input, init) => server.fetch(input, init));

describe('passkey owner authentication', () => {
  it('registers two distinct owners with real attestation verification and authenticates the original credential', async () => {
    const browser = makeBrowser(),
      device = await authenticator(),
      signer = await keyPair(),
      handle = 'owner' + crypto.randomUUID().slice(0, 8);
    const options = await browser.post('/api/auth/register/options', {
      handle,
      name: 'First Owner',
      signingKey: signer.publicKey,
    });
    expect(options.status).toBe(200);
    const setup = await options.json<{
      options: PublicKeyCredentialCreationOptionsJSON;
      signingChallenge: { user_id: string };
    }>();
    const payload = {
      response: device.register(setup.options.challenge),
      signingProof: await signPayload(signer.privateKey, setup.signingChallenge),
    };
    const verified = await browser.post('/api/auth/register/verify', payload);
    expect(verified.status).toBe(201);
    const first = await verified.json<{ owner: { id: string; signingKey: string } }>();
    expect(first.owner.signingKey).toBe(signer.publicKey);
    expect(first.owner.id).toBe(setup.signingChallenge.user_id);
    expect((await browser.post('/api/auth/register/verify', payload)).status).toBe(400);
    const secondBrowser = makeBrowser(),
      otherDevice = await authenticator(),
      otherSigner = await keyPair();
    const secondOptions = await secondBrowser.post('/api/auth/register/options', {
      handle: 'second' + crypto.randomUUID().slice(0, 8),
      name: 'Second Owner',
      signingKey: otherSigner.publicKey,
    });
    const second = await secondOptions.json<{
      options: PublicKeyCredentialCreationOptionsJSON;
      signingChallenge: unknown;
    }>();
    const secondVerified = await secondBrowser.post('/api/auth/register/verify', {
      response: otherDevice.register(second.options.challenge),
      signingProof: await signPayload(otherSigner.privateKey, second.signingChallenge),
    });
    expect(secondVerified.status).toBe(201);
    expect((await secondVerified.json<{ owner: { id: string } }>()).owner.id).not.toBe(
      first.owner.id,
    );
    await browser.post('/api/auth/logout', {});
    const loginOptions = await browser.post('/api/auth/login/options', {}),
      login = await loginOptions.json<{ options: { challenge: string } }>();
    const logged = await browser.post(
      '/api/auth/login/verify',
      await device.login(login.options.challenge, setup.options.user.id),
    );
    expect(logged.status).toBe(200);
    expect((await logged.json<{ owner: { id: string } }>()).owner.id).toBe(first.owner.id);
  });

  it('refuses an otherwise valid authenticator response from the wrong origin', async () => {
    const browser = makeBrowser(),
      device = await authenticator(),
      signer = await keyPair();
    const setup = await (
      await browser.post('/api/auth/register/options', {
        handle: 'origin' + crypto.randomUUID().slice(0, 8),
        name: 'Origin Test',
        signingKey: signer.publicKey,
      })
    ).json<{ options: { challenge: string }; signingChallenge: unknown }>();
    const result = await browser.post('/api/auth/register/verify', {
      response: device.register(setup.options.challenge, 'https://evil.example'),
      signingProof: await signPayload(signer.privateKey, setup.signingChallenge),
    });
    expect(result.status).toBe(400);
    expect((await result.json<{ error: string }>()).error).toBe('passkey_verification_failed');
  });

  it('refuses to bind an owner approval key without proof of possession', async () => {
    const browser = makeBrowser(),
      device = await authenticator(),
      signer = await keyPair(),
      attacker = await keyPair();
    const setup = await (
      await browser.post('/api/auth/register/options', {
        handle: 'proof' + crypto.randomUUID().slice(0, 8),
        name: 'Proof Test',
        signingKey: signer.publicKey,
      })
    ).json<{ options: { challenge: string }; signingChallenge: unknown }>();
    const result = await browser.post('/api/auth/register/verify', {
      response: device.register(setup.options.challenge),
      signingProof: await signPayload(attacker.privateKey, setup.signingChallenge),
    });
    expect(result.status).toBe(400);
    expect((await result.json<{ error: string }>()).error).toBe('invalid_signing_proof');
  });
});
