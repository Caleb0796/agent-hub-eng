// Which messages this browser has seen, for the sidebar's unread dot. A convenience only: losing
// it (private window, cleared storage) just makes old chats look unread once.
const key = (chatId: string) => `seen:${chatId}`;

export function lastSeen(chatId: string): number {
  try {
    return Number(localStorage.getItem(key(chatId))) || 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
export function markSeen(chatId: string, at: number): void {
  try {
    if (at > lastSeen(chatId)) localStorage.setItem(key(chatId), String(at));
  } catch {
    // Storage blocked: the dot simply stays off.
  }
}
