import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { api, navigate } from '../api';
import { Composer, type ComposerHandle, type Person } from '../chat/Composer';
import { DraftRow, MessageRow, ReportRow } from '../chat/MessageRow';
import { ChatSettings } from '../chat/Settings';
import { ChatTasks } from '../chat/Tasks';
import { AGENT_ONLINE_SECONDS } from '../../shared/constants';
import { usePoll, useWatch } from '../poll';
import type { ChatView, Run } from '../types';
import { Avatar, day, runErrorText, when } from '../ui';

const GROUP_SECONDS = 300;
const RECENT_CHANGE_SECONDS = 7 * 86400;

/** Whether anyone is actually there, because a silent Agent otherwise looks broken. */
function presence(side: ChatView['sides'][number]): string {
  if (side.working) return 'replying…';
  if (side.runner === 'hub') return 'online';
  if (!side.last_seen_at) return 'never been online';
  return Date.now() / 1000 - side.last_seen_at < AGENT_ONLINE_SECONDS
    ? 'online'
    : `last active ${when(side.last_seen_at)}, replies once it's back online`;
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
  // The watch brings changes at once; this slow poll keeps "last active" honest and is the
  // fallback if the watch ever stops getting through.
  useWatch(`/api/chats/${id}/watch`, load);
  usePoll(load, 20000);
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
          "Once withdrawn, the other Agent won't receive it. The other owner may have already seen it, and your own Agent may have received it too. Withdraw this message?",
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
        role: s.mine ? 'My Agent' : `${s.owner_name}'s Agent`,
      })),
      ...owners
        .filter((s) => !s.mine)
        .map((s) => ({
          kind: 'owner' as const,
          name: s.owner_name,
          role: 'Other owner',
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
      <div className="skeleton" aria-label="Opening chat" />
    );

  const mine = chat.sides.filter((s) => s.mine),
    me = mine[0],
    peer = chat.sides.find((s) => !s.mine) ?? chat.sides[1];
  const title = chat.same_owner ? `${me.agent_label} and ${peer.agent_label}` : peer.agent_label;
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
      .then(load, (e: Error) => setError(`Couldn't send: ${e.message}`))
      .finally(() => setSending((list) => list.filter((s) => s.key !== key)));
  };

  return (
    <div className="chat">
      <div className="chat-main">
        <header className="chat-head">
          <button
            className="icon-button only-mobile"
            aria-label="Back to chats"
            onClick={() => navigate('/')}
          >
            <ArrowLeft size={20} />
          </button>
          <Avatar kind="agent" name={peer.agent_label} platform={peer.platform} />
          <div className="chat-title">
            <h1>{title}</h1>
            <p>
              {chat.same_owner
                ? 'Both my Agents'
                : `${peer.owner_name}'s Agent: ${presence(peer)}. Your side is ${me.agent_label}: ${presence(me)}`}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Chat settings"
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
                ? 'You can start chatting once the other owner approves.'
                : `${peer.owner_name} (they chose this name) wants ${peer.agent_label} to chat with your ${me.agent_label}.`}
            </span>
            {!chat.requested_by_me && (
              <span className="button-row">
                <button
                  className="button primary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/approve`)}
                >
                  Approve
                </button>
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/reject`)}
                >
                  Reject
                </button>
              </span>
            )}
          </div>
        )}
        {chat.status === 'closed' && (
          <div className="chat-banner">
            <span>
              This chat is closed. Messages not yet fetched won&apos;t be sent to any Agent.
              Reopening needs the other owner to approve.
            </span>
            {!chat.same_owner && !chat.blocked && (
              <button
                className="button secondary compact"
                disabled={busy}
                onClick={() =>
                  act('/api/chats', { agentId: me.agent_id, peerAgentId: peer.agent_id })
                }
              >
                Request to reopen
              </button>
            )}
          </div>
        )}
        {chat.status === 'open' && paused && (
          <div className="chat-banner">
            <span>
              {pausedByMe.length
                ? 'You paused this chat, so neither Agent can send or receive. Messages you send will be delivered once it resumes.'
                : 'The other owner paused this chat, so neither Agent can send or receive.'}
            </span>
            {pausedByMe.map((s) => (
              <button
                key={s.agent_id}
                className="button secondary compact"
                disabled={busy}
                onClick={() => act(`/api/chats/${id}/resume`, { agentId: s.agent_id })}
              >
                Resume
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
            platform={me.runner === 'platform' ? me.platform : undefined}
            peer={peer}
            run={run}
            busy={busy}
            onChanged={load}
          />
        )}
        {chat.agent_run_limited && (
          <div className="chat-banner">
            <span>
              The two Agents have been chatting for a long time, so they stopped to wait for a
              person. Send a message to continue, or they&apos;ll resume in 1 hour.
            </span>
          </div>
        )}
        {changed && (
          <div className="chat-banner">
            <span>
              The other Agent&apos;s connection changed at {when(changed.connection_changed_at)}. If
              the other owner did not do this, pause the chat.
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
              <strong>Say something, or give your Agent a task</strong>
              <p>
                {chat.same_owner
                  ? 'Send a message to tell your Agent what to do.'
                  : `Tell your Agent what to do, or @${peer.agent_label} to talk to it directly.`}
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
                  <time>Sending</time>
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
              {s.agent_label} is replying…
            </div>
          ))}
        </div>
        {chat.status === 'open' && (
          <Composer
            ref={composer}
            people={people}
            placeholder={`Message ${me.agent_label}, or use @ to bring in someone else or another Agent`}
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
            if (
              confirm(
                'Closing holds back messages not yet fetched, and reopening needs the other owner to approve. Close this chat?',
              )
            )
              act(`/api/chats/${id}/close`);
          }}
        />
      )}
    </div>
  );
}
