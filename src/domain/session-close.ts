import type { Awaitable } from './persistence.js';
export type NativeStopReceipt = { requestId: string; state: 'stopped' };
export interface SessionClosePort {
  closeLocal(): Promise<void>;
  // Optional same-owner recovery after its task page is independently confirmed closed.
  // This must recheck actual local cancellation; remote STOP alone cannot supply it.
  retryCloseLocal?(): Promise<void>;
  assertTransport(): Awaitable<void>;
  stopRemote(requestId: string): Promise<NativeStopReceipt>;
  release(): Awaitable<void>;
}
