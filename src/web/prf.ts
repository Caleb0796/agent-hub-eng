import { base64url, decode64, utf8 } from '../shared/crypto';

// Owner approval keys derived from a passkey's WebAuthn PRF output. A synced passkey
// yields the same PRF output on every device, so each device re-derives the same key.
const info = utf8('agent-hub owner approval ed25519 v1');
const pkcs8Prefix = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export class PrfUnavailableError extends Error {
  constructor() {
    super('这个通行密钥或浏览器不支持跨设备授权密钥');
    this.name = 'PrfUnavailableError';
  }
}

async function prfSalt(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8('agent-hub/owner-approval/v1')));
}

export async function approvalKeyFromPrf(
  output: Uint8Array<ArrayBuffer>,
): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const base = await crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveBits']);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info },
      base,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);
  // Import once as extractable only to read the public half, then keep a non-extractable copy.
  const exportable = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, [
    'sign',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', exportable);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, [
    'sign',
  ]);
  seed.fill(0);
  pkcs8.fill(0);
  if (!jwk.x) throw new PrfUnavailableError();
  return { publicKey: jwk.x, privateKey };
}

export async function derivePasskeyApprovalKey(credentialId?: string | null) {
  const credential = (await navigator.credentials.get({
    publicKey: {
      // This assertion never leaves the browser; it is only used to evaluate PRF.
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: 'required',
      ...(credentialId
        ? { allowCredentials: [{ type: 'public-key', id: decode64(credentialId) }] }
        : {}),
      extensions: { prf: { eval: { first: await prfSalt() } } },
    },
  })) as PublicKeyCredential | null;
  const first = credential?.getClientExtensionResults().prf?.results?.first;
  if (!credential || !first) throw new PrfUnavailableError();
  const output = new Uint8Array(first instanceof ArrayBuffer ? first : first.buffer.slice(0));
  const key = await approvalKeyFromPrf(output);
  output.fill(0);
  return { key, credentialId: base64url(new Uint8Array(credential.rawId)) };
}
