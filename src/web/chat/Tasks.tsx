import { useState } from 'react';
import { ListTodo, Plus, X } from 'lucide-react';
import { api } from '../api';
import type { ChatView, Run } from '../types';

const templates = (friend: string) => [
  {
    label: '约饭',
    text: `帮我和 ${friend} 约一顿饭。我周五、周六晚上有空，人均 200 以内。定下来后告诉我。`,
  },
  { label: '约时间', text: `帮我和 ${friend} 约个时间聊聊，下周工作日晚上都行。` },
  { label: '问点事', text: `帮我问问 ${friend}：` },
];

/** What the owner handed to their Agent here, pinned above the conversation. */
export function ChatTasks({
  chat,
  agentId,
  agentName,
  friend,
  run,
  busy,
  onChanged,
}: {
  chat: ChatView;
  agentId: string;
  agentName: string;
  friend: string;
  run: Run;
  busy: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false),
    [text, setText] = useState('');
  const save = () =>
    void run(async () => {
      await api(`/api/chats/${chat.id}/grants`, 'POST', { text, agentId });
      setText('');
      setAdding(false);
      await onChanged();
    });
  return (
    <section className="tasks" aria-label={`交给 ${agentName} 的事`}>
      {chat.grants.map((g) => (
        <div className="task" key={g.id}>
          <ListTodo size={15} />
          <span>{g.text}</span>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/api/grants/${g.id}`, 'DELETE');
                await onChanged();
              })
            }
          >
            移除
          </button>
        </div>
      ))}
      {adding ? (
        <form
          className="task-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="chips">
            {templates(friend).map((t) => (
              <button type="button" className="chip" key={t.label} onClick={() => setText(t.text)}>
                {t.label}
              </button>
            ))}
          </div>
          <textarea
            autoFocus
            rows={2}
            maxLength={1000}
            value={text}
            aria-label={`交给 ${agentName} 的事`}
            placeholder={`想让 ${agentName} 替你办什么？`}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="task-form-foot">
            <small>只有你和你的 Agent 能看到，对方看不到。</small>
            <span className="button-row">
              <button
                type="button"
                className="icon-button"
                aria-label="取消"
                onClick={() => setAdding(false)}
              >
                <X size={16} />
              </button>
              <button className="button primary compact" disabled={busy || !text.trim()}>
                交给它
              </button>
            </span>
          </div>
        </form>
      ) : (
        <button className="task-add" onClick={() => setAdding(true)}>
          <Plus size={15} /> 交给 {agentName} 一件事
        </button>
      )}
    </section>
  );
}
