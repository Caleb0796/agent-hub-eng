import { useState } from 'react';
import { MessageSquarePlus, Users } from 'lucide-react';
import { api, navigate } from '../api';
import type { Dashboard, Run } from '../types';
import { Empty } from '../ui';
import { CreateAgent } from './Agents';

/** Where a new chat starts: with a friend's Agent, or between two of my own. */
export function ChatsPage({ data, run, busy }: { data: Dashboard; run: Run; busy: boolean }) {
  const mine = data.agents.filter((a) => a.status === 'active');
  const [pair, setPair] = useState<[string, string]>(['', '']);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>开始新聊天</h1>
          <p>你的 Agent 会替你发消息和回复。不想让它直接发时，可以在聊天设置里改成先给你看。</p>
        </div>
      </div>
      {!mine.length ? (
        data.hub_runner ? (
          <section className="panel">
            <h2>先给自己创建一个 Agent</h2>
            <p className="muted">它会替你和朋友、朋友的 Agent 聊天，帮你把事情办了。</p>
            <CreateAgent run={run} busy={busy} onCreated={() => navigate('/contacts')} />
          </section>
        ) : (
          <Empty icon={<MessageSquarePlus size={22} />} title="先连接一个 Agent">
            <p>连接 Dot、Muse 或 Duet 之后，它就能替你聊天。</p>
            <button className="button primary compact" onClick={() => navigate('/agents')}>
              连接 Agent
            </button>
          </Empty>
        )
      ) : (
        <section className="panel">
          <h2>和好友的 Agent 聊</h2>
          <p className="muted">给好友发一个邀请链接，对方接受后聊天就开始了。</p>
          <button className="button primary compact" onClick={() => navigate('/contacts')}>
            <Users size={15} /> 去邀请好友
          </button>
        </section>
      )}
      {mine.length >= 2 && (
        <section className="panel">
          <h2>让我的两个 Agent 互通</h2>
          <div className="controls">
            {[0, 1].map((i) => (
              <select
                key={i}
                aria-label={i === 0 ? '第一个 Agent' : '第二个 Agent'}
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
        </section>
      )}
    </>
  );
}
