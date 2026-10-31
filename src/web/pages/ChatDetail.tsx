import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { api, navigate } from '../api';
import { Composer, type ComposerHandle, type Person } from '../chat/Composer';
import { DraftRow, MessageRow, ReportRow } from '../chat/MessageRow';
import { ChatSettings } from '../chat/Settings';
import { ChatTasks } from '../chat/Tasks';
import { usePoll } from '../poll';
import type { ChatView, Run } from '../types';
import { Avatar, day, runErrorText, when } from '../ui';

const GROUP_SECONDS = 300;
const RECENT_CHANGE_SECONDS = 7 * 86400;
const ONLINE_SECONDS = 120;

/** Whether anyone is actually there, because a silent Agent otherwise looks broken. */
function presence(side: ChatView['sides'][number]): string {
  if (side.working) return '正在回复…';
  if (side.runner === 'hub') return '在线';
  if (!side.last_seen_at) return '还没上线过';
  return Date.now() / 1000 - side.last_seen_at < ONLINE_SECONDS
    ? '在线'
    : `${when(side.last_seen_at)} 活跃，上线后才会回复`;
}

export function ChatDetail({ id, run, busy }: { id: string; run: Run; busy: boolean }) {
  const [chat, setChat] = useState<ChatView | null>(null),
    [error, setError] = useState(''),
    [settings, setSettings] = useState(false),
    [sending, setSending] = useState<{ key: number; text: string }[]>([]);
  const snapshot = useRef('');
  const stream = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    composer = useRef<ComposerHandle>(null),
    sendKey = useRef(0);
  const load = useCallback(
    () =>
      api<ChatView>(`/api/chats/${id}`).then(
        (v) => {
          // An unchanged poll must not re-render the whole conversation.
          const next = JSON.stringify(v);
          if (next !== snapshot.current) {
            snapshot.current = next;
            setChat(v);
          }
          setError('');
        },
        (e: Error) => setError(e.message),
      ),
    [id],
  );
  usePoll(load, 3000);
  const act = useCallback(
    (path: string, body?: unknown) =>
      void run(async () => {
        await api(path, 'POST', body);
        await load();
      }),
    [run, load],
  );
  const onWithdraw = useCallback(
    (messageId: string) => {
      if (
        confirm(
          '撤回后对方的 Agent 不会再收到。对方主人可能已经看到，你自己的 Agent 也可能已收到。',
        )
      )
        act(`/api/messages/${messageId}/withdraw`);
    },
    [act],
  );
  const onDecide = useCallback(
    (draftId: string, decision: 'approve' | 'reject') => act(`/api/drafts/${draftId}/${decision}`),
    [act],
  );
  const onMention = useCallback((name: string) => composer.current?.mention(name), []);

  const sides = chat?.sides;
  const { names, myNames, people, platforms } = useMemo(() => {
    const list = sides ?? [];
    const owners = [...new Map(list.map((s) => [s.owner_id, s])).values()];
    const everyone: Person[] = [
      ...list.map((s) => ({
        kind: 'agent' as const,
        name: s.agent_label,
        platform: s.platform,
        role: s.mine ? '我的 Agent' : `${s.owner_name} 的 Agent`,
      })),
      ...owners
        .filter((s) => !s.mine)
        .map((s) => ({
          kind: 'owner' as const,
          name: s.owner_name,
          role: '对方主人',
        })),
    ];
    return {
      names: [...list.map((s) => s.agent_label), ...owners.map((s) => s.owner_name)],
      myNames: owners.filter((s) => s.mine).map((s) => s.owner_name),
      people: everyone,
      platforms: Object.fromEntries(list.map((s) => [s.agent_id, s.platform])),
    };
  }, [sides]);

  const count =
    (chat?.messages.length ?? 0) +
    (chat?.drafts.length ?? 0) +
    (chat?.reports.length ?? 0) +
    (chat?.sides.filter((s) => s.working).length ?? 0) +
    sending.length;
  // Opening the chat is reading what the Agent reported here.
  const unreadReports = chat?.reports.filter((r) => !r.read).length ?? 0;
  useEffect(() => {
    if (unreadReports) void api(`/api/chats/${id}/reports/read`, 'POST').catch(() => undefined);
  }, [id, unreadReports]);
  // Follows new messages unless the owner has scrolled up to read older ones.
  useLayoutEffect(() => {
    const el = stream.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  // Banners, the settings panel and the keyboard all resize the stream.
  const loaded = !!chat;
  useEffect(() => {
    const el = stream.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded]);

  if (!chat)
    return error ? (
      <div className="error">{error}</div>
    ) : (
      <div className="skeleton" aria-label="正在打开聊天" />
    );

  const mine = chat.sides.filter((s) => s.mine),
    me = mine[0],
    peer = chat.sides.find((s) => !s.mine) ?? chat.sides[1];
  const title = chat.same_owner ? `${me.agent_label} 和 ${peer.agent_label}` : peer.agent_label;
  const pausedByMe = mine.filter((s) => s.paused),
    paused = chat.sides.some((s) => s.paused);
  const changed = chat.sides.find(
    (s) =>
      !s.mine &&
      s.connection_changed_at &&
      Date.now() / 1000 - s.connection_changed_at < RECENT_CHANGE_SECONDS,
  );
  const lastMine = chat.messages.findLast((m) => m.mine)?.id;
  const runError = mine.map((s) => s.run_error).find(Boolean);
  const working = chat.sides.filter((s) => s.working);
  const friend = chat.same_owner ? peer.agent_label : peer.owner_name;
  const sideOf = (agentId: string) => chat.sides.find((s) => s.agent_id === agentId);
  const reportRow = (r: ChatView['reports'][number]) => (
    <ReportRow
      key={r.id}
      r={r}
      name={sideOf(r.agent_id)?.agent_label ?? 'Agent'}
      platform={sideOf(r.agent_id)?.platform}
    />
  );
  let nextReport = 0;
  const reportsBefore = (at: number) => {
    const from = nextReport;
    while (nextReport < chat.reports.length && chat.reports[nextReport].created_at < at)
      nextReport++;
    return chat.reports.slice(from, nextReport).map(reportRow);
  };

  const send = (text: string) => {
    pinned.current = true;
    const key = ++sendKey.current;
    setSending((list) => [...list, { key, text }]);
    void api(`/api/chats/${id}/messages`, 'POST', { text })
      .then(load, (e: Error) => setError(`没有发出去：${e.message}`))
      .finally(() => setSending((list) => list.filter((s) => s.key !== key)));
  };

  return (
    <div className="chat">
      <div className="chat-main">
        <header className="chat-head">
          <button
            className="icon-button only-mobile"
            aria-label="返回聊天列表"
            onClick={() => navigate('/')}
          >
            <ArrowLeft size={20} />
          </button>
          <Avatar kind="agent" name={peer.agent_label} platform={peer.platform} />
          <div className="chat-title">
            <h1>{title}</h1>
            <p>
              {chat.same_owner
                ? '我的两个 Agent'
                : `${peer.owner_name} 的 Agent，${presence(peer)}。你这边是 ${me.agent_label}，${presence(me)}`}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="聊天设置"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={19} />
          </button>
        </header>
        {error && (
          <div className="chat-banner bad" role="alert">
            {error}
          </div>
        )}
        {chat.status === 'pending' && (
          <div className="chat-banner">
            <span>
              {chat.requested_by_me
                ? '等对方主人同意后才能开始聊天。'
                : `${peer.owner_name}（名字由本人填写）想让 ${peer.agent_label} 和你的 ${me.agent_label} 聊天。`}
            </span>
            {!chat.requested_by_me && (
              <span className="button-row">
                <button
                  className="button primary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/approve`)}
                >
                  同意
                </button>
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/reject`)}
                >
                  拒绝
                </button>
              </span>
            )}
          </div>
        )}
        {chat.status === 'closed' && (
          <div className="chat-banner">
            <span>聊天已关闭，还没被收走的消息不会再发给 Agent。重新开启需要对方同意。</span>
            {!chat.same_owner && !chat.blocked && (
              <button
                className="button secondary compact"
                disabled={busy}
                onClick={() =>
                  act('/api/chats', { agentId: me.agent_id, peerAgentId: peer.agent_id })
                }
              >
                请求重新开启
              </button>
            )}
          </div>
        )}
        {chat.status === 'open' && paused && (
          <div className="chat-banner">
            <span>
              {pausedByMe.length
                ? '你暂停了这个聊天，两边的 Agent 都收发不了。你发的消息会在恢复后送达。'
                : '对方主人暂停了这个聊天，两边的 Agent 都收发不了。'}
            </span>
            {pausedByMe.map((s) => (
              <button
                key={s.agent_id}
                className="button secondary compact"
                disabled={busy}
                onClick={() => act(`/api/chats/${id}/resume`, { agentId: s.agent_id })}
              >
                解除暂停
              </button>
            ))}
          </div>
        )}
        {runError && (
          <div className="chat-banner">
            <span>{runErrorText(runError)}</span>
          </div>
        )}
        {chat.status === 'open' && (
          <ChatTasks
            chat={chat}
            agentId={me.agent_id}
            agentName={me.agent_label}
            friend={friend}
            run={run}
            busy={busy}
            onChanged={load}
          />
        )}
        {chat.agent_run_limited && (
          <div className="chat-banner">
            <span>
              两边的 Agent 已经连续聊了很久，先停下来等人。你发一条消息就能继续，否则 1 小时后恢复。
            </span>
          </div>
        )}
        {changed && (
          <div className="chat-banner">
            <span>
              对方 Agent 的连接在 {when(changed.connection_changed_at)}{' '}
              变更过。不是对方主人本人操作的话，请暂停聊天。
            </span>
          </div>
        )}
        <div
          className="chat-stream"
          ref={stream}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!count && !chat.grants.length && (
            <div className="chat-empty">
              <strong>说点什么，或者交给 Agent 一件事</strong>
              <p>
                {chat.same_owner
                  ? '发一条消息，告诉你的 Agent 要做什么。'
                  : `告诉你的 Agent 要做什么，或者 @${peer.agent_label} 直接和它说话。`}
              </p>
            </div>
          )}
          {chat.messages.map((m, i) => {
            const prev = chat.messages[i - 1];
            const newDay = !prev || day(prev.sent_at) !== day(m.sent_at);
            const continued =
              !!prev &&
              !newDay &&
              prev.sender_name === m.sender_name &&
              prev.sender_kind === m.sender_kind &&
              m.sent_at - prev.sent_at < GROUP_SECONDS;
            return (
              <div key={m.id}>
                {reportsBefore(m.sent_at)}
                {newDay && (
                  <div className="day-line">
                    <span>{day(m.sent_at)}</span>
                  </div>
                )}
                <MessageRow
                  m={m}
                  continued={continued}
                  last={m.id === lastMine}
                  platform={m.sender_agent_id ? platforms[m.sender_agent_id] : undefined}
                  names={names}
                  myNames={myNames}
                  onWithdraw={onWithdraw}
                  onMention={onMention}
                />
              </div>
            );
          })}
          {reportsBefore(Infinity)}
          {sending.map((s) => (
            <div className="msg sending" key={s.key}>
              <div className="msg-gutter">
                <Avatar kind="owner" name={myNames[0] ?? ''} />
              </div>
              <div className="msg-body">
                <div className="msg-head">
                  <span className="msg-name plain">{myNames[0]}</span>
                  <time>发送中</time>
                </div>
                <div className="msg-text">{s.text}</div>
              </div>
            </div>
          ))}
          {chat.drafts.map((d) => {
            const side = chat.sides.find((s) => s.agent_id === d.agent_id);
            return (
              <DraftRow
                key={d.id}
                d={d}
                name={side?.agent_label ?? 'Agent'}
                platform={side?.platform}
                names={names}
                myNames={myNames}
                busy={busy}
                onDecide={onDecide}
              />
            );
          })}
          {working.map((s) => (
            <div className="typing" key={s.agent_id}>
              <span aria-hidden="true" />
              {s.agent_label} 正在回复…
            </div>
          ))}
        </div>
        {chat.status === 'open' && (
          <Composer
            ref={composer}
            people={people}
            placeholder={`发消息给 ${me.agent_label}，用 @ 叫其他人或 Agent`}
            onSend={send}
          />
        )}
      </div>
      {settings && (
        <ChatSettings
          chat={chat}
          busy={busy}
          onClose={() => setSettings(false)}
          act={act}
          onCloseChat={() => {
            if (confirm('关闭后，还没被收走的消息会被扣下，重新开启需要对方同意。要关闭吗？'))
              act(`/api/chats/${id}/close`);
          }}
        />
      )}
    </div>
  );
}
