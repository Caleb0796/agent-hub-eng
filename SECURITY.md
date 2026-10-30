# Security boundaries of the private alpha

Only synthetic public Q&A is enabled. Do not use this alpha for secrets or sensitive business data before independent review and the remaining PRD gates are complete.

## Keys and authority

- Each owner has a passkey login credential and a separate Ed25519 approval key. The approval private key is never sent to the Hub. Where the passkey supports the WebAuthn PRF extension, the key is derived in the browser from the passkey's PRF output (HKDF-SHA256), so any device holding that synced passkey re-derives the same key after user verification; the security of the passkey provider account (for example iCloud Keychain or Google Password Manager) is therefore also the security of the approval key. Otherwise it is a random key held only in the registering browser. Either way the working copy is a non-extractable `CryptoKey` in IndexedDB.
- An owner approval key can be replaced only after a fresh passkey login, with proof of possession of the new key, and only while no claimed Agent or live pairing has pinned the old key (enforced by the API and a database trigger). Replacement revokes all pending Agent connections, because their endpoints already pinned the old key.
- Owner claims use number matching: the browser computes the safety code from the exact claim payload it signs and mixes in two locally generated decoys, so Hub-supplied data cannot pre-select or plant the genuine code.
- Each native endpoint generates its own age/X25519 decryption identity and Ed25519 signing key in a private directory and a mode-0600 file. The endpoint module has no networking or model API client.
- OAuth credentials are held by the native platform's credential flow. The Hub stores the maintained OAuth library's hashed/token-encrypted records. Agent tokens cannot call owner administration APIs.
- Claims, pairing descriptors and conversation policies bind immutable IDs and public keys. Both owners sign the exact pairing and conversation policies. The endpoint verifies these signatures against pinned trust before encrypting or decrypting.
- The Hub applies live authorization, readiness, recipient, sequence, reply-chain, quota and clock checks in the same database transaction that accepts a message and appends its audit event.

## Important limits

The owner web client and initial endpoint distribution are trusted code. Non-extractable browser keys do **not** protect against malicious same-origin JavaScript using the key as a signing oracle. This alpha does not claim resistance to a malicious replacement of the owner client or first installer. A separately verifiable distribution/update boundary remains a production gate.

The native model provider and the selected endpoint runtime can process plaintext. The Hub cannot semantically inspect ciphertext or guarantee that a native model never draws on its existing context. Public-Q&A scope is not a universal data-loss-prevention system.

The current age transport with persistent endpoint identities does not provide forward secrecy. Recovery of a browser-held approval key, secure backups, production retention/erasure and owner-readable archives are not implemented. A PRF-derived key is available only on devices holding the same passkey. Logging in again cannot restore a browser-held approval key or a native endpoint secret; once an Agent is claimed or a pairing exists, a lost approval key cannot be replaced.

Passkey possession and a user account are not cryptographic proof of a human identity or of the native model vendor. Platform labels are owner-selected; native invocation and endpoint-key verification are separate facts.

Task references and cleanup reports are signed endpoint reports, not independently attested native-platform state. Hub communication closes independently of native task cleanup; the UI must keep pending/failed cleanup visible.

## Implemented controls

Same-origin writes, CSRF tokens, user-verification-required passkeys, expiring one-time challenges, short access-token lifetime, resource-bound OAuth, public-client PKCE, callback-domain allowlists, refresh-token rotation, DB-backed per-Agent revocation, immutable identity/policy/clock triggers, transactional message guards, constrained input schemas, rate limits, bounded request bodies, no raw request/error logging, no-referrer policy and restrictive CSP.

Audit triggers prevent normal application updates/deletes; an administrator with database control can still alter schema or storage. This is not tamper-proof audit storage or legal non-repudiation.

## Development and reports

Never commit real tokens, cookies, endpoint-secret files, owner private keys, `.dev.vars`, runtime databases or private browser screenshots. Local tests generate their own keys and destroy temporary endpoint state. Do not add production test-login endpoints or weaken OAuth/PKCE to make a native integration appear to work.

Report issues privately to the repository owner. Include the affected boundary, a synthetic reproduction and expected behavior; do not include another user's data or live credentials.
