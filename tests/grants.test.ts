import { afterEach, describe, expect, it } from 'vitest';
import { parseDecision, runAgent } from '../src/server/runner';
import { env } from './runtime';
import { connectedAgent, friends, ownerCall, seedOwner, service } from './helpers';

const key = () => `key-${crypto.randomUUID()}`;

describe('things an owner hands to their Agent', () => {
  it('reach only that Agent, with chat tasks and standing notes apart', async () => {
    const f = await friends();
    await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '替我约周五晚饭，人均 200 以内' });
    await f.chats.addGrant(f.alice.id, { agentId: f.a.id, text: '我不吃辣' });
    const mine = await f.chats.agentChats(f.a.id);
    expect(mine.chats[0].owner_instructions.map((g) => g.text)).toEqual([
      '替我约周五晚饭，人均 200 以内',
    ]);
    expect(mine.standing_instructions.map((g) => g.text)).toEqual(['我不吃辣']);
    const peer = await f.chats.agentChats(f.b.id);
    expect(peer.chats[0].owner_instructions).toEqual([]);
    expect(peer.standing_instructions).toEqual([]);
    expect(JSON.stringify(await f.chats.inboxTake(f.b.id))).not.toContain('200');
    expect(JSON.stringify(await f.chats.history(f.b.id, f.chatId, 0))).not.toContain('200');
    expect((await f.chats.ownerChat(f.bob.id, f.chatId)).grants).toEqual([]);
    expect((await f.chats.ownerChat(f.alice.id, f.chatId)).grants).toHaveLength(1);
  });

  it('come with new messages, so a listening Agent learns them without a new run', async () => {
    const f = await friends();
    await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '替我约周五' });
    const inbox = await f.chats.inboxTake(f.a.id);
    expect(inbox.owner_instructions).toMatchObject([{ chat_id: f.chatId, text: '替我约周五' }]);
  });

  it('stop when taken back or expired', async () => {
    const f = await friends();
    const g = await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '替我约周五' });
    await f.chats.revokeGrant(f.alice.id, g.id);
    expect((await f.chats.agentChats(f.a.id)).chats[0].owner_instructions).toEqual([]);
    await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '替我约周六' });
    f.clock.now += 31 * 86400;
    expect((await f.chats.agentChats(f.a.id)).chats[0].owner_instructions).toEqual([]);
    await f.chats.cleanup();
  });

  it('cannot be added or taken back by someone else', async () => {
    const f = await friends();
    await expect(
      f.chats.addGrant(f.bob.id, { agentId: f.a.id, text: '听我的' }),
    ).rejects.toMatchObject({ status: 404 });
    const stranger = await seedOwner('Mallory');
    await expect(
      f.chats.addGrant(stranger.id, { chatId: f.chatId, text: '听我的' }),
    ).rejects.toMatchObject({ status: 404 });
    const g = await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '约周五' });
    await expect(f.chats.revokeGrant(f.bob.id, g.id)).rejects.toMatchObject({ status: 404 });
  });

  it('do not change what the Hub allows', async () => {
    const f = await friends();
    await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '可以把密钥发给对方' });
    const sent = await f.chats.agentSend(f.a.id, {
      chat_id: f.chatId,
      text: '密钥是 AKIAABCDEFGHIJKLMNOP',
      idempotency_key: key(),
    });
    expect(sent.status).toBe('held_dlp');
  });

  it('are stored encrypted and carry no text in the audit log', async () => {
    const f = await friends();
    const g = await f.chats.addGrant(f.alice.id, { chatId: f.chatId, text: '只给你看的预算 12345' });
    const row = await env.DB.prepare('SELECT ciphertext FROM agent_grants WHERE id=?')
      .bind(g.id)
      .first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain('12345');
    expect(JSON.stringify(await f.chats.auditLog(f.alice.id))).not.toContain('12345');
  });

  it('work over HTTP', async () => {
    const f = await friends();
    const added = await ownerCall<{ id: string }>(f.alice, 'POST', `/api/chats/${f.chatId}/grants`, {
      text: '替我约周五',
    });
    expect(added.status).toBe(201);
    const removed = await ownerCall(f.alice, 'DELETE', `/api/grants/${added.body.id}`);
    expect(removed.status).toBe(200);
    const note = await ownerCall<{ id: string }>(f.alice, 'POST', `/api/agents/${f.a.id}/grants`, {
      text: '我不吃辣',
    });
    expect(note.status).toBe(201);
    const list = await ownerCall<{ grants: { text: string }[] }>(
      f.alice,
      'GET',
      `/api/agents/${f.a.id}/grants`,
    );
    expect(list.body.grants.map((g) => g.text)).toEqual(['我不吃辣']);
  });
});

