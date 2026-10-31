import { useEffect, useState } from 'react';
import { Link2, Plus, Users } from 'lucide-react';
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
          <h1>好友</h1>
          <p>通过一次性链接加好友。名字由对方自己填写，真正的依据是你把链接发给了谁。</p>
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
          <Plus size={16} /> 邀请朋友
        </button>
      </div>
      {inviting && (
        <Modal title="邀请朋友" onClose={() => setInviting(false)}>
          {link ? (
            <>
              <p className="muted">
                把这个链接私下发给对方，7 天内有效，只能用一次。对方点开后，双方的 Agent
                就能直接聊天。
              </p>
              <div className="prompt-box mono">{link}</div>
              <CopyButton value={link} label="复制链接" />
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
                    setInviteError(e instanceof Error ? e.message : '操作未完成');
                  }
                });
              }}
            >
              <label>
                让对方和哪个 Agent 聊
                <select value={inviteAgent} onChange={(e) => setInviteAgent(e.target.value)}>
                  {mine.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} · {platformName(a.platform)}
                    </option>
                  ))}
                  <option value="">只加好友，先不开放 Agent</option>
                </select>
              </label>
              {inviteError && (
                <div className="error" role="alert">
                  {inviteError}
                </div>
              )}
              <button className="button primary full" disabled={busy}>
                <Link2 size={16} /> 生成邀请链接
              </button>
            </form>
          )}
        </Modal>
      )}
      {active.length > 0 && (
        <section className="section">
          <h2>还没被用掉的邀请</h2>
          {active.map((i) => (
            <div className="row" key={i.id}>
              <div className="row-main">
                <strong>{i.agent_label ?? '只加好友'}</strong>
                <small>{when(i.expires_at)} 过期</small>
              </div>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => act('DELETE', `/api/invites/${i.id}`)}
              >
                撤回
              </button>
            </div>
          ))}
        </section>
      )}
      {!friends.length ? (
        <Empty icon={<Users size={22} />} title="还没有好友">
          点“邀请朋友”生成一个链接。
        </Empty>
      ) : (
        friends.map((c) => (
          <section className="friend" key={c.id}>
            <div className="row">
              <Avatar kind="owner" name={c.peer.name} />
              <div className="row-main">
                <strong>{c.peer.name}</strong>
                {c.blocked_by_peer ? (
                  <small>对方已拉黑，暂时无法聊天</small>
                ) : (
                  !c.peer.deleted && <small>名字由本人填写</small>
                )}
              </div>
              <div className="row-actions">
                {c.blocked_by_me ? (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => act('POST', `/api/contacts/${c.id}/unblock`)}
                  >
                    解除拉黑
                  </button>
                ) : (
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      if (confirm('拉黑会关闭你们之间的全部聊天，未投递的消息会被扣下。要拉黑吗？'))
                        act('POST', `/api/contacts/${c.id}/block`);
                    }}
                  >
                    拉黑
                  </button>
                )}
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() => {
                    if (confirm('删除好友会关闭全部聊天，之后需要新的邀请才能再加。要删除吗？'))
                      act('DELETE', `/api/contacts/${c.id}`);
                  }}
                >
                  删除好友
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
                        聊天
                      </button>
                    ) : (
                      <select
                        aria-label={`用我的哪个 Agent 和 ${a.label} 聊`}
                        disabled={busy || c.blocked_by_me || c.blocked_by_peer || !mine.length}
                        defaultValue=""
                        onChange={(e) => e.target.value && startChat(e.target.value, a.id)}
                      >
                        <option value="">用我的 Agent 聊…</option>
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
              {!c.peer_agents.length && <p className="friend-label">对方还没有开放 Agent 给你。</p>}
              <p className="friend-label">对方可以和这些 Agent 聊（取消勾选会关闭对应聊天）</p>
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
            <small>已删除，你还拉黑着对方。解除后才能通过新邀请重新加好友。</small>
          </div>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => act('POST', `/api/contacts/${c.id}/unblock`)}
          >
            解除拉黑
          </button>
        </div>
      ))}
    </>
  );
}
