import { z } from 'zod';

export const BridgeConnectionHealth = z
  .object({
    failures: z
      .array(
        z
          .object({
            profileId: z.uuid().nullable(),
            code: z.string().max(80),
            fields: z.array(z.string().max(160)).max(8),
            at: z.number().int().nonnegative(),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(32),
    pending: z
      .array(
        z
          .object({
            id: z.uuid(),
            profileId: z.uuid(),
            expiresAt: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type ConnectionHealth = z.infer<typeof BridgeConnectionHealth>;
export const BridgeConnectionRecoveryResult = z
  .object({
    requested: z.literal(true),
    profileId: z.uuid(),
  })
  .strict();
const descriptions: Record<string, string> = {
  AUTH_PROOF_MISMATCH: '本机连接凭据不一致',
  AUTH_PROOF_MISSING: '插件未提供连接凭据',
  AUTH_EXTENSION_MISMATCH: '插件身份与原登记不一致',
  AUTH_FAILED: '连接认证未通过',
  CAPABILITY_MISMATCH: '插件能力或版本不匹配',
  DUPLICATE_PROFILE: '同一资料已有在线连接',
  SCHEMA_REJECTED: '消息格式不匹配',
  EPOCH_REJECTED: '连接代次已失效',
  MESSAGE_REJECTED: '消息顺序不匹配',
};
export function bridgeHealthDescription(code: string) {
  return Object.hasOwn(descriptions, code)
    ? (descriptions[code] ?? '连接协议未通过')
    : '连接协议未通过';
}