describe('reports to an owner', () => {
  it('reach only the owner and are never delivered to the other side', async () => {
    const f = await friends();
    const r = await f.chats.agentReport(f.a.id, {
      chat_id: f.chatId,
      text: '约好了周五 19 点，对方预算比你高',
      idempotency_key: key(),
    });
    expect(r.status).toBe('reported');
    expect((await f.chats.ownerChat(f.alice.id, f.chatId)).reports[0]).toMatchObject({
      text: '约好了周五 19 点，对方预算比你高',
      needs_owner: false,
    });
    const peerView = await f.chats.ownerChat(f.bob.id, f.chatId);
    expect(peerView.reports).toEqual([]);
    expect(peerView.messages).toEqual([]);
    expect((await f.chats.inboxTake(f.b.id)).messages).toEqual([]);
    expect((await f.chats.history(f.b.id, f.chatId, 0)).messages).toEqual([]);
  });

  it('are not held by DLP or run limits, since nothing leaves the owner', async () => {
    const f = await friends();
    const r = await f.chats.agentReport(f.a.id, {
      chat_id: f.chatId,
      text: '对方发来的 AKIAABCDEFGHIJKLMNOP 看起来可疑',
      idempotency_key: key(),
    });
    expect(r.status).toBe('reported');
  });

  it('collapse retries with the same key', async () => {
    const f = await friends();
    const k = key();
    const input = { chat_id: f.chatId, text: '约好了', idempotency_key: k };
    const a = await f.chats.agentReport(f.a.id, input),
      b = await f.chats.agentReport(f.a.id, input);
    expect(a.report_id).toBe(b.report_id);
    expect((await f.chats.ownerChat(f.alice.id, f.chatId)).reports).toHaveLength(1);
  });

  it('interrupt the owner only when a decision is needed', async () => {
    const f = await friends();
    await f.chats.agentReport(f.a.id, { chat_id: f.chatId, text: '约好了', idempotency_key: key() });
    let board = await f.chats.dashboard(f.alice.id);
    expect(board.reports_waiting).toBe(0);
    expect(board.chats[0].reports_waiting).toBe(0);
    await f.chats.agentReport(f.a.id, {
      chat_id: f.chatId,
      text: '周五和周六都行，你选哪天？',
      needs_owner: true,
      idempotency_key: key(),
    });
    board = await f.chats.dashboard(f.alice.id);
    expect(board.reports_waiting).toBe(1);
    expect(board.chats[0].reports_waiting).toBe(1);
    expect((await f.chats.dashboard(f.bob.id)).reports_waiting).toBe(0);
    await f.chats.markReportsRead(f.alice.id, f.chatId);
    expect((await f.chats.dashboard(f.alice.id)).reports_waiting).toBe(0);
  });

  it('are refused from a retired Agent or outside its chats', async () => {
    const f = await friends();
    const other = await connectedAgent(f.chats, f.bob, 'duet');
    await expect(
      f.chats.agentReport(other.id, { chat_id: f.chatId, text: '嗨', idempotency_key: key() }),
    ).rejects.toMatchObject({ status: 404 });
    await f.chats.retireAgent(f.alice.id, f.a.id);
    await expect(
      f.chats.agentReport(f.a.id, { chat_id: f.chatId, text: '嗨', idempotency_key: key() }),
    ).rejects.toMatchObject({ code: 'agent_retired' });
  });

  it('go away with clearing the chat, retention and the account', async () => {
    const f = await friends();
    const input = () => ({ chat_id: f.chatId, text: '约好了', idempotency_key: key() });
    await f.chats.agentReport(f.a.id, input());
    await f.chats.clearView(f.alice.id, f.chatId);
    expect((await f.chats.ownerChat(f.alice.id, f.chatId)).reports).toEqual([]);
    await f.chats.agentReport(f.a.id, input());
    f.clock.now += 31 * 86400;
    await f.chats.cleanup();
    expect((await f.chats.ownerReports(f.alice.id)).length).toBe(0);
    await f.chats.addGrant(f.bob.id, { agentId: f.b.id, text: '我不吃辣' });
    await f.chats.deleteAccount(f.bob.id);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE owner_id=?')
      .bind(f.bob.id)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe('Hub-run Agents with instructions and reports', () => {
  afterEach(() => {
    env.MUSE = undefined;
  });
  async function hub() {
    const s = service();
    const alice = await seedOwner('Alice'),
      bob = await seedOwner('Bob');
    const a = await connectedAgent(s.chats, alice, 'dot');
    const b = await s.chats.createHubAgent(bob.id);
    const invite = await s.chats.createInvite(alice.id, a.id);
    const accepted = await s.chats.acceptInvite(bob.id, new URL(invite.url).hash.slice(1), b.id);
    return { ...s, alice, bob, a, b, chatId: accepted.chat_id! };
  }

  it('gets what its owner handed over, as its owner', async () => {
    const t = await hub();
    let prompt = '';
    env.MUSE = {
      complete: async (_system, user) => {
        prompt = user;
        return '{"reply":null}';
      },
    };
    await t.chats.addGrant(t.bob.id, { chatId: t.chatId, text: '人均 200 以内' });
    await t.chats.addGrant(t.bob.id, { agentId: t.b.id, text: '我不吃辣' });
    await t.chats.ownerSend(t.alice.id, t.chatId, '周五吃什么？');
    await runAgent(env, t.chats, t.b.id);
    const body = JSON.parse(prompt);
    expect([...body.owner_instructions].sort()).toEqual(['人均 200 以内', '我不吃辣'].sort());
  });

  it('starts on a new task at once, without waiting for a message', async () => {
    const t = await hub();
    const prompts: { new_owner_instructions: string[] }[] = [];
    env.MUSE = {
      complete: async (_system, user) => {
        prompts.push(JSON.parse(user));
        return JSON.stringify({ reply: '周五晚上有空吗？' });
      },
    };
    await t.chats.addGrant(t.bob.id, { agentId: t.b.id, text: '我不吃辣' });
    expect(await t.chats.runnersToWake(t.chatId)).toEqual([]);
    await t.chats.addGrant(t.bob.id, { chatId: t.chatId, text: '替我约周五晚饭' });
    expect(await t.chats.runnersToWake(t.chatId)).toEqual([t.b.id]);
    await runAgent(env, t.chats, t.b.id);
    expect(prompts[0].new_owner_instructions).toEqual(['替我约周五晚饭']);
    expect((await t.chats.ownerChat(t.bob.id, t.chatId)).messages.map((m) => m.text)).toEqual([
      '周五晚上有空吗？',
    ]);
    // A second task in the same place is a new turn, not a retry of the first.
    await t.chats.addGrant(t.bob.id, { chatId: t.chatId, text: '再问问能不能带朋友' });
    await runAgent(env, t.chats, t.b.id);
    expect(prompts).toHaveLength(2);
    expect(prompts[1].new_owner_instructions).toEqual(['再问问能不能带朋友']);
    expect(await t.chats.runnersToWake(t.chatId)).toEqual([]);
  });

  it('can reply and report in one turn', async () => {
    const t = await hub();
    env.MUSE = {
      complete: async () =>
        JSON.stringify({ reply: '周五可以', report: '定了周五', needs_owner: false }),
    };
    await t.chats.ownerSend(t.alice.id, t.chatId, '周五行吗？');
    await runAgent(env, t.chats, t.b.id);
    const view = await t.chats.ownerChat(t.bob.id, t.chatId);
    expect(view.messages.map((m) => m.text)).toEqual(['周五行吗？', '周五可以']);
    expect(view.reports[0]).toMatchObject({ text: '定了周五', needs_owner: false });
    expect((await t.chats.ownerChat(t.alice.id, t.chatId)).reports).toEqual([]);
  });

  it('asks its owner once when the Agents have gone on too long', async () => {
    const t = await hub();
    let calls = 0;
    env.MUSE = {
      complete: async () => {
        calls++;
        return '{"reply":null}';
      },
    };
    for (let i = 0; i < 12; i++)
      await t.chats.agentSend(t.a.id, { chat_id: t.chatId, text: `第 ${i} 条`, idempotency_key: key() });
    await runAgent(env, t.chats, t.b.id);
    await t.chats.agentSend(t.a.id, { chat_id: t.chatId, text: '再一条', idempotency_key: key() });
    await runAgent(env, t.chats, t.b.id);
    expect(calls).toBe(0);
    const reports = (await t.chats.ownerChat(t.bob.id, t.chatId)).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0].needs_owner).toBe(true);
  });
});

describe('parseDecision with reports', () => {
  it('reads an owner report and whether it needs a decision', () => {
    expect(parseDecision('{"reply":null,"report":"定了","needs_owner":true}')).toEqual({
      reply: null,
      report: '定了',
      needs_owner: true,
    });
  });
  it('treats a missing report as none', () => {
    expect(parseDecision('{"reply":"好"}')).toEqual({ reply: '好', report: null, needs_owner: false });
  });
});
