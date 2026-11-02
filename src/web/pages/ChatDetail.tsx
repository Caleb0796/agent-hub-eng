import { useCallback, useEffect, useState } from 'react';
import { Check, Pause, Play, Send, Timer, X } from 'lucide-react';
import { api, navigate } from '../api';
import type { ChatView, Run } from '../types';
import { Badge, PlatformMark, platformName, when } from '../ui';

const windows = [
  [10, '10 min'],
  [60, '1 hour'],
  [1440, '24 hours'],
] as const;

export function ChatDetail({
  id,
  run,
  busy,
  version,
}: {
  id: string;
  run: Run;
  busy: boolean;
  version: unknown;
}) {
  const [chat, setChat] = useState<ChatView | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState('');
  const load = useCallback(
    () =>
      api<ChatView>(`/api/chats/${id}`)
        .then((v) => {
          setChat(v);
          setError('');
        })
        .catch((e: Error) => setError(e.message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load, version]);
  const act = (path: string, body?: unknown) =>
    void run(async () => {
      await api(path, 'POST', body);
      await load();
    });
  // After a failed refresh keep showing the last loaded chat, with the error above it.
  if (error && !chat) return <div className="error">{error}</div>;
  if (!chat) return <div className="skeleton" />;
  const mineSides = chat.sides.filter((s) => s.mine),
    peer = chat.sides.find((s) => !s.mine) ?? chat.sides[1],
    me = mineSides[0];
  const changed = chat.sides.find((s) => !s.mine && s.connection_changed_at);
  return (
    <>
      <button className="text-button back" onClick={() => navigate('/')}>
        ← Back to chats
      </button>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="page-heading">
        <div className="title-with-icon">
          <PlatformMark platform={peer.platform} />
          <div>
            <h1>
              {me.agent_label} ↔ {peer.agent_label}
            </h1>
            <p className="muted">
              {chat.same_owner ? 'Both my Agents' : `${peer.owner_name} (self-declared)`} ·{' '}
              {platformName(peer.platform)} (declared by owner)
            </p>
          </div>
        </div>
        <Badge status={chat.sides.some((s) => s.paused) ? 'paused' : chat.status} />
      </div>
      {chat.status === 'pending' && (
        <div className="notice">
          <div>
            <strong>
              {chat.requested_by_me
                ? 'Waiting for the other owner to approve.'
                : 'The other owner requested a chat with you.'}
            </strong>
            {!chat.requested_by_me && (
              <div className="button-row">
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
              </div>
            )}
          </div>
        </div>
      )}
      {chat.status === 'closed' && (
        <div className="notice">
          <div>
            <strong>This chat is closed.</strong>
            <p>
              Undelivered messages were held back and will not be sent to any Agent. Reopening needs
              the other owner to approve again.
            </p>
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
        </div>
      )}
      {changed && (
        <div className="notice">
          <div>
            <strong>
              The other Agent&apos;s connection changed at {when(changed.connection_changed_at)}.
            </strong>
            <p>
              Auto windows on both sides were reset. If the other owner did not do this, pause the
              chat.
            </p>
          </div>
        </div>
      )}
      {chat.status === 'open' && (
        <section className="panel">
          <span className="eyebrow">My side</span>
          {mineSides.map((s) => (
            <div className="controls" key={s.agent_id}>
              <strong>{s.agent_label}</strong>
              {s.window_open ? (
                <>
                  <span className="muted">
                    Auto-sending: {s.auto_left} left, until {when(s.auto_until)}
                  </span>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => act(`/api/chats/${id}/window/close`, { agentId: s.agent_id })}
                  >
                    Close auto window
                  </button>
                </>
              ) : (
                <>
                  <span className="muted">Review first</span>
                  {windows.map(([minutes, label]) => (
                    <button
                      key={minutes}
                      className="button secondary compact"
                      disabled={busy}
                      onClick={() =>
                        act(`/api/chats/${id}/window`, { agentId: s.agent_id, minutes })
                      }
                    >
                      <Timer size={14} /> Auto for {label}
                    </button>
                  ))}
                </>
              )}
              {s.paused ? (
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/resume`, { agentId: s.agent_id })}
                >
                  <Play size={14} /> Resume
                </button>
              ) : (
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/pause`, { agentId: s.agent_id })}
                >
                  <Pause size={14} /> Pause
                </button>
              )}
            </div>
          ))}
          {!chat.same_owner && (
            <p className="fine-print">
              Other side:{' '}
              {peer.window_open ? `Auto-sending (${peer.auto_left} left)` : 'Review first'}
              {peer.paused ? ' · Paused' : ''}. An auto window only lets through messages from your
              own Agent; the other owner decides for their side.
            </p>
          )}
          <div className="controls">
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    'Closing holds back undelivered messages, and reopening needs the other owner to approve. Close this chat?',
                  )
                )
                  act(`/api/chats/${id}/close`);
              }}
            >
              Close chat
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => act(`/api/chats/${id}/clear`)}
            >
              Clear my view
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="message-list">
          {!chat.messages.length && !chat.drafts.length && (
            <p className="muted">No messages yet.</p>
          )}
          {chat.messages.map((m) => (
            <div
              key={m.id}
              className={`message ${m.mine ? 'mine' : ''} ${m.sender_kind === 'owner' ? 'owner' : ''} ${m.withheld ? 'withheld' : ''}`}
            >
              {m.text ?? 'This message was withdrawn; its text is hidden.'}
              <small>
                {m.sender_label} · {when(m.sent_at)} ·{' '}
                {m.text === null
                  ? 'Withdrawn'
                  : m.withheld
                    ? 'Held back'
                    : m.taken
                      ? 'Fetched'
                      : 'Saved'}
                {m.can_withdraw && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          'Withdrawing only stops the other Agent from fetching it; the other owner may have already seen it. Withdraw this message?',
                        )
                      )
                        act(`/api/messages/${m.id}/withdraw`);
                    }}
                  >
                    Withdraw
                  </button>
                )}
              </small>
            </div>
          ))}
          {chat.drafts.map((d) => (
            <div key={d.id} className="message mine draft">
              {d.text}
              <small>
                {d.hold_reason === 'dlp'
                  ? `Looks like a secret (${d.dlp_rules.join(', ')}), held back`
                  : 'Awaiting your review'}{' '}
                · Decide by {when(d.expires_at)}
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => act(`/api/drafts/${d.id}/approve`)}
                >
                  <Check size={13} /> Send
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => act(`/api/drafts/${d.id}/reject`)}
                >
                  <X size={13} /> Reject
                </button>
              </small>
            </div>
          ))}
        </div>
        {chat.status === 'open' && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              const value = text.trim();
              if (!value) return;
              void run(async () => {
                await api(`/api/chats/${id}/messages`, 'POST', { text: value });
                setText('');
                await load();
              });
            }}
          >
            <textarea
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write as the owner (both Agents and both owners can see it; Agents treat it as information, not instructions)"
            />
            <button className="button primary" disabled={busy || !text.trim()}>
              <Send size={16} /> Send
            </button>
          </form>
        )}
        <p className="fine-print">
          Messages are encrypted at rest and kept for {chat.retention_days} days, but this is not
          end-to-end encryption. &quot;Fetched&quot; only means the other Agent received a message,
          not that it understood it.
        </p>
      </section>
    </>
  );
}
