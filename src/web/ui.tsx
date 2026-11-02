import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { platformNames, type Platform } from '../shared/constants';

export const platformName = (p: string) => platformNames[p as Platform] ?? p;

export const when = (at: number | null | undefined) =>
  at
    ? new Date(at * 1000).toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

export const clock = (at: number) =>
  new Date(at * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** For the 36px hover gutter, where AM/PM would wrap; the group's first message shows it. */
export const shortClock = (at: number) => clock(at).replace(/\s*[AP]M$/, '');

export const day = (at: number) =>
  new Date(at * 1000).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });

/** People are round and Agents are square, everywhere, so nobody mistakes one for the other. */
export function Avatar({
  kind,
  name,
  platform,
  size,
}: {
  kind: 'agent' | 'owner';
  name: string;
  platform?: string;
  size?: 'small';
}) {
  const shape = kind === 'agent' ? `agent ${platform ?? ''}` : 'person';
  return (
    <span className={`avatar ${shape}${size ? ` ${size}` : ''}`} aria-hidden="true">
      {(kind === 'agent' && platform ? platformName(platform) : name).slice(0, 1)}
    </span>
  );
}

const labels: Record<string, [string, 'good' | 'pending' | 'quiet']> = {
  online: ['Online', 'good'],
  authorized: ['Authorized', 'pending'],
  not_connected: ['Not connected', 'quiet'],
  retired: ['Retired', 'quiet'],
  open: ['Open', 'good'],
  pending: ['Awaiting approval', 'pending'],
  closed: ['Closed', 'quiet'],
  paused: ['Paused', 'pending'],
};
export function Badge({ status, label }: { status: string; label?: string }) {
  const [text, tone] = labels[status] ?? [status, 'pending'];
  return (
    <span className={`badge ${tone}`}>
      <span />
      {label ?? text}
    </span>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <div className="muted">{children}</div>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="button secondary compact"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : label}
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

/** In-app browsers (WeChat, etc.) often cannot use passkeys; send people to the system browser. */
export function passkeyEnvironment(): 'ok' | 'in-app' | 'unsupported' {
  const ua = navigator.userAgent;
  if (
    /MicroMessenger|WeChat|QQ\/|FBAN|FBAV|Instagram|Line\/|DingTalk|Lark|Feishu|Weibo|wv\)/i.test(
      ua,
    )
  )
    return 'in-app';
  return window.PublicKeyCredential ? 'ok' : 'unsupported';
}

export function SystemBrowserNotice() {
  return (
    <div className="notice">
      <div>
        <strong>Open this page in your system browser.</strong>
        <p>
          This is an in-app browser or an environment that does not support passkeys. Copy the link
          and open it in Safari, Chrome or Edge. The link still works.
        </p>
        <CopyButton value={location.href} label="Copy link" />
      </div>
    </div>
  );
}

const runErrors: Record<string, string> = {
  model_unavailable: "Couldn't reply just now. It will try again automatically soon.",
  budget_exhausted: "Today's replies are used up. They will resume automatically later.",
  bad_output: "One message didn't get a reply. Just send another message.",
};
export const runErrorText = (code: string | null): string => (code ? (runErrors[code] ?? '') : '');
