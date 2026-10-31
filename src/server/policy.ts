// The only place permission decisions are made. Pure functions over rows read by chat.ts;
// identities come from the OAuth token or the owner's login session, never from message text.

export type Decision =
  { kind: 'allow' } | { kind: 'hold'; reason: 'review' | 'dlp' } | { kind: 'deny'; code: DenyCode };

export type DenyCode =
  | 'not_found'
  | 'chat_not_open'
  | 'chat_paused'
  | 'blocked'
  | 'peer_retired'
  | 'agent_retired'
  | 'review_queue_full'
  | 'agent_run_limit'
  | 'not_receiver'
  | 'not_paused_by_you'
  | 'already_closed';

export const REVIEW_QUEUE_LIMIT = 20;
// Agent messages in a row, within AGENT_RUN_SECONDS, before Agents must wait for an owner to speak.
// Two autonomous Agents can answer each other forever; this stops them without asking for approval.
export const AGENT_RUN_LIMIT = 40;
export const AGENT_RUN_SECONDS = 3600;
// Agents the Hub runs spend a model call per turn, so they wait for a person much sooner.
export const HUB_RUN_LIMIT = 12;

export interface SideState {
  agent_id: string;
  owner_id: string;
  paused_at: number | null;
  review_required: number;
}
export interface ChatState {
  status: 'pending' | 'open' | 'closed';
  requested_by: string | null;
  same_owner: number;
  sides: [SideState, SideState];
  agentStatus: Record<string, 'active' | 'revoked'>;
  blocked: boolean;
}

const allow: Decision = { kind: 'allow' };
const deny = (code: DenyCode): Decision => ({ kind: 'deny', code });

export function sideOf(chat: ChatState, agentId: string): SideState | undefined {
  return chat.sides.find((s) => s.agent_id === agentId);
}
export function ownsSide(chat: ChatState, ownerId: string): boolean {
  return chat.sides.some((s) => s.owner_id === ownerId);
}

// Shared by send-time and delivery-time checks (both are required).
function liveChat(chat: ChatState, agentId?: string): Decision {
  if (chat.status !== 'open') return deny('chat_not_open');
  for (const side of chat.sides)
    if (chat.agentStatus[side.agent_id] !== 'active')
      return deny(side.agent_id === agentId ? 'agent_retired' : 'peer_retired');
  if (chat.blocked) return deny('blocked');
  if (chat.sides.some((s) => s.paused_at)) return deny('chat_paused');
  return allow;
}

/**
 * Agents act for their owners, so sends go out directly. Only three things stop one: the owner
 * asked to see this chat's sends first, the text looks like a credential, or two Agents have been
 * talking alone for too long. Message text never changes any of this.
 */
export function canAgentSend(
  chat: ChatState,
  agentId: string,
  input: { dlpHits: string[]; pendingDrafts: number; recentAgentRun: number },
): Decision {
  const side = sideOf(chat, agentId);
  if (!side) return deny('not_found');
  const live = liveChat(chat, agentId);
  if (live.kind !== 'allow') return live;
  if (input.recentAgentRun >= AGENT_RUN_LIMIT) return deny('agent_run_limit');
  if (!input.dlpHits.length && !side.review_required) return allow;
  if (input.pendingDrafts >= REVIEW_QUEUE_LIMIT) return deny('review_queue_full');
  return { kind: 'hold', reason: input.dlpHits.length ? 'dlp' : 'review' };
}

/** A report reaches only the Agent's own owner, so it needs no live chat and no review. */
export function canAgentReport(chat: ChatState, agentId: string): Decision {
  if (!sideOf(chat, agentId)) return deny('not_found');
  return chat.agentStatus[agentId] === 'active' ? allow : deny('agent_retired');
}

export function canDeliver(
  chat: ChatState,
  message: { withheld_at: number | null; expires_at: number },
  now: number,
): boolean {
  return liveChat(chat).kind === 'allow' && !message.withheld_at && message.expires_at > now;
}

export type OwnerAction =
  | 'read'
  | 'owner_send'
  | 'approve_request'
  | 'reject_request'
  | 'close'
  | 'pause'
  | 'resume'
  | 'set_review'
  | 'set_grant'
  | 'clear';

// `agentId` names the side an action targets (the owner's own Agent in this chat).
export function canOwnerAct(
  chat: ChatState,
  ownerId: string,
  action: OwnerAction,
  agentId?: string,
): Decision {
  if (!ownsSide(chat, ownerId)) return deny('not_found');
  const mine = agentId
    ? chat.sides.find((s) => s.agent_id === agentId && s.owner_id === ownerId)
    : chat.sides.find((s) => s.owner_id === ownerId);
  switch (action) {
    case 'read':
    case 'clear':
      return allow;
    case 'owner_send':
      // Owner messages are stored while paused and delivered after resume.
      return chat.status === 'open' && !chat.blocked ? allow : deny('chat_not_open');
    case 'approve_request':
    case 'reject_request':
      if (chat.status !== 'pending') return deny('chat_not_open');
      return chat.requested_by === ownerId ? deny('not_receiver') : allow;
    case 'close':
      return chat.status === 'closed' ? deny('already_closed') : allow;
    case 'pause':
      return chat.status === 'open' && mine ? allow : deny('chat_not_open');
    case 'resume':
      return mine?.paused_at ? allow : deny('not_paused_by_you');
    case 'set_review':
    case 'set_grant':
      if (!mine) return deny('not_found');
      return chat.status === 'open' ? allow : deny('chat_not_open');
  }
}
