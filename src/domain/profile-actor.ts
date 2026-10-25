import type { Awaitable } from './persistence.js';
import type { RuntimeProfile, TaskBrowserPort } from './tasks.js';
import type { SettlementPort } from './settlement.js';
import type { KernelState, TabProof } from '../shared/kernel-state.js';
import type { ExecutionSession, Binding, ExecutionReceipt } from '../shared/task-execution.js';
import type { Operation } from '../shared/task-contracts.js';
import type { StopBinding, StopReceipt } from '../shared/task-control.js';

export interface ProfileActorSession extends SettlementPort {
  profile(): Awaitable<RuntimeProfile>;
  current(): Awaitable<ExecutionSession | null>;
  inventory(): Promise<KernelState>;
}
// The native adapter must call assertCurrent for every input/file command, after async SDK waits.
export interface GuardedBrowserPort extends TaskBrowserPort {
  profile?(profileId: string): Awaitable<RuntimeProfile | undefined>;
  sendGuarded(
    operation: Operation & { binding: Binding },
    assertCurrent: () => Awaitable<void>,
  ): Promise<ExecutionReceipt>;
}
// One already authenticated SDK/transport owner. Stop must cancel its waits and match native receipt.
export interface ManagedProfileSession extends ProfileActorSession {
  // Local fences must not wait for persistence. Metadata identifies the exact
  // already-owned plan; it does not grant permission for an input.
  ownedPlanId?(): string;
  revokeInput?(reason: string): void;
  confirmTaskTab?(proof: TabProof): Promise<void>;
  setFailureHandler(handler: (reason: string) => Promise<void>): Awaitable<void>;
  sendGuarded(
    operation: Operation & { binding: Binding },
    assertCurrent: () => Awaitable<void>,
  ): Promise<ExecutionReceipt>;
  stop(binding: StopBinding): Promise<StopReceipt>;
  // Explicit same-owner recovery only. Absence means this transport cannot safely retry.
  retryStop?(binding: StopBinding): Promise<StopReceipt>;
}
// Private admission and session construction; it never claims tasks or owns their lifecycle.
export interface QueuedProfileFactory {
  supportsControlRelease?(profileId: string): boolean;
  profile(profileId: string): Awaitable<RuntimeProfile | null>;
  observeQueued(planId: string): Promise<RuntimeProfile>;
  openClaimed(planId: string): Promise<ManagedProfileSession>;
  forget(profileId: string): void | Promise<void>;
  close(): Promise<void>;
}
export type ProfileActorState =
  'BLOCKED' | 'OBSERVING' | 'READY' | 'DISPATCHING' | 'AWAITING_VERIFICATION';
