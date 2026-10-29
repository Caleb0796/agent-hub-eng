import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema, platformSchema, signatureSchema } from '../shared/protocol';
import {
  db,
  nowSeconds,
  owner,
  publicOwner,
  rateLimit,
  type HubBindings,
  type HubContext,
} from './common';
import { Hub } from './hub';

const router = new Hono<{ Bindings: HubBindings }>();
const hub = (c: HubContext) => new Hub(db(c.env), c.env.PUBLIC_ORIGIN);
const signatureInput = z.object({ signature: signatureSchema }).strict();

router.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
router.get('/me', async (c) =>
  c.json({
    owner: publicOwner(await owner(c)),
    features: {
      platforms: ['dot', 'muse'],
      mode: 'private-alpha',
      ownerRecovery: false,
      backgroundWake: false,
      privateHistory: false,
    },
  }),
);
router.get('/dashboard', async (c) => c.json(await hub(c).dashboard((await owner(c)).id)));

router.post('/agents', async (c) => {
  const u = await owner(c, { write: true, fresh: true });
  await rateLimit(c.env, `create-agent:${u.id}`, 10, 3600);
  const input = z
    .object({ platform: platformSchema, label: z.string().trim().min(1).max(60) })
    .strict()
    .parse(await c.req.json());
  return c.json(await hub(c).createAgent(u.id, input.platform, input.label), 201);
});
router.get('/agents/:id', async (c) =>
  c.json(await hub(c).agentDetail((await owner(c)).id, idSchema.parse(c.req.param('id')))),
);
router.post('/agents/:id/claim', async (c) => {
  const u = await owner(c, { write: true, fresh: true }),
    input = signatureInput.parse(await c.req.json());
  return c.json(await hub(c).ownerClaim(u.id, idSchema.parse(c.req.param('id')), input.signature));
});
router.post('/agents/:id/revoke', async (c) =>
  c.json(
    await hub(c).revokeAgent(
      (await owner(c, { write: true, fresh: true })).id,
      idSchema.parse(c.req.param('id')),
    ),
  ),
);

router.post('/pairings', async (c) => {
  const u = await owner(c, { write: true, fresh: true });
  await rateLimit(c.env, `invite:${u.id}`, 20, 3600);
  const input = z
    .object({ agentId: idSchema })
    .strict()
    .parse(await c.req.json());
  return c.json(await hub(c).createPairing(u.id, input.agentId), 201);
});
router.post('/pairing-invitation', async (c) => {
  const u = await owner(c, { write: true }),
    { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(await c.req.json());
  return c.json(await hub(c).pairingInvitation(u.id, token));
});
router.post('/pairings/join', async (c) => {
  const u = await owner(c, { write: true, fresh: true }),
    input = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), agentId: idSchema })
      .strict()
      .parse(await c.req.json());
  return c.json(await hub(c).joinPairing(u.id, input.token, input.agentId));
});
router.post('/pairings/:id/approve', async (c) => {
  const u = await owner(c, { write: true, fresh: true }),
    input = signatureInput.parse(await c.req.json());
  return c.json(
    await hub(c).approvePairing(u.id, idSchema.parse(c.req.param('id')), input.signature),
  );
});
router.post('/pairings/:id/revoke', async (c) =>
  c.json(
    await hub(c).revokePairing(
      (await owner(c, { write: true, fresh: true })).id,
      idSchema.parse(c.req.param('id')),
    ),
  ),
);

router.post('/conversations', async (c) => {
  const u = await owner(c, { write: true, fresh: true });
  await rateLimit(c.env, `conversation:${u.id}`, 20, 3600);
  const input = z
    .object({
      pairingId: idSchema,
      duration: z.number().int().min(60).max(600).default(600),
      maxMessages: z.number().int().min(2).max(64).default(40),
    })
    .strict()
    .parse(await c.req.json());
  return c.json(
    await hub(c).createConversation(u.id, input.pairingId, input.duration, input.maxMessages),
    201,
  );
});
router.post('/conversations/:id/approve', async (c) => {
  const u = await owner(c, { write: true, fresh: true }),
    input = signatureInput.parse(await c.req.json());
  return c.json(
    await hub(c).approveConversation(u.id, idSchema.parse(c.req.param('id')), input.signature),
  );
});
router.post('/conversations/:id/end', async (c) =>
  c.json(
    await hub(c).closeConversation(idSchema.parse(c.req.param('id')), {
      owner: (await owner(c, { write: true })).id,
    }),
  ),
);
router.post('/conversations/:id/decline', async (c) =>
  c.json(
    await hub(c).closeConversation(
      idSchema.parse(c.req.param('id')),
      { owner: (await owner(c, { write: true })).id },
      'owner-declined',
    ),
  ),
);
router.get('/conversations/:id', async (c) => {
  const u = await owner(c),
    h = hub(c),
    id = idSchema.parse(c.req.param('id')),
    row = await h.conversation(id, u.id);
  const messages = await h.connection
    .prepare(
      'SELECT id,position,sender_id,recipient_id,accepted_at,delivered_at,(receipt_json IS NOT NULL) AS endpoint_receipt FROM messages WHERE conversation_id=? ORDER BY position',
    )
    .bind(id)
    .all();
  const readiness = await h.connection
    .prepare(
      'SELECT agent_id,ready_at,native_context_json,cleanup_status FROM readiness WHERE conversation_id=?',
    )
    .bind(id)
    .all();
  return c.json({
    ...h.conversationView(row),
    messages: messages.results,
    readiness: readiness.results,
    server_time: nowSeconds(),
  });
});

router.get('/audit', async (c) => {
  const u = await owner(c),
    rows = await db(c.env)
      .prepare(
        `SELECT DISTINCT e.* FROM audit_events e
    WHERE e.owner_id=? OR e.agent_id IN(SELECT id FROM agents WHERE owner_id=?)
    OR e.entity_id IN(SELECT id FROM pairings WHERE owner_a=? OR owner_b=?)
    OR e.entity_id IN(SELECT c.id FROM conversations c JOIN pairings p ON p.id=c.pairing_id WHERE p.owner_a=? OR p.owner_b=?)
    ORDER BY e.created_at DESC LIMIT 200`,
      )
      .bind(u.id, u.id, u.id, u.id, u.id, u.id)
      .all();
  return c.json({ events: rows.results });
});

export default router;
