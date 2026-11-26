import { z } from 'zod';
import { Id, NonNegInt, PosInt, sMax, strictObj } from './contracts.js';
const failures: Record<string, string> = {
  NETWORK_UNAVAILABLE: '无法建立本机连接，请检查本机端口或浏览器网络提示',
  AUTH_TIMEOUT: '连接已到达软件，但认证握手超时',
  AUTH_OR_PROTOCOL_REJECTED: '软件拒绝了认证或协议，请保留资料编号供核对',
  PROTOCOL_REJECTED: '插件拒绝了软件返回的协议消息',
  CONNECTION_CLOSED: '本机连接已断开，插件将尝试重连',
};
export function bridgeConnectionDescription(stage: string, failure: string) {
  if (stage === 'ready') return '';
  const prev = Object.hasOwn(failures, failure) ? failures[failure] : undefined;
  if (prev && ['connecting', 'authenticating'].includes(stage)) return prev + '；正在重连';
  if (stage === 'restoring') return '软件握手已通过，正在确认原控制已停止';
  if (stage === 'authenticating') return '已到达本机软件，正在认证';
  if (stage === 'connecting') return '正在连接本机端口18767';
  return prev ?? '尚未连接本机软件';
}
export const bridgeTransportDescription = (connected: boolean, stage: string, failure: string) =>
  connected && stage === 'ready'
    ? '软件已连接 · 通道就绪'
    : bridgeConnectionDescription(stage === 'ready' ? 'disconnected' : stage, failure);
export function heartbeatLeaseDeadline(
  value: unknown,
  epoch: string,
  now: number,
  maximumLease: number,
): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    v.type !== 'HEARTBEAT' ||
    !epoch ||
    v.connectionEpoch !== epoch ||
    typeof v.leaseMs !== 'number' ||
    !Number.isSafeInteger(v.leaseMs) ||
    v.leaseMs <= 0 ||
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isSafeInteger(maximumLease) ||
    maximumLease <= 0
  )
    return null;
  return now + Math.min(v.leaseMs, maximumLease);
}
export const BridgeConnectionHealth = strictObj({
  failures: z
    .array(
      strictObj({
        profileId: Id.nullable(),
        code: sMax(80),
        fields: z.array(sMax(160)).max(8),
        at: NonNegInt,
        count: PosInt,
      }),
    )
    .max(32),
  pending: z.array(strictObj({ id: Id, profileId: Id, expiresAt: NonNegInt })).max(32),
});
export type ConnectionHealth = z.infer<typeof BridgeConnectionHealth>;
export const BridgeConnectionRecoveryResult = strictObj({
  requested: z.literal(true),
  profileId: Id,
});
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
export const bridgeHealthDescription = (code: string) =>
  (Object.hasOwn(descriptions, code) ? descriptions[code] : undefined) ?? '连接协议未通过';
