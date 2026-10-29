import { z } from 'zod';

export const PROTOCOL_VERSION = 'agent-hub/1' as const;
export const platformSchema = z.enum(['dot', 'muse']);
export const idSchema = z.uuid();
export const keySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const publicKeysSchema = z
  .object({
    age: z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),
    sign: keySchema,
  })
  .strict();

export const enrollmentPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal('endpoint-registration'),
    agent_id: idSchema,
    owner_id: idSchema,
    owner_key: keySchema,
    nonce: keySchema,
    keys: publicKeysSchema,
  })
  .strict();
export const enrollmentSchema = z
  .object({ payload: enrollmentPayloadSchema, signature: signatureSchema })
  .strict();

export const messagePayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal('encrypted-message'),
    id: idSchema,
    conversation_id: idSchema,
    grant_hash: hashSchema,
    from: idSchema,
    to: idSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expires_at: timestampSchema,
    reply_to: idSchema.nullable(),
    ciphertext: z
      .string()
      .min(150)
      .max(48_000)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export const messageEnvelopeSchema = z
  .object({ payload: messagePayloadSchema, signature: signatureSchema })
  .strict();
export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type Enrollment = z.infer<typeof enrollmentSchema>;
export type Platform = z.infer<typeof platformSchema>;

export interface Participant {
  owner_id: string;
  owner_name: string;
  owner_key: string;
  agent_id: string;
  agent_name: string;
  platform: Platform;
  keys: { age: string; sign: string };
  generation: number;
  fingerprint: string;
}

export interface PairDescriptor {
  v: typeof PROTOCOL_VERSION;
  kind: 'pairing';
  id: string;
  nonce: string;
  participants: [Participant, Participant];
  expires_at: number;
}

export interface ConversationPolicy {
  v: typeof PROTOCOL_VERSION;
  kind: 'conversation-grant';
  id: string;
  pairing_id: string;
  pairing_hash: string;
  nonce: string;
  initiator_agent_id: string;
  participants: [Participant, Participant];
  scope: 'public-qa';
  duration_seconds: number;
  max_messages: number;
  max_plaintext_chars: number;
  start_rule: 'first-recipient-delivery';
  receipt_grace_seconds: 300;
  expires_at: number;
  created_at: number;
}

export interface Signed<T> {
  payload: T;
  signature: string;
}

export interface ClaimPayload {
  v: typeof PROTOCOL_VERSION;
  kind: 'owner-claim';
  agent_id: string;
  owner_id: string;
  owner_key: string;
  endpoint_keys: { age: string; sign: string };
  registration_nonce: string;
  fingerprint: string;
  generation: number;
}

export const scopes = {
  read: 'agent:read',
  enroll: 'agent:enroll',
  message: 'agent:message',
} as const;

export const participantSchema = z
  .object({
    owner_id: idSchema,
    owner_name: z.string().min(1).max(60),
    owner_key: keySchema,
    agent_id: idSchema,
    agent_name: z.string().min(1).max(60),
    platform: platformSchema,
    keys: publicKeysSchema,
    generation: z.number().int().positive(),
    fingerprint: hashSchema,
  })
  .strict();
export const claimPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal('owner-claim'),
    agent_id: idSchema,
    owner_id: idSchema,
    owner_key: keySchema,
    endpoint_keys: publicKeysSchema,
    registration_nonce: keySchema,
    fingerprint: hashSchema,
    generation: z.number().int().positive(),
  })
  .strict();
export const pairDescriptorSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal('pairing'),
    id: idSchema,
    nonce: keySchema,
    participants: z.tuple([participantSchema, participantSchema]),
    expires_at: timestampSchema,
  })
  .strict();
export const conversationPolicySchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal('conversation-grant'),
    id: idSchema,
    pairing_id: idSchema,
    pairing_hash: hashSchema,
    nonce: keySchema,
    initiator_agent_id: idSchema,
    participants: z.tuple([participantSchema, participantSchema]),
    scope: z.literal('public-qa'),
    duration_seconds: z.number().int().min(60).max(600),
    max_messages: z.number().int().min(2).max(64),
    max_plaintext_chars: z.literal(2000),
    start_rule: z.literal('first-recipient-delivery'),
    receipt_grace_seconds: z.literal(300),
    created_at: timestampSchema,
    expires_at: timestampSchema,
  })
  .strict();
