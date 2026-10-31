import { env, server, TEST_MESSAGE_KEY } from './runtime';
import { randomToken, sha256 } from '../src/shared/crypto';
import type { Platform } from '../src/shared/protocol';
import { ChatService } from '../src/server/chat';
import { Vault } from '../src/server/vault';

export const base = 'http://localhost:8789';

export async function seedOwner(name: string) {
  const id = crypto.randomUUID(),
    at = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)')
    .bind(id, name, at)
    .run();
  const cookie = randomToken(),
    csrf = randomToken();
  await env.DB.prepare(
    'INSERT INTO browser_sessions(token_hash,user_id,csrf_hash,authenticated_at,expires_at) VALUES(?,?,?,?,?)',
  )
    .bind(await sha256(cookie), id, await sha256(csrf), at, at + 86400)
    .run();
  return { id, name, cookie, csrf };
}
export type TestOwner = Awaited<ReturnType<typeof seedOwner>>;

export function ownerHeaders(u: TestOwner, csrf = true) {
  return {
    Origin: base,
    Cookie: `agent-hub-local-session=${u.cookie}; agent-hub-csrf=${u.csrf}`,
    ...(csrf ? { 'X-CSRF-Token': u.csrf } : {}),
    'Content-Type': 'application/json',
  };
}

/** Owner REST calls through the real HTTP stack. */
export async function ownerCall<T = unknown>(
  u: TestOwner,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await server.fetch(`${base}${path}`, {
    method,
    headers: ownerHeaders(u),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** A ChatService on the shared test database with a controllable clock. */
export function service(clock = { now: Math.floor(Date.now() / 1000) }) {
  return {
    clock,
    chats: new ChatService(env.DB, new Vault({ 1: TEST_MESSAGE_KEY }), {
      origin: base,
      now: () => clock.now,
      inboxWaitMs: 0,
    }),
  };
}

export async function connectedAgent(chats: ChatService, u: TestOwner, platform: Platform = 'dot') {
  const a = await chats.createAgent(u.id, platform);
  return chats.onAuthorized(u.id, a.id, `client-${a.id}`);
}

/** Two owners who became contacts through an invite, with one open chat between their Agents. */
export async function friends(platforms: [Platform, Platform] = ['dot', 'muse']) {
  const s = service();
  const alice = await seedOwner('Alice'),
    bob = await seedOwner('Bob');
  const a = await connectedAgent(s.chats, alice, platforms[0]),
    b = await connectedAgent(s.chats, bob, platforms[1]);
  const invite = await s.chats.createInvite(alice.id, a.id);
  const token = new URL(invite.url).hash.slice(1);
  const accepted = await s.chats.acceptInvite(bob.id, token, b.id);
  return { ...s, alice, bob, a, b, chatId: accepted.chat_id!, contactId: accepted.contact_id };
}
