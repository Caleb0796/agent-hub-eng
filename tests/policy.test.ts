import { describe, expect, it } from 'vitest';
import { canAgentSend, canDeliver, canOwnerAct, type ChatState } from '../src/server/policy';
import { Vault, messageAad } from '../src/server/vault';
import { scan } from '../src/server/dlp';
import { TEST_MESSAGE_KEY } from './runtime';

const now = 1_000_000;
function chat(
  overrides: Partial<ChatState> = {},
  sides: Partial<ChatState['sides'][0]>[] = [{}, {}],
): ChatState {
  return {
    status: 'open',
    requested_by: 'alice',
    same_owner: 0,
    blocked: false,
    agentStatus: { A: 'active', B: 'active' },
    sides: [
      {
        agent_id: 'A',
        owner_id: 'alice',
        paused_at: null,
        auto_until: null,
        auto_left: 0,
        ...sides[0],
      },
      {
        agent_id: 'B',
        owner_id: 'bob',
        paused_at: null,
        auto_until: null,
        auto_left: 0,
        ...sides[1],
      },
    ],
    ...overrides,
  };
}
const send = (c: ChatState, extra: { dlpHits?: string[]; pendingDrafts?: number } = {}) =>
  canAgentSend(c, 'A', {
    now,
    dlpHits: extra.dlpHits ?? [],
    pendingDrafts: extra.pendingDrafts ?? 0,
  });
const window = { auto_until: now + 600, auto_left: 3 };

describe('permission matrix', () => {
  it.each([
    ['open chat, no window → review', chat(), {}, { kind: 'hold', reason: 'review' }],
    ['window with slots → allow', chat({}, [window, {}]), {}, { kind: 'allow' }],
    [
      'window used up → review',
      chat({}, [{ auto_until: now + 600, auto_left: 0 }, {}]),
      {},
      { kind: 'hold', reason: 'review' },
    ],
    [
      'window expired → review',
      chat({}, [{ auto_until: now - 1, auto_left: 3 }, {}]),
      {},
      { kind: 'hold', reason: 'review' },
    ],
    [
      'DLP inside window → dlp hold',
      chat({}, [window, {}]),
      { dlpHits: ['x'] },
      { kind: 'hold', reason: 'dlp' },
    ],
    [
      'queue full → deny',
      chat(),
      { pendingDrafts: 20 },
      { kind: 'deny', code: 'review_queue_full' },
    ],
    [
      'peer side paused → deny',
      chat({}, [{}, { paused_at: now }]),
      {},
      { kind: 'deny', code: 'chat_paused' },
    ],
    [
      'own side paused → deny',
      chat({}, [{ paused_at: now }, {}]),
      {},
      { kind: 'deny', code: 'chat_paused' },
    ],
    ['pending → deny', chat({ status: 'pending' }), {}, { kind: 'deny', code: 'chat_not_open' }],
    ['closed → deny', chat({ status: 'closed' }), {}, { kind: 'deny', code: 'chat_not_open' }],
    ['blocked → deny', chat({ blocked: true }), {}, { kind: 'deny', code: 'blocked' }],
    [
      'peer retired → deny',
      chat({ agentStatus: { A: 'active', B: 'revoked' } }),
      {},
      { kind: 'deny', code: 'peer_retired' },
    ],
  ] as const)('Agent send: %s', (_name, state, extra, expected) => {
    expect(
      send(state as ChatState, extra as { dlpHits?: string[]; pendingDrafts?: number }),
    ).toEqual(expected);
  });

  it('an Agent outside the chat is not found', () => {
    expect(canAgentSend(chat(), 'C', { now, dlpHits: [], pendingDrafts: 0 })).toEqual({
      kind: 'deny',
      code: 'not_found',
    });
  });

  it.each([
    ['third party reads', 'eve', 'read', chat(), 'not_found'],
    [
      'requester approves own request',
      'alice',
      'approve_request',
      chat({ status: 'pending' }),
      'not_receiver',
    ],
    ['receiver approves', 'bob', 'approve_request', chat({ status: 'pending' }), null],
    ['owner speaks while paused', 'alice', 'owner_send', chat({}, [{}, { paused_at: now }]), null],
    [
      'owner speaks in closed chat',
      'alice',
      'owner_send',
      chat({ status: 'closed' }),
      'chat_not_open',
    ],
    [
      'resume someone else’s pause',
      'alice',
      'resume',
      chat({}, [{}, { paused_at: now }]),
      'not_paused_by_you',
    ],
    ['either owner closes', 'bob', 'close', chat(), null],
    ['close twice', 'bob', 'close', chat({ status: 'closed' }), 'already_closed'],
  ] as const)('Owner action: %s', (_name, who, action, state, code) => {
    const result = canOwnerAct(state as ChatState, who, action);
    expect(result).toEqual(code ? { kind: 'deny', code } : { kind: 'allow' });
  });

  it('owners can only set windows on their own side', () => {
    expect(canOwnerAct(chat(), 'bob', 'set_window', 'A')).toEqual({
      kind: 'deny',
      code: 'not_found',
    });
    expect(canOwnerAct(chat(), 'alice', 'set_window', 'A')).toEqual({ kind: 'allow' });
  });

  it('delivery rechecks live permission, withholding and expiry', () => {
    const m = { withheld_at: null, expires_at: now + 10 };
    expect(canDeliver(chat(), m, now)).toBe(true);
    expect(canDeliver(chat({}, [{ paused_at: now }, {}]), m, now)).toBe(false);
    expect(canDeliver(chat(), { ...m, withheld_at: now }, now)).toBe(false);
    expect(canDeliver(chat(), { ...m, expires_at: now }, now)).toBe(false);
    expect(canDeliver(chat({ blocked: true }), m, now)).toBe(false);
  });
});

