import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { base64url, decode64, utf8 } from '../shared/crypto';
import { HubError } from './common';

// Application-layer AES-256-GCM for message bodies. Keys live in environment variables,
// separate from the database. The AAD binds a ciphertext to its chat and message so a
// stored value cannot be moved to another row. This is not end-to-end encryption: the
// Hub holds the keys.
export class Vault {
  readonly current: number;
  private keys = new Map<number, Buffer>();

  constructor(keys: Record<number, string>) {
    for (const [version, encoded] of Object.entries(keys)) {
      const key = Buffer.from(decode64(encoded));
      if (key.length !== 32) throw new Error(`MESSAGE_KEY_V${version} must be 32 bytes`);
      this.keys.set(Number(version), key);
    }
    if (!this.keys.size) throw new Error('At least one MESSAGE_KEY_V<n> is required');
    this.current = Math.max(...this.keys.keys());
  }

  seal(
    text: string,
    aad: string,
    version = this.current,
  ): { ciphertext: string; keyVersion: number } {
    const key = this.key(version),
      iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(utf8(aad));
    const body = Buffer.concat([cipher.update(utf8(text)), cipher.final()]);
    return {
      ciphertext: base64url(Buffer.concat([iv, body, cipher.getAuthTag()])),
      keyVersion: version,
    };
  }

  open(ciphertext: string, aad: string, version: number): string {
    const raw = Buffer.from(decode64(ciphertext)),
      decipher = createDecipheriv('aes-256-gcm', this.key(version), raw.subarray(0, 12));
    decipher.setAAD(utf8(aad));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  }

  private key(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new HubError('key_unavailable', 503, '消息密钥不可用');
    return key;
  }
}

export const messageAad = (chatId: string, id: string) => `message|${chatId}|${id}`;
export const draftAad = (chatId: string, id: string) => `draft|${chatId}|${id}`;
export const grantAad = (agentId: string, id: string) => `grant|${agentId}|${id}`;
export const reportAad = (chatId: string, id: string) => `report|${chatId}|${id}`;

export function messageKeysFrom(
  source: Record<string, string | undefined>,
): Record<number, string> {
  const keys: Record<number, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const match = /^MESSAGE_KEY_V(\d{1,3})$/.exec(name);
    if (match && value) keys[Number(match[1])] = value;
  }
  return keys;
}
