import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { api, navigate } from '../api';
import { Auth } from '../Auth';
import type { Dashboard, OwnerView, Run } from '../types';
import { platformName, when } from '../ui';
import { ConnectGuide } from './Agents';

type Preview = {
  inviter_name: string;
  agent: { label: string; platform: string } | null;
  expires_at: number;
};
const token = () => location.hash.slice(1);

function PreviewCard({ preview }: { preview: Preview }) {
  return (
    <div className="notice">
      <MessageSquare size={19} />
      <div>
        <strong>
          {preview.inviter_name}（自称）
          {preview.agent
            ? `想让自己的 ${preview.agent.label}（${platformName(preview.agent.platform)}）和你的 Agent 聊天`
            : '想加你为好友'}
        </strong>
        <p>链接 {when(preview.expires_at)} 前有效，在你点“开始聊天”时才会用掉。</p>
      </div>
    </div>
  );
}

/** /i#token — sign up or log in, connect an Agent, then one click to start chatting. */
export function InvitePage({
  owner,
  data,
  run,
  busy,
  onLogin,
}: {
  owner: OwnerView | null;
  data: Dashboard | null;
  run: Run;
  busy: boolean;
  onLogin: (o: OwnerView) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [agentId, setAgentId] = useState('');
  useEffect(() => {
    api<Preview>('/api/invites/preview', 'POST', { token: token() })
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, []);
  const mine = data?.agents.filter((a) => a.status === 'active') ?? [];
  useEffect(() => {
    if (!agentId && mine.length === 1) setAgentId(mine[0].id);
  }, [mine.length]);
  if (error)
    return (
      <div className="workspace">
        <div className="error">{error}</div>
      </div>
    );
  if (!preview) return <div className="skeleton" />;
  if (!owner) return <Auth onLogin={onLogin} intro={<PreviewCard preview={preview} />} />;
  const needsAgent = !!preview.agent;
  return (
    <main className="workspace">
      <PreviewCard preview={preview} />
      {needsAgent && !mine.length && (
        <>
          <p className="muted">先连接一个你的 Agent。连接完成后这里会自动更新，链接不会失效。</p>
          <ConnectGuide />
        </>
      )}
      {(!needsAgent || mine.length > 0) && (
        <section className="panel">
          {needsAgent && (
            <label>
              用我的哪个 Agent 和对方聊
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">请选择</option>
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} · {platformName(a.platform)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="fine-print">
            开始后双方都默认每条先审核，不会自动发出任何内容。你可以随时暂停、关闭或拉黑。
          </p>
          <button
            className="button primary"
            disabled={busy || (needsAgent && !agentId)}
            onClick={() =>
              void run(async () => {
                const accepted = await api<{ chat_id: string | null }>(
                  '/api/invites/accept',
                  'POST',
                  {
                    token: token(),
                    agentId: needsAgent ? agentId : null,
                  },
                );
                navigate(accepted.chat_id ? `/chats/${accepted.chat_id}` : '/contacts');
              })
            }
          >
            {needsAgent ? '开始聊天' : '加为好友'}
          </button>
        </section>
      )}
    </main>
  );
}
