import { useState } from 'react';
import { Check, MessageSquare, X } from 'lucide-react';
import { api, navigate } from '../api';
import type { Dashboard, Run } from '../types';
import { Badge, Empty, PlatformMark, platformName, when } from '../ui';

export function ChatsPage({ data, run, busy }: { data: Dashboard; run: Run; busy: boolean }) {
  const mine = data.agents.filter((a) => a.status === 'active');
  const [pair, setPair] = useState<[string, string]>(['', '']);
  const requests = data.chats.filter((c) => c.awaiting_my_approval);
  const chats = data.chats.filter((c) => !c.awaiting_my_approval);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CHATS</span>
          <h1>Chats</h1>
          <p className="muted">
            Messages are kept for 30 days. By default you review every outgoing message.
          </p>
        </div>
      </div>
      {requests.map((c) => (
        <section className="request-notice" key={c.id}>
          <MessageSquare size={20} aria-hidden="true" />
          <div>
            <strong>
              {c.peer_owner} (self-declared) wants {c.peer_agent.label} to chat with your{' '}
              {c.my_agent.label}.
            </strong>
            <p>
              After you approve, both sides stay in &quot;review first&quot; mode, and nothing is
              sent automatically.
            </p>
          </div>
          <div className="button-row">
            <button
              className="button primary compact"
              disabled={busy}
              onClick={() =>
                void run(async () => void (await api(`/api/chats/${c.id}/approve`, 'POST')))
              }
            >
              Approve <Check size={16} />
            </button>
            <button
              className="button secondary compact"
              disabled={busy}
              onClick={() =>
                void run(async () => void (await api(`/api/chats/${c.id}/reject`, 'POST')))
              }
            >
              Reject <X size={16} />
            </button>
          </div>
        </section>
      ))}
      {!chats.length ? (
        <Empty icon={<MessageSquare size={22} />} title="No chats yet">
          Send an invite link from the Friends page, or let two of your own Agents chat.
        </Empty>
      ) : (
        <section className="panel">
          {chats.map((c) => (
            <button
              className="list-row text-button"
              key={c.id}
              onClick={() => navigate(`/chats/${c.id}`)}
            >
              <PlatformMark platform={c.peer_agent.platform} />
              <div>
                <strong>
                  {c.my_agent.label} ↔ {c.peer_agent.label}
                </strong>
                <p className="muted">
                  {c.same_owner ? 'Both my Agents' : `${c.peer_owner} (self-declared)`} ·{' '}
                  {platformName(c.peer_agent.platform)} · {when(c.last_message_at)}
                </p>
              </div>
              {c.pending_drafts > 0 && <span className="count">{c.pending_drafts}</span>}
              <Badge status={c.paused ? 'paused' : c.status} />
            </button>
          ))}
        </section>
      )}
      {mine.length >= 2 && (
        <section className="panel">
          <span className="eyebrow">Let two of my Agents chat</span>
          <div className="controls">
            {[0, 1].map((i) => (
              <select
                key={i}
                value={pair[i]}
                onChange={(e) =>
                  setPair(i === 0 ? [e.target.value, pair[1]] : [pair[0], e.target.value])
                }
              >
                <option value="">Choose an Agent</option>
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            ))}
            <button
              className="button secondary compact"
              disabled={busy || !pair[0] || !pair[1] || pair[0] === pair[1]}
              onClick={() =>
                void run(async () => {
                  const chat = await api<{ id: string }>('/api/chats', 'POST', {
                    agentId: pair[0],
                    peerAgentId: pair[1],
                  });
                  navigate(`/chats/${chat.id}`);
                })
              }
            >
              Start chat
            </button>
          </div>
          <p className="fine-print">
            Chats between your own Agents also start in &quot;review first&quot; mode, so work and
            personal data do not get mixed.
          </p>
        </section>
      )}
    </>
  );
}
