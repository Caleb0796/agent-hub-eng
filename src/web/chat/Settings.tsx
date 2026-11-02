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
    <aside className="chat-drawer" aria-label="Chat settings">
      <div className="drawer-head">
        <strong>Chat settings</strong>
        <button className="icon-button" aria-label="Close settings" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <section>
        <h3>Who&apos;s here</h3>
        <ul className="people">
          {owners.map((s) => (
            <li key={s.owner_id}>
              <Avatar kind="owner" name={s.owner_name} />
              <span>
                <strong>{s.owner_name}</strong>
                <small>{s.mine ? 'You' : 'Other owner (they chose this name)'}</small>
              </span>
            </li>
          ))}
          {chat.sides.map((s) => (
            <li key={s.agent_id}>
              <Avatar kind="agent" name={s.agent_label} platform={s.platform} />
              <span>
                <strong>{s.agent_label}</strong>
                <small>{s.mine ? 'Your Agent' : `${s.owner_name}'s Agent`}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {chat.status === 'open' && (
        <section>
          <h3>My side</h3>
          <p className="drawer-note">
            Your Agent sends messages for you directly. It treats what you send here as your
            instructions; what the other side says is only for reference.
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
                  <span>Review {s.agent_label}&apos;s messages first</span>
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
                  {s.paused ? 'Resume' : 'Pause this chat'}
                </button>
              </div>
            ))}
        </section>
      )}
      <section>
        <h3>Messages</h3>
        <p className="drawer-note">
          Messages are encrypted at rest and kept for {chat.retention_days} days, but this is not
          end-to-end encryption: the Hub can technically decrypt them. Don&apos;t send passwords, ID
          documents or other sensitive details.
        </p>
        {chat.sides.some((s) => s.runner === 'hub') && (
          <p className="drawer-note">
            The Hub runs{' '}
            {chat.sides
              .filter((s) => s.runner === 'hub')
              .map((s) => s.agent_label)
              .join(', ')}{' '}
            on Meta&apos;s Muse Spark, and messages in this chat are sent to that model to generate
            replies.
          </p>
        )}
        {chat.sides.some((s) => s.runner === 'platform') && (
          <p className="drawer-note">
            A connected Agent only gets messages while it&apos;s running on its platform, so replies
            may not be immediate.
          </p>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => act(`/api/chats/${chat.id}/clear`)}
        >
          Clear my view
        </button>
        {chat.status === 'open' && (
          <button className="text-button danger" disabled={busy} onClick={onCloseChat}>
            Close chat
          </button>
        )}
      </section>
    </aside>
  );
}
