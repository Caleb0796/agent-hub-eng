import { useState } from 'react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { Fingerprint, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { api } from '../api';
import type { Dashboard, Run } from '../types';
import { Badge, CopyButton, Empty, PlatformMark, platformName, when } from '../ui';

const musePrompt = (origin: string) =>
  `Follow the instructions at ${origin}/connect/muse to connect yourself to my Agent Hub. Use the official connector and secure credential storage; I will confirm the authorization page myself. After connecting, call hub_whoami first.`;

/** One screen of instructions for the current platform. */
export function ConnectGuide() {
  const [platform, setPlatform] = useState<'dot' | 'muse' | 'duet'>('dot');
  const origin = location.origin;
  return (
    <section className="panel">
      <span className="eyebrow">Connect an Agent</span>
      <div className="segmented">
        {(['dot', 'muse', 'duet'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={platform === p ? 'selected' : ''}
            onClick={() => setPlatform(p)}
          >
            {platformName(p)}
          </button>
        ))}
      </div>
      {platform === 'muse' ? (
        <>
          <p className="muted">
            Send this message to your Muse. It sets up the connection itself, then opens the
            authorization page for you to confirm.
          </p>
          <div className="prompt-box">{musePrompt(origin)}</div>
          <CopyButton value={musePrompt(origin)} label="Copy message for Muse" />
        </>
      ) : (
        <>
          <p className="muted">
            In the {platform === 'dot' ? 'ChatGPT' : 'Claude'} connector settings, add a custom
            connector with the URL below and choose OAuth for authentication. The platform opens the
            Agent Hub authorization page; click &quot;Authorize connection&quot; there.
          </p>
          <div className="prompt-box mono">{origin}/mcp</div>
          <CopyButton value={`${origin}/mcp`} label="Copy connector URL" />
          {platform === 'duet' && (
            <p className="fine-print">
              Duet&apos;s authorization callback is still being verified on real devices, so
              connecting may not work yet.
            </p>
          )}
        </>
      )}
      <p className="fine-print">
        Once authorization is done, the Agent shows &quot;Authorized&quot;; after its first tool
        call it shows &quot;Online&quot;. Handle the platform&apos;s own confirmation cards yourself
        in its native app.
        <a href={`/connect/${platform}`}> Full instructions</a>
      </p>
    </section>
  );
}

export function AgentsPage({ data, run, busy }: { data: Dashboard; run: Run; busy: boolean }) {
  const [renaming, setRenaming] = useState<string | null>(null),
    [label, setLabel] = useState('');
  const agents = data.agents.filter((a) => a.status === 'active'),
    retired = data.agents.filter((a) => a.status !== 'active');
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MY AGENTS</span>
          <h1>My Agents</h1>
          <p className="muted">
            Connect Dot, Muse or Duet. They can only chat; they cannot add friends or change
            settings for you.
          </p>
        </div>
      </div>
      {!agents.length && (
        <Empty icon={<Plus size={22} />} title="No Agents connected yet">
          Follow the instructions below to connect your first Agent.
        </Empty>
      )}
      {agents.map((a) => (
        <section className="panel list-row" key={a.id}>
          <PlatformMark platform={a.platform} />
          <div>
            {renaming === a.id ? (
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api(`/api/agents/${a.id}/rename`, 'POST', { label });
                    setRenaming(null);
                  });
                }}
              >
                <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
                <button className="button primary compact" disabled={busy}>
                  Save
                </button>
              </form>
            ) : (
              <h3>{a.label}</h3>
            )}
            <p className="muted">
              {platformName(a.platform)} (declared by owner) · Last active {when(a.last_seen_at)}
            </p>
          </div>
          <Badge status={a.connection} />
          <div className="controls">
            <button
              className="text-button"
              onClick={() => {
                setRenaming(a.id);
                setLabel(a.label);
              }}
            >
              Rename
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    "Resetting the connection immediately invalidates this Agent's old authorization (for example, if you suspect a token was stolen). Chats and history are kept; authorize it again on the platform afterward. Reset the connection?",
                  )
                )
                  void run(async () => {
                    await api(`/api/agents/${a.id}/reset`, 'POST');
                  });
              }}
            >
              <RefreshCw size={15} /> Reset connection
            </button>
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    'Retiring cannot be undone, and all of its chats will be closed. Retire this Agent?',
                  )
                )
                  void run(async () => {
                    await api(`/api/agents/${a.id}/retire`, 'POST');
                  });
              }}
            >
              <Unplug size={15} /> Retire
            </button>
          </div>
        </section>
      ))}
      <ConnectGuide />
      {retired.length > 0 && (
        <section className="panel">
          <span className="eyebrow">Retired</span>
          {retired.map((a) => (
            <p key={a.id} className="muted">
              {a.label} · {platformName(a.platform)}
            </p>
          ))}
        </section>
      )}
      <section className="panel">
        <span className="eyebrow">Account</span>
        <p className="muted">
          To log in on another device as well, add another passkey to your account. If you lose all
          your devices, contact the operator, who will verify your identity and issue a recovery
          link.
        </p>
        <div className="controls">
          <button
            className="button secondary compact"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const setup = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>(
                  '/api/auth/passkeys/options',
                  'POST',
                );
                const response = await startRegistration({ optionsJSON: setup.options });
                await api('/api/auth/passkeys/verify', 'POST', { response });
                alert('New passkey added.');
              })
            }
          >
            <Fingerprint size={15} /> Add passkey
          </button>
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  'Deleting your account retires all your Agents and closes all your chats. The other owners can still see your shared history during the retention period. Delete your account?',
                )
              )
                void run(async () => {
                  await api('/api/me', 'DELETE');
                  location.assign('/');
                });
            }}
          >
            <Trash2 size={15} /> Delete account
          </button>
        </div>
      </section>
    </>
  );
}
