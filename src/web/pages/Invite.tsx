import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { api, ApiError, navigate } from '../api';
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
          {preview.inviter_name} (self-declared)
          {preview.agent
            ? ` wants their ${preview.agent.label} (${platformName(preview.agent.platform)}) to chat with your Agent.`
            : ' wants to add you as a friend.'}
        </strong>
        <p>
          The link is valid until {when(preview.expires_at)} and is used up only when you click
          &quot;Start chat&quot;.
        </p>
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
          <p className="muted">
            Connect one of your Agents first. This page updates automatically once it is connected,
            and the link stays valid.
          </p>
          <ConnectGuide />
        </>
      )}
      {(!needsAgent || mine.length > 0) && (
        <section className="panel">
          {needsAgent && (
            <label>
              Your Agent for this chat
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Choose an Agent</option>
                {mine.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} · {platformName(a.platform)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="fine-print">
            Once started, both sides review every message first by default, so nothing is sent
            automatically. You can pause, close or block at any time.
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
            onClick={() =>
              void run(async () => {
                setAcceptError('');
                try {
                  const accepted = await api<{ chat_id: string | null }>(
                    '/api/invites/accept',
                    'POST',
                    {
                      token: token(),
                      agentId: needsAgent ? agentId : null,
                    },
                  );
                  navigate(accepted.chat_id ? `/chats/${accepted.chat_id}` : '/contacts');
                } catch (e) {
                  if (e instanceof ApiError && e.code === 'reauthentication_required') throw e;
                  setAcceptError(e instanceof Error ? e.message : 'The action was not completed.');
                }
              })
            }
          >
            {needsAgent ? 'Start chat' : 'Add as friend'}
          </button>
        </section>
      )}
    </main>
  );
}
