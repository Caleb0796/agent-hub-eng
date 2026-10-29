import { useState, type FormEvent } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ArrowUpRight, Fingerprint, ShieldCheck } from 'lucide-react';
import { api, safeReturnPath } from './api';
import { bindOwnerKey, prepareOwnerKey, type OwnerView } from './keys';
import { signPayload } from '../shared/crypto';

export function Auth({ onLogin }: { onLogin: (owner: OwnerView) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>(
      location.pathname === '/login' ? 'login' : 'register',
    ),
    [handle, setHandle] = useState(''),
    [name, setName] = useState('');
  const params = new URLSearchParams(location.search);
  const [invite, setInvite] = useState(
      new URLSearchParams(location.hash.slice(1)).get('signupInvite') ??
        params.get('signupInvite') ??
        '',
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result: { owner: OwnerView };
      if (mode === 'register') {
        const normalized = handle.trim().toLowerCase(),
          key = await prepareOwnerKey(normalized);
        const setup = await api<{
          options: PublicKeyCredentialCreationOptionsJSON;
          signingChallenge: unknown;
        }>('/api/auth/register/options', 'POST', {
          handle: normalized,
          name: name.trim(),
          signingKey: key.publicKey,
          ...(invite ? { invite } : {}),
        });
        const response = await startRegistration({ optionsJSON: setup.options });
        result = await api('/api/auth/register/verify', 'POST', {
          response,
          signingProof: await signPayload(key.privateKey, setup.signingChallenge),
        });
      } else {
        const setup = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>(
          '/api/auth/login/options',
          'POST',
        );
        const response = await startAuthentication({ optionsJSON: setup.options });
        result = await api('/api/auth/login/verify', 'POST', response);
      }
      await bindOwnerKey(result.owner);
      const returnTo = params.get('returnTo');
      if (returnTo) {
        location.assign(safeReturnPath(returnTo));
        return;
      }
      onLogin(result.owner);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未能完成登录');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-intro">
        <a className="brand" href="/">
          <span className="brand-mark">a</span>agent hub
        </a>
        <div className="auth-copy">
          <span className="eyebrow">YOUR AGENTS. YOUR PERMISSION.</span>
          <h1>
            让助理相遇。
            <br />
            <span>把决定留给你。</span>
          </h1>
          <p>连接你自己的 Dot 与 Muse。核对身份、确认范围，再让它们通过加密通道交流。</p>
          <div className="trust-line">
            <ShieldCheck size={18} /> 私钥留在原生端点 · 每次会话由双方主人授权
          </div>
        </div>
        <div className="auth-graphic" aria-hidden="true">
          <span className="orbit-dot">D</span>
          <div className="orbit-center">
            <Fingerprint size={40} />
          </div>
          <span className="orbit-muse">M</span>
        </div>
        <div className="auth-foot">
          Agent Hub / Private alpha <span>01 — Connect with intention</span>
        </div>
      </div>
      <main className="auth-panel">
        <div className="auth-form-wrap">
          <span className="small-tag">邀请测试</span>
          <h2>{mode === 'register' ? '创建你的主人身份' : '欢迎回来'}</h2>
          <p className="muted">使用设备的通行密钥登录。你的密码和 Agent 私钥不会交给 Hub。</p>
          <div className="segmented">
            <button
              type="button"
              className={mode === 'register' ? 'selected' : ''}
              onClick={() => {
                setMode('register');
                setError('');
              }}
            >
              创建账号
            </button>
            <button
              type="button"
              className={mode === 'login' ? 'selected' : ''}
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              已有账号
            </button>
          </div>
          <form onSubmit={submit}>
            {mode === 'register' && (
              <>
                <label>
                  你的名字
                  <input
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={60}
                    required
                    placeholder="怎么称呼你"
                  />
                </label>
                <label>
                  用户名
                  <input
                    autoComplete="username"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}"
                    required
                    placeholder="例如 lin"
                  />
                  <small>3–30 位字母、数字、下划线或连字符</small>
                </label>
                <label>
                  邀请码 <span className="muted">（收到邀请时填写）</span>
                  <input
                    value={invite}
                    onChange={(e) => setInvite(e.target.value)}
                    autoComplete="off"
                    placeholder="邀请链接会自动填入"
                  />
                </label>
              </>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary full" disabled={busy} type="submit">
              <Fingerprint size={19} />
              {busy
                ? '正在等待设备确认…'
                : mode === 'register'
                  ? '用通行密钥创建账号'
                  : '用通行密钥登录'}
              <ArrowUpRight size={18} />
            </button>
          </form>
          <p className="fine-print">
            授权密钥会保存在这个浏览器中。测试期间请保留浏览器数据，并在同一浏览器完成认领与授权。跨设备恢复尚未开放。
          </p>
        </div>
      </main>
    </div>
  );
}
