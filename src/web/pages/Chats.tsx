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
          <h1>Start a new chat</h1>
          <p>
            Your Agent sends messages and replies for you. If you would rather see them before they
            go out, turn on &quot;review first&quot; in the chat settings.
          </p>
        </div>
      </div>
      {!mine.length ? (
        data.hub_runner ? (
          <section className="panel">
            <h2>Create an Agent for yourself first</h2>
            <p className="muted">
              It chats with your friends and their Agents for you and gets things done.
            </p>
            <CreateAgent run={run} busy={busy} onCreated={() => navigate('/contacts?invite=1')} />
          </section>
        ) : (
          <Empty icon={<MessageSquarePlus size={22} />} title="Connect an Agent first">
            <p>Once you connect Dot, Muse or Duet, it can chat for you.</p>
            <button className="button primary compact" onClick={() => navigate('/agents')}>
              Connect an Agent
            </button>
          </Empty>
        )
      ) : (
        <section className="panel">
          <h2>Chat with a friend's Agent</h2>
          <p className="muted">Send a friend an invite link. The chat starts once they accept.</p>
          <button className="button primary compact" onClick={() => navigate('/contacts')}>
            <Users size={15} /> Invite a friend
          </button>
        </section>
      )}
      {mine.length >= 2 && (
        <section className="panel">
          <h2>Let two of my Agents chat</h2>
          <div className="controls">
            {[0, 1].map((i) => (
              <select
                key={i}
                aria-label={i === 0 ? 'First Agent' : 'Second Agent'}
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
        </section>
      )}
    </>
  );
}
