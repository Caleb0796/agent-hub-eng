import { fingerprint } from './crypto';
import {
  claimPayloadSchema,
  pairDescriptorSchema,
  conversationPolicySchema,
  PROTOCOL_VERSION,
} from './protocol';

export async function validateOwnerPayload(
  ownerId: string,
  ownerKey: string,
  input: unknown,
): Promise<void> {
  const kind =
    input && typeof input === 'object' ? ('kind' in input ? input.kind : undefined) : undefined;
  if (kind === 'owner-claim') {
    const p = claimPayloadSchema.parse(input);
    if (p.owner_id !== ownerId || p.owner_key !== ownerKey)
      throw new Error('认领内容不属于当前主人');
    const hash = await fingerprint({
      v: PROTOCOL_VERSION,
      agent_id: p.agent_id,
      owner_id: p.owner_id,
      owner_key: p.owner_key,
      keys: p.endpoint_keys,
      generation: p.generation,
    });
    if (hash !== p.fingerprint) throw new Error('认领安全码与端点公钥不一致');
    return;
  }
  const p =
    kind === 'pairing'
      ? pairDescriptorSchema.parse(input)
      : kind === 'conversation-grant'
        ? conversationPolicySchema.parse(input)
        : null;
  if (!p) throw new Error('不能签署未知用途的数据');
  if (
    p.participants[0].owner_id === p.participants[1].owner_id ||
    p.participants[0].agent_id === p.participants[1].agent_id ||
    p.participants.filter((x) => x.owner_id === ownerId && x.owner_key === ownerKey).length !== 1
  )
    throw new Error('授权必须包含当前主人与另一位独立主人');
  for (const participant of p.participants) {
    const hash = await fingerprint({
      v: PROTOCOL_VERSION,
      agent_id: participant.agent_id,
      owner_id: participant.owner_id,
      owner_key: participant.owner_key,
      keys: participant.keys,
      generation: participant.generation,
    });
    if (hash !== participant.fingerprint) throw new Error('参与者指纹与公钥不一致');
  }
  if (p.kind === 'conversation-grant') {
    if (
      p.expires_at <= p.created_at ||
      p.expires_at - p.created_at > 1800 ||
      !p.participants.some((x) => x.agent_id === p.initiator_agent_id)
    )
      throw new Error('会话有效期或发起对象无效');
  }
}
