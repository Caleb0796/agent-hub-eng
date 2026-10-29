import { canonical, decode64, fingerprint, verifySignature } from '../shared/crypto';
import {
  messageEnvelopeSchema,
  PROTOCOL_VERSION,
  type MessageEnvelope,
  type Signed,
} from '../shared/protocol';
import { asJson, ensure, HubError } from './common';
import { Hub } from './hub';

export interface MessageRow {
  id: string;
  conversation_id: string;
  position: number;
  sender_id: string;
  recipient_id: string;
  sender_sequence: number;
  reply_to: string | null;
  idempotency_key: string;
  envelope_json: string;
  envelope_hash: string;
  ciphertext_bytes: number;
  accepted_at: number;
  expires_at: number;
  delivered_at: number | null;
  receipt_json: string | null;
}

export class Mailbox {
  constructor(private hub: Hub) {}

  async send(agentId: string, input: unknown, idempotencyKey: string) {
    const envelope = messageEnvelopeSchema.parse(input),
      p = envelope.payload;
    ensure(p.from === agentId, 'sender_mismatch', 403, '不能以其他 Agent 的身份发送');
    const agent = await this.hub.activeAgent(agentId),
      conversation = await this.hub.conversation(p.conversation_id, undefined, agentId);
    const pair = await this.hub.pair(conversation.pairing_id, undefined, agentId);
    ensure(pair.status === 'active', 'pairing_revoked', 403, '配对已撤销');
    ensure(
      p.to === (pair.agent_a === agentId ? pair.agent_b : pair.agent_a),
      'recipient_mismatch',
      403,
      '接收者不在授权范围内',
    );
    ensure(
      p.grant_hash === conversation.policy_hash,
      'grant_mismatch',
      403,
      '消息引用的会话授权不匹配',
    );
    ensure(
      agent.signing_key && (await verifySignature(agent.signing_key, p, envelope.signature)),
      'invalid_signature',
      403,
      '消息签名无效',
    );
    const envelopeHash = await fingerprint(envelope),
      encoded = canonical(envelope);
    const prior = await this.hub.connection
      .prepare(
        'SELECT * FROM messages WHERE id=? OR (conversation_id=? AND sender_id=? AND idempotency_key=?)',
      )
      .bind(p.id, p.conversation_id, agentId, idempotencyKey)
      .first<MessageRow>();
    if (prior) {
      ensure(
        prior.sender_id === agentId &&
          prior.conversation_id === p.conversation_id &&
          prior.envelope_hash === envelopeHash &&
          prior.idempotency_key === idempotencyKey,
        'idempotency_conflict',
        409,
        '幂等键或消息 ID 已用于另一份密文',
      );
      return {
        status: 'already_accepted',
        message_id: prior.id,
        position: prior.position,
        accepted_at: prior.accepted_at,
        conversation: this.hub.conversationView(conversation),
      };
    }
    ensure(
      !this.hub.conversationView(conversation).conversation_closed,
      'conversation_closed',
      410,
      '会话已结束，不再接受新发送',
    );
    const raw = decode64(p.ciphertext);
    ensure(
      raw.byteLength <= 32768 &&
        new TextDecoder().decode(raw.subarray(0, 22)) === 'age-encryption.org/v1\n',
      'invalid_ciphertext',
      400,
      '只接受 age v1 密文信封',
    );
    const at = this.hub.now();
    try {
      // The database trigger checks live authorization, both readiness proofs, sequence,
      // exact reply chain, clock, quota and keys in the same transaction as this insert.
      await this.hub.connection
        .prepare(
          `INSERT INTO messages(id,conversation_id,position,sender_id,recipient_id,sender_sequence,reply_to,idempotency_key,envelope_json,envelope_hash,ciphertext_bytes,accepted_at,expires_at)
        SELECT ?,id,message_count+1,?,?,?,?,?,?,?,?,?,? FROM conversations WHERE id=?`,
        )
        .bind(
          p.id,
          agentId,
          p.to,
          p.sequence,
          p.reply_to,
          idempotencyKey,
          encoded,
          envelopeHash,
          raw.byteLength,
          at,
          p.expires_at,
          p.conversation_id,
        )
        .run();
    } catch (error) {
      if (
        error instanceof Error &&
        /message not authorized|UNIQUE constraint failed/.test(error.message)
      ) {
        const retry = await this.hub.connection
          .prepare(
            'SELECT * FROM messages WHERE conversation_id=? AND sender_id=? AND idempotency_key=?',
          )
          .bind(p.conversation_id, agentId, idempotencyKey)
          .first<MessageRow>();
        if (retry && retry.id === p.id && retry.envelope_hash === envelopeHash)
          return {
            status: 'already_accepted',
            message_id: retry.id,
            position: retry.position,
            accepted_at: retry.accepted_at,
            conversation: this.hub.conversationView(
              await this.hub.conversation(p.conversation_id, undefined, agentId),
            ),
          };
        throw new HubError(
          'message_state_conflict',
          409,
          '发送被拒绝：授权、截止、额度、序号或回复链已变化，请先读取状态',
        );
      }
      throw error;
    }
    const stored = await this.hub.connection
      .prepare('SELECT id,position,accepted_at FROM messages WHERE id=?')
      .bind(p.id)
      .first<{ id: string; position: number; accepted_at: number }>();
    ensure(stored, 'message_not_accepted', 409, '消息未被接受');
    return {
      status: 'accepted',
      message_id: stored.id,
      position: stored.position,
      accepted_at: stored.accepted_at,
      conversation: this.hub.conversationView(
        await this.hub.conversation(p.conversation_id, undefined, agentId),
      ),
    };
  }

