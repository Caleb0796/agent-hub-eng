import type { ChatService } from '../server/chat';

export type OwnerView = { id: string; name: string };
export type Dashboard = Awaited<ReturnType<ChatService['dashboard']>>;
export type ChatView = Awaited<ReturnType<ChatService['ownerChat']>>;
export type ReviewItem = Awaited<ReturnType<ChatService['reviewQueue']>>[number];
export type Contact = Awaited<ReturnType<ChatService['contacts']>>[number];
export type Invite = {
  id: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  agent_label: string | null;
};
export type Run = (action: () => Promise<void>) => Promise<void>;
