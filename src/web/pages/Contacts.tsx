import { useEffect, useState } from 'react';
import { Link2, MessageCircle, Plus, Users } from 'lucide-react';
import { api, ApiError, navigate } from '../api';
import type { Contact, Dashboard, Invite, Run } from '../types';
import { Avatar, CopyButton, Empty, Modal, platformName, when } from '../ui';

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
    // Creating a first Agent lands here, because inviting a friend is the very next step.
    [inviting, setInviting] = useState(location.search.includes('invite=1')),
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
  const startChat = (agentId: string, peerAgentId: string) =>
    void run(async () => {
      const chat = await api<{ id: string }>('/api/chats', 'POST', { agentId, peerAgentId });
      navigate(`/chats/${chat.id}`);
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
          <h1>Friends</h1>
          <p>
            Add friends with a one-time link. Each person chooses their own name, so what counts is
            who you sent the link to.
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
          <Plus size={16} /> Invite a friend
        </button>
      </div>
      {inviting && (
        <Modal title="Invite a friend" onClose={() => setInviting(false)}>
          {link ? (
            <>
              <p className="muted">
                Send this link to your friend privately. It is valid for 7 days and works only once.
                When they open it, your Agents can chat directly.
              </p>
              <div className="prompt-box mono">{link}</div>
              <div className="button-row">
                {/* The token travels in this URL to WhatsApp, which is where it is going anyway. */}
                <a
                  className="button primary compact"
                  href={`https://wa.me/?text=${encodeURIComponent(`Let's have our Agents sort this out for us. Tap here to join: ${link}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageCircle size={15} /> Send with WhatsApp
                </a>
                <CopyButton value={link} label="Copy link" />
              </div>
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
                      agentId: mine.length > 1 ? inviteAgent || null : (mine[0]?.id ?? null),
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
              {mine.length > 1 ? (
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
              ) : (
                <p className="muted">
                  {mine.length
                    ? `Once they accept, ${mine[0].label} can start chatting with their Agent.`
                    : 'Once they accept, you will be friends. You do not have an Agent yet, but you can add one later.'}
                </p>
              )}
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
        <section className="section">
          <h2>Unused invites</h2>
          {active.map((i) => (
            <div className="row" key={i.id}>
              <div className="row-main">
                <strong>{i.agent_label ?? 'Friend only'}</strong>
                <small>Expires {when(i.expires_at)}</small>
              </div>
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
          <section className="friend" key={c.id}>
            <div className="row">
              <Avatar kind="owner" name={c.peer.name} />
              <div className="row-main">
                <strong>{c.peer.name}</strong>
                {c.blocked_by_peer ? (
                  <small>This friend has blocked you, so you cannot chat for now.</small>
                ) : (
                  !c.peer.deleted && <small>They chose this name themselves</small>
                )}
              </div>
              <div className="row-actions">
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
            <div className="friend-body">
              {c.peer_agents.map((a) => (
                <div className="row" key={a.id}>
                  <Avatar kind="agent" name={a.label} platform={a.platform} size="small" />
                  <div className="row-main">
                    <strong>{a.label}</strong>
                  </div>
                  <div className="row-actions">
                    {mine.length === 1 ? (
                      <button
                        className="button secondary compact"
                        disabled={busy || c.blocked_by_me || c.blocked_by_peer}
                        onClick={() => startChat(mine[0].id, a.id)}
                      >
                        Chat
                      </button>
                    ) : (
                      <select
                        aria-label={`Which of my Agents should chat with ${a.label}`}
                        disabled={busy || c.blocked_by_me || c.blocked_by_peer || !mine.length}
                        defaultValue=""
                        onChange={(e) => e.target.value && startChat(e.target.value, a.id)}
                      >
                        <option value="">Start a chat with my Agent…</option>
                        {mine.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              ))}
              {!c.peer_agents.length && (
                <p className="friend-label">They have not shared an Agent with you yet.</p>
              )}
              <p className="friend-label">
                Agents they can chat with (unchecking one closes its chats)
              </p>
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
            </div>
          </section>
        ))
      )}
      {removed.map((c) => (
        <div className="row" key={c.id}>
          <Avatar kind="owner" name={c.peer.name} />
          <div className="row-main">
            <strong>{c.peer.name}</strong>
            <small>
              You removed this friend but still have them blocked. Unblock them first; then you can
              add them again with a new invite.
            </small>
          </div>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => act('POST', `/api/contacts/${c.id}/unblock`)}
          >
            Unblock
          </button>
        </div>
      ))}
    </>
  );
}
