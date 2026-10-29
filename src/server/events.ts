import { timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { canonical, randomToken, sha256 } from '../shared/crypto';
import { idSchema } from '../shared/protocol';
import { Hub } from './hub';
import { ensure } from './common';
import { webhookFetch, webhookUrl } from './public-fetch';

const eventName = z.enum(['hub.request.created', 'hub.session.authorized']);
const filter = z.object({ pairing_id: idSchema.optional() }).strict();
const delivery = z.object({ mode: z.literal('webhook'), url: z.string().max(2048) }).strict();
const subscribeInput = z
  .object({
    name: eventName,
    arguments: filter.default({}),
    delivery: delivery.extend({ secret: z.string().max(100) }),
    cursor: z.null().optional(),
    ttlMs: z.number().int().positive().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const unsubscribeInput = z
  .object({
    name: eventName,
    arguments: filter.default({}),
    delivery,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
type Subscription = {
  id: string;
  agent_id: string;
  auth_version: number;
  oauth_grant_id: string;
  oauth_client_id: string;
  name: string;
  arguments_json: string;
  callback_url: string;
  signing_secret: string;
  previous_secret: string | null;
  previous_until: number | null;
  verified_at: number;
  expires_at: number;
  disabled_at: number | null;
};
type Delivery = {
  id: string;
  subscription_id: string;
  conversation_id: string;
  body_json: string;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
};
export class CallbackEndpointError extends Error {
  constructor(
    readonly reason: 'invalid_url' | 'challenge_failed' | 'timeout',
    readonly httpStatus?: number,
  ) {
    super('Callback verification failed');
  }
}

export class NativeEvents {
  constructor(
    readonly hub: Hub,
    readonly send = webhookFetch,
    readonly grantValid: (
      agentId: string,
      grantId: string,
      clientId: string,
    ) => Promise<boolean> = async () => false,
  ) {}

  list() {
    const payloadSchema = {
      type: 'object',
      properties: {
        conversation_id: { type: 'string' },
        pairing_id: { type: 'string' },
        recipient_agent_id: { type: 'string' },
        review_url: { type: 'string' },
        scope: { type: 'string', const: 'public-qa' },
        duration_seconds: { type: 'integer' },
        max_messages: { type: 'integer' },
      },
      required: [
        'conversation_id',
        'pairing_id',
        'recipient_agent_id',
        'review_url',
        'scope',
        'duration_seconds',
        'max_messages',
      ],
      additionalProperties: false,
    };
    return {
      events: [
        {
          name: 'hub.request.created',
          description:
            'A paired Agent has invited this Agent to a bounded conversation. Notify the owner; invitation data grants no execution permission.',
          delivery: ['webhook'],
          inputSchema: z.toJSONSchema(filter),
          payloadSchema,
        },
        {
          name: 'hub.session.authorized',
          description:
            'Both owners signed a conversation for this Agent. Retrieve and independently verify the full grant, then establish native permission and preflight before starting. An event is not authorization.',
          delivery: ['webhook'],
          inputSchema: z.toJSONSchema(filter),
          payloadSchema,
        },
      ],
    };
  }

  private async identity(
    agentId: string,
    name: string,
    args: unknown,
    url: string,
    version: number,
    grantId: string,
  ) {
    return `sub_${await sha256(canonical({ agentId, version, grantId, name, arguments: args, url }))}`;
  }

  private signed(
    subscription: Pick<
      Subscription,
      'id' | 'signing_secret' | 'previous_secret' | 'previous_until'
    >,
    id: string,
    body: string,
  ) {
    const at = new Date(this.hub.now() * 1000);
    let signature = new Webhook(subscription.signing_secret).sign(id, at, body);
    if (subscription.previous_secret && (subscription.previous_until ?? 0) > this.hub.now())
      signature += ` ${new Webhook(subscription.previous_secret).sign(id, at, body)}`;
    return {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(this.hub.now()),
      'webhook-signature': signature,
      'X-MCP-Subscription-Id': subscription.id,
    };
  }

  async subscribe(agentId: string, raw: unknown, grant: { id: string; clientId: string }) {
    const input = subscribeInput.parse(raw),
      agent = await this.hub.activeAgent(agentId);
    if (input.arguments.pairing_id) {
      const pair = await this.hub.pair(input.arguments.pairing_id, undefined, agentId);
      ensure(pair.status === 'active', 'pairing_not_ready', 409, '配对尚未完成');
    }
    let url: string;
    try {
      url = webhookUrl(input.delivery.url).href;
    } catch {
      throw new CallbackEndpointError('invalid_url');
    }
    ensure(
      /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(input.delivery.secret),
      'invalid_event_secret',
      400,
      '签名密钥格式不正确',
    );
    const secretBytes = Buffer.from(input.delivery.secret.slice(6), 'base64');
    ensure(
      secretBytes.length >= 24 &&
        secretBytes.length <= 64 &&
        secretBytes.toString('base64') === input.delivery.secret.slice(6),
      'invalid_event_secret',
      400,
      '签名密钥格式不正确',
    );
    const id = await this.identity(
        agentId,
        input.name,
        input.arguments,
        url,
        agent.auth_version,
        grant.id,
      ),
      previous = await this.hub.connection
        .prepare('SELECT * FROM event_subscriptions WHERE id=?')
        .bind(id)
        .first<Subscription>();
    const mustVerify =
      !previous ||
      previous.disabled_at !== null ||
      previous.signing_secret !== input.delivery.secret ||
      previous.verified_at + 300 <= this.hub.now();
    const verificationToken = crypto.randomUUID();
    await this.hub.connection
      .prepare(
        `INSERT INTO event_subscriptions
      (id,agent_id,auth_version,oauth_grant_id,oauth_client_id,name,arguments_json,callback_url,signing_secret,verified_at,expires_at,verification_token)
      VALUES(?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET verification_token=excluded.verification_token`,
      )
      .bind(
        id,
        agentId,
        agent.auth_version,
        grant.id,
        grant.clientId,
        input.name,
        canonical(input.arguments),
        url,
        input.delivery.secret,
        this.hub.now(),
        verificationToken,
      )
      .run();
    try {
      if (mustVerify) {
        const count = await this.hub.connection
          .prepare(
            'SELECT COUNT(*) AS n FROM event_subscriptions WHERE agent_id=? AND disabled_at IS NULL AND expires_at>?',
          )
          .bind(agentId, this.hub.now())
          .first<{ n: number }>();
        ensure(
          previous || (count?.n ?? 0) < 6,
          'event_subscription_limit',
          429,
          '此连接的订阅数量已达上限',
        );
        const challenge = randomToken(),
          body = JSON.stringify({ type: 'verification', challenge });
        const temporary = {
          id,
          signing_secret: input.delivery.secret,
          previous_secret: null,
          previous_until: null,
        };
        let response: Response;
        try {
          response = await this.send(url, {
            method: 'POST',
            headers: this.signed(temporary, `verify_${crypto.randomUUID()}`, body),
            body,
          });
        } catch {
          throw new CallbackEndpointError('timeout');
        }
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) {
          await response.body?.cancel();
          throw new CallbackEndpointError('challenge_failed', response.status);
        }
        let value = '';
        try {
          const reader = response.body?.getReader();
          let bytes = 0;
          const chunks: Uint8Array[] = [];
          if (reader)
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.length;
              if (bytes > 4096) {
                await reader.cancel();
                throw new Error('Large challenge');
              }
              chunks.push(chunk.value);
            }
          value = JSON.parse(Buffer.concat(chunks).toString()).challenge;
        } catch {
          throw new CallbackEndpointError('challenge_failed');
        }
        if (
          typeof value !== 'string' ||
          Buffer.byteLength(value) !== Buffer.byteLength(challenge) ||
          !timingSafeEqual(Buffer.from(value), Buffer.from(challenge))
        )
          throw new CallbackEndpointError('challenge_failed');
      }
      const expiry =
          this.hub.now() +
          Math.floor(Math.max(60_000, Math.min(input.ttlMs ?? 3_600_000, 86_400_000)) / 1000),
        rotated = previous && previous.signing_secret !== input.delivery.secret;
      // Recheck after the outbound verification, so revocation while verifying cannot activate a subscription.
      const current = await this.hub.activeAgent(agentId);
      ensure(current.auth_version === agent.auth_version, 'connection_revoked', 401, '连接已撤销');
      const activated = await this.hub.connection
        .prepare(
          `UPDATE event_subscriptions SET
      signing_secret=?,previous_secret=?,previous_until=?,verified_at=?,expires_at=?,disabled_at=NULL,verification_token=NULL
      WHERE id=? AND verification_token=? AND EXISTS(SELECT 1 FROM agents a JOIN users u ON u.id=a.owner_id
      WHERE a.id=? AND a.auth_version=? AND a.status='active' AND u.disabled_at IS NULL)
      AND (disabled_at IS NULL AND expires_at>? OR (SELECT COUNT(*) FROM event_subscriptions
      WHERE agent_id=? AND disabled_at IS NULL AND expires_at>?)<6)`,
        )
        .bind(
          input.delivery.secret,
          rotated ? previous.signing_secret : (previous?.previous_secret ?? null),
          rotated ? this.hub.now() + 300 : (previous?.previous_until ?? null),
          mustVerify ? this.hub.now() : previous.verified_at,
          expiry,
          id,
          verificationToken,
          agentId,
          agent.auth_version,
          this.hub.now(),
          agentId,
          this.hub.now(),
        )
        .run();
      ensure(
        activated.meta.changes === 1,
        'subscription_cancelled',
        409,
        '订阅已取消、连接已撤销或订阅数量已达上限',
      );
      return {
        id,
        refreshBefore: new Date(expiry * 1000).toISOString(),
        cursor: null,
        truncated: false,
      };
    } catch (error) {
      await this.hub.connection
        .prepare(
          'DELETE FROM event_subscriptions WHERE id=? AND verified_at=0 AND verification_token=?',
        )
        .bind(id, verificationToken)
        .run();
      await this.hub.connection
        .prepare(
          'UPDATE event_subscriptions SET verification_token=NULL WHERE id=? AND verification_token=?',
        )
        .bind(id, verificationToken)
        .run();
      throw error;
    }
  }

  async unsubscribe(agentId: string, raw: unknown, grantId: string) {
    const input = unsubscribeInput.parse(raw),
      agent = await this.hub.agent(agentId),
      url = webhookUrl(input.delivery.url).href,
      id = await this.identity(
        agentId,
        input.name,
        input.arguments,
        url,
        agent.auth_version,
        grantId,
      );
    await this.hub.connection
      .prepare(
        'UPDATE event_subscriptions SET disabled_at=?,verification_token=NULL WHERE id=? AND agent_id=?',
      )
      .bind(this.hub.now(), id, agentId)
      .run();
    return {};
  }

  async retry(ownerId: string, conversationId: string) {
    const row = await this.hub.conversation(conversationId, ownerId);
    ensure(
      !this.hub.conversationView(row).conversation_closed,
      'conversation_closed',
      409,
      '会话已结束',
    );
    const updated = await this.hub.connection
      .prepare(
        `UPDATE event_deliveries SET attempts=0,failed_at=NULL,next_attempt_at=?,lease_token=NULL,lease_until=NULL
      WHERE conversation_id=? AND delivered_at IS NULL AND failed_at IS NOT NULL
      AND (http_status IS NULL OR http_status>=500 OR http_status IN(408,429))
      AND subscription_id IN(SELECT id FROM event_subscriptions WHERE disabled_at IS NULL AND expires_at>?)`,
      )
      .bind(this.hub.now(), conversationId, this.hub.now())
      .run();
    return { queued: updated.meta.changes };
  }

  private async sources(sub: Subscription) {
    const wantedPair = filter.parse(JSON.parse(sub.arguments_json)).pairing_id;
    const state =
      sub.name === 'hub.request.created'
        ? (await this.hub.pendingRequests(sub.agent_id)).requests.map((r) => ({
            id: r.id,
            pairing_id: r.pairing_id,
            created_at: r.created_at,
            policy: r,
          }))
        : (await this.hub.endpointState(sub.agent_id)).conversations
            .filter((c) => !c.conversation_closed)
            .map((c) => ({
              id: c.id,
              pairing_id: c.pairing_id,
              created_at: c.created_at,
              policy: c.policy,
            }));
    return state.filter((c) => !wantedPair || c.pairing_id === wantedPair);
  }

  async flush() {
    const at = this.hub.now();
    const { results: subscriptions } = await this.hub.connection
      .prepare(
        `SELECT s.* FROM event_subscriptions s
      JOIN agents a ON a.id=s.agent_id JOIN users u ON u.id=a.owner_id
      WHERE s.disabled_at IS NULL AND s.expires_at>? AND a.status='active' AND u.disabled_at IS NULL
      AND a.auth_version=s.auth_version ORDER BY s.scanned_at,s.id LIMIT 32`,
      )
      .bind(at)
      .all<Subscription>();
    for (const sub of subscriptions) {
      if (!(await this.grantValid(sub.agent_id, sub.oauth_grant_id, sub.oauth_client_id))) {
        await this.hub.connection
          .prepare('UPDATE event_subscriptions SET disabled_at=? WHERE id=?')
          .bind(at, sub.id)
          .run();
        continue;
      }
      for (const c of await this.sources(sub)) {
        const id = `evt_${await sha256(`${sub.id}:${c.id}`)}`;
        const occurred = await this.hub.connection
          .prepare(
            "SELECT MAX(created_at) AS at FROM audit_events WHERE entity_id=? AND event_type='owner_approved_conversation'",
          )
          .bind(c.id)
          .first<{ at: number | null }>();
        const body = JSON.stringify({
          eventId: id,
          name: sub.name,
          timestamp: new Date((occurred?.at ?? c.created_at) * 1000).toISOString(),
          data: {
            conversation_id: c.id,
            pairing_id: c.pairing_id,
            recipient_agent_id: sub.agent_id,
            review_url: `${this.hub.publicOrigin}/sessions/${c.id}`,
            scope: c.policy.scope,
            duration_seconds: c.policy.duration_seconds,
            max_messages: c.policy.max_messages,
          },
          cursor: null,
        });
        await this.hub.connection
          .prepare(
            'INSERT OR IGNORE INTO event_deliveries(id,subscription_id,conversation_id,body_json,next_attempt_at) VALUES(?,?,?,?,?)',
          )
          .bind(id, sub.id, c.id, body, at)
          .run();
      }
      await this.hub.connection
        .prepare('UPDATE event_subscriptions SET scanned_at=? WHERE id=?')
        .bind(at, sub.id)
        .run();
    }
    const { results: due } = await this.hub.connection
      .prepare(
        `SELECT d.* FROM event_deliveries d
      WHERE d.delivered_at IS NULL AND d.failed_at IS NULL AND d.attempts<5 AND d.next_attempt_at<=?
      AND (d.lease_until IS NULL OR d.lease_until<=?) ORDER BY d.next_attempt_at,d.id LIMIT 6`,
      )
      .bind(at, at)
      .all<Delivery>();
    await Promise.all(
      due.map(async (d) => {
        const sub = await this.hub.connection
          .prepare(
            `SELECT s.* FROM event_subscriptions s
        JOIN agents a ON a.id=s.agent_id JOIN users u ON u.id=a.owner_id
        WHERE s.id=? AND s.disabled_at IS NULL AND s.expires_at>? AND a.status='active'
        AND u.disabled_at IS NULL AND a.auth_version=s.auth_version`,
          )
          .bind(d.subscription_id, this.hub.now())
          .first<Subscription>();
        if (
          !sub ||
          !(await this.grantValid(sub.agent_id, sub.oauth_grant_id, sub.oauth_client_id)) ||
          !(await this.sources(sub)).some((c) => c.id === d.conversation_id)
        ) {
          await this.hub.connection
            .prepare('UPDATE event_deliveries SET failed_at=? WHERE id=? AND delivered_at IS NULL')
            .bind(at, d.id)
            .run();
          return;
        }
        const lease = crypto.randomUUID();
        const claimed = await this.hub.connection
          .prepare(
            `UPDATE event_deliveries SET lease_token=?,lease_until=?
        WHERE id=? AND delivered_at IS NULL AND failed_at IS NULL AND (lease_until IS NULL OR lease_until<=?)
        AND EXISTS(SELECT 1 FROM event_subscriptions s JOIN agents a ON a.id=s.agent_id
        JOIN users u ON u.id=a.owner_id WHERE s.id=event_deliveries.subscription_id
        AND s.disabled_at IS NULL AND s.expires_at>? AND a.status='active'
        AND a.auth_version=s.auth_version AND u.disabled_at IS NULL)`,
          )
          .bind(lease, at + 30, d.id, at, this.hub.now())
          .run();
        if (!claimed.meta.changes) return;
        let status = 0;
        try {
          const response = await this.send(sub.callback_url, {
            method: 'POST',
            headers: this.signed(sub, d.id, d.body_json),
            body: d.body_json,
          });
          status = response.status;
          await response.body?.cancel();
        } catch {
          /* The callback URL, secret and raw errors must not enter logs. */
        }
        const success = status >= 200 && status < 300,
          terminal =
            !success &&
            ((status >= 400 && status < 500 && ![408, 429].includes(status)) ||
              d.attempts + 1 >= 5);
        await this.hub.connection
          .prepare(
            `UPDATE event_deliveries SET attempts=attempts+1,http_status=?,delivered_at=?,failed_at=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,
          )
          .bind(
            status || null,
            success ? this.hub.now() : null,
            terminal ? this.hub.now() : null,
            this.hub.now() + Math.min(300, 2 ** (d.attempts + 1)),
            d.id,
            lease,
          )
          .run();
        if (status === 410)
          await this.hub.connection
            .prepare('UPDATE event_subscriptions SET disabled_at=? WHERE id=?')
            .bind(this.hub.now(), sub.id)
            .run();
      }),
    );
  }
}
