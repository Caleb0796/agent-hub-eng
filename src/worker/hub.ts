import {
  canonical,
  decode64,
  fingerprint,
  randomToken,
  safetyCode,
  sha256,
  verifySignature,
} from '../shared/crypto';
import {
  PROTOCOL_VERSION,
  enrollmentSchema,
  type ClaimPayload,
  type ConversationPolicy,
  type PairDescriptor,
  type Participant,
  type Platform,
  type Signed,
} from '../shared/protocol';
import { asJson, audit, ensure, HubError, type Connection } from './common';

export interface AgentRow {
  id: string;
  owner_id: string;
  platform: Platform;
  label: string;
  status: string;
  age_key: string | null;
  signing_key: string | null;
  fingerprint: string | null;
  generation: number;
  auth_version: number;
  claim_json: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}
export interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  signing_key: string;
  disabled_at: number | null;
}
export interface PairRow {
  id: string;
  owner_a: string;
  agent_a: string;
  owner_b: string | null;
  agent_b: string | null;
  status: string;
  invite_hash: string;
  descriptor_json: string | null;
  fingerprint: string | null;
  approval_a_json: string | null;
  approval_b_json: string | null;
  endpoint_a_ack: string | null;
  endpoint_b_ack: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}
export interface ConversationRow {
  id: string;
  pairing_id: string;
  initiator_agent_id: string;
  status: string;
  policy_json: string;
  policy_hash: string;
  approval_a_json: string | null;
  approval_b_json: string | null;
  duration_seconds: number;
  max_messages: number;
  message_count: number;
  last_sender: string | null;
  last_message_id: string | null;
  created_at: number;
  expires_at: number;
  started_at: number | null;
  deadline: number | null;
  closed_at: number | null;
  close_reason: string | null;
}
interface EnrollmentRow {
  agent_id: string;
  nonce: string;
  proof_json: string | null;
  claim_payload_json: string | null;
  expires_at: number;
}

