import { base64url, signPayload } from '../shared/crypto';
import { validateOwnerPayload } from '../shared/authorization';

export interface OwnerView {
  id: string;
  handle: string;
  name: string;
  signingKey: string;
}
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
export async function ownerCanSign(owner: OwnerView): Promise<boolean> {
  return bindOwnerKey(owner);
}
export async function signOwner(owner: OwnerView, payload: unknown): Promise<string> {
  const key = await read(`owner:${owner.id}`);
  if (!key || key.publicKey !== owner.signingKey)
    throw new Error(
      '此浏览器没有你的授权密钥。请回到注册账号时使用的浏览器完成认领或授权；登录恢复不会替换密钥。',
    );
  await validateOwnerPayload(owner.id, key.publicKey, payload);
  return signPayload(key.privateKey, payload);
}
