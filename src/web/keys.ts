import { base64url, signPayload } from '../shared/crypto';
import { validateOwnerPayload } from '../shared/authorization';
import { api } from './api';
import { derivePasskeyApprovalKey, PrfUnavailableError } from './prf';

export interface OwnerView {
  id: string;
  handle: string;
  name: string;
  signingKey: string;
  approvalKeyKind: 'browser' | 'passkey-prf';
  approvalCredentialId: string | null;
  approvalKeyReplaceable: boolean;
}
// 'local': this browser holds the key. 'passkey': it can be re-derived with the passkey.
export type SignMode = 'local' | 'passkey' | 'none';
interface StoredKey {
  publicKey: string;
  privateKey: CryptoKey;
}
const database = 'agent-hub-owner-keys';
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(database, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('无法保存本地授权密钥，请允许此站点使用浏览器存储'));
  });
}
async function read(key: string): Promise<StoredKey | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readonly'),
      req = tx.objectStore('keys').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}
async function write(key: string, value: StoredKey): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
// Generated before the user submits, so the click-to-WebAuthn gap stays short enough
// for browsers (notably Safari) that require a recent user activation.
export async function draftOwnerKey(): Promise<StoredKey> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  return {
    publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: pair.privateKey,
  };
}
export async function handleOwnerKey(handle: string): Promise<StoredKey | undefined> {
  return read(`handle:${handle}`);
}
export async function saveHandleOwnerKey(handle: string, value: StoredKey): Promise<void> {
  await write(`handle:${handle}`, value);
}
export async function bindOwnerKey(owner: OwnerView): Promise<boolean> {
  const existing = (await read(`owner:${owner.id}`)) ?? (await read(`handle:${owner.handle}`));
  if (!existing || existing.publicKey !== owner.signingKey) return false;
  await write(`owner:${owner.id}`, existing);
  return true;
}
export async function ownerCanSign(owner: OwnerView): Promise<SignMode> {
  if (await bindOwnerKey(owner)) return 'local';
  return owner.approvalKeyKind === 'passkey-prf' ? 'passkey' : 'none';
}
async function signingKey(owner: OwnerView): Promise<StoredKey> {
  const local = await read(`owner:${owner.id}`);
  if (local && local.publicKey === owner.signingKey) return local;
  if (owner.approvalKeyKind !== 'passkey-prf')
    throw new Error(
      '此浏览器没有你的授权密钥。请回到注册账号时使用的浏览器完成认领或授权，或在尚未认领时重置授权密钥。',
    );
  const { key } = await derivePasskeyApprovalKey(owner.approvalCredentialId);
  if (key.publicKey !== owner.signingKey)
    throw new Error('这个通行密钥派生的授权密钥与账号不一致，请使用注册时的那个通行密钥。');
  // Cache the non-extractable key so later approvals in this browser need no extra prompt.
  await write(`owner:${owner.id}`, key);
  return key;
}
export async function signOwner(owner: OwnerView, payload: unknown): Promise<string> {
  await validateOwnerPayload(owner.id, owner.signingKey, payload);
  return signPayload((await signingKey(owner)).privateKey, payload);
}

// Replaces the account's approval key with a passkey-derived one, falling back to a
// browser-held key when PRF is unavailable and `fallback` is allowed.
export async function replaceApprovalKey(
  owner: OwnerView,
  options: { credentialId?: string; fallback: boolean },
): Promise<OwnerView> {
  let key: StoredKey, keyKind: OwnerView['approvalKeyKind'], credentialId: string | null;
  try {
    const derived = await derivePasskeyApprovalKey(options.credentialId);
    key = derived.key;
    keyKind = 'passkey-prf';
    credentialId = derived.credentialId;
  } catch (error) {
    if (!(error instanceof PrfUnavailableError) || !options.fallback) throw error;
    key = await draftOwnerKey();
    keyKind = 'browser';
    credentialId = null;
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signPayload(key.privateKey, {
    kind: 'owner-approval-key',
    user_id: owner.id,
    signing_key: key.publicKey,
    key_kind: keyKind,
    credential_id: credentialId,
    issued_at: issuedAt,
  });
  const result = await api<{ owner: OwnerView }>('/api/auth/approval-key', 'POST', {
    signingKey: key.publicKey,
    keyKind,
    credentialId,
    issuedAt,
    signature,
  });
  await write(`owner:${owner.id}`, key);
  await write(`handle:${owner.handle}`, key);
  return result.owner;
}
