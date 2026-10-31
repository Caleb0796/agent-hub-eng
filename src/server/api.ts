import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_GRANT_TEXT } from '../shared/constants';
import { displayNameSchema, idSchema, textSchema } from '../shared/protocol';
import {
  ensure,
  owner,
  publicOwner,
  rateLimit,
  type HubBindings,
  type HubContext,
} from './common';
import { wakeChat } from './runner';
import { chatService } from './services';

// Owner (browser session) operations. Every write needs the session cookie and CSRF token;
// destructive or trust-changing ones also need a recent passkey login.
const router = new Hono<{ Bindings: HubBindings }>();
const chats = (c: HubContext) => chatService(c.env);
const write = (c: HubContext) => owner(c, { write: true });
const fresh = (c: HubContext) => owner(c, { write: true, fresh: true });
const body = async <T extends z.ZodType>(c: HubContext, schema: T): Promise<z.infer<T>> =>
  schema.parse(await c.req.json().catch(() => ({})));
const id = (c: HubContext, name = 'id') => idSchema.parse(c.req.param(name));
const sideInput = z.object({ agentId: idSchema.optional() }).strict();

router.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

router.get('/me', async (c) =>
  c.json({
    owner: publicOwner(await owner(c)),
    features: {
      platforms: ['dot', 'muse', 'duet'],
      endToEndEncrypted: false,
      retentionDays: 30,
      backgroundWake: !!c.env.MUSE,
    },
  }),
);
router.delete('/me', async (c) => c.json(await chats(c).deleteAccount((await fresh(c)).id)));
router.get('/dashboard', async (c) =>
  c.json({ ...(await chats(c).dashboard((await owner(c)).id)), hub_runner: !!c.env.MUSE }),
);
router.post('/notifications/seen', async (c) =>
  c.json(await chats(c).markNotificationsSeen((await write(c)).id)),
);
router.get('/audit', async (c) => c.json({ events: await chats(c).auditLog((await owner(c)).id) }));

// ------------------------------------------------------------------ invites and contacts

router.post('/invites', async (c) => {
  const u = await write(c);
  await rateLimit(c.env, `invite:${u.id}`, 20, 3600);
  const input = await body(c, z.object({ agentId: idSchema.nullable().default(null) }).strict());
  return c.json(await chats(c).createInvite(u.id, input.agentId), 201);
});
router.get('/invites', async (c) =>
  c.json({ invites: await chats(c).invites((await owner(c)).id) }),
);
router.delete('/invites/:id', async (c) =>
  c.json(await chats(c).revokeInvite((await write(c)).id, id(c))),
);
const tokenInput = z.object({ token: z.string().min(20).max(100) }).strict();
// Public: shows only the inviter's self-declared name and Agent before sign-up.
router.post('/invites/preview', async (c) => {
  await rateLimit(c.env, `invite-preview:${c.req.header('X-Forwarded-For') ?? 'local'}`, 30);
  return c.json(await chats(c).previewInvite((await body(c, tokenInput)).token));
});
router.post('/invites/accept', async (c) => {
  const u = await write(c);
  const input = await body(
    c,
    z
      .object({ token: tokenInput.shape.token, agentId: idSchema.nullable().default(null) })
      .strict(),
  );
  return c.json(await chats(c).acceptInvite(u.id, input.token, input.agentId));
});

router.get('/contacts', async (c) =>
  c.json({ contacts: await chats(c).contacts((await owner(c)).id) }),
);
router.post('/contacts/:id/agents', async (c) => {
  const u = await write(c);
  const input = await body(c, z.object({ agentIds: z.array(idSchema).max(8) }).strict());
  return c.json(await chats(c).setExposure(u.id, id(c), input.agentIds));
});
router.post('/contacts/:id/block', async (c) =>
  c.json(await chats(c).block((await write(c)).id, id(c))),
);
router.post('/contacts/:id/unblock', async (c) =>
  c.json(await chats(c).unblock((await write(c)).id, id(c))),
);
router.delete('/contacts/:id', async (c) =>
  c.json(await chats(c).removeContact((await fresh(c)).id, id(c))),
);

// ------------------------------------------------------------------ chats

