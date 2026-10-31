import { memo } from 'react';
import { findMentions } from '../../shared/mentions';

/** Message text with @mentions highlighted. Links stay plain text: messages are not trusted. */
export const MessageText = memo(function MessageText({
  text,
  names,
  myNames,
}: {
  text: string;
  names: string[];
  myNames: string[];
}) {
  const parts = [];
  let at = 0;
  for (const m of findMentions(text, names)) {
    parts.push(text.slice(at, m.start));
    parts.push(
      <span className={myNames.includes(m.name) ? 'mention me' : 'mention'} key={m.start}>
        {text.slice(m.start, m.end)}
      </span>,
    );
    at = m.end;
  }
  parts.push(text.slice(at));
  return <div className="msg-text">{parts}</div>;
});
