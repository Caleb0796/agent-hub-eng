"""G0 trusted endpoint: age v1 encryption; Ed25519 authenticated envelopes.
Experimental integration, NOT a reviewed messaging protocol. No forward secrecy.
Never deploy this program in the relay process or store endpoint state there.
"""
import base64, hashlib, json, os, sys, time, uuid
from pathlib import Path
from pyrage import encrypt, decrypt, x25519
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption


def canonical(x):
    return json.dumps(x, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def b64(x): return base64.b64encode(x).decode()
def unb64(x): return base64.b64decode(x, validate=True)
def fingerprint(public): return hashlib.sha256(canonical(public)).hexdigest()


def write_private(path, value):
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)


class Endpoint:
    def __init__(self, directory, role):
        if role not in ('dot', 'duet', 'muse'): raise ValueError('Unknown role')
        self.path = Path(directory) / 'endpoint-secret.json'
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
            if self.state['public']['role'] != role: raise ValueError('Identity mismatch')
        else:
            age = x25519.Identity.generate()
            sign = Ed25519PrivateKey.generate()
            self.state = {'age_private': str(age), 'sign_private': b64(sign.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())),
                          'public': {'role': role, 'age': str(age.to_public()), 'sign': b64(sign.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))},
                          'peers': {}, 'seen': [], 'sent': {}, 'sequence': 0}
            self.save()
        self.role = role
        self.age = x25519.Identity.from_str(self.state['age_private'])
        self.signer = Ed25519PrivateKey.from_private_bytes(unb64(self.state['sign_private']))

    def save(self): write_private(self.path, self.state)

    def signed(self, payload):
        return {'payload': payload, 'signature': b64(self.signer.sign(canonical(payload)))}

    def registration(self):
        p = self.state['public']
        return {'g0': 1, 'op': 'register', **self.signed(p), 'fingerprint': fingerprint(p)}

    def pin(self, public, expected_fingerprint):
        if fingerprint(public) != expected_fingerprint: raise ValueError('Fingerprint mismatch')
        role = public['role']
        if role == self.role or role not in ('dot', 'duet', 'muse'): raise ValueError('Wrong peer')
        old = self.state['peers'].get(role)
        if old and old != public: raise ValueError('Key change requires a new owner ceremony')
        self.state['peers'][role] = public
        self.save()
        return {'peer_pinned': role, 'fingerprint': expected_fingerprint}

    def seal(self, text, run, ttl=1800, reply_to=None, idempotency_key=None, to=None):
        peers = list(self.state['peers'])
        peer = to or (peers[0] if len(peers) == 1 else None)
        if peer not in self.state['peers']: raise ValueError('Owner must verify peer first')
        if not isinstance(text, str) or not 1 <= len(text) <= 240: raise ValueError('G0 text length 1..240')
        if not 1 <= ttl <= 3600: raise ValueError('Invalid TTL')
        request = {'text': text, 'run': run, 'ttl': ttl, 'reply_to': reply_to, 'to': peer}
        key = idempotency_key or str(uuid.uuid4())
        cached = self.state['sent'].get(key)
        if cached:
            if cached['request'] != request: raise ValueError('Idempotency conflict')
            return cached['envelope']
        self.state['sequence'] += 1
        p = {'v': 1, 'run': run, 'id': str(uuid.uuid4()), 'from': self.role, 'to': peer,
             'seq': self.state['sequence'], 'expires': int(time.time()) + ttl, 'reply_to': reply_to}
        # age format handles key derivation, AEAD, and recipient wrapping.
        # Both endpoints can reread history; the Hub has neither identity.
        recipients = [self.age.to_public(), x25519.Recipient.from_str(self.state['peers'][peer]['age'])]
        p['ciphertext'] = b64(encrypt(canonical({'text': text}), recipients))
        env = {'g0': 1, 'op': 'message', **self.signed(p)}
        if len(json.dumps(env, separators=(',', ':'))) > 2000: raise ValueError('Envelope exceeds connector limit')
        self.state['sent'][key] = {'request': request, 'envelope': env}
        self.save()
        return env

    def open(self, env, run, archive=False):
        p = env['payload']
        if env.get('g0') != 1 or env.get('op') != 'message' or p.get('v') != 1: raise ValueError('Wrong protocol')
        if p['run'] != run: raise ValueError('Wrong conversation')
        if p['to'] != self.role and not (archive and p['from'] == self.role): raise ValueError('Wrong recipient')
        sender = self.state['public'] if p['from'] == self.role else self.state['peers'].get(p['from'])
        if not sender: raise ValueError('Unverified sender')
        Ed25519PublicKey.from_public_bytes(unb64(sender['sign'])).verify(unb64(env['signature']), canonical(p))
        if not archive and p['expires'] <= time.time(): raise ValueError('Message expired')
        if not archive and p['id'] in self.state['seen']: raise ValueError('Replay rejected')
        plain = json.loads(decrypt(unb64(p['ciphertext']), [self.age]))
        if not archive:
            self.state['seen'].append(p['id']); self.save()
        return {'id': p['id'], 'from': p['from'], 'text': plain['text'], 'sha256': hashlib.sha256(plain['text'].encode()).hexdigest()}


if __name__ == '__main__':
    # JSON input through stdin avoids shell quoting and secret-bearing argv.
    directory, role, command = sys.argv[1:]
    e = Endpoint(directory, role)
    arg = json.load(sys.stdin) if command != 'register' else {}
    if command == 'register': result = e.registration()
    elif command == 'pin': result = e.pin(arg['public'], arg['fingerprint'])
    elif command == 'seal': result = e.seal(**arg)
    elif command == 'open': result = e.open(**arg)
    else: raise ValueError('Unknown command')
    print(json.dumps(result, separators=(',', ':'), ensure_ascii=False))
