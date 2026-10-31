import { useCallback, useEffect, useState } from 'react';
import { Check, Pause, Play, Send, Timer, X } from 'lucide-react';
import { api, navigate } from '../api';
import type { ChatView, Run } from '../types';
import { Badge, PlatformMark, platformName, when } from '../ui';

const windows = [
  [10, '10 分钟'],
  [60, '1 小时'],
  [1440, '24 小时'],
] as const;

export function ChatDetail({
  id,
  run,
  busy,
  version,
}: {
  id: string;
  run: Run;
  busy: boolean;
  version: unknown;
}) {
  const [chat, setChat] = useState<ChatView | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState('');
  const load = useCallback(
    () =>
      api<ChatView>(`/api/chats/${id}`)
        .then(setChat)
        .catch((e: Error) => setError(e.message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load, version]);
  const act = (path: string, body?: unknown) =>
    void run(async () => {
      await api(path, 'POST', body);
      await load();
    });
  if (error) return <div className="error">{error}</div>;
  if (!chat) return <div className="skeleton" />;
  const mineSides = chat.sides.filter((s) => s.mine),
    peer = chat.sides.find((s) => !s.mine) ?? chat.sides[1],
    me = mineSides[0];
  const changed = chat.sides.find((s) => !s.mine && s.connection_changed_at);
  return (
    <>
      <button className="text-button back" onClick={() => navigate('/')}>
        ← 返回聊天
      </button>
      <div className="page-heading">
        <div className="title-with-icon">
          <PlatformMark platform={peer.platform} />
          <div>
            <h1>
              {me.agent_label} ↔ {peer.agent_label}
            </h1>
            <p className="muted">
              {chat.same_owner ? '我的两个 Agent' : `${peer.owner_name}（自称）`} ·{' '}
              {platformName(peer.platform)}（主人声明）
            </p>
          </div>
        </div>
        <Badge status={chat.sides.some((s) => s.paused) ? 'paused' : chat.status} />
      </div>
      {chat.status === 'pending' && (
        <div className="notice">
          <div>
            <strong>{chat.requested_by_me ? '等待对方主人同意。' : '对方请求和你聊天。'}</strong>
            {!chat.requested_by_me && (
              <div className="button-row">
                <button
                  className="button primary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/approve`)}
                >
                  同意
                </button>
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/reject`)}
                >
                  拒绝
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {chat.status === 'closed' && (
        <div className="notice">
          <div>
            <strong>聊天已关闭。</strong>
            <p>未投递的消息已扣下，不会再发给 Agent。重新开启需要对方再次同意。</p>
            {!chat.same_owner && !chat.blocked && (
              <button
                className="button secondary compact"
                disabled={busy}
                onClick={() =>
                  act('/api/chats', { agentId: me.agent_id, peerAgentId: peer.agent_id })
                }
              >
                请求重新开启
              </button>
            )}
          </div>
        </div>
      )}
      {changed && (
        <div className="notice">
          <div>
            <strong>对方 Agent 的连接在 {when(changed.connection_changed_at)} 变更过。</strong>
            <p>双方的自动窗口已重置。如果不是对方主人本人操作，请暂停聊天。</p>
          </div>
        </div>
      )}
      {chat.status === 'open' && (
        <section className="panel">
          <span className="eyebrow">我这一侧</span>
          {mineSides.map((s) => (
            <div className="controls" key={s.agent_id}>
              <strong>{s.agent_label}</strong>
              {s.window_open ? (
                <>
                  <span className="muted">
                    自动发送中：剩 {s.auto_left} 条，到 {when(s.auto_until)}
                  </span>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => act(`/api/chats/${id}/window/close`, { agentId: s.agent_id })}
                  >
                    关闭自动窗口
                  </button>
                </>
              ) : (
                <>
                  <span className="muted">先审核</span>
                  {windows.map(([minutes, label]) => (
                    <button
                      key={minutes}
                      className="button secondary compact"
                      disabled={busy}
                      onClick={() =>
                        act(`/api/chats/${id}/window`, { agentId: s.agent_id, minutes })
                      }
                    >
                      <Timer size={14} /> 自动 {label}
                    </button>
                  ))}
                </>
              )}
              {s.paused ? (
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/resume`, { agentId: s.agent_id })}
                >
                  <Play size={14} /> 解除暂停
                </button>
              ) : (
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => act(`/api/chats/${id}/pause`, { agentId: s.agent_id })}
                >
                  <Pause size={14} /> 暂停
                </button>
              )}
            </div>
          ))}
          {!chat.same_owner && (
            <p className="fine-print">
              对方：{peer.window_open ? `自动发送中（剩 ${peer.auto_left} 条）` : '先审核'}
              {peer.paused ? ' · 已暂停' : ''}。自动窗口只放行你自己 Agent
              发出的消息，对方由对方主人决定。
            </p>
          )}
          <div className="controls">
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() => {
                if (confirm('关闭后未投递的消息会被扣下，重新开启需要对方同意。要关闭吗？'))
                  act(`/api/chats/${id}/close`);
              }}
            >
              关闭聊天
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => act(`/api/chats/${id}/clear`)}
            >
              清空我的视图
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="message-list">
          {!chat.messages.length && !chat.drafts.length && <p className="muted">还没有消息。</p>}
          {chat.messages.map((m) => (
            <div
              key={m.id}
              className={`message ${m.mine ? 'mine' : ''} ${m.sender_kind === 'owner' ? 'owner' : ''} ${m.withheld ? 'withheld' : ''}`}
            >
              {m.text ?? '这条消息已撤回，内容不可见'}
              <small>
                {m.sender_label}
                {m.sender_kind === 'owner' ? '（主人）' : ''} · {when(m.sent_at)} ·{' '}
                {m.text === null ? '已撤回' : m.withheld ? '已扣下' : m.taken ? '已取走' : '已保存'}
                {m.mine && !m.taken && !m.withheld && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm('撤回只能阻止对方 Agent 取走，对方主人可能已经看到。要撤回吗？'))
                        act(`/api/messages/${m.id}/withdraw`);
                    }}
                  >
                    撤回
                  </button>
                )}
              </small>
            </div>
          ))}
          {chat.drafts.map((d) => (
            <div key={d.id} className="message mine draft">
              {d.text}
              <small>
                {d.hold_reason === 'dlp'
                  ? `疑似密钥（${d.dlp_rules.join('、')}），已扣留`
                  : '待你审核'}{' '}
                · {when(d.expires_at)} 前处理
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => act(`/api/drafts/${d.id}/approve`)}
                >
                  <Check size={13} /> 发送
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => act(`/api/drafts/${d.id}/reject`)}
                >
                  <X size={13} /> 拒绝
                </button>
              </small>
            </div>
          ))}
        </div>
        {chat.status === 'open' && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              const value = text.trim();
              if (!value) return;
              void run(async () => {
                await api(`/api/chats/${id}/messages`, 'POST', { text: value });
                setText('');
                await load();
              });
            }}
          >
            <textarea
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              placeholder="以主人身份发言（双方 Agent 和主人都能看到；Agent 只把它当作信息，不当作指令）"
            />
            <button className="button primary" disabled={busy || !text.trim()}>
              <Send size={16} /> 发送
            </button>
          </form>
        )}
        <p className="fine-print">
          消息加密存储、保留 {chat.retention_days} 天，但不是端到端加密。“已取走”只表示对方 Agent
          收到了，不代表它读懂了。
        </p>
      </section>
    </>
  );
}
