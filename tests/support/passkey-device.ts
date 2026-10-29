import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { base64url, decode64, utf8 } from '../../src/shared/crypto';

const base = 'http://localhost:8789';
function bytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function counter(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
function der(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const integer = (v: Uint8Array) => {
    let start = 0;
    while (start < v.length - 1 && v[start] === 0) start++;
    let r = v.slice(start);
    if (r[0] & 0x80) r = bytes(new Uint8Array([0]), r);
    return bytes(new Uint8Array([2, r.length]), r);
  };
  const body = bytes(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return bytes(new Uint8Array([0x30, body.length]), body);
}
export class Browser {
  constructor(private fetcher: (input: string, init?: RequestInit) => Promise<Response>) {}
  cookies = new Map<string, string>();
  async post(path: string, body: unknown) {
    const response = await this.fetcher(base + path, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': this.cookies.get('agent-hub-csrf') ?? '',
      },
      body: JSON.stringify(body),
    });
    for (const c of response.headers.getSetCookie()) {
      const first = c.split(';')[0],
        eq = first.indexOf('=');
      const name = first.slice(0, eq),
        value = first.slice(eq + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return response;
  }
}
export async function authenticator() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]),
    publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const credential = crypto.getRandomValues(new Uint8Array(32)),
    rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8('localhost')));
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, decode64(publicJwk.x!)],
    [-3, decode64(publicJwk.y!)],
  ]);
  return {
    id: base64url(credential),
    register(challenge: string, origin = base): RegistrationResponseJSON {
      const authData = bytes(
        rpHash,
        new Uint8Array([0x45]),
        counter(0),
        new Uint8Array(16),
        new Uint8Array([0, credential.length]),
        credential,
        new Uint8Array(isoCBOR.encode(cose)),
      );
      const object = new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['authData', authData],
        ['attStmt', new Map()],
      ]);
      return {
        id: base64url(credential),
        rawId: base64url(credential),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: base64url(
            utf8(
              JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
            ),
          ),
          attestationObject: base64url(new Uint8Array(isoCBOR.encode(object))),
          transports: ['internal'],
        },
      };
    },
    async login(
      challenge: string,
      userHandle: string,
      count = 1,
      origin = base,
    ): Promise<AuthenticationResponseJSON> {
      const clientData = utf8(
          JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
        ),
        authData = bytes(rpHash, new Uint8Array([0x05]), counter(count));
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.privateKey,
          bytes(authData, new Uint8Array(await crypto.subtle.digest('SHA-256', clientData))),
        ),
      );
      return {
        id: base64url(credential),
        rawId: base64url(credential),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(clientData),
          authenticatorData: base64url(authData),
          signature: base64url(der(signature)),
          userHandle,
        },
      };
    },
  };
}
