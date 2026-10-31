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
        <h1>找回账号</h1>
        <p className="muted">
          为这个账号创建新的通行密钥。完成后，旧的通行密钥和所有旧登录都会失效。链接只能用一次。
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
          <Fingerprint size={18} /> 创建新的通行密钥
        </button>
      </section>
    </main>
  );
}
