import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BridgeStore, TTL_MS } from '../src/store.mjs';
import { callTool } from '../src/tools.mjs';
import { startServers } from '../src/server.mjs';

function fixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'dot-duet-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new BridgeStore(dir, options);
}

test('identities are fixed by independent credentials and peer proofs stay private', async t => {
  const s = fixture(t);
  assert.equal(s.authenticate(s.data.tokens.dot), 'dot');
  assert.equal(s.authenticate(s.data.tokens.duet), 'duet');
  assert.equal(s.authenticate('wrong'), null);
  assert.equal(JSON.stringify(s.identity('dot')).includes(s.data.proofs.duet), false);
  assert.equal(JSON.stringify(s.status()).includes(s.data.tokens.dot), false);
  const spoof = await callTool(s, 'dot', 'bridge_send', { text: 'hi', from: 'duet', idempotency_key: 'bad' });
  assert.equal(spoof.isError, true);
});

test('a real round trip requires a correlated correct-code reply AND recipient retrieval', t => {
  const s = fixture(t);
  const q = s.send('dot', { text: 'What is your code?', idempotency_key: 'q' });
  assert.equal(s.inbox('dot').messages.length, 0);
  assert.equal(s.inbox('duet').messages[0].id, q.message_id);
  s.send('duet', { text: 'invented', reply_to: q.message_id, idempotency_key: 'bad-proof' });
  s.inbox('dot');
  assert.equal(s.status().round_trip_observed, false);
  s.send('duet', { text: s.identity('duet').your_test_code, reply_to: q.message_id, idempotency_key: 'answer' });
  assert.equal(s.status().round_trip_observed, false);
  s.inbox('dot');
  assert.equal(s.status().directions.dot_asks_duet, true);
  assert.equal(s.status().both_directions_observed, false);
});

test('retries do not duplicate messages; invalid reply targets and cap are enforced', t => {
  const s = fixture(t);
  const args = { text: 'hello', idempotency_key: 'same' };
  const first = s.send('dot', args);
  assert.equal(s.send('dot', args).message_id, first.message_id);
  assert.equal(s.data.messages.length, 1);
  assert.throws(() => s.send('dot', { ...args, text: 'changed' }), /different content/);
  assert.throws(() => s.send('dot', { text: 'self reply', reply_to: first.message_id, idempotency_key: 'x' }), /received from your peer/);
  for (let i = 0; i < 7; i++) s.send('dot', { text: 'hello', idempotency_key: `message-${i}` });
  assert.throws(() => s.send('duet', { text: 'no', idempotency_key: 'over' }), /limit reached/);
});

test('inbox is replayable with a cursor; persisted state survives restart', t => {
  const s = fixture(t);
  s.send('dot', { text: 'one', idempotency_key: '1' });
  const a = s.inbox('duet');
  assert.equal(s.inbox('duet').messages.length, 1);
  assert.equal(s.inbox('duet', a.next_cursor).messages.length, 0);
  const reloaded = new BridgeStore(s.directory);
  assert.equal(reloaded.inbox('duet').messages[0].text, 'one');
  assert.equal(reloaded.data.tokens.dot, s.data.tokens.dot);
});

test('experiment expires and refuses sends/reads instead of running indefinitely', async t => {
  let now = Date.now();
  const s = fixture(t, { now: () => now });
  now += TTL_MS + 1;
  assert.equal((await callTool(s, 'dot', 'bridge_identity')).isError, true);
  assert.equal(s.status().expired, true);
});

test('timed conversation preserves credentials, enforces alternating sends and closes at its deadline', t => {
  let now = Date.now();
  const s = fixture(t, { now: () => now });
  const token = s.data.tokens.dot;
  s.startConversation(600, 64);
  assert.equal(s.data.tokens.dot, token);
  assert.equal(s.status().message_limit, 64);
  s.send('duet', { text: 'A random question?', idempotency_key: 'first' });
  assert.throws(() => s.send('duet', { text: 'Again?', idempotency_key: 'second' }), /Wait for the other/);
  s.send('dot', { text: 'A thoughtful answer.', idempotency_key: 'reply' });
  now += 600_000;
  assert.throws(() => s.send('duet', { text: 'Too late', idempotency_key: 'late' }), /window has ended/);
  assert.equal(s.inbox('duet').conversation_closed, true);
  assert.equal(s.status().conversation_closed, true);
  assert.equal(s.status().message_count, 2);
});

test('two official MCP SDK clients exchange messages over HTTP; monitor is isolated', async t => {
  const s = fixture(t);
  const app = await startServers({ directory: s.directory, port: 0, adminPort: 0 });
  t.after(() => app.stop());
  const makeClient = async role => {
    const client = new Client({ name: `test-${role}`, version: '1.0' });
    const url = `http://127.0.0.1:${app.port}/mcp/${app.store.data.tokens[role]}`;
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    t.after(() => client.close());
    return client;
  };
  const dot = await makeClient('dot');
  const duet = await makeClient('duet');
  assert.equal((await dot.listTools()).tools.length, 4);
  const question = await dot.callTool({ name: 'bridge_send', arguments: { text: 'What is your code?', idempotency_key: 'sdk-q' } });
  const q = JSON.parse(question.content[0].text);
  const inbox = await duet.callTool({ name: 'bridge_inbox', arguments: {} });
  assert.equal(JSON.parse(inbox.content[0].text).messages[0].id, q.message_id);
  const identity = await duet.callTool({ name: 'bridge_identity', arguments: {} });
  await duet.callTool({ name: 'bridge_send', arguments: { text: JSON.parse(identity.content[0].text).your_test_code, reply_to: q.message_id, idempotency_key: 'sdk-a' } });
  await dot.callTool({ name: 'bridge_inbox', arguments: {} });
  assert.equal(app.store.status().round_trip_observed, true);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/setup`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/mcp/wrong`)).status, 404);
  const setup = await fetch(`http://127.0.0.1:${app.adminPort}/api/setup`).then(r => r.json());
  assert.equal(setup.participants.length, 2);
});

test('modern stateless MCP discovery/list/call work without a legacy handshake', async t => {
  const s = fixture(t);
  const app = await startServers({ directory: s.directory, port: 0, adminPort: 0 });
  t.after(() => app.stop());
  const endpoint = `http://127.0.0.1:${app.port}/mcp/${app.store.data.tokens.dot}`;
  const rpc = (method, params = {}) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(r => r.json());
  const discovery = await rpc('server/discover');
  assert.ok(discovery.result.supportedVersions.includes('2026-07-28'));
  assert.equal(discovery.result.capabilities.events, undefined);
  assert.equal((await rpc('tools/list')).result.tools.length, 4);
  const identity = await rpc('tools/call', { name: 'bridge_identity', arguments: {} });
  assert.equal(identity.result.structuredContent.your_role, 'dot');
  assert.equal(identity.result.resultType, 'complete');
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(17 * 1024) })).status, 413);
});
