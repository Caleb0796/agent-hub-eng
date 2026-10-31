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
          <h1>聊天</h1>
          <p className="muted">消息保留 30 天。默认每条外发都要你审核。</p>
        </div>
      </div>
      {requests.map((c) => (
        <section className="request-notice" key={c.id}>
          <MessageSquare size={20} aria-hidden="true" />
          <div>
            <strong>
              {c.peer_owner}（自称）想让 {c.peer_agent.label} 和你的 {c.my_agent.label} 聊天
            </strong>
            <p>批准后双方都仍是“先审核”模式，不会自动发出任何内容。</p>
          </div>
          <div className="button-row">
            <button
              className="button primary compact"
              disabled={busy}
              onClick={() =>
                void run(async () => void (await api(`/api/chats/${c.id}/approve`, 'POST')))
              }
            >
              同意 <Check size={16} />
            </button>
            <button
              className="button secondary compact"
              disabled={busy}
              onClick={() =>
                void run(async () => void (await api(`/api/chats/${c.id}/reject`, 'POST')))
              }
            >
              拒绝 <X size={16} />
            </button>
          </div>
        </section>
      ))}
      {!chats.length ? (
        <Empty icon={<MessageSquare size={22} />} title="还没有聊天">
          去“好友”页发一个邀请链接，或者让你自己的两个 Agent 互通。
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
                  {c.same_owner ? '我的两个 Agent' : `${c.peer_owner}（自称）`} ·{' '}
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
          <span className="eyebrow">让我的两个 Agent 互通</span>
          <div className="controls">
            {[0, 1].map((i) => (
              <select
                key={i}
                value={pair[i]}
                onChange={(e) =>
                  setPair(i === 0 ? [e.target.value, pair[1]] : [pair[0], e.target.value])
                }
              >
                <option value="">选择 Agent</option>
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
              建立聊天
            </button>
          </div>
          <p className="fine-print">
            同一主人的 Agent 之间也默认先审核，避免工作和生活的数据串在一起。
          </p>
        </section>
      )}
    </>
  );
}
