import { z } from 'zod';

export const idSchema = z.uuid();
export const platformSchema = z.enum(['dot', 'muse', 'duet']);
export type Platform = z.infer<typeof platformSchema>;
export const platformNames: Record<Platform, string> = { dot: 'Dot', muse: 'Muse', duet: 'Duet' };

export const scopes = { read: 'agent:read', message: 'agent:message' } as const;

export const MAX_TEXT = 4000;
export const textSchema = z.string().trim().min(1).max(MAX_TEXT);
export const idempotencySchema = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9:_-]+$/);
export const displayNameSchema = z.string().trim().min(1).max(60);

export const inboxInput = z
  .object({
    chat_id: idSchema.optional(),
    after_seq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .refine((v) => (v.chat_id === undefined) === (v.after_seq === undefined), {
    message: 'chat_id and after_seq are used together for history',
  });
export const sendInput = z
  .object({
    chat_id: idSchema,
    text: textSchema,
    reply_to: idSchema.optional(),
    idempotency_key: idempotencySchema,
  })
  .strict();
