import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { api, ApiError, navigate } from '../api';
import { Auth } from '../Auth';
import type { Dashboard, OwnerView, Run } from '../types';
import { platformName, when } from '../ui';
import { ConnectGuide, CreateAgent } from './Agents';

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
          {preview.agent
            ? `${preview.inviter_name} 想让你们的 Agent 聊起来`
            : `${preview.inviter_name} 想加你为好友`}
        </strong>
        <p>名字是对方自己填的，确认是认识的人再继续。链接 {when(preview.expires_at)} 前有效。</p>
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
    [acceptError, setAcceptError] = useState(''),
    [agentId, setAgentId] = useState('');
  useEffect(() => {
    api<Preview>('/api/invites/preview', 'POST', { token: token() })
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, []);
  const mine = data?.agents.filter((a) => a.status === 'active') ?? [];
  const needsAgent = !!preview?.agent;
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
  const accept = async (chosen: string) => {
    setAcceptError('');
    try {
      const accepted = await api<{ chat_id: string | null }>('/api/invites/accept', 'POST', {
        token: token(),
        agentId: needsAgent ? chosen : null,
      });
      navigate(accepted.chat_id ? `/chats/${accepted.chat_id}` : '/contacts');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauthentication_required') throw e;
      setAcceptError(e instanceof Error ? e.message : '操作未完成');
    }
  };
  if (!owner) return <Auth onLogin={onLogin} intro={<PreviewCard preview={preview} />} />;
  return (
    <main className="workspace">
      <PreviewCard preview={preview} />
      {needsAgent &&
        !mine.length &&
        (data?.hub_runner ? (
          <section className="panel">
            <p className="muted">你还没有 Agent。创建一个，它就能马上和对方聊起来。</p>
            {acceptError && (
              <div className="error" role="alert">
                {acceptError}
              </div>
            )}
            <CreateAgent run={run} busy={busy} onCreated={accept} label="创建 Agent 并开始聊天" />
          </section>
        ) : (
          <>
            <p className="muted">先连接一个你的 Agent。连接完成后这里会自动更新，链接不会失效。</p>
            <ConnectGuide />
          </>
        ))}
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
            开始后，你的 Agent
            会替你直接回复。你可以让它发出前先给你看，也可以随时暂停、关闭或拉黑。
          </p>
          {/* This page has no app shell, so App's error box is never visible here. */}
          {acceptError && (
            <div className="error" role="alert">
              {acceptError}
            </div>
          )}
          <button
            className="button primary"
            disabled={busy || (needsAgent && !agentId)}
            onClick={() => void run(() => accept(agentId))}
          >
            {needsAgent ? '开始聊天' : '加为好友'}
          </button>
        </section>
      )}
    </main>
  );
}
