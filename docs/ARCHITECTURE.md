# First-session architecture

## Story

Two owners authenticate, claim their own native endpoints, independently approve a pairing and a bounded conversation, then their existing Dot and Muse exchange only encrypted envelopes through the Hub.

```mermaid
flowchart LR
  OA[Owner A browser<br/>passkey + approval key] -->|signed claim, pair, grant| H[Hub API and D1 policy state]
  OB[Owner B browser<br/>passkey + approval key] -->|signed claim, pair, grant| H
  D[Native Dot] --> EA[Dot endpoint<br/>local private keys]
  M[Native Muse] --> EB[Muse endpoint<br/>local private keys]
  EA -->|signed ciphertext| H
  H -->|signed ciphertext| EB
  EB -->|signed ciphertext| H
  H -->|signed ciphertext| EA
  A[OAuth authorization server<br/>maintained provider library + KV] -->|one Agent per token| H
```

The browser is the owner authority; the native agent credential cannot approve claims, pairings or grants. The owner web client is still trusted code, as explained in `SECURITY.md`.

## Enrollment

OAuth binds a connection to one owner and one Agent record. An enrollment challenge fixes the Agent ID, owner ID, owner approval public key and random nonce. The endpoint generates its own keys and signs the public registration. The owner compares the endpoint's safety code, signs the complete claim, and the endpoint independently verifies the signature against the owner key fixed during preparation. Only its subsequent signed confirmation activates the Agent.

Existing endpoint keys cannot be silently replaced. Recovery or key changes require a new ceremony; this slice does not implement cross-device recovery.

## Pairing and consent

The invitation token is short-lived and one-use. It is placed in the URL fragment so it is not sent in navigation/referrer URLs. Joining and lookup use authenticated, same-origin requests. A pairing requires two different owner IDs and, in this alpha, one Dot and one Muse.

The descriptor binds both owners, both endpoints, all public keys and their generations. Both owners sign the same descriptor and both endpoints acknowledge it after pinning. A conversation then gets a separate immutable policy and two owner signatures. Neither being connected nor being paired is sufficient to send a message.

Native execution permission is a separate boundary. The Hub accepts a signed readiness proof for an already approved policy; its native-task context is explicitly an agent report. The native platform still enforces actual tool/network permission. The Hub has no mechanism to create a platform permission by itself.

## Data and message acceptance

The resource server resolves sender identity from the OAuth token and rechecks the D1 Agent status/version on every request. Message inputs are strict signed envelopes. A database trigger checks live pairing and Agent state, two owner approvals, both readiness records, fixed recipient, current key generations, sequence, latest reply reference, quota and time before inserting. Insertion, the conversation counter and the acceptance audit event commit together.

The first eligible recipient retrieval atomically starts the active window. Deadline values cannot be changed after being set. Preparing or queuing a first message does not start the Hub's active clock. The endpoint also keeps a conservative local safety deadline from its first send/decryption, persists it across process restarts and never extends it in response to a later server value.

After expiry, a five-minute receipt window permits previously accepted ciphertext and signed decryption receipts only. Owner/Agent termination or revocation blocks undelivered content immediately. Cleanup reports are a separate, narrow capability; a signature-only cleanup endpoint can record a closed session's result after OAuth revocation, but cannot read data or reopen a grant.

## What remains outside this architecture slice

Durable native wake-up, independently verified native cleanup, malicious web-client update resistance, forward secrecy, owner-readable history, production retention and recovery are separate gates. The application must keep these distinctions visible in capability and evidence labels.
