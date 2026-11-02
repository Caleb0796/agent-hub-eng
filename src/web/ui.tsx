import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { platformNames, type Platform } from '../shared/protocol';

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

export function PlatformMark({ platform }: { platform: string }) {
  return (
    <span className={`platform ${platform}`} aria-label={platformName(platform)}>
      {platformName(platform).slice(0, 1)}
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
