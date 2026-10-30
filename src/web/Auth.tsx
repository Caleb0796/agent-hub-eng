import { useEffect, useRef, useState, type FormEvent } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ArrowUpRight, Fingerprint, ShieldCheck } from 'lucide-react';
import { api, ApiError, safeReturnPath } from './api';
import {
  bindOwnerKey,
  draftOwnerKey,
  handleOwnerKey,
  replaceApprovalKey,
  saveHandleOwnerKey,
  type OwnerView,
} from './keys';
import { signPayload } from '../shared/crypto';

type Mode = 'login' | 'register';
type Support = 'checking' | 'ready' | 'no-webauthn' | 'no-ed25519';

function passkeyError(err: unknown, mode: Mode): string {
  const name =
    err instanceof Error
      ? err.name === 'Error' && err.cause instanceof Error
        ? err.cause.name
        : err.name
      : '';
  if (name === 'NotAllowedError')
    return mode === 'login'
      ? '没有完成通行密钥登录：已取消、超时，或这台设备上没有本站的通行密钥。还没有账号的话，请选择“创建账号”。'
      : '通行密钥创建已取消或超时，请再点一次按钮。';
  if (name === 'InvalidStateError') return '这台设备已为本站创建过通行密钥，请选择“已有账号”登录。';
  if (name === 'SecurityError')
    return '当前网址与 Agent Hub 正式地址不一致，请从邀请链接重新打开。';
  if (err instanceof ApiError) return err.message;
  return '未能完成，请刷新页面后重试';
}

export function Auth({ onLogin }: { onLogin: (owner: OwnerView) => void }) {
  const params = new URLSearchParams(location.search);
  const linkedInvite =
    new URLSearchParams(location.hash.slice(1)).get('signupInvite') ??
    params.get('signupInvite') ??
    '';
  // An invitation link always means a new owner, whichever path it was opened on.
  const [mode, setMode] = useState<Mode>(
      linkedInvite ? 'register' : location.pathname === '/login' ? 'login' : 'register',
    ),
    [handle, setHandle] = useState(''),
    [name, setName] = useState('');
  const [invite, setInvite] = useState(linkedInvite),
    [inviteValid, setInviteValid] = useState<boolean | undefined>(),
    [support, setSupport] = useState<Support>('checking'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stage, setStage] = useState('');
  const draft = useRef<Awaited<ReturnType<typeof draftOwnerKey>>>(undefined);

  useEffect(() => {
    if (!window.PublicKeyCredential) {
      setSupport('no-webauthn');
      return;
    }
    draftOwnerKey().then(
      (key) => {
        draft.current = key;
        setSupport('ready');
      },
      () => setSupport('no-ed25519'),
    );
  }, []);

  async function checkInvite(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return setInviteValid(undefined);
    try {
      const { valid } = await api<{ valid: boolean }>('/api/auth/invite/check', 'POST', {
        invite: trimmed,
      });
      setInviteValid(valid);
    } catch {
      setInviteValid(undefined);
    }
  }
  useEffect(() => {
    if (linkedInvite) void checkInvite(linkedInvite);
  }, []);

  const unsupported =
    support === 'no-webauthn' || (mode === 'register' && support === 'no-ed25519');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result: { owner: OwnerView };
      if (mode === 'register') {
        const normalized = handle.trim().toLowerCase(),
          existing = await handleOwnerKey(normalized),
          key = existing ?? draft.current ?? (await draftOwnerKey());
        const setup = await api<{
          options: PublicKeyCredentialCreationOptionsJSON;
          signingChallenge: unknown;
        }>('/api/auth/register/options', 'POST', {
          handle: normalized,
          name: name.trim(),
          signingKey: key.publicKey,
          ...(invite.trim() ? { invite: invite.trim() } : {}),
        });
        const response = await startRegistration({ optionsJSON: setup.options });
        if (!existing) {
          await saveHandleOwnerKey(normalized, key);
          draft.current = undefined;
          void draftOwnerKey().then((next) => (draft.current = next));
        }
        result = await api('/api/auth/register/verify', 'POST', {
          response,
          signingProof: await signPayload(key.privateKey, setup.signingChallenge),
        });
        // The invitation is consumed; keep it out of the address bar and history.
        history.replaceState(null, '', location.pathname + location.search);
        // Upgrade to a passkey-derived approval key so other devices can sign too.
        // On any failure the browser-held key above stays valid.
        if (response.clientExtensionResults.prf?.enabled !== false) {
          setStage('再确认一次通行密钥，用于启用跨设备签名…');
          try {
            result = {
              owner: await replaceApprovalKey(result.owner, {
                credentialId: response.id,
                fallback: false,
              }),
            };
          } catch {
            // Unsupported or cancelled: signing remains limited to this browser.
          }
        }
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
      setError(passkeyError(err, mode));
    } finally {
      setBusy(false);
      setStage('');
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
                    onChange={(e) => {
                      setInvite(e.target.value);
                      setInviteValid(undefined);
                    }}
                    onBlur={(e) => void checkInvite(e.target.value)}
                    autoComplete="off"
                    placeholder="邀请链接会自动填入"
                  />
                  {inviteValid === false && (
                    <small className="error-text">
                      这个邀请码无效、已过期或已被使用，请向邀请人索取新的链接。
                    </small>
                  )}
                </label>
                <div className="notice">
                  <ShieldCheck size={19} />
                  <div>
                    <strong>请在你日常使用的浏览器中注册，不要使用 App 内置浏览器。</strong>
                    <p>
                      注册时会请你确认两次通行密钥。设备支持时，授权密钥由通行密钥派生，换设备也能签名；不支持时只能在这个浏览器签名。
                    </p>
                  </div>
                </div>
              </>
            )}
            {mode === 'login' && params.get('returnTo') && (
              <p className="muted">
                第一次使用？请先选择“创建账号”，注册完成后会自动回到授权页面。如果这是 App
                内置的浏览器，请复制链接到日常使用的浏览器中打开。
              </p>
            )}
            {unsupported && (
              <div className="error" role="alert">
                当前浏览器不支持通行密钥或所需的加密功能。请用最新版 Chrome、Safari、Edge 或 Firefox
                直接打开此链接，不要使用 App 内置浏览器。
              </div>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button primary full"
              disabled={
                busy ||
                unsupported ||
                (mode === 'register' && (support === 'checking' || inviteValid === false))
              }
              type="submit"
            >
              <Fingerprint size={19} />
              {busy
                ? stage || '正在等待设备确认…'
                : mode === 'register'
                  ? '用通行密钥创建账号'
                  : '用通行密钥登录'}
              <ArrowUpRight size={18} />
            </button>
          </form>
          <p className="fine-print">测试期间请保留这个浏览器的网站数据。跨设备恢复尚未开放。</p>
        </div>
      </main>
    </div>
  );
}
