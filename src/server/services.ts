import { ChatService } from './chat';
import { wakeChat } from './runner';
import { Vault } from './vault';

const vaults = new WeakMap<Record<number, string>, Vault>();

export function chatService(env: Env, options: { inboxWaitMs?: number } = {}): ChatService {
  let vault = vaults.get(env.MESSAGE_KEYS);
  if (!vault) {
    vault = new Vault(env.MESSAGE_KEYS);
    vaults.set(env.MESSAGE_KEYS, vault);
  }
  const service: ChatService = new ChatService(env.DB, vault, {
    origin: env.PUBLIC_ORIGIN,
    inboxWaitMs: options.inboxWaitMs ?? (env.APP_ENV === 'test' ? 0 : undefined),
    afterMessage: (chatId) => wakeChat(env, service, chatId),
  });
  return service;
}
