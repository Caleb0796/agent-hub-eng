# Verification of the first-session slice

**Story:** Owner UI and passkeys → authenticated owner API → immutable D1 identities and consent → native OAuth/MCP → two independent Python cryptographic endpoints → ciphertext mailbox → signed receipts and visible session state.

## Current evidence

| Boundary | Result | Evidence |
|---|---|---|
| Type and bundle checks | Passed | Generated Worker bindings, TypeScript, Vite UI and Wrangler dry-run build |
| Owner identity | Passed with synthetic authenticators | Valid W3C registration/authentication signatures, distinct owner accounts, challenge replay rejection, expected origin and approval-key possession |
| OAuth | Passed | Discovery, DCR, browser-bound consent, S256 PKCE, resource binding, code replay rejection and per-Agent revocation |
| Domain/SQL policy | Passed | 18 Workers tests covering consent, preflight, isolation, concurrency, immutable identity and clocks, quota, receipt window and CSRF |
| Endpoint cryptography | Passed | 6 Python tests with real age encryption, Ed25519 verification, wrong-key rejection, replay/idempotency, pinned owner keys and persistent cutoff |
| Complete protocol flow | Passed | Two isolated identities enroll, claim, pair, approve and exchange four actual encrypted messages; both endpoint digest maps match |
| Hub data boundary | Passed for the fixture | No test plaintext or private-key markers in the accepted message store; cryptographic checks supplement this scan |
| Browser rendering | Inspected | Local owner onboarding screen renders, with no replacement model or fake connection data |
| Browser authenticator UI | Not completed | This computer-use surface does not expose the CDP virtual WebAuthn authenticator; API tests use synthetic devices. A real user must complete the native passkey prompt |
| Native Dot/Muse self-service UI | Pending | Must run against the fixed HTTPS pilot with two real owners and preserve platform consent and approval |

The protocol report is saved in `docs/evidence/mvp-e2e.json`. It explicitly marks `native_ui_compatibility_verified=false`. The earlier native 21-message experiment is preserved separately and must not be counted as proof of this new onboarding implementation.

## Reproducing

Run `npm run check` after installing Node dependencies and the pinned Python requirements. The integration test runs the actual built Worker, actual OAuth provider, valid synthetic passkey attestations and the actual Python endpoint, with temporary isolated storage. It does not mock the cryptographic encrypt/decrypt functions.

CI has read-only repository permissions and no production deployment credentials. Local/test data and private keys are excluded from Git. `check:secrets` is an auxiliary publication guard, not a substitute for independent security review.
