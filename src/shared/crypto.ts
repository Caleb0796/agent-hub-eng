export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Cannot canonicalize undefined');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function base64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (base64url(bytes) !== value) throw new Error('Non-canonical base64url');
  return bytes;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const raw = typeof value === 'string' ? utf8(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export async function fingerprint(value: unknown): Promise<string> {
  return sha256(canonical(value));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function verifySignature(
  publicKey: string,
  payload: unknown,
  signature: string,
): Promise<boolean> {
  try {
    const keyBytes = decode64(publicKey),
      sigBytes = decode64(signature);
    if (keyBytes.length !== 32 || sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, utf8(canonical(payload)));
  } catch {
    return false;
  }
}

export async function signPayload(key: CryptoKey, payload: unknown): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, utf8(canonical(payload)))),
  );
}

export function safetyCode(hash: string): string {
  return (
    hash
      .slice(0, 24)
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join(' ') ?? ''
  );
}
