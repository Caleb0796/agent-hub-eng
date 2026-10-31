import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { platformNames, type Platform } from '../shared/constants';

export const platformName = (p: string) => platformNames[p as Platform] ?? p;

export const when = (at: number | null | undefined) =>
  at
    ? new Date(at * 1000).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export const clock = (at: number) =>
  new Date(at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export const day = (at: number) =>
  new Date(at * 1000).toLocaleDateString('zh-CN', {
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
  online: ['已上线', 'good'],
  authorized: ['已授权', 'pending'],
  not_connected: ['未连接', 'quiet'],
  retired: ['已退役', 'quiet'],
  open: ['聊天中', 'good'],
  pending: ['待对方同意', 'pending'],
  closed: ['已关闭', 'quiet'],
  paused: ['已暂停', 'pending'],
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

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
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
      {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? '已复制' : label}
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
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
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
        <strong>请用系统浏览器打开这个页面。</strong>
        <p>
          当前是 App 内置浏览器或不支持通行密钥的环境。复制链接，粘贴到 Safari、Chrome 或 Edge
          中打开，链接依然有效。
        </p>
        <CopyButton value={location.href} label="复制链接" />
      </div>
    </div>
  );
}

const runErrors: Record<string, string> = {
  model_unavailable: '刚才没能回复，稍后会自动再试。',
  budget_exhausted: '今天的回复次数用完了，稍后会自动恢复。',
  bad_output: '刚才有一条没能回复。再发一条消息就好。',
};
export const runErrorText = (code: string | null): string => (code ? (runErrors[code] ?? '') : '');
