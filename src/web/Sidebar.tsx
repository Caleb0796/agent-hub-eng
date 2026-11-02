import { memo } from 'react';
import {
  Activity,
  CircleCheck,
  ClipboardCheck,
  Fingerprint,
  LogOut,
  Plus,
  Users,
} from 'lucide-react';
import { navigate } from './api';
import { lastSeen } from './seen';
import type { Dashboard, OwnerView } from './types';
import { Avatar } from './ui';

type Chat = Dashboard['chats'][number];

function ChatRow({ chat, active }: { chat: Chat; active: boolean }) {
  const unread = !active && !!chat.last_message_at && chat.last_message_at > lastSeen(chat.id);
  const waiting = chat.pending_drafts + chat.reports_waiting;
  const attention = chat.awaiting_my_approval || waiting > 0;
  return (
    <button
      className={`side-chat${active ? ' active' : ''}${unread || attention ? ' unread' : ''}${chat.status === 'closed' ? ' closed' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate(`/chats/${chat.id}`)}
    >
      <Avatar
        kind="agent"
        name={chat.peer_agent.label}
        platform={chat.peer_agent.platform}
        size="small"
      />
      <span className="side-chat-text">
        <span>{chat.peer_agent.label}</span>
        <small>
          {chat.awaiting_my_approval
            ? 'Wants to chat with you'
            : chat.status === 'closed'
              ? 'Closed'
              : chat.status === 'pending'
                ? 'Waiting for them to approve'
                : chat.paused
                  ? 'Paused'
                  : chat.same_owner
                    ? 'Both my Agents'
                    : `Via ${chat.my_agent.label}`}
        </small>
      </span>
      {waiting > 0 ? (
        <span className="count">{waiting}</span>
      ) : chat.awaiting_my_approval ? (
        <span className="count">1</span>
      ) : (
        unread && <span className="side-dot" aria-label="New messages" />
      )}
    </button>
  );
}

export const Sidebar = memo(function Sidebar({
  owner,
  data,
  path,
  onLogout,
}: {
  owner: OwnerView;
  data: Dashboard | null;
  path: string;
  onLogout: () => void;
}) {
  const drafts = data?.pending.drafts ?? 0;
  const tools = [
    ...(drafts || path === '/review'
      ? [{ path: '/review', label: 'Awaiting review', icon: ClipboardCheck, count: drafts }]
      : []),
    { path: '/reports', label: 'Results', icon: CircleCheck, count: data?.reports_waiting ?? 0 },
    { path: '/contacts', label: 'Friends', icon: Users, count: 0 },
    { path: '/agents', label: 'My Agents', icon: Fingerprint, count: 0 },
    { path: '/activity', label: 'Activity', icon: Activity, count: 0 },
  ];
  return (
    <aside className="sidebar">
      <a
        className="side-brand"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
      >
        agent hub
      </a>
      <nav className="side-scroll" aria-label="Chats and tools">
        <div className="side-section">
          <span>Chats</span>
          <button
            className="side-add"
            aria-label="Start a new chat"
            onClick={() => navigate('/new')}
          >
            <Plus size={16} />
          </button>
        </div>
        {data?.chats.map((c) => (
          <ChatRow key={c.id} chat={c} active={path === `/chats/${c.id}`} />
        ))}
        {data && !data.chats.length && (
          <button className="side-hint" onClick={() => navigate('/new')}>
            No chats yet. Start one
          </button>
        )}
        <div className="side-section">
          <span>Tools</span>
        </div>
        {tools.map((t) => (
          <button
            key={t.path}
            className={path === t.path ? 'side-tool active' : 'side-tool'}
            aria-current={path === t.path ? 'page' : undefined}
            onClick={() => navigate(t.path)}
          >
            <t.icon size={16} />
            <span>{t.label}</span>
            {t.count > 0 && <span className="count">{t.count}</span>}
          </button>
        ))}
      </nav>
      <div className="side-me">
        <Avatar kind="owner" name={owner.name} size="small" />
        <strong>{owner.name}</strong>
        <button className="side-add" aria-label="Log out" onClick={onLogout}>
          <LogOut size={15} />
        </button>
      </div>
    </aside>
  );
});
