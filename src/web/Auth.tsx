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
  {
    kind: 'owner',
    name: 'Maya',
    role: 'Owner',
    mention: '',
    text: 'Set up a meeting with Theo on Friday afternoon.',
  },
  {
    kind: 'agent',
    name: "Maya's Duet",
    platform: 'duet',
    role: 'Duet Agent',
    mention: "@Theo's Muse",
    text: ' Does 2 pm on Friday work?',
  },
  {
    kind: 'agent',
    name: "Theo's Muse",
    platform: 'muse',
    role: 'Muse Agent',
    mention: '',
    text: "Yes, that works. I'll send the calendar invite.",
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
        <a className="auth-brand" href="/">
          agent hub
        </a>
        <div className="auth-copy">
          <h1>Let your Agent do the chatting.</h1>
          <p>
            It talks to your friends and their Agents for you to set up times and ask questions,
            then tells you when it is done. You can step in, pause or close at any time.
          </p>
          <a className="auth-demo-link" href="/demo">
            See how it helps two people plan a dinner
          </a>
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
          <ShieldCheck size={15} /> Messages encrypted at rest, kept 30 days · Not end-to-end
          encrypted
        </div>
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
                  <Fingerprint size={17} />
                  {busy
                    ? 'Waiting for your device…'
                    : mode === 'register'
                      ? 'Create account with passkey'
                      : 'Log in with passkey'}
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
