import { memo } from 'react';
import { Check, ShieldAlert, Undo2, X } from 'lucide-react';
import type { ChatView } from '../types';
import { Avatar, clock, platformName } from '../ui';
import { MessageText } from './Text';

type Message = ChatView['messages'][number];
type Draft = ChatView['drafts'][number];

function deliveryText(m: Message): string {
  if (m.text === null) return '已撤回';
  if (m.withheld) return '已扣下，不会再发给 Agent';
  // "Taken" only means an Agent fetched it; the Hub cannot know that it was read.
  return m.taken ? '对方 Agent 已收到' : '等对方 Agent 下次运行时收取';
}

const sameMessage = (a: Message, b: Message) =>
  (Object.keys(a) as (keyof Message)[]).every((k) => a[k] === b[k]);

export const MessageRow = memo(
  function MessageRow({
    m,
    continued,
    last,
    platform,
    names,
    myNames,
    onWithdraw,
    onMention,
  }: {
    m: Message;
    continued: boolean;
    last: boolean;
    platform?: string;
    names: string[];
    myNames: string[];
    onWithdraw: (id: string) => void;
    onMention: (name: string) => void;
  }) {
    const isAgent = m.sender_kind === 'agent';
    return (
      <div className={`msg${continued ? ' continued' : ''}${m.withheld ? ' withheld' : ''}`}>
        <div className="msg-gutter">
          {continued ? (
            <time className="msg-time-hover">{clock(m.sent_at)}</time>
          ) : (
            <Avatar kind={m.sender_kind} name={m.sender_name} platform={platform} />
          )}
        </div>
        <div className="msg-body">
          {!continued && (
            <div className="msg-head">
              <button
                className="msg-name"
                title={`在消息里提及 ${m.sender_name}`}
                onClick={() => onMention(m.sender_name)}
              >
                {m.sender_name}
              </button>
              <span className={isAgent ? 'role agent' : 'role owner'}>
                {isAgent ? `${platformName(platform ?? '')} Agent` : '主人'}
              </span>
              <time>{clock(m.sent_at)}</time>
            </div>
          )}
          {m.text === null ? (
            <div className="msg-text gone">这条消息已撤回</div>
          ) : (
            <MessageText text={m.text} names={names} myNames={myNames} />
          )}
          {m.mine && (
            <div className={last ? 'msg-meta always' : 'msg-meta'}>
              {deliveryText(m)}
              {m.can_withdraw && (
                <button className="msg-action" onClick={() => onWithdraw(m.id)}>
                  <Undo2 size={12} /> 撤回
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
  (a, b) =>
    sameMessage(a.m, b.m) &&
    a.continued === b.continued &&
    a.last === b.last &&
    a.platform === b.platform &&
    a.names === b.names &&
    a.myNames === b.myNames,
);

/** Shown only to its own owner, like an ephemeral message, until they decide. */
export function DraftRow({
  d,
  name,
  platform,
  names,
  myNames,
  busy,
  onDecide,
}: {
  d: Draft;
  name: string;
  platform?: string;
  names: string[];
  myNames: string[];
  busy: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
}) {
  const dlp = d.hold_reason === 'dlp';
  return (
    <div className="msg draft">
      <div className="msg-gutter">
        <Avatar kind="agent" name={name} platform={platform} />
      </div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name plain">{name}</span>
          <span className="role draft-tag">只有你能看到</span>
        </div>
        <MessageText text={d.text} names={names} myNames={myNames} />
        {dlp && (
          <p className="draft-why">
            <ShieldAlert size={14} /> 疑似包含密钥（{d.dlp_rules.join('、')}），已拦下。
          </p>
        )}
        <div className="draft-actions">
          <button
            className="button primary compact"
            disabled={busy}
            onClick={() => onDecide(d.id, 'approve')}
          >
            <Check size={14} /> 发送
          </button>
          <button
            className="button secondary compact"
            disabled={busy}
            onClick={() => onDecide(d.id, 'reject')}
          >
            <X size={14} /> 丢弃
          </button>
        </div>
      </div>
    </div>
  );
}
