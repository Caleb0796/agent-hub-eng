import { memo } from 'react';
import { Activity, ClipboardCheck, Fingerprint, LogOut, Plus, Users } from 'lucide-react';
import { navigate } from './api';
import { lastSeen } from './seen';
import type { Dashboard, OwnerView } from './types';
import { Avatar } from './ui';

type Chat = Dashboard['chats'][number];

function ChatRow({ chat, active }: { chat: Chat; active: boolean }) {
  const unread = !active && !!chat.last_message_at && chat.last_message_at > lastSeen(chat.id);
  const attention = chat.awaiting_my_approval || chat.pending_drafts > 0;
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
            ? '想和你聊天'
            : chat.status === 'closed'
              ? '已关闭'
              : chat.status === 'pending'
                ? '等对方同意'
                : chat.paused
                  ? '已暂停'
                  : chat.same_owner
                    ? '我的两个 Agent'
                    : `通过 ${chat.my_agent.label}`}
        </small>
      </span>
      {chat.pending_drafts > 0 ? (
        <span className="count">{chat.pending_drafts}</span>
      ) : chat.awaiting_my_approval ? (
        <span className="count">1</span>
      ) : (
        unread && <span className="side-dot" aria-label="有新消息" />
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
      ? [{ path: '/review', label: '待你确认', icon: ClipboardCheck, count: drafts }]
      : []),
    { path: '/contacts', label: '好友', icon: Users, count: 0 },
    { path: '/agents', label: '我的 Agent', icon: Fingerprint, count: 0 },
    { path: '/activity', label: '活动记录', icon: Activity, count: 0 },
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
      <nav className="side-scroll" aria-label="聊天和工具">
        <div className="side-section">
          <span>聊天</span>
          <button className="side-add" aria-label="开始新聊天" onClick={() => navigate('/new')}>
            <Plus size={16} />
          </button>
        </div>
        {data?.chats.map((c) => (
          <ChatRow key={c.id} chat={c} active={path === `/chats/${c.id}`} />
        ))}
        {data && !data.chats.length && (
          <button className="side-hint" onClick={() => navigate('/new')}>
            还没有聊天，开始一个
          </button>
        )}
        <div className="side-section">
          <span>工具</span>
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
        <button className="side-add" aria-label="退出登录" onClick={onLogout}>
          <LogOut size={15} />
        </button>
      </div>
    </aside>
  );
});
