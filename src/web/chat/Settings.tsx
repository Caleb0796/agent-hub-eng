import { Pause, Play, X } from 'lucide-react';
import type { ChatView } from '../types';
import { Avatar } from '../ui';

export function ChatSettings({
  chat,
  busy,
  onClose,
  act,
  onCloseChat,
}: {
  chat: ChatView;
  busy: boolean;
  onClose: () => void;
  act: (path: string, body?: unknown) => void;
  onCloseChat: () => void;
}) {
  const owners = [...new Map(chat.sides.map((s) => [s.owner_id, s])).values()];
  return (
    <aside className="chat-drawer" aria-label="聊天设置">
      <div className="drawer-head">
        <strong>聊天设置</strong>
        <button className="icon-button" aria-label="关闭设置" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <section>
        <h3>谁在这里</h3>
        <ul className="people">
          {owners.map((s) => (
            <li key={s.owner_id}>
              <Avatar kind="owner" name={s.owner_name} />
              <span>
                <strong>{s.owner_name}</strong>
                <small>{s.mine ? '你' : '对方主人（名字由本人填写）'}</small>
              </span>
            </li>
          ))}
          {chat.sides.map((s) => (
            <li key={s.agent_id}>
              <Avatar kind="agent" name={s.agent_label} platform={s.platform} />
              <span>
                <strong>{s.agent_label}</strong>
                <small>{s.mine ? '你的 Agent' : `${s.owner_name} 的 Agent`}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {chat.status === 'open' && (
        <section>
          <h3>我的 Agent</h3>
          <p className="drawer-note">
            Agent 会直接替你发消息。在这里发的消息，你的 Agent 会当作你的指令；对方说的话只作参考。
          </p>
          {chat.sides
            .filter((s) => s.mine)
            .map((s) => (
              <div className="drawer-side" key={s.agent_id}>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={s.review_required}
                    disabled={busy}
                    onChange={(e) =>
                      act(`/api/chats/${chat.id}/review`, {
                        agentId: s.agent_id,
                        on: e.target.checked,
                      })
                    }
                  />
                  <span>{s.agent_label} 发出前先给我看</span>
                </label>
                <button
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() =>
                    act(`/api/chats/${chat.id}/${s.paused ? 'resume' : 'pause'}`, {
                      agentId: s.agent_id,
                    })
                  }
                >
                  {s.paused ? <Play size={14} /> : <Pause size={14} />}
                  {s.paused ? '解除暂停' : '暂停这个聊天'}
                </button>
              </div>
            ))}
        </section>
      )}
      <section>
        <h3>消息</h3>
        <p className="drawer-note">
          消息加密存储，保留 {chat.retention_days} 天，但不是端到端加密，Hub
          技术上能解密。不要发密码、证件等敏感资料。
        </p>
        {chat.sides.some((s) => s.runner === 'hub') && (
          <p className="drawer-note">
            {chat.sides
              .filter((s) => s.runner === 'hub')
              .map((s) => s.agent_label)
              .join('、')}{' '}
            由 Hub 调用 Meta 的 Muse Spark 运行，这个聊天的消息会发给这个模型来生成回复。
          </p>
        )}
        {chat.sides.some((s) => s.runner === 'platform') && (
          <p className="drawer-note">
            连接进来的 Agent 只有在它的平台运行时才会收到消息，所以回复不一定是即时的。
          </p>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => act(`/api/chats/${chat.id}/clear`)}
        >
          清空我这边的记录
        </button>
        {chat.status === 'open' && (
          <button className="text-button danger" disabled={busy} onClick={onCloseChat}>
            关闭聊天
          </button>
        )}
      </section>
    </aside>
  );
}
