import { useState } from 'react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { Fingerprint } from 'lucide-react';
import { api } from '../api';
import { passkeyError } from '../Auth';
import type { OwnerView } from '../types';
import { passkeyEnvironment, SystemBrowserNotice } from '../ui';

/** /recover#token — operator-issued, one-time. Replaces every old passkey and session. */
export function RecoverPage({ onLogin }: { onLogin: (o: OwnerView) => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (passkeyEnvironment() !== 'ok')
    return (
      <main className="workspace">
        <SystemBrowserNotice />
      </main>
    );
  return (
    <main className="workspace">
      <section className="panel">
        <h1>Recover account</h1>
        <p className="muted">
          Create a new passkey for this account. When you finish, your old passkeys and all existing
          logins stop working. The link can be used only once.
        </p>
        {error && <div className="error">{error}</div>}
        <button
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const setup = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>(
                '/api/auth/recover/options',
                'POST',
                {
                  token: location.hash.slice(1),
                },
              );
              const response = await startRegistration({ optionsJSON: setup.options });
              const result = await api<{ owner: OwnerView }>('/api/auth/recover/verify', 'POST', {
                response,
              });
              history.replaceState(null, '', '/');
              onLogin(result.owner);
            } catch (e) {
              setError(passkeyError(e, 'register'));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Fingerprint size={18} /> Create new passkey
        </button>
      </section>
    </main>
  );
}
