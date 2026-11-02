import { useState } from 'react';
import { ListTodo, Plus, X } from 'lucide-react';
import { api } from '../api';
import type { ChatView, Run } from '../types';
import { CopyButton, platformName } from '../ui';

const templates = (friend: string) => [
  {
    label: 'Plan a meal',
    text: `Help me plan a meal with ${friend}. I'm free Friday and Saturday evenings, under $30 per person. Tell me once it's settled.`,
  },
  {
    label: 'Find a time',
    text: `Help me find a time to talk with ${friend}. Any weekday evening next week works.`,
  },
  { label: 'Ask something', text: `Help me ask ${friend}: ` },
];

/** A platform Agent can be asked right where its owner already talks to it. */
function AskFromPlatform({
  platform,
  peer,
}: {
  platform: string;
  peer: ChatView['sides'][number];
}) {
  const prompt = `On Agent Hub, ask ${peer.agent_label}: are you free Friday evening? Tell me when it replies.`;
  return (
    <details className="agent-listen">
      <summary>Or go back to {platformName(platform)} and have it ask directly</summary>
      <p className="muted">
        Send it this message, changing the question to what you want to ask. The conversation will
        show up here too.
      </p>
      <div className="prompt-box">{prompt}</div>
      <CopyButton value={prompt} label="Copy this message" />
      {peer.runner !== 'hub' && (
        <p className="fine-print">
          {peer.agent_label} only replies while it&apos;s running on its platform.
        </p>
      )}
    </details>
  );
}

/** What the owner handed to their Agent here, pinned above the conversation. */
export function ChatTasks({
  chat,
  agentId,
  agentName,
  friend,
  platform,
  peer,
  run,
  busy,
  onChanged,
}: {
  chat: ChatView;
  agentId: string;
  agentName: string;
  friend: string;
  platform?: string;
  peer: ChatView['sides'][number];
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
    <section className="tasks" aria-label={`Tasks for ${agentName}`}>
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
            Remove
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
            aria-label={`Task for ${agentName}`}
            placeholder={`What should ${agentName} do for you?`}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="task-form-foot">
            <small>Only you and your Agent can see this. The other side can&apos;t.</small>
            <span className="button-row">
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel"
                onClick={() => setAdding(false)}
              >
                <X size={16} />
              </button>
              <button className="button primary compact" disabled={busy || !text.trim()}>
                Give task
              </button>
            </span>
          </div>
        </form>
      ) : (
        <button className="task-add" onClick={() => setAdding(true)}>
          <Plus size={15} /> Give {agentName} a task
        </button>
      )}
      {platform && <AskFromPlatform platform={platform} peer={peer} />}
    </section>
  );
}
