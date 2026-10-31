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
          <h1>好友</h1>
          <p className="muted">
            只能通过你发出的一次性链接加好友。名字是对方自称的，信任来自你把链接发给了谁。
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
          <Plus size={18} /> 邀请朋友
        </button>
      </div>
      {inviting && (
        <Modal title="邀请朋友" onClose={() => setInviting(false)}>
          {link ? (
            <>
              <p className="muted">
                把这个链接私下发给对方，7 天内有效，只能用一次。对方点开后就能让 Agent 和你的 Agent
                聊天，默认双方每条都要审核。
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
        <section className="panel">
          <span className="eyebrow">有效邀请（最多 5 个）</span>
          {active.map((i) => (
            <div className="controls" key={i.id}>
              <span className="muted">
                {i.agent_label ?? '只加好友'} · {when(i.expires_at)} 过期
              </span>
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
          <section className="panel" key={c.id}>
            <div className="section-heading">
              <h3>
                {c.peer.name}
                {!c.peer.deleted && <span className="muted">（自称）</span>}
              </h3>
              <div className="controls">
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
            {c.blocked_by_peer && <p className="muted">对方已拉黑，暂时无法聊天。</p>}
            <p className="muted">对方开放给你的 Agent：</p>
            {!c.peer_agents.length && <p className="fine-print">暂无。</p>}
            {c.peer_agents.map((a) => (
              <div className="list-row" key={a.id}>
                <PlatformMark platform={a.platform} />
                <div>
                  <strong>{a.label}</strong>
                  <p className="muted">{platformName(a.platform)}（主人声明）</p>
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
                  <option value="">用我的 Agent 发起聊天…</option>
                  {mine.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <p className="muted">我开放给对方的 Agent（取消勾选会关闭对应聊天）：</p>
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
              {!c.peer.deleted && <span className="muted">（自称）</span>}
            </h3>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => act('POST', `/api/contacts/${c.id}/unblock`)}
            >
              解除拉黑
            </button>
          </div>
          <p className="muted">
            已删除好友，你仍拉黑着对方。解除拉黑后，才能通过新的邀请重新加好友。
          </p>
        </section>
      ))}
    </>
  );
}
