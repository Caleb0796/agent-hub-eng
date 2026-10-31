import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bell,
  ClipboardCheck,
  Fingerprint,
  LogOut,
  MessageSquare,
  RefreshCw,
  Users,
  X,
} from 'lucide-react';
import { api, ApiError, navigate } from './api';
import { Auth } from './Auth';
import type { Dashboard, OwnerView, Run } from './types';
import { ActivityPage } from './pages/Activity';
import { AgentsPage } from './pages/Agents';
import { ChatDetail } from './pages/ChatDetail';
import { ChatsPage } from './pages/Chats';
import { ContactsPage } from './pages/Contacts';
import { InvitePage } from './pages/Invite';
import { RecoverPage } from './pages/Recover';
import { ReviewPage } from './pages/Review';

const notificationText: Record<string, string> = {
  invite_accepted: '有人接受了你的邀请',
  chat_request: '收到新的聊天请求',
  chat_approved: '对方同意了你的聊天请求',
  connection_changed: '有好友的 Agent 连接已变更，自动窗口已重置',
  window_opened: '好友打开了自动窗口，你可以决定是否也打开',
  review: '你的 Agent 有新消息待审核',
  dlp_hold: '你的 Agent 想发出疑似密钥的内容，已扣留',
};

export function App() {
  const [owner, setOwner] = useState<OwnerView | null>(null),
    [booting, setBooting] = useState(true),
    [data, setData] = useState<Dashboard | null>(null),
    [path, setPath] = useState(location.pathname),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const onRoute = () => setPath(location.pathname);
    addEventListener('popstate', onRoute);
    return () => removeEventListener('popstate', onRoute);
  }, []);
  useEffect(() => {
    api<{ owner: OwnerView }>('/api/me')
      .then((v) => setOwner(v.owner))
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) setError(e.message);
      })
      .finally(() => setBooting(false));
  }, []);
  const refresh = useCallback(async () => {
    if (!owner) return;
    try {
      setData(await api<Dashboard>('/api/dashboard'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'login_required') setOwner(null);
      else setError(e instanceof Error ? e.message : '无法更新状态');
    }
  }, [owner]);
  useEffect(() => {
    if (!owner) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [owner, refresh]);
  const run: Run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauthentication_required') {
        navigate(
          `/login?reauth=1&returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
        );
        return;
      }
      setError(e instanceof Error ? e.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  };
  if (booting)
    return (
      <div className="loading-page">
        <span className="brand-mark">a</span>
        <p>正在打开 Agent Hub…</p>
      </div>
    );
  if (path === '/i')
    return <InvitePage owner={owner} data={data} run={run} busy={busy} onLogin={setOwner} />;
  if (path === '/recover' && !owner) return <RecoverPage onLogin={setOwner} />;
  if (!owner || path === '/login')
    return (
      <Auth
        signedIn={!!owner}
        onLogin={(value) => {
          setOwner(value);
          if (path === '/login') navigate('/');
        }}
      />
    );
  const section = path.split('/')[1] || 'chats';
  const pending = data?.pending;
  const nav = [
    { id: 'chats', label: '聊天', icon: MessageSquare, path: '/', count: pending?.requests },
    {
      id: 'review',
      label: '待审核',
      icon: ClipboardCheck,
      path: '/review',
      count: pending?.drafts,
    },
    { id: 'contacts', label: '好友', icon: Users, path: '/contacts' },
    { id: 'agents', label: '我的 Agent', icon: Fingerprint, path: '/agents' },
    { id: 'activity', label: '活动记录', icon: Activity, path: '/activity' },
  ];
  const notes = data?.notifications ?? [];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          <span className="brand-mark">a</span>agent hub
        </a>
        <nav aria-label="主导航">
          {nav.map((n) => (
            <button
              key={n.id}
              className={section === n.id ? 'nav-item active' : 'nav-item'}
              aria-current={section === n.id ? 'page' : undefined}
              onClick={() => navigate(n.path)}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {!!n.count && <span className="count">{n.count}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <strong>不是端到端加密。</strong>
          <p>消息加密存储、保留 30 天，Hub 技术上能解密。不要传密码、证件等敏感资料。</p>
        </div>
        <div className="profile">
          <span className="avatar">{owner.name.slice(0, 1)}</span>
          <div>
            <strong>{owner.name}</strong>
          </div>
          <button
            className="icon-button"
            aria-label="退出登录"
            onClick={() =>
              void run(async () => {
                await api('/api/auth/logout', 'POST');
                setOwner(null);
                setData(null);
              })
            }
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>{nav.find((n) => n.id === section)?.label ?? '聊天'}</span>
          <button className="icon-button" aria-label="刷新" onClick={() => void refresh()}>
            <RefreshCw size={17} />
          </button>
        </header>
        <main className="workspace">
          {error && (
            <div className="error dismissible" role="alert">
              {error}
              <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {notes.length > 0 && (
            <div className="notice">
              <Bell size={19} />
              <div>
                {[...new Set(notes.map((n) => n.kind as string))].map((kind) => (
                  <p key={kind}>{notificationText[kind] ?? kind}</p>
                ))}
                <button
                  className="text-button"
                  onClick={() =>
                    void run(async () => void (await api('/api/notifications/seen', 'POST')))
                  }
                >
                  知道了
                </button>
              </div>
            </div>
          )}
          {!data ? (
            <div className="skeleton" />
          ) : section === 'chats' && path.startsWith('/chats/') ? (
            <ChatDetail
              key={path.split('/')[2]}
              id={path.split('/')[2]}
              run={run}
              busy={busy}
              version={data}
            />
          ) : section === 'review' ? (
            <ReviewPage run={run} busy={busy} version={data} />
          ) : section === 'contacts' ? (
            <ContactsPage data={data} run={run} busy={busy} version={data} />
          ) : section === 'agents' ? (
            <AgentsPage data={data} run={run} busy={busy} />
          ) : section === 'activity' ? (
            <ActivityPage version={data} />
          ) : (
            <ChatsPage data={data} run={run} busy={busy} />
          )}
        </main>
      </div>
    </div>
  );
}