router.post('/chats', async (c) => {
  const u = await write(c);
  await rateLimit(c.env, `chat-request:${u.id}`, 30, 3600);
  const input = await body(c, z.object({ agentId: idSchema, peerAgentId: idSchema }).strict());
  return c.json(await chats(c).requestChat(u.id, input.agentId, input.peerAgentId), 201);
});
router.get('/chats/:id', async (c) => {
  const service = chats(c),
    view = await service.ownerChat((await owner(c)).id, id(c));
  // Picks up anything a failed or cut-off run left behind, once its retry delay has passed.
  wakeChat(c.env, service, view.id);
  return c.json(view);
});
router.post('/chats/:id/approve', async (c) =>
  c.json(await chats(c).approveChat((await write(c)).id, id(c))),
);
router.post('/chats/:id/reject', async (c) =>
  c.json(await chats(c).rejectChat((await write(c)).id, id(c))),
);
router.post('/chats/:id/close', async (c) =>
  c.json(await chats(c).closeChat((await write(c)).id, id(c))),
);
router.post('/chats/:id/pause', async (c) => {
  const u = await write(c);
  return c.json(await chats(c).pause(u.id, id(c), (await body(c, sideInput)).agentId));
});
router.post('/chats/:id/resume', async (c) => {
  const u = await write(c);
  return c.json(await chats(c).resume(u.id, id(c), (await body(c, sideInput)).agentId));
});
router.post('/chats/:id/review', async (c) => {
  const u = await write(c);
  const input = await body(c, z.object({ agentId: idSchema.optional(), on: z.boolean() }).strict());
  return c.json(await chats(c).setReview(u.id, id(c), input.on, input.agentId));
});
router.post('/chats/:id/clear', async (c) =>
  c.json(await chats(c).clearView((await write(c)).id, id(c))),
);
const grantText = z.string().trim().min(1).max(MAX_GRANT_TEXT);
router.post('/chats/:id/grants', async (c) => {
  const u = await write(c);
  const input = await body(c, z.object({ text: grantText, agentId: idSchema.optional() }).strict());
  return c.json(await chats(c).addGrant(u.id, { ...input, chatId: id(c) }), 201);
});
router.post('/chats/:id/reports/read', async (c) =>
  c.json(await chats(c).markReportsRead((await write(c)).id, id(c))),
);
router.post('/chats/:id/messages', async (c) => {
  const u = await write(c);
  await rateLimit(c.env, `owner-send:${u.id}`, 60);
  const input = await body(
    c,
    z.object({ text: textSchema, replyTo: idSchema.optional() }).strict(),
  );
  return c.json(await chats(c).ownerSend(u.id, id(c), input.text, input.replyTo), 201);
});
router.post('/messages/:id/withdraw', async (c) =>
  c.json(await chats(c).withdraw((await write(c)).id, id(c))),
);

// ------------------------------------------------------------------ review

router.get('/review', async (c) =>
  c.json({ drafts: await chats(c).reviewQueue((await owner(c)).id) }),
);
router.post('/drafts/:id/approve', async (c) =>
  c.json(await chats(c).approveDraft((await write(c)).id, id(c))),
);
router.post('/drafts/:id/reject', async (c) =>
  c.json(await chats(c).rejectDraft((await write(c)).id, id(c))),
);

// ------------------------------------------------------------------ agents

router.delete('/grants/:id', async (c) =>
  c.json(await chats(c).revokeGrant((await write(c)).id, id(c))),
);
router.get('/reports', async (c) =>
  c.json({ reports: await chats(c).ownerReports((await owner(c)).id) }),
);
router.post('/reports/read', async (c) =>
  c.json(await chats(c).markReportsRead((await write(c)).id)),
);
router.get('/agents/:id/grants', async (c) =>
  c.json({ grants: await chats(c).standingGrants((await owner(c)).id, id(c)) }),
);
router.post('/agents/:id/grants', async (c) => {
  const u = await write(c);
  const input = await body(c, z.object({ text: grantText }).strict());
  return c.json(await chats(c).addGrant(u.id, { ...input, agentId: id(c) }), 201);
});
router.post('/agents/hub', async (c) => {
  const u = await write(c);
  ensure(c.env.MUSE, 'hub_runner_unavailable', 409, '现在还不能一键创建 Agent');
  const input = await body(c, z.object({ label: displayNameSchema.optional() }).strict());
  return c.json(await chats(c).createHubAgent(u.id, input.label), 201);
});
router.post('/agents/:id/rename', async (c) => {
  const u = await write(c);
  return c.json(
    await chats(c).renameAgent(
      u.id,
      id(c),
      (await body(c, z.object({ label: displayNameSchema }).strict())).label,
    ),
  );
});
router.post('/agents/:id/reset', async (c) =>
  c.json(await chats(c).resetConnection((await fresh(c)).id, id(c))),
);
router.post('/agents/:id/retire', async (c) =>
  c.json(await chats(c).retireAgent((await fresh(c)).id, id(c))),
);

export default router;