  async inbox(agentId: string, conversationId: string, after: number) {
    await this.hub.activeAgent(agentId);
    const c = await this.hub.conversation(conversationId, undefined, agentId),
      pair = await this.hub.pair(c.pairing_id, undefined, agentId);
    ensure(
      pair.status === 'active' && c.status !== 'revoked',
      'conversation_revoked',
      403,
      '配对或会话已撤销',
    );
    ensure(
      c.approval_a_json && c.approval_b_json,
      'conversation_not_authorized',
      403,
      '双方尚未批准会话',
    );
    const at = this.hub.now();
    const eligible = `EXISTS(SELECT 1 FROM conversations c JOIN pairings p ON p.id=c.pairing_id
      JOIN agents a ON a.id=p.agent_a JOIN agents b ON b.id=p.agent_b
      WHERE c.id=messages.conversation_id AND p.status='active' AND a.status='active' AND b.status='active'
      AND c.status IN ('ready','active','closed','expired') AND c.close_reason IS NOT 'owner-ended' AND c.close_reason IS NOT 'owner-declined' AND c.close_reason IS NOT 'agent-ended'
      AND c.approval_a_json IS NOT NULL AND c.approval_b_json IS NOT NULL
      AND ? < MIN(c.expires_at+300,COALESCE(c.deadline+300,c.expires_at+300)))`;
    const results = await this.hub.connection.batch<MessageRow>([
      this.hub.connection
        .prepare(
          `UPDATE conversations SET started_at=?,deadline=MIN(?+duration_seconds,expires_at),status='active'
        WHERE id=? AND status='ready' AND started_at IS NULL AND expires_at>?
        AND EXISTS(SELECT 1 FROM pairings p JOIN agents a ON a.id=p.agent_a JOIN agents b ON b.id=p.agent_b
          WHERE p.id=conversations.pairing_id AND p.status='active' AND a.status='active' AND b.status='active')
        AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id AND m.recipient_id=? AND m.position>? AND m.expires_at>?)`,
        )
        .bind(at, at, conversationId, at, agentId, after, at),
      this.hub.connection
        .prepare(
          `UPDATE messages SET delivered_at=COALESCE(delivered_at,?)
        WHERE conversation_id=? AND recipient_id=? AND position>? AND expires_at>? AND ${eligible}`,
        )
        .bind(at, conversationId, agentId, after, at, at),
      this.hub.connection
        .prepare(
          `SELECT * FROM messages WHERE conversation_id=? AND recipient_id=? AND position>? AND expires_at>? AND ${eligible} ORDER BY position LIMIT 64`,
        )
        .bind(conversationId, agentId, after, at, at),
    ]);
    const latest = await this.hub.conversation(conversationId, undefined, agentId);
    ensure(
      latest.status !== 'revoked' && (await this.hub.pair(latest.pairing_id)).status === 'active',
      'conversation_revoked',
      403,
      '会话已撤销',
    );
    const messages = results[2].results as MessageRow[];
    return {
      messages: messages.map((m) => ({
        id: m.id,
        position: m.position,
        envelope: asJson<MessageEnvelope>(m.envelope_json),
        envelope_hash: m.envelope_hash,
        accepted_at: m.accepted_at,
      })),
      next_cursor: messages.at(-1)?.position ?? after,
      conversation: this.hub.conversationView(latest),
    };
  }