export class Hub {
  constructor(
    public connection: Connection,
    public publicOrigin: string,
    public now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async user(id: string): Promise<UserRow> {
    const row = await this.connection
      .prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL')
      .bind(id)
      .first<UserRow>();
    ensure(row, 'owner_unavailable', 403, '主人账号不可用');
    return row;
  }

  async agent(id: string, ownerId?: string): Promise<AgentRow> {
    const row = await this.connection
      .prepare(
        'SELECT a.* FROM agents a JOIN users u ON u.id=a.owner_id WHERE a.id=? AND u.disabled_at IS NULL',
      )
      .bind(id)
      .first<AgentRow>();
    ensure(
      row && (!ownerId || row.owner_id === ownerId),
      'agent_not_found',
      404,
      '找不到这个 Agent',
    );
    return row;
  }

  async activeAgent(id: string, ownerId?: string): Promise<AgentRow> {
    const row = await this.agent(id, ownerId);
    ensure(
      row.status === 'active' && row.age_key && row.signing_key && row.fingerprint,
      'agent_not_ready',
      409,
      'Agent 尚未完成认领和端点确认',
    );
    return row;
  }

  async participant(id: string): Promise<Participant> {
    const a = await this.activeAgent(id),
      u = await this.user(a.owner_id);
    ensure(a.age_key && a.signing_key && a.fingerprint, 'agent_not_ready', 409, '密钥尚未确认');
    return {
      owner_id: u.id,
      owner_name: u.display_name,
      owner_key: u.signing_key,
      agent_id: a.id,
      agent_name: a.label,
      platform: a.platform,
      keys: { age: a.age_key, sign: a.signing_key },
      generation: a.generation,
      fingerprint: a.fingerprint,
    };
  }

  async createAgent(ownerId: string, platform: Platform, label: string): Promise<AgentRow> {
    await this.user(ownerId);
    const count = await this.connection
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_id=? AND status<>'revoked'")
      .bind(ownerId)
      .first<{ n: number }>();
    ensure((count?.n ?? 0) < 8, 'agent_limit', 409, '当前测试版每位主人最多连接 8 个 Agent');
    const id = crypto.randomUUID(),
      at = this.now();
    await this.connection.batch([
      this.connection
        .prepare(
          "INSERT INTO agents(id,owner_id,platform,label,status,created_at,updated_at) VALUES(?,?,?,?,'awaiting_connection',?,?)",
        )
        .bind(id, ownerId, platform, label, at, at),
      audit(this.connection, 'agent_created', id, { owner: ownerId }, { platform }, at),
    ]);
    return this.agent(id, ownerId);
  }

  async authorizeConnection(ownerId: string, agentId: string): Promise<AgentRow> {
    const a = await this.agent(agentId, ownerId);
    ensure(a.status !== 'revoked', 'agent_revoked', 403, '这个连接已撤销');
    await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE agents SET status=CASE WHEN status='awaiting_connection' THEN 'awaiting_endpoint' ELSE status END,updated_at=? WHERE id=? AND owner_id=? AND status<>'revoked'",
        )
        .bind(this.now(), agentId, ownerId),
      audit(this.connection, 'connector_authorized', agentId, { owner: ownerId }, {}, this.now()),
    ]);
    return this.agent(agentId, ownerId);
  }

  async enrollmentChallenge(agentId: string) {
    const a = await this.agent(agentId),
      u = await this.user(a.owner_id);
    ensure(
      a.status !== 'awaiting_connection' && a.status !== 'revoked',
      'enrollment_unavailable',
      409,
      '连接尚未授权或已撤销',
    );
    let row = await this.connection
      .prepare('SELECT * FROM enrollments WHERE agent_id=?')
      .bind(agentId)
      .first<EnrollmentRow>();
    if (!row) {
      await this.connection
        .prepare('INSERT OR IGNORE INTO enrollments(agent_id,nonce,expires_at) VALUES(?,?,?)')
        .bind(agentId, randomToken(), this.now() + 900)
        .run();
      row = await this.connection
        .prepare('SELECT * FROM enrollments WHERE agent_id=?')
        .bind(agentId)
        .first<EnrollmentRow>();
    }
    ensure(row, 'enrollment_unavailable', 503, '无法准备认领，请稍后重试');
    ensure(
      row.expires_at > this.now() || a.status === 'active',
      'enrollment_expired',
      410,
      '本次接入已过期，请主人撤销后创建新连接',
    );
    return {
      v: PROTOCOL_VERSION,
      agent_id: a.id,
      platform: a.platform,
      owner_id: u.id,
      owner_name: u.display_name,
      owner_key: u.signing_key,
      nonce: row.nonce,
      expires_at: row.expires_at,
      claim_url: `${this.publicOrigin}/agents/${a.id}`,
      endpoint_version: '0.1.0',
    };
  }

  async registerEndpoint(agentId: string, input: unknown) {
    const signed = enrollmentSchema.parse(input),
      a = await this.agent(agentId),
      u = await this.user(a.owner_id);
    const e = await this.connection
      .prepare('SELECT * FROM enrollments WHERE agent_id=?')
      .bind(agentId)
      .first<EnrollmentRow>();
    ensure(e && e.expires_at > this.now(), 'enrollment_expired', 410, '接入请求已过期');
    ensure(
      signed.payload.agent_id === agentId &&
        signed.payload.owner_id === u.id &&
        signed.payload.owner_key === u.signing_key &&
        signed.payload.nonce === e.nonce,
      'registration_mismatch',
      403,
      '接入身份或挑战不匹配',
    );
    ensure(
      await verifySignature(signed.payload.keys.sign, signed.payload, signed.signature),
      'invalid_signature',
      403,
      '端点签名无效',
    );
    const identityHash = await fingerprint({
      v: PROTOCOL_VERSION,
      agent_id: a.id,
      owner_id: u.id,
      owner_key: u.signing_key,
      keys: signed.payload.keys,
      generation: a.generation,
    });
    if (a.fingerprint) {
      ensure(
        a.status !== 'revoked' && a.fingerprint === identityHash,
        'identity_change_rejected',
        409,
        '既有身份不能被替换，请创建新的连接',
      );
      return {
        status: a.status,
        fingerprint: identityHash,
        safety_code: safetyCode(identityHash),
        claim_url: `${this.publicOrigin}/agents/${a.id}`,
      };
    }
    ensure(
      a.status === 'awaiting_endpoint',
      'registration_not_allowed',
      409,
      '当前状态不允许提交端点',
    );
    const claim: ClaimPayload = {
      v: PROTOCOL_VERSION,
      kind: 'owner-claim',
      agent_id: a.id,
      owner_id: u.id,
      owner_key: u.signing_key,
      endpoint_keys: signed.payload.keys,
      registration_nonce: e.nonce,
      fingerprint: identityHash,
      generation: a.generation,
    };
    const result = await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE agents SET status='awaiting_claim',age_key=?,signing_key=?,fingerprint=?,updated_at=? WHERE id=? AND status='awaiting_endpoint' AND signing_key IS NULL",
        )
        .bind(signed.payload.keys.age, signed.payload.keys.sign, identityHash, this.now(), agentId),
      this.connection
        .prepare(
          "UPDATE enrollments SET proof_json=?,claim_payload_json=? WHERE agent_id=? AND nonce=? AND expires_at>? AND EXISTS(SELECT 1 FROM agents WHERE id=? AND fingerprint=? AND status='awaiting_claim')",
        )
        .bind(
          canonical(signed),
          canonical(claim),
          agentId,
          e.nonce,
          this.now(),
          agentId,
          identityHash,
        ),
      this.conditionalEvent(
        'endpoint_registered',
        agentId,
        { agent: agentId },
        "EXISTS(SELECT 1 FROM agents WHERE id=? AND fingerprint=? AND status='awaiting_claim')",
        [agentId, identityHash],
        { fingerprint: identityHash },
        `registered:${agentId}`,
      ),
    ]);
    ensure(
      result[0].meta.changes === 1,
      'registration_conflict',
      409,
      '连接状态已改变，请检查当前状态',
    );
    return {
      status: 'awaiting_claim',
      fingerprint: identityHash,
      safety_code: safetyCode(identityHash),
      claim_url: `${this.publicOrigin}/agents/${a.id}`,
    };
  }

  async ownerClaim(ownerId: string, agentId: string, signature: string) {
    const a = await this.agent(agentId, ownerId),
      u = await this.user(ownerId);
    const e = await this.connection
      .prepare('SELECT * FROM enrollments WHERE agent_id=?')
      .bind(agentId)
      .first<EnrollmentRow>();
    ensure(e?.claim_payload_json && e.expires_at > this.now(), 'claim_expired', 410, '认领已过期');
    ensure(
      ['awaiting_claim', 'awaiting_confirmation', 'active'].includes(a.status),
      'claim_not_allowed',
      409,
      '当前状态不能认领',
    );
    const payload = asJson<ClaimPayload>(e.claim_payload_json);
    ensure(
      await verifySignature(u.signing_key, payload, signature),
      'invalid_owner_signature',
      403,
      '主人授权签名无效',
    );
    const certificate = canonical({ payload, signature });
    await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE agents SET status='awaiting_confirmation',claim_json=?,updated_at=? WHERE id=? AND owner_id=? AND status='awaiting_claim' AND EXISTS(SELECT 1 FROM enrollments WHERE agent_id=? AND expires_at>?)",
        )
        .bind(certificate, this.now(), agentId, ownerId, agentId, this.now()),
      this.conditionalEvent(
        'owner_claimed_agent',
        agentId,
        { owner: ownerId },
        "EXISTS(SELECT 1 FROM agents WHERE id=? AND claim_json=? AND status<>'revoked')",
        [agentId, certificate],
        {},
        `claimed:${agentId}`,
      ),
    ]);
    const after = await this.agent(agentId, ownerId);
    ensure(
      after.claim_json === certificate && after.status !== 'revoked',
      'claim_conflict',
      409,
      '认领状态已变化',
    );
    return after;
  }

  async confirmClaim(
    agentId: string,
    proof: Signed<{ v: string; kind: string; agent_id: string; claim_hash: string }>,
  ) {
    const a = await this.agent(agentId);
    ensure(
      a.claim_json && a.signing_key && ['awaiting_confirmation', 'active'].includes(a.status),
      'claim_not_ready',
      409,
      '主人尚未认领',
    );
    const expected = {
      v: PROTOCOL_VERSION,
      kind: 'claim-confirmation',
      agent_id: agentId,
      claim_hash: await fingerprint(asJson(a.claim_json)),
    };
    ensure(
      canonical(proof.payload) === canonical(expected) &&
        (await verifySignature(a.signing_key, proof.payload, proof.signature)),
      'invalid_claim_confirmation',
      403,
      '端点未正确确认主人证书',
    );
    await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE agents SET status='active',updated_at=? WHERE id=? AND status='awaiting_confirmation' AND claim_json=?",
        )
        .bind(this.now(), agentId, a.claim_json),
      this.conditionalEvent(
        'agent_activated',
        agentId,
        { agent: agentId },
        "EXISTS(SELECT 1 FROM agents WHERE id=? AND status='active')",
        [agentId],
        {},
        `activated:${agentId}`,
      ),
    ]);
    return this.activeAgent(agentId);
  }

  async agentDetail(ownerId: string, agentId: string) {
    const a = await this.agent(agentId, ownerId);
    const e = await this.connection
      .prepare('SELECT claim_payload_json,expires_at FROM enrollments WHERE agent_id=?')
      .bind(agentId)
      .first<{ claim_payload_json: string | null; expires_at: number }>();
    return {
      ...a,
      safety_code: a.fingerprint ? safetyCode(a.fingerprint) : null,
      claim_payload: e?.claim_payload_json ? asJson<ClaimPayload>(e.claim_payload_json) : null,
      enrollment_expires_at: e?.expires_at ?? null,
    };
  }

  async pair(id: string, ownerId?: string, agentId?: string): Promise<PairRow> {
    const row = await this.connection
      .prepare('SELECT * FROM pairings WHERE id=?')
      .bind(id)
      .first<PairRow>();
    ensure(
      row &&
        (!ownerId || [row.owner_a, row.owner_b].includes(ownerId)) &&
        (!agentId || [row.agent_a, row.agent_b].includes(agentId)),
      'pairing_not_found',
      404,
      '找不到这个配对',
    );
    return row;
  }

  async createPairing(ownerId: string, agentId: string) {
    await this.activeAgent(agentId, ownerId);
    const id = crypto.randomUUID(),
      token = randomToken(),
      at = this.now();
    await this.connection.batch([
      this.connection
        .prepare(
          "INSERT INTO pairings(id,owner_a,agent_a,status,invite_hash,created_at,expires_at) VALUES(?,?,?,'invited',?,?,?)",
        )
        .bind(id, ownerId, agentId, await sha256(token), at, at + 86400),
      audit(this.connection, 'pairing_invited', id, { owner: ownerId }, {}, at),
    ]);
    return { id, invite_url: `${this.publicOrigin}/pair#invite=${token}`, expires_at: at + 86400 };
  }

  async pairingInvitation(ownerId: string, token: string) {
    const pair = await this.connection
      .prepare("SELECT * FROM pairings WHERE invite_hash=? AND status='invited' AND expires_at>?")
      .bind(await sha256(token), this.now())
      .first<PairRow>();
    ensure(pair, 'invitation_unavailable', 410, '配对邀请无效、已使用或已过期');
    ensure(
      pair.owner_a !== ownerId,
      'independent_owner_required',
      409,
      '请由另一位独立主人打开邀请',
    );
    return {
      id: pair.id,
      inviter: await this.participant(pair.agent_a),
      expires_at: pair.expires_at,
    };
  }

  async joinPairing(ownerId: string, token: string, agentId: string) {
    const b = await this.activeAgent(agentId, ownerId);
    const p = await this.connection
      .prepare("SELECT * FROM pairings WHERE invite_hash=? AND status='invited' AND expires_at>?")
      .bind(await sha256(token), this.now())
      .first<PairRow>();
    ensure(p, 'invitation_unavailable', 410, '配对邀请已使用或已过期');
    ensure(p.owner_a !== ownerId, 'independent_owner_required', 409, '这一步需要两位独立主人');
    const a = await this.activeAgent(p.agent_a);
    ensure(a.platform !== b.platform, 'unsupported_pair', 409, '首版先支持 Dot 与 Muse 之间的配对');
    const descriptor: PairDescriptor = {
      v: PROTOCOL_VERSION,
      kind: 'pairing',
      id: p.id,
      nonce: randomToken(),
      participants: [await this.participant(a.id), await this.participant(b.id)],
      expires_at: p.expires_at,
    };
    const hash = await fingerprint(descriptor),
      encoded = canonical(descriptor);
    const results = await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE pairings SET owner_b=?,agent_b=?,descriptor_json=?,fingerprint=?,status='confirming' WHERE id=? AND status='invited' AND expires_at>? AND owner_a<>?",
        )
        .bind(ownerId, agentId, encoded, hash, p.id, this.now(), ownerId),
      this.conditionalEvent(
        'pairing_joined',
        p.id,
        { owner: ownerId },
        'EXISTS(SELECT 1 FROM pairings WHERE id=? AND descriptor_json=?)',
        [p.id, encoded],
        { fingerprint: hash },
        `joined:${p.id}`,
      ),
    ]);
    ensure(
      results[0].meta.changes === 1,
      'pairing_conflict',
      409,
      '邀请刚被其他连接使用，请重新申请',
    );
    return this.pairView(await this.pair(p.id, ownerId));
  }

  pairView(p: PairRow) {
    return {
      id: p.id,
      status: p.status,
      owner_a: p.owner_a,
      owner_b: p.owner_b,
      agent_a: p.agent_a,
      agent_b: p.agent_b,
      descriptor: p.descriptor_json ? asJson<PairDescriptor>(p.descriptor_json) : null,
      fingerprint: p.fingerprint,
      safety_code: p.fingerprint ? safetyCode(p.fingerprint) : null,
      approvals: [p.approval_a_json, p.approval_b_json]
        .filter((x): x is string => !!x)
        .map((x) => asJson<{ owner_id: string; signature: string }>(x)),
      endpoint_confirmations: { a: !!p.endpoint_a_ack, b: !!p.endpoint_b_ack },
      expires_at: p.expires_at,
    };
  }

  async approvePairing(ownerId: string, id: string, signature: string) {
    const p = await this.pair(id, ownerId),
      u = await this.user(ownerId);
    ensure(
      p.descriptor_json &&
        p.expires_at > this.now() &&
        ['confirming', 'awaiting_endpoints', 'active'].includes(p.status),
      'pairing_not_approvable',
      409,
      '配对已过期或不再等待批准',
    );
    const descriptor = asJson<PairDescriptor>(p.descriptor_json);
    ensure(
      await verifySignature(u.signing_key, descriptor, signature),
      'invalid_owner_signature',
      403,
      '主人配对签名无效',
    );
    await this.activeAgent(p.agent_a);
    ensure(p.agent_b, 'pairing_not_ready', 409, '对方尚未加入');
    await this.activeAgent(p.agent_b);
    const approval = canonical({ owner_id: ownerId, signature }),
      field = p.owner_a === ownerId ? 'approval_a_json' : 'approval_b_json';
    await this.connection.batch([
      this.connection
        .prepare(
          `UPDATE pairings SET ${field}=? WHERE id=? AND status='confirming' AND ${field} IS NULL AND expires_at>?`,
        )
        .bind(approval, id, this.now()),
      this.connection
        .prepare(
          "UPDATE pairings SET status='awaiting_endpoints' WHERE id=? AND status='confirming' AND approval_a_json IS NOT NULL AND approval_b_json IS NOT NULL",
        )
        .bind(id),
      this.conditionalEvent(
        'owner_approved_pairing',
        id,
        { owner: ownerId },
        `EXISTS(SELECT 1 FROM pairings WHERE id=? AND ${field}=?)`,
        [id, approval],
        {},
        `pair-approved:${id}:${ownerId}`,
      ),
    ]);
    const after = await this.pair(id, ownerId);
    ensure(
      after[field] === approval && !['revoked', 'expired'].includes(after.status),
      'pairing_conflict',
      409,
      '配对状态已变化',
    );
    return this.pairView(after);
  }

  async acknowledgePairing(agentId: string, id: string, signature: string) {
    const p = await this.pair(id, undefined, agentId),
      a = await this.activeAgent(agentId);
    ensure(
      p.fingerprint &&
        p.approval_a_json &&
        p.approval_b_json &&
        ['awaiting_endpoints', 'active'].includes(p.status),
      'pairing_not_authorized',
      403,
      '两位主人尚未批准配对',
    );
    ensure(
      p.status === 'active' || p.expires_at > this.now(),
      'pairing_expired',
      410,
      '配对已过期',
    );
    const proof = {
      v: PROTOCOL_VERSION,
      kind: 'pairing-confirmation',
      pairing_id: id,
      agent_id: agentId,
      pairing_hash: p.fingerprint,
    };
    ensure(
      a.signing_key && (await verifySignature(a.signing_key, proof, signature)),
      'invalid_signature',
      403,
      '配对端点确认无效',
    );
    const field = p.agent_a === agentId ? 'endpoint_a_ack' : 'endpoint_b_ack';
    await this.connection.batch([
      this.connection
        .prepare(
          `UPDATE pairings SET ${field}=? WHERE id=? AND status IN ('awaiting_endpoints','active') AND (status='active' OR expires_at>?)`,
        )
        .bind(signature, id, this.now()),
      this.connection
        .prepare(
          "UPDATE pairings SET status='active' WHERE id=? AND status='awaiting_endpoints' AND endpoint_a_ack IS NOT NULL AND endpoint_b_ack IS NOT NULL AND expires_at>?",
        )
        .bind(id, this.now()),
      this.conditionalEvent(
        'endpoint_confirmed_pairing',
        id,
        { agent: agentId },
        `EXISTS(SELECT 1 FROM pairings WHERE id=? AND ${field}=?)`,
        [id, signature],
        {},
        `pair-ack:${id}:${agentId}`,
      ),
    ]);
    return this.pairView(await this.pair(id, undefined, agentId));
  }

  async conversation(id: string, ownerId?: string, agentId?: string): Promise<ConversationRow> {
    const row = await this.connection
      .prepare(
        `SELECT c.* FROM conversations c JOIN pairings p ON p.id=c.pairing_id
      WHERE c.id=? AND (? IS NULL OR p.owner_a=? OR p.owner_b=?) AND (? IS NULL OR p.agent_a=? OR p.agent_b=?)`,
      )
      .bind(
        id,
        ownerId ?? null,
        ownerId ?? null,
        ownerId ?? null,
        agentId ?? null,
        agentId ?? null,
        agentId ?? null,
      )
      .first<ConversationRow>();
    ensure(row, 'conversation_not_found', 404, '找不到这个会话');
    return row;
  }

  conversationView(c: ConversationRow) {
    const timeEnded =
      (c.deadline !== null && c.deadline <= this.now()) || c.expires_at <= this.now();
    const closed = timeEnded || ['closed', 'expired', 'revoked'].includes(c.status);
    return {
      id: c.id,
      pairing_id: c.pairing_id,
      status: timeEnded && !['closed', 'revoked'].includes(c.status) ? 'expired' : c.status,
      policy: asJson<ConversationPolicy>(c.policy_json),
      policy_hash: c.policy_hash,
      approvals: [c.approval_a_json, c.approval_b_json]
        .filter((x): x is string => !!x)
        .map((x) => asJson<{ owner_id: string; signature: string }>(x)),
      message_count: c.message_count,
      max_messages: c.max_messages,
      started_at: c.started_at,
      deadline: c.deadline,
      conversation_closed: closed,
      remaining_seconds: c.deadline ? Math.max(0, c.deadline - this.now()) : c.duration_seconds,
      close_reason: c.close_reason ?? (timeEnded ? 'deadline_reached' : null),
      created_at: c.created_at,
    };
  }

  async createConversation(ownerId: string, pairingId: string, duration = 600, maxMessages = 40) {
    const pair = await this.pair(pairingId, ownerId);
    ensure(
      pair.status === 'active' && pair.descriptor_json && pair.fingerprint && pair.agent_b,
      'pairing_not_ready',
      409,
      '请先让两端确认安全配对',
    );
    ensure(
      Number.isInteger(duration) &&
        duration >= 60 &&
        duration <= 600 &&
        Number.isInteger(maxMessages) &&
        maxMessages >= 2 &&
        maxMessages <= 64,
      'invalid_limits',
      400,
      '会话时长或条数超出限制',
    );
    await this.activeAgent(pair.agent_a);
    await this.activeAgent(pair.agent_b);
    await this.connection
      .prepare(
        "UPDATE conversations SET status='expired',closed_at=COALESCE(deadline,expires_at),close_reason='deadline_reached' WHERE pairing_id=? AND status IN ('awaiting_approval','authorized','ready','active') AND (expires_at<=? OR (deadline IS NOT NULL AND deadline<=?))",
      )
      .bind(pairingId, this.now(), this.now())
      .run();
    const live = await this.connection
      .prepare(
        "SELECT id FROM conversations WHERE pairing_id=? AND status NOT IN ('closed','revoked','expired') AND expires_at>? AND (deadline IS NULL OR deadline>?)",
      )
      .bind(pairingId, this.now(), this.now())
      .first();
    ensure(!live, 'conversation_already_open', 409, '这对 Agent 已有未结束的会话');
    const id = crypto.randomUUID(),
      at = this.now(),
      descriptor = asJson<PairDescriptor>(pair.descriptor_json);
    const policy: ConversationPolicy = {
      v: PROTOCOL_VERSION,
      kind: 'conversation-grant',
      id,
      pairing_id: pair.id,
      pairing_hash: pair.fingerprint,
      nonce: randomToken(),
      initiator_agent_id: pair.owner_a === ownerId ? pair.agent_a : pair.agent_b,
      participants: descriptor.participants,
      scope: 'public-qa',
      duration_seconds: duration,
      max_messages: maxMessages,
      max_plaintext_chars: 2000,
      start_rule: 'first-recipient-delivery',
      receipt_grace_seconds: 300,
      created_at: at,
      expires_at: at + 1800,
    };
    const hash = await fingerprint(policy);
    try {
      await this.connection.batch([
        this.connection
          .prepare(
            "INSERT INTO conversations(id,pairing_id,initiator_agent_id,status,policy_json,policy_hash,duration_seconds,max_messages,created_at,expires_at) VALUES(?,?,?,'awaiting_approval',?,?,?,?,?,?)",
          )
          .bind(
            id,
            pair.id,
            policy.initiator_agent_id,
            canonical(policy),
            hash,
            duration,
            maxMessages,
            at,
            policy.expires_at,
          ),
        this.connection
          .prepare('INSERT INTO readiness(conversation_id,agent_id,nonce) VALUES(?,?,?),(?,?,?)')
          .bind(id, pair.agent_a, randomToken(), id, pair.agent_b, randomToken()),
        audit(
          this.connection,
          'conversation_proposed',
          id,
          { owner: ownerId },
          { policy_hash: hash, duration_seconds: duration, max_messages: maxMessages },
          at,
        ),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: conversations.pairing_id/.test(error.message)
      )
        throw new HubError('conversation_already_open', 409, '这对 Agent 已有未结束的会话');
      throw error;
    }
    return this.conversationView(await this.conversation(id, ownerId));
  }

  async approveConversation(ownerId: string, id: string, signature: string) {
    const c = await this.conversation(id, ownerId),
      p = await this.pair(c.pairing_id, ownerId),
      u = await this.user(ownerId);
    ensure(
      p.status === 'active' &&
        c.expires_at > this.now() &&
        ['awaiting_approval', 'authorized', 'ready', 'active'].includes(c.status),
      'conversation_not_approvable',
      409,
      '会话已过期、撤销或不再等待授权',
    );
    ensure(
      await verifySignature(u.signing_key, asJson(c.policy_json), signature),
      'invalid_owner_signature',
      403,
      '会话授权签名无效',
    );
    const field = p.owner_a === ownerId ? 'approval_a_json' : 'approval_b_json',
      approval = canonical({ owner_id: ownerId, signature });
    await this.connection.batch([
      this.connection
        .prepare(
          `UPDATE conversations SET ${field}=? WHERE id=? AND status='awaiting_approval' AND ${field} IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM pairings WHERE id=? AND status='active')`,
        )
        .bind(approval, id, this.now(), p.id),
      this.connection
        .prepare(
          "UPDATE conversations SET status='authorized' WHERE id=? AND status='awaiting_approval' AND approval_a_json IS NOT NULL AND approval_b_json IS NOT NULL",
        )
        .bind(id),
      this.conditionalEvent(
        'owner_approved_conversation',
        id,
        { owner: ownerId },
        `EXISTS(SELECT 1 FROM conversations WHERE id=? AND ${field}=?)`,
        [id, approval],
        { policy_hash: c.policy_hash },
        `grant-approved:${id}:${ownerId}`,
      ),
    ]);
    const after = await this.conversation(id, ownerId);
    ensure(
      after[field] === approval && !this.conversationView(after).conversation_closed,
      'approval_conflict',
      409,
      '会话授权状态已变化',
    );
    return this.conversationView(after);
  }

  async preflight(
    agentId: string,
    id: string,
    signature: string,
    nativeContext: Record<string, string>,
  ) {
    const a = await this.activeAgent(agentId),
      c = await this.conversation(id, undefined, agentId),
      p = await this.pair(c.pairing_id, undefined, agentId);
    ensure(
      p.status === 'active' &&
        ['authorized', 'ready', 'active'].includes(c.status) &&
        !this.conversationView(c).conversation_closed,
      'conversation_not_authorized',
      403,
      '会话尚未获双方授权或已经结束',
    );
    const r = await this.connection
      .prepare('SELECT nonce FROM readiness WHERE conversation_id=? AND agent_id=?')
      .bind(id, agentId)
      .first<{ nonce: string }>();
    ensure(r && a.signing_key, 'preflight_unavailable', 409, '无法取得预检挑战');
    const payload = {
      v: PROTOCOL_VERSION,
      kind: 'session-preflight',
      conversation_id: id,
      agent_id: agentId,
      grant_hash: c.policy_hash,
      nonce: r.nonce,
    };
    ensure(
      await verifySignature(a.signing_key, payload, signature),
      'invalid_signature',
      403,
      '预检签名无效',
    );
    const readinessUpdate = await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE readiness SET proof_json=?,native_context_json=?,ready_at=COALESCE(ready_at,?),cleanup_status='required' WHERE conversation_id=? AND agent_id=? AND EXISTS(SELECT 1 FROM conversations WHERE id=? AND status IN ('authorized','ready','active') AND expires_at>? AND (deadline IS NULL OR deadline>?))",
        )
        .bind(
          canonical({ payload, signature }),
          canonical(nativeContext),
          this.now(),
          id,
          agentId,
          id,
          this.now(),
          this.now(),
        ),
      this.connection
        .prepare(
          "UPDATE conversations SET status='ready' WHERE id=? AND status='authorized' AND (SELECT COUNT(*) FROM readiness WHERE conversation_id=? AND ready_at IS NOT NULL)=2",
        )
        .bind(id, id),
      this.conditionalEvent(
        'agent_preflight_passed',
        id,
        { agent: agentId },
        'EXISTS(SELECT 1 FROM readiness WHERE conversation_id=? AND agent_id=? AND ready_at IS NOT NULL)',
        [id, agentId],
        {},
        `ready:${id}:${agentId}`,
      ),
    ]);
    ensure(
      readinessUpdate[0].meta.changes === 1,
      'preflight_state_conflict',
      409,
      '预检期间会话状态已变化',
    );
    return this.conversationView(await this.conversation(id, undefined, agentId));
  }

  async closeConversation(
    id: string,
    actor: { owner?: string; agent?: string },
    reason: 'owner-ended' | 'owner-declined' | 'agent-ended' = 'owner-ended',
  ) {
    await this.conversation(id, actor.owner, actor.agent);
    await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE conversations SET status='closed',closed_at=?,close_reason=? WHERE id=? AND status NOT IN ('closed','revoked','expired')",
        )
        .bind(this.now(), reason, id),
      audit(this.connection, 'conversation_closed', id, actor, { reason }, this.now()),
    ]);
    return this.conversationView(await this.conversation(id, actor.owner, actor.agent));
  }

  async revokeAgent(ownerId: string, id: string) {
    await this.agent(id, ownerId);
    await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE agents SET status='revoked',revoked_at=?,updated_at=?,auth_version=auth_version+1 WHERE id=? AND owner_id=? AND status<>'revoked'",
        )
        .bind(this.now(), this.now(), id, ownerId),
      this.connection
        .prepare(
          "UPDATE pairings SET status='revoked',revoked_at=? WHERE (agent_a=? OR agent_b=?) AND status<>'revoked'",
        )
        .bind(this.now(), id, id),
      this.connection
        .prepare(
          "UPDATE conversations SET status='revoked',closed_at=?,close_reason='agent-revoked' WHERE pairing_id IN (SELECT id FROM pairings WHERE agent_a=? OR agent_b=?) AND status<>'revoked'",
        )
        .bind(this.now(), id, id),
      audit(
        this.connection,
        'agent_revoked',
        id,
        { owner: ownerId },
        {},
        this.now(),
        `revoked:${id}`,
      ),
    ]);
    return { ok: true };
  }

  async revokePairing(ownerId: string, id: string) {
    await this.pair(id, ownerId);
    await this.connection.batch([
      this.connection
        .prepare(
          "UPDATE pairings SET status='revoked',revoked_at=? WHERE id=? AND status<>'revoked'",
        )
        .bind(this.now(), id),
      this.connection
        .prepare(
          "UPDATE conversations SET status='revoked',closed_at=?,close_reason='pairing-revoked' WHERE pairing_id=? AND status<>'revoked'",
        )
        .bind(this.now(), id),
      audit(
        this.connection,
        'pairing_revoked',
        id,
        { owner: ownerId },
        {},
        this.now(),
        `pair-revoked:${id}`,
      ),
    ]);
    return { ok: true };
  }

  async dashboard(ownerId: string) {
    const agents = await this.connection
      .prepare('SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC')
      .bind(ownerId)
      .all<AgentRow>();
    const pairs = await this.connection
      .prepare('SELECT * FROM pairings WHERE owner_a=? OR owner_b=? ORDER BY created_at DESC')
      .bind(ownerId, ownerId)
      .all<PairRow>();
    const conversations = await this.connection
      .prepare(
        'SELECT c.* FROM conversations c JOIN pairings p ON p.id=c.pairing_id WHERE p.owner_a=? OR p.owner_b=? ORDER BY c.created_at DESC LIMIT 100',
      )
      .bind(ownerId, ownerId)
      .all<ConversationRow>();
    return {
      agents: agents.results,
      pairings: pairs.results.map((p) => this.pairView(p)),
      conversations: conversations.results.map((c) => this.conversationView(c)),
    };
  }

  async endpointState(agentId: string) {
    const a = await this.agent(agentId),
      u = await this.user(a.owner_id);
    ensure(a.status !== 'revoked', 'agent_revoked', 403, '连接已撤销');
    const pairs = await this.connection
      .prepare(
        "SELECT * FROM pairings WHERE (agent_a=? OR agent_b=?) AND status IN ('awaiting_endpoints','active')",
      )
      .bind(agentId, agentId)
      .all<PairRow>();
    const sessions = await this.connection
      .prepare(
        `SELECT c.* FROM conversations c JOIN pairings p ON p.id=c.pairing_id
      WHERE (p.agent_a=? OR p.agent_b=?) AND c.approval_a_json IS NOT NULL AND c.approval_b_json IS NOT NULL
      AND c.expires_at+300>? ORDER BY c.created_at DESC LIMIT 20`,
      )
      .bind(agentId, agentId, this.now())
      .all<ConversationRow>();
    const ready = await this.connection
      .prepare(
        'SELECT conversation_id,nonce,ready_at,cleanup_status FROM readiness WHERE agent_id=?',
      )
      .bind(agentId)
      .all();
    return {
      agent_id: a.id,
      owner_id: u.id,
      owner_key: u.signing_key,
      platform: a.platform,
      status: a.status,
      keys: a.signing_key ? { age: a.age_key, sign: a.signing_key } : null,
      claim_certificate: a.claim_json ? asJson(a.claim_json) : null,
      pairings: pairs.results.map((p) => this.pairView(p)),
      conversations: sessions.results.map((c) => this.conversationView(c)),
      readiness: ready.results,
    };
  }

  async reportCleanup(agentId: string, id: string, proof: Signed<Record<string, unknown>>) {
    const a = await this.agent(agentId),
      c = await this.conversation(id, undefined, agentId);
    ensure(
      a.signing_key && this.conversationView(c).conversation_closed,
      'cleanup_not_due',
      409,
      '会话尚未结束',
    );
    ensure(
      proof.payload.v === PROTOCOL_VERSION &&
        proof.payload.kind === 'session-cleanup' &&
        proof.payload.agent_id === agentId &&
        proof.payload.conversation_id === id &&
        ['complete', 'failed'].includes(String(proof.payload.result)) &&
        typeof proof.payload.task_reference === 'string' &&
        String(proof.payload.task_reference).length <= 200 &&
        Object.keys(proof.payload).sort().join(',') ===
          ['v', 'kind', 'agent_id', 'conversation_id', 'result', 'task_reference'].sort().join(','),
      'invalid_cleanup_report',
      400,
      '清理回执格式不正确',
    );
    ensure(
      await verifySignature(a.signing_key, proof.payload, proof.signature),
      'invalid_signature',
      403,
      '清理回执签名无效',
    );
    await this.connection.batch([
      this.connection
        .prepare(
          'UPDATE readiness SET cleanup_status=?,cleanup_proof_json=? WHERE conversation_id=? AND agent_id=?',
        )
        .bind(
          proof.payload.result === 'complete' ? 'reported_complete' : 'failed',
          canonical(proof),
          id,
          agentId,
        ),
      audit(
        this.connection,
        'native_cleanup_reported',
        id,
        { agent: agentId },
        { result: String(proof.payload.result), evidence: 'agent-signed-report' },
        this.now(),
      ),
    ]);
    return {
      status: 'recorded',
      evidence: 'agent-signed-report',
      note: 'This is the endpoint report, not independent attestation by the native platform.',
    };
  }

  private conditionalEvent(
    type: string,
    id: string,
    actor: { owner?: string; agent?: string },
    condition: string,
    bindings: (string | number | null)[],
    metadata: Record<string, string | number | boolean | null>,
    eventId: string,
  ) {
    return this.connection
      .prepare(
        `INSERT OR IGNORE INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${condition}`,
      )
      .bind(
        eventId,
        type,
        actor.owner ?? null,
        actor.agent ?? null,
        id,
        canonical(metadata),
        this.now(),
        ...bindings,
      );
  }
}
