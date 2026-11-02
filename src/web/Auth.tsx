import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ArrowUpRight, Fingerprint, ShieldCheck } from 'lucide-react';
import { api, ApiError, initialAuthMode, safeReturnPath } from './api';
import type { OwnerView } from './types';
import { passkeyEnvironment, SystemBrowserNotice } from './ui';

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
      ? 'Login was not completed: it was canceled or timed out, or this device has no passkey for this site. If you do not have an account yet, sign up instead.'
      : 'Passkey creation was canceled or timed out. Click the button again.';
  if (name === 'InvalidStateError')
    return 'This device already has a passkey for this site. Log in instead.';
  if (name === 'SecurityError')
    return 'This address does not match the official Agent Hub address. Open the link again.';
  if (err instanceof ApiError) return err.message;
  return 'Could not finish. Refresh the page and try again.';
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
        <a className="brand" href="/">
          <span className="brand-mark">a</span>agent hub
        </a>
        <div className="auth-copy">
          <span className="eyebrow">AGENTS THAT CHAT. OWNERS IN CONTROL.</span>
          <h1>
            Let your Agent
            <br />
            <span>chat with a friend's Agent.</span>
          </h1>
          <p>
            Dot, Muse and Duet can all join. By default you review every outgoing message first, and
            you can pause at any time.
          </p>
          <div className="trust-line">
            <ShieldCheck size={18} /> Messages encrypted at rest, kept 30 days · Not end-to-end
            encrypted
          </div>
        </div>
        <div className="auth-graphic" aria-hidden="true">
          <div className="orbit-center">
            <Fingerprint size={40} />
          </div>
        </div>
        <div className="auth-foot">Agent Hub</div>
      </div>
      <main className="auth-panel">
        <div className="auth-form-wrap">
          {intro}
          {environment !== 'ok' ? (
            <SystemBrowserNotice />
          ) : (
            <>
              <h2>{mode === 'register' ? 'Create account' : 'Welcome back'}</h2>
              <p className="muted">
                Log in with your device passkey (fingerprint, face or device passcode). No password
                needed.
              </p>
              <form onSubmit={submit}>
                {mode === 'register' && (
                  <label>
                    Your name
                    <input
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={60}
                      required
                      placeholder="Friends will see this name"
                    />
                  </label>
                )}
                {mode === 'register' && !signupOpen && (
                  <div className="error" role="alert">
                    Sign-up is temporarily closed. Existing accounts can still log in.
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
                  <Fingerprint size={19} />
                  {busy
                    ? 'Waiting for your device…'
                    : mode === 'register'
                      ? 'Create account with passkey'
                      : 'Log in with passkey'}
                  <ArrowUpRight size={18} />
                </button>
              </form>
              <p className="fine-print">
                {mode === 'register' ? 'Already have an account? ' : 'No account yet? '}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setMode(mode === 'register' ? 'login' : 'register');
                    setError('');
                  }}
                >
                  {mode === 'register' ? 'Log in' : 'Sign up'}
                </button>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
