import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
export const canonical = x => JSON.stringify(x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, JSON.parse(canonical(x[k]))])) : x);
export const fingerprint = p => createHash('sha256').update(canonical(p)).digest('hex');
const fail = s => { throw new Error(s); };
function exact(x, keys) { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join() !== [...keys].sort().join()) fail('Invalid fields'); }
export function verifySigned(pub, payload, signature) {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature || '')) fail('Invalid signature encoding');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub.sign, 'base64').toString('base64url') } });
  if (!verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, 'base64'))) fail('Signature rejected');
}
export class G0Store {
  constructor(directory, { now = () => Date.now(), participants = ['dot', 'duet'], maxMessages = 8 } = {}) {
    if (participants.length !== 2 || new Set(participants).size !== 2 || participants.some(r => !['dot','duet','muse'].includes(r))) fail('Exactly two supported participants required');
    if (!Number.isInteger(maxMessages) || maxMessages < 2 || maxMessages > 64) fail('Message limit must be 2..64');
    this.now = now; this.directory = directory; this.file = join(directory, 'g0-relay.json');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {
      run_id: randomUUID(), participants, max_messages: maxMessages, expires: now() + 4 * 3600_000, registrations: {}, messages: [], reads: {}, activity: [], revoked: false,
    };
    this.data.participants ||= ['dot', 'duet'];
    this.data.max_messages = Math.min(this.data.max_messages || 8, maxMessages);
    if (canonical(this.data.participants) !== canonical(participants)) fail('Existing experiment has different participants');
    this.persist();
  }
  persist() { writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
  ensureActive(role) { if (!this.data.participants.includes(role) || this.data.revoked || this.now() >= this.data.expires) fail('Experiment closed'); }
  peer(role) { this.ensureActive(role); return this.data.participants.find(r => r !== role); }
  record(role, action) { this.data.activity.push({ role, action, at: new Date(this.now()).toISOString() }); this.persist(); }
  conversationClosed() { return true; }
  identity(role) { this.ensureActive(role); this.record(role, 'identity'); const r = this.data.registrations[role]; return { mode: 'agent_hub_g0', run_id: this.data.run_id, your_role: role, peer: this.peer(role), registration: r ? { status: r.status, fingerprint: r.fingerprint, claim_id: r.id } : null, instructions: 'bridge_send accepts only JSON g0=1 op=bootstrap, op=register or op=message. Never send plaintext or private keys. Owner claim is separate; cannot be completed with agent tools.' }; }
  status() { return { mode: 'agent_hub_g0', run_id: this.data.run_id, participants: this.data.participants, conversation_closed: this.data.revoked || this.now() >= this.data.expires, expires_at: new Date(this.data.expires).toISOString(), message_count: this.data.messages.length, max_messages: this.data.max_messages, registrations: Object.fromEntries(Object.entries(this.data.registrations).map(([k,v]) => [k,v.status])) }; }
  send(role, { text, idempotency_key }) {
    this.ensureActive(role);
    if (typeof text !== 'string' || text.length > 2000) fail('Invalid envelope size');
    let env; try { env = JSON.parse(text); } catch { fail('G0 only accepts encrypted protocol JSON; plaintext rejected'); }
    if (env.g0 !== 1) fail('G0 envelope required');
    if (env.op === 'bootstrap') {
      exact(env, ['g0','op']);
      return { source: readFileSync(new URL('./endpoint.py', import.meta.url), 'utf8'), dependencies: ['pyrage==1.4.0','cryptography==50.0.2'], instructions: 'Run only after verifying SHA-256 provided by the owner outside this relay. Never upload endpoint-secret.json.' };
    }
    if (env.op === 'register') {
      exact(env, ['g0','op','payload','signature','fingerprint']);
      const p = env.payload; exact(p, ['role','age','sign']);
      if (p.role !== role || !/^age1[0-9a-z]{58}$/.test(p.age) || !/^[A-Za-z0-9+/]{43}=$/.test(p.sign)) fail('Invalid public identity');
      verifySigned(p, p, env.signature);
      if (fingerprint(p) !== env.fingerprint) fail('Fingerprint mismatch');
      const old = this.data.registrations[role];
      if (old) {
        if (old.fingerprint !== env.fingerprint) fail('Identity change rejected; owner must revoke and start over');
        old.reconfirmed_run_id = this.data.run_id;
        old.reconfirmed_at = new Date(this.now()).toISOString();
        this.record(role, 'registration_reconfirmed');
        return { status: old.status, claim_id: old.id, fingerprint: old.fingerprint, idempotent: true };
      }
      const r = { id: randomUUID(), status: 'pending_owner', public: p, fingerprint: env.fingerprint, created: this.now(), expires: this.now()+30*60_000 };
      this.data.registrations[role] = r; this.record(role, 'registration_created');
      return { status: r.status, claim_id: r.id, fingerprint: r.fingerprint, expires_at: new Date(r.expires).toISOString(), claim_url: 'http://127.0.0.1:8788/g0', note: 'Owner must compare fingerprint with native agent output; this localhost console is an engineering prototype.' };
    }
    if (env.op !== 'message') fail('Unsupported operation; agent cannot approve claims');
    exact(env, ['g0','op','payload','signature']);
    const p = env.payload; exact(p, ['v','run','id','from','to','seq','expires','reply_to','ciphertext']);
    const peer = this.peer(role);
    const r = this.data.registrations[role], dest = this.data.registrations[peer];
    if (r?.status !== 'claimed' || dest?.status !== 'claimed') fail('Both owners must claim first');
    if (p.v !== 1 || p.from !== role || p.to !== peer || p.run !== this.data.run_id || !/^[0-9a-f-]{36}$/.test(p.id)) fail('Routing rejected');
    if (!Number.isSafeInteger(p.seq) || p.seq < 1 || !Number.isSafeInteger(p.expires) || p.expires*1000 <= this.now() || p.expires*1000 > this.now()+3600_000) fail('Invalid sequence or expiry');
    if (typeof p.ciphertext !== 'string' || p.ciphertext.length > 1500 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.ciphertext)) fail('Invalid ciphertext');
    const raw = Buffer.from(p.ciphertext, 'base64');
    if (!raw.subarray(0,23).equals(Buffer.from('age-encryption.org/v1\n-'))) fail('age v1 ciphertext required');
    verifySigned(r.public, p, env.signature);
    const previous = this.data.messages.find(m => m.id === p.id || (m.from === role && m.idempotency_key === idempotency_key));
    if (previous) {
      if (canonical(previous.envelope) !== canonical(env)) fail('Idempotency conflict');
      return { message_id: previous.id, sequence: previous.sequence, status: 'stored_ciphertext', idempotent: true };
    }
    if (this.data.messages.length >= this.data.max_messages) fail('Message limit reached');
    if (this.data.messages.some(m => m.from === role && m.envelope.payload.seq >= p.seq)) fail('Sequence replay rejected');
    if (p.reply_to !== null && !this.data.messages.some(m => m.id === p.reply_to && m.to === role)) fail('Invalid reply reference');
    const m = { id: p.id, from: role, to: peer, sequence: this.data.messages.length+1, idempotency_key, envelope: env, at: new Date(this.now()).toISOString() };
    this.data.messages.push(m); this.record(role, 'ciphertext_stored');
    return { message_id: m.id, sequence: m.sequence, status: 'stored_ciphertext', plaintext_access: false };
  }
  inbox(role, after = 0) {
    this.ensureActive(role);
    if (this.data.registrations[role]?.status !== 'claimed') fail('Owner claim required');
    const messages = this.data.messages.filter(m => m.to === role && m.sequence > after && m.envelope.payload.expires*1000 > this.now());
    this.data.reads[role] = [...new Set([...(this.data.reads[role] || []), ...messages.map(m => m.id)])]; this.record(role, 'ciphertext_fetched');
    const peer = this.peer(role);
    return { run_id: this.data.run_id, messages: messages.map(({ envelope, sequence }) => ({ envelope, sequence })), next_cursor: messages.at(-1)?.sequence || after,
      peer_public: this.data.registrations[peer]?.status === 'claimed' ? this.data.registrations[peer].public : null,
      note: 'Pin the peer fingerprint through an independent owner confirmation before encrypting. Fetch is not proof of decryption.' };
  }
  claim({ role, claim_id, expected_fingerprint }) {
    this.ensureActive(role);
    const r = this.data.registrations[role];
    if (!r || r.id !== claim_id || r.fingerprint !== expected_fingerprint) fail('Claim pairing mismatch');
    if (r.status !== 'pending_owner') fail('Claim already used');
    if (r.expires <= this.now()) fail('Claim expired');
    r.status = 'claimed'; r.claimed_at = new Date(this.now()).toISOString(); this.record('owner', `claimed_${role}`);
    return { role, status: r.status, fingerprint: r.fingerprint };
  }
  revoke() { this.data.revoked = true; this.record('owner', 'revoked'); return this.status(); }
  dashboard() { return { ...this.status(), registrations: this.data.registrations, messages: this.data.messages, reads: this.data.reads, activity: this.data.activity }; }
}
