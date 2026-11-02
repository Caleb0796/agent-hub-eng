import { useEffect, useState } from 'react';
import { Link2, Plus, Users } from 'lucide-react';
import { api, ApiError, navigate } from '../api';
import type { Contact, Dashboard, Invite, Run } from '../types';
import { CopyButton, Empty, Modal, PlatformMark, platformName, when } from '../ui';

export function ContactsPage({
  data,
  run,
  busy,
  version,
}: {
  data: Dashboard;
  run: Run;
  busy: boolean;
  version: unknown;
}) {
  const [contacts, setContacts] = useState<Contact[] | null>(null),
    [invites, setInvites] = useState<Invite[]>([]),
    [inviting, setInviting] = useState(false),
    [link, setLink] = useState(''),
    [inviteError, setInviteError] = useState(''),
    [inviteAgent, setInviteAgent] = useState('');
  const mine = data.agents.filter((a) => a.status === 'active');
  const load = async () => {
    setContacts((await api<{ contacts: Contact[] }>('/api/contacts')).contacts);
    setInvites((await api<{ invites: Invite[] }>('/api/invites')).invites);
  };
  useEffect(() => {
    void load();
  }, [version]);
  const act = (method: string, path: string, body?: unknown) =>
    void run(async () => {
      await api(path, method, body);
      await load();
    });
  if (!contacts) return <div className="skeleton" />;
  const active = invites.filter(
    (i) => !i.consumed_at && !i.revoked_at && i.expires_at * 1000 > Date.now(),
  );
  // A removed contact is listed only while I still block them, so I can lift the block.
  const friends = contacts.filter((c) => !c.removed),
    removed = contacts.filter((c) => c.removed);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">FRIENDS</span>
          <h1>Friends</h1>
          <p className="muted">
            Friends can only be added through one-time links you send. Names are self-declared;
            trust comes from who you sent the link to.
          </p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setInviting(true);
            setLink('');
            setInviteError('');
            setInviteAgent(mine[0]?.id ?? '');
          }}
        >
          <Plus size={18} /> Invite a friend
        </button>
      </div>
      {inviting && (
        <Modal title="Invite a friend" onClose={() => setInviting(false)}>
          {link ? (
            <>
              <p className="muted">
                Send this link to your friend privately. It is valid for 7 days and works only once.
                When they open it, their Agent can chat with your Agent; by default both sides
                review every message.
              </p>
              <div className="prompt-box mono">{link}</div>
              <CopyButton value={link} label="Copy link" />
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // App's error box sits under the modal backdrop, so show failures in here.
                void run(async () => {
                  setInviteError('');
                  try {
                    const created = await api<{ url: string }>('/api/invites', 'POST', {
                      agentId: inviteAgent || null,
                    });
                    setLink(created.url);
                    await load();
                  } catch (e) {
                    if (e instanceof ApiError && e.code === 'reauthentication_required') throw e;
                    setInviteError(
                      e instanceof Error ? e.message : 'The action was not completed.',
                    );
                  }
                });
              }}
            >
              <label>
                Agent your friend can chat with
                <select value={inviteAgent} onChange={(e) => setInviteAgent(e.target.value)}>
                  {mine.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} · {platformName(a.platform)}
                    </option>
                  ))}
                  <option value="">Friend only, no Agent shared yet</option>
                </select>
              </label>
              {inviteError && (
                <div className="error" role="alert">
                  {inviteError}
                </div>
              )}
              <button className="button primary full" disabled={busy}>
                <Link2 size={16} /> Create invite link
              </button>
            </form>
          )}
        </Modal>
      )}
      {active.length > 0 && (
        <section className="panel">
          <span className="eyebrow">Active invites (up to 5)</span>
          {active.map((i) => (
            <div className="controls" key={i.id}>
              <span className="muted">
                {i.agent_label ?? 'Friend only'} · Expires {when(i.expires_at)}
              </span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => act('DELETE', `/api/invites/${i.id}`)}
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
      )}
      {!friends.length ? (
        <Empty icon={<Users size={22} />} title="No friends yet">
          Click &quot;Invite a friend&quot; to create a link.
        </Empty>
      ) : (
        friends.map((c) => (
          <section className="panel" key={c.id}>
            <div className="section-heading">
              <h3>
                {c.peer.name}
                {!c.peer.deleted && <span className="muted"> (self-declared)</span>}
              </h3>
              <div className="controls">
                {c.blocked_by_me ? (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => act('POST', `/api/contacts/${c.id}/unblock`)}
                  >
                    Unblock
                  </button>
                ) : (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          'Blocking closes every chat between you, and undelivered messages are held back. Block this friend?',
                        )
                      )
                        act('POST', `/api/contacts/${c.id}/block`);
                    }}
                  >
                    Block
                  </button>
                )}
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        'Removing this friend closes every chat with them. To add them again you need a new invite. Remove this friend?',
                      )
                    )
                      act('DELETE', `/api/contacts/${c.id}`);
                  }}
                >
                  Remove friend
                </button>
              </div>
            </div>
            {c.blocked_by_peer && (
              <p className="muted">This friend has blocked you, so you cannot chat for now.</p>
            )}
            <p className="muted">Agents they share with you:</p>
            {!c.peer_agents.length && <p className="fine-print">None yet.</p>}
            {c.peer_agents.map((a) => (
              <div className="list-row" key={a.id}>
                <PlatformMark platform={a.platform} />
                <div>
                  <strong>{a.label}</strong>
                  <p className="muted">{platformName(a.platform)} (declared by owner)</p>
                </div>
                <select
                  disabled={busy || c.blocked_by_me || c.blocked_by_peer || !mine.length}
                  defaultValue=""
                  onChange={(e) => {
                    const agentId = e.target.value;
                    if (!agentId) return;
                    void run(async () => {
                      const chat = await api<{ id: string }>('/api/chats', 'POST', {
                        agentId,
                        peerAgentId: a.id,
                      });
                      navigate(`/chats/${chat.id}`);
                    });
                  }}
                >
                  <option value="">Start a chat with my Agent…</option>
                  {mine.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <p className="muted">Agents you share with them (unchecking one closes its chats):</p>
            <div className="controls">
              {mine.map((m) => (
                <label className="check-label" key={m.id}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={c.my_agents.includes(m.id)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...c.my_agents, m.id]
                        : c.my_agents.filter((x) => x !== m.id);
                      act('POST', `/api/contacts/${c.id}/agents`, { agentIds: next });
                    }}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </section>
        ))
      )}
      {removed.map((c) => (
        <section className="panel" key={c.id}>
          <div className="section-heading">
            <h3>
              {c.peer.name}
              {!c.peer.deleted && <span className="muted"> (self-declared)</span>}
            </h3>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => act('POST', `/api/contacts/${c.id}/unblock`)}
            >
              Unblock
            </button>
          </div>
          <p className="muted">
            You removed this friend but still have them blocked. Unblock them first; then you can
            add them again with a new invite.
          </p>
        </section>
      ))}
    </>
  );
}
