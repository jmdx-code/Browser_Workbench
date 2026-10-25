import { z } from 'zod';
import type { PageProjection, PageProjectionRequest } from './page-read.js';
import type { NativeFacebookIdentityRead } from './facebook-native-identity.js';

// Private SDK transport contract. It is deliberately absent from public HTTP/UI contracts.
export const KernelJsonObject = z.record(z.string(), z.json());
export type KernelJsonObject = z.infer<typeof KernelJsonObject>;
export const KernelStamp = z
  .object({
    profileId: z.string().uuid(),
    connectionEpoch: z.string().uuid(),
    leaseId: z.string().uuid(),
    generation: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type KernelStamp = z.infer<typeof KernelStamp>;
export const KernelTarget = z
  .object({ tabId: z.number().int().positive(), sessionId: z.string().max(200).optional() })
  .strict();
export type KernelTarget = z.infer<typeof KernelTarget>;
export const KernelTargetInfo = z
  .object({
    targetId: z.string().min(1).max(200),
    type: z.enum(['page', 'iframe', 'worker', 'service_worker']),
    title: z.string().max(4096),
    url: z.string().max(4096),
    attached: z.boolean(),
    browserContextId: z.string().max(200).optional(),
    openerId: z.string().max(200).optional(),
    canAccessOpener: z.boolean().optional(),
  })
  .passthrough();
export type KernelTargetInfo = z.infer<typeof KernelTargetInfo>;
export const KernelCdpCommand = z
  .object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    method: z
      .string()
      .regex(/^[A-Za-z]+\.[A-Za-z]+$/)
      .max(160),
    sessionId: z.string().min(1).max(200).optional(),
    params: KernelJsonObject.optional(),
  })
  .strict();
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