  async acknowledge(
    agentId: string,
    input: Signed<{
      v: string;
      kind: string;
      conversation_id: string;
      message_id: string;
      receiver_id: string;
      envelope_hash: string;
      decrypted: boolean;
    }>,
  ) {
    const a = await this.hub.activeAgent(agentId),
      p = input.payload;
    ensure(
      p.v === PROTOCOL_VERSION &&
        p.kind === 'message-receipt' &&
        p.receiver_id === agentId &&
        p.decrypted === true,
      'invalid_receipt',
      400,
      '回执格式无效',
    );
    const m = await this.hub.connection
      .prepare(
        'SELECT * FROM messages WHERE id=? AND conversation_id=? AND recipient_id=? AND delivered_at IS NOT NULL',
      )
      .bind(p.message_id, p.conversation_id, agentId)
      .first<MessageRow>();
    ensure(
      m && p.envelope_hash === m.envelope_hash,
      'receipt_mismatch',
      403,
      '回执不对应已领取的消息',
    );
    const c = await this.hub.conversation(m.conversation_id, undefined, agentId);
    ensure(
      c.status !== 'revoked' && (await this.hub.pair(c.pairing_id)).status === 'active',
      'conversation_revoked',
      403,
      '会话已撤销',
    );
    ensure(
      this.hub.now() < Math.min(c.expires_at + 300, (c.deadline ?? c.expires_at) + 300),
      'receipt_window_closed',
      403,
      '回执收尾窗口已结束',
    );
    ensure(
      a.signing_key && (await verifySignature(a.signing_key, p, input.signature)),
      'invalid_signature',
      403,
      '回执签名无效',
    );
    const stored = canonical(input);
    ensure(
      !m.receipt_json || m.receipt_json === stored,
      'receipt_conflict',
      409,
      '这条消息已有不同回执',
    );
    const updated = await this.hub.connection.batch([
      this.hub.connection
        .prepare(
          `UPDATE messages SET receipt_json=? WHERE id=? AND recipient_id=? AND (receipt_json IS NULL OR receipt_json=?)
           AND EXISTS(SELECT 1 FROM conversations c JOIN pairings p ON p.id=c.pairing_id JOIN agents a ON a.id=messages.recipient_id
             WHERE c.id=messages.conversation_id AND c.status<>'revoked' AND p.status='active' AND a.status='active'
             AND ?<MIN(c.expires_at+300,COALESCE(c.deadline+300,c.expires_at+300)))`,
        )
        .bind(stored, m.id, agentId, stored, this.hub.now()),
      this.hub.connection
        .prepare(
          `INSERT OR IGNORE INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at)
        SELECT ?,'endpoint_reported_decryption',NULL,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND receipt_json=?)`,
        )
        .bind(
          `receipt:${m.id}`,
          agentId,
          m.conversation_id,
          canonical({
            message_id: m.id,
            envelope_hash: m.envelope_hash,
            evidence: 'signed-endpoint-report',
          }),
          this.hub.now(),
          m.id,
          stored,
        ),
    ]);
    ensure(updated[0].meta.changes === 1, 'receipt_state_conflict', 409, '回执权限或状态已变化');
    return { status: 'recorded', message_id: m.id, evidence: 'signed-endpoint-report' };
  }
}
