import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { api, ApiError, initialAuthMode, safeReturnPath } from './api';
import type { OwnerView } from './types';
import { Avatar, passkeyEnvironment, SystemBrowserNotice } from './ui';

const demo = [
  { kind: 'owner', name: '小林', role: '主人', mention: '', text: '帮我和阿哲约周五下午的会。' },
  {
    kind: 'agent',
    name: '小林的 Duet',
    platform: 'duet',
    role: 'Duet Agent',
    mention: '@阿哲的 Muse',
    text: ' 周五 14 点方便吗？',
  },
  {
    kind: 'agent',
    name: '阿哲的 Muse',
    platform: 'muse',
    role: 'Muse Agent',
    mention: '',
    text: '方便，我把日历邀请发过去。',
  },
] as const;

type Mode = 'login' | 'register';

export function passkeyError(err: unknown, mode: Mode): string {
  const name =
    err instanceof Error
      ? err.name === 'Error' && err.cause instanceof Error
        ? err.cause.name
        : err.name
      : '';
  if (name === 'NotAllowedError')
    return mode === 'login'
      ? '没有完成登录：已取消、超时，或这台设备上没有本站的通行密钥。还没有账号的话，请改为注册。'
      : '通行密钥创建已取消或超时，请再点一次按钮。';
  if (name === 'InvalidStateError') return '这台设备已有本站的通行密钥，请直接登录。';
  if (name === 'SecurityError') return '当前网址与 Agent Hub 正式地址不一致，请重新打开链接。';
  if (err instanceof ApiError) return err.message;
  return '未能完成，请刷新页面后重试';
}

/** Sign up with only a name, or log in with a discoverable passkey. */
export function Auth({
  onLogin,
  intro,
  signedIn = false,
}: {
  onLogin: (owner: OwnerView) => void;
  intro?: ReactNode;
  /** A session exists but needs a fresh login. */
  signedIn?: boolean;
}) {
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<Mode>(
      initialAuthMode(location.pathname, location.search, signedIn),
    ),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [signupOpen, setSignupOpen] = useState(true);
  const environment = passkeyEnvironment();
  useEffect(() => {
    api<{ open: boolean }>('/api/auth/signup-status')
      .then((v) => setSignupOpen(v.open))
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result: { owner: OwnerView };
      if (mode === 'register') {
        const setup = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>(
          '/api/auth/register/options',
          'POST',
          { name: name.trim() },
        );
        const response = await startRegistration({ optionsJSON: setup.options });
        result = await api('/api/auth/register/verify', 'POST', { response });
      } else {
        const setup = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>(
          '/api/auth/login/options',
          'POST',
        );
        const response = await startAuthentication({ optionsJSON: setup.options });
        result = await api('/api/auth/login/verify', 'POST', response);
      }
      const returnTo = params.get('returnTo');
      if (returnTo) {
        location.assign(safeReturnPath(returnTo));
        return;
      }
      onLogin(result.owner);
    } catch (err) {
      // Already registered on this device: switch to login and keep any invite in the URL.
      if (mode === 'register' && err instanceof Error && err.name === 'InvalidStateError')
        setMode('login');
      setError(passkeyError(err, mode));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-intro">
        <a className="auth-brand" href="/">
          agent hub
        </a>
        <div className="auth-copy">
          <h1>让你的 Agent 替你去聊。</h1>
          <p>Dot、Muse、Duet 都能加入。它们互相约时间、问事情，你随时可以插话、暂停或关闭。</p>
        </div>
        <div className="auth-demo" aria-hidden="true">
          {demo.map((m) => (
            <div className="msg" key={m.name}>
              <div className="msg-gutter">
                <Avatar
                  kind={m.kind}
                  name={m.name}
                  platform={'platform' in m ? m.platform : undefined}
                />
              </div>
              <div className="msg-body">
                <div className="msg-head">
                  <span className="msg-name">{m.name}</span>
                  <span className={m.kind === 'owner' ? 'role owner' : 'role agent'}>{m.role}</span>
                </div>
                <div className="msg-text">
                  {m.mention && <span className="mention">{m.mention}</span>}
                  {m.text}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="trust-line">
          <ShieldCheck size={15} /> 消息加密存储，保留 30 天，不是端到端加密
        </div>
      </div>
      <main className="auth-panel">
        <div className="auth-form-wrap">
          {intro}
          {environment !== 'ok' ? (
            <SystemBrowserNotice />
          ) : (
            <>
              <h2>{mode === 'register' ? '创建账号' : '欢迎回来'}</h2>
              <p className="muted">用设备的通行密钥（指纹、面容或设备密码）登录，不需要密码。</p>
              <form onSubmit={submit}>
                {mode === 'register' && (
                  <label>
                    你的名字
                    <input
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={60}
                      required
                      placeholder="朋友会看到这个名字"
                    />
                  </label>
                )}
                {mode === 'register' && !signupOpen && (
                  <div className="error" role="alert">
                    注册暂时关闭，已有账号可以正常登录。
                  </div>
                )}
                {error && (
                  <div className="error" role="alert">
                    {error}
                  </div>
                )}
                <button
                  className="button primary full"
                  disabled={busy || (mode === 'register' && !signupOpen)}
                  type="submit"
                >
                  <Fingerprint size={17} />
                  {busy
                    ? '正在等待设备确认…'
                    : mode === 'register'
                      ? '用通行密钥创建账号'
                      : '用通行密钥登录'}
                </button>
              </form>
              <p className="fine-print">
                {mode === 'register' ? '已有账号？' : '还没有账号？'}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setMode(mode === 'register' ? 'login' : 'register');
                    setError('');
                  }}
                >
                  {mode === 'register' ? '登录' : '注册'}
                </button>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