describe('vault and DLP', () => {
  const vault = new Vault({ 1: TEST_MESSAGE_KEY });
  it('round-trips and binds ciphertext to its chat and message', () => {
    const sealed = vault.seal('秘密内容', messageAad('chat', 'm1'));
    expect(sealed.ciphertext).not.toContain('秘密');
    expect(vault.open(sealed.ciphertext, messageAad('chat', 'm1'), 1)).toBe('秘密内容');
    expect(() => vault.open(sealed.ciphertext, messageAad('chat', 'm2'), 1)).toThrow();
  });
  it('decrypts old versions and seals with the newest key', () => {
    const rotated = new Vault({
      1: TEST_MESSAGE_KEY,
      2: Buffer.alloc(32, 7).toString('base64url'),
    });
    const old = vault.seal('v1', 'aad');
    expect(rotated.open(old.ciphertext, 'aad', 1)).toBe('v1');
    expect(rotated.seal('v2', 'aad').keyVersion).toBe(2);
  });
  it('flags fixed-format secrets but not ordinary text', () => {
    expect(scan('ghp_' + 'a'.repeat(30))).toEqual(['GitHub token']);
    expect(scan('-----BEGIN ' + 'PRIVATE KEY-----')).toEqual(['private key']);
    expect(scan('password: hunter2hunter2')).toEqual(['password assignment']);
    expect(scan('明天下午三点一起吃饭')).toEqual([]);
  });
  // Long values are built at runtime so scripts/check-secrets.mjs does not flag this file.
  it.each([
    ['DB_PASSWORD=correcthorsebattery', ['password assignment']],
    ['POSTGRES_PASSWORD=hunter2hunter2', ['password assignment']],
    ['OAUTH_CLIENT_SECRET=' + 'a'.repeat(16), ['password assignment']],
    ['STRIPE_API_KEY=' + 'a'.repeat(16), ['password assignment']],
    ['SLACK_ACCESS_TOKEN=' + 'a'.repeat(16), ['password assignment']],
    ['{"password": "supersecretvalue123"}', ['password assignment']],
    ['{"access_token":"' + 'a'.repeat(26) + '"}', ['password assignment', 'literal secret value']],
    ['authorization: bearer ' + 'a'.repeat(40), ['bearer credential']],
    ['{"aws_secret_access_key": "' + 'A'.repeat(40) + '"}', ['AWS secret key']],
  ])('flags env-style, JSON and lowercase credentials: %s', (text, expected) => {
    expect(scan(text)).toEqual(expected);
  });
});
