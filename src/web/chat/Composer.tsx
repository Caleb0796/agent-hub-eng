import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Send } from 'lucide-react';
import { MAX_TEXT } from '../../shared/constants';
import { Avatar } from '../ui';

export interface Person {
  kind: 'agent' | 'owner';
  name: string;
  role: string;
  platform?: string;
}
export interface ComposerHandle {
  mention: (name: string) => void;
}

/** The "@query" being typed right before the caret, if any. */
function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const start = text.lastIndexOf('@', caret - 1);
  if (start === -1) return null;
  if (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) return null;
  const query = text.slice(start + 1, caret);
  return /[\n@]/.test(query) ? null : { start, query };
}

// Typing state lives here, so a keystroke never re-renders the message list.
export const Composer = forwardRef<
  ComposerHandle,
  { people: Person[]; placeholder: string; onSend: (text: string) => void }
>(function Composer({ people, placeholder, onSend }, ref) {
  const [text, setText] = useState(''),
    [caret, setCaret] = useState(0),
    [picked, setPicked] = useState(0),
    [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = dismissed ? null : activeQuery(text, caret);
  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q));
  }, [people, trigger?.query, !!trigger]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const place = (value: string, position: number) => {
    setText(value);
    setCaret(position);
    setDismissed(false);
    setPicked(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
  };
  const pick = (name: string) => {
    if (!trigger) return;
    const before = text.slice(0, trigger.start) + `@${name} `;
    place(before + text.slice(caret), before.length);
  };
  useImperativeHandle(ref, () => ({
    mention: (name) => {
      const gap = text && !/\s$/.test(text) ? ' ' : '';
      const value = `${text}${gap}@${name} `;
      place(value, value.length);
    },
  }));
  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    place('', 0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while choosing Chinese characters confirms the IME, not the message.
    if (e.nativeEvent.isComposing) return;
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setPicked((picked + step + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[Math.min(picked, matches.length - 1)].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {matches.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="选择要提及的人">
          {matches.map((p, i) => (
            <li
              key={`${p.kind}:${p.name}`}
              role="option"
              aria-selected={i === Math.min(picked, matches.length - 1)}
              // Keeps focus in the textarea, so the caret and the IME survive the click.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p.name);
              }}
            >
              <Avatar kind={p.kind} name={p.name} platform={p.platform} size="small" />
              <strong>{p.name}</strong>
              <small>{p.role}</small>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={input}
        rows={1}
        value={text}
        maxLength={MAX_TEXT}
        aria-label="消息"
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setDismissed(false);
          setPicked(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <button className="composer-send" aria-label="发送" disabled={!text.trim()}>
        <Send size={17} />
      </button>
    </form>
  );
});
