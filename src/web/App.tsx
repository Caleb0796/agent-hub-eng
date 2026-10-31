import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bell, X } from 'lucide-react';
import { api, ApiError, navigate } from './api';
import { ChatDetail } from './pages/ChatDetail';
import { usePoll } from './poll';
import { markSeen } from './seen';
import { Sidebar } from './Sidebar';
import type { Dashboard, OwnerView, Run } from './types';

// Only the chat view is in the first download; everything else loads when it is opened.
const Auth = lazy(async () => ({ default: (await import('./Auth')).Auth }));
const ActivityPage = lazy(async () => ({
  default: (await import('./pages/Activity')).ActivityPage,
}));
const AgentsPage = lazy(async () => ({ default: (await import('./pages/Agents')).AgentsPage }));
const ChatsPage = lazy(async () => ({ default: (await import('./pages/Chats')).ChatsPage }));
const ContactsPage = lazy(async () => ({
  default: (await import('./pages/Contacts')).ContactsPage,
}));
const InvitePage = lazy(async () => ({ default: (await import('./pages/Invite')).InvitePage }));
const RecoverPage = lazy(async () => ({ default: (await import('./pages/Recover')).RecoverPage }));
const ReviewPage = lazy(async () => ({ default: (await import('./pages/Review')).ReviewPage }));

// Requests and messages to confirm already show as badges in the sidebar.
const notificationText: Record<string, string> = {
  invite_accepted: '有人接受了你的邀请',
  chat_approved: '对方同意了你的聊天请求',
  connection_changed: '有好友的 Agent 连接变更过，不是对方本人操作的话请暂停聊天',
};

const pageTitles: Record<string, string> = {
  '/new': '开始新聊天',
  '/review': '待你确认',
  '/contacts': '好友',
  '/agents': '我的 Agent',
  '/activity': '活动记录',
};

export function App() {
  const [owner, setOwner] = useState<OwnerView | null>(null),
    [booting, setBooting] = useState(true),
    [data, setData] = useState<Dashboard | null>(null),
    [path, setPath] = useState(location.pathname),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const snapshot = useRef('');
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
    try {
      const next = await api<Dashboard>('/api/dashboard');
      // Pages reload when this object changes, so an identical poll must keep the old one.
      const text = JSON.stringify(next);
      if (text !== snapshot.current) {
        snapshot.current = text;
        setData(next);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'login_required') setOwner(null);
      else setError(e instanceof Error ? e.message : '无法更新状态');
    }
  }, []);
  usePoll(refresh, 6000, !!owner);
  const run: Run = useCallback(
    async (action) => {
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
    },
    [refresh],
  );
  const logout = useCallback(
    () =>
      void run(async () => {
        await api('/api/auth/logout', 'POST');
        setOwner(null);
        setData(null);
        snapshot.current = '';
      }),
    [run],
  );
  const openChatId = path.startsWith('/chats/') ? path.split('/')[2] : null;
  const openChatAt = data?.chats.find((c) => c.id === openChatId)?.last_message_at;
  useEffect(() => {
    if (openChatId && openChatAt) markSeen(openChatId, openChatAt);
  }, [openChatId, openChatAt]);
  // On a wide screen the home page is the most recent chat, as in Slack.
  const latestChat = data?.chats.find((c) => c.status !== 'closed')?.id;
  useEffect(() => {
    if (path === '/' && latestChat && matchMedia('(min-width: 761px)').matches) {
      history.replaceState({}, '', `/chats/${latestChat}`);
      setPath(`/chats/${latestChat}`);
    }
  }, [path, latestChat]);
  if (booting) return <div className="loading-page">正在打开 Agent Hub…</div>;
  const fallback = <div className="skeleton" />;
  if (path === '/i')
    return (
      <Suspense fallback={fallback}>
        <InvitePage owner={owner} data={data} run={run} busy={busy} onLogin={setOwner} />
      </Suspense>
    );
  if (path === '/recover' && !owner)
    return (
      <Suspense fallback={fallback}>
        <RecoverPage onLogin={setOwner} />
      </Suspense>
    );
  if (!owner || path === '/login')
    return (
      <Suspense fallback={fallback}>
        <Auth
          signedIn={!!owner}
          onLogin={(value) => {
            setOwner(value);
            if (path === '/login') navigate('/');
          }}
        />
      </Suspense>
    );
  const kinds = [...new Set((data?.notifications ?? []).map((n) => n.kind as string))].filter(
    (kind) => notificationText[kind],
  );
  const title = pageTitles[path];
  return (
    <div className={path === '/' ? 'app-shell at-home' : 'app-shell'}>
      <Sidebar owner={owner} data={data} path={path} onLogout={logout} />
      <div className="main-pane">
        {title && (
          <header className="page-bar only-mobile">
            <button className="icon-button" aria-label="返回聊天列表" onClick={() => navigate('/')}>
              <ArrowLeft size={20} />
            </button>
            <span>{title}</span>
          </header>
        )}
        {error && (
          <div className="error dismissible" role="alert">
            {error}
            <button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {kinds.length > 0 && (
          <div className="note-bar">
            <Bell size={16} />
            <span>{kinds.map((kind) => notificationText[kind]).join('；')}</span>
            <button
              className="text-button"
              onClick={() =>
                void run(async () => void (await api('/api/notifications/seen', 'POST')))
              }
            >
              知道了
            </button>
          </div>
        )}
        {openChatId ? (
          <ChatDetail key={openChatId} id={openChatId} run={run} busy={busy} />
        ) : (
          <main className="workspace">
            <Suspense fallback={fallback}>
              {!data ? (
                fallback
              ) : path === '/review' ? (
                <ReviewPage run={run} busy={busy} version={data} />
              ) : path === '/contacts' ? (
                <ContactsPage data={data} run={run} busy={busy} version={data} />
              ) : path === '/agents' ? (
                <AgentsPage data={data} run={run} busy={busy} />
              ) : path === '/activity' ? (
                <ActivityPage version={data} />
              ) : (
                <ChatsPage data={data} run={run} busy={busy} />
              )}
            </Suspense>
          </main>
        )}
      </div>
    </div>
  );
}
