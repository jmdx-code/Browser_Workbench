import { z } from 'zod';
import { Id, NonNegInt, PosInt, optBool, sMax, sReq, strictObj } from './contracts.js';
import type { PageProjection, PageProjectionRequest } from './page-read.js';
import type { NativeFacebookIdentityRead } from './facebook-native-identity.js';
export const MAX_PENDING_KERNEL_RPC = 128;
export const RESERVED_KERNEL_CONTROL_RPC = 16;
// Private SDK transport contract. It is deliberately absent from public HTTP/UI contracts.
export const KernelJsonObject = z.custom<Record<string, unknown>>(
  (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
);
export type KernelJsonObject = z.infer<typeof KernelJsonObject>;
export const KernelStamp = strictObj({
  profileId: Id,
  connectionEpoch: Id,
  leaseId: Id,
  generation: NonNegInt,
  expiresAt: PosInt,
});
export type KernelStamp = z.infer<typeof KernelStamp>;
export const KernelTarget = strictObj({ tabId: PosInt, sessionId: sMax(200).optional() });
export type KernelTarget = z.infer<typeof KernelTarget>;
export const KernelTargetInfo = z
  .object({
    targetId: sReq(200),
    type: z.enum(['page', 'iframe', 'worker', 'service_worker']),
    title: sMax(4096),
    url: sMax(4096),
    attached: z.boolean(),
    browserContextId: sMax(200).optional(),
    openerId: sMax(200).optional(),
    canAccessOpener: optBool,
  })
  .passthrough();
export type KernelTargetInfo = z.infer<typeof KernelTargetInfo>;
export const KernelCdpCommand = strictObj({
  id: PosInt.max(Number.MAX_SAFE_INTEGER),
  method: z
    .string()
    .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
    .max(160),
  sessionId: sReq(200).optional(),
  params: KernelJsonObject.optional(),
});
export type KernelCdpCommand = z.infer<typeof KernelCdpCommand>;
export type KernelCdpMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: KernelJsonObject;
  result?: KernelJsonObject;
  error?: { code: number; message: string };
};
export type KernelBackend = {
  // Private trusted transport only: send delegates to a native executor which freshly
  // checks scope and lease. Never serialized into a request or granted by a browser reply.
  readonly scopeEnforcedBySend?: true;
  scope(tabId: number): Promise<void>;
  // Cleanup may close an exact owned native target after its URL changed. It
  // grants no read/input scope and must still validate target identity and lease.
  scopeForClose?(tabId: number): Promise<void>;
  attach(tabId: number): Promise<KernelTargetInfo>;
  detach(tabId: number): Promise<void>;
  create(url: string, ownershipId?: string, foreground?: boolean): Promise<{ tabId: number }>;
  remove(tabId: number): Promise<void>;
  send(target: KernelTarget, method: string, params: KernelJsonObject): Promise<KernelJsonObject>;
  project?(tabId: number, request: PageProjectionRequest): Promise<PageProjection>;
  observeIdentity?(
    tabId: number,
    assertCurrent: () => void,
  ): Promise<NativeFacebookIdentityRead | null>;
};
