import { KernelJournal, type KernelStateStorage } from '../src/application/kernel-journal.js';
import type { KernelState } from '../src/shared/kernel-state.js';
class MemoryKernelStorage implements KernelStateStorage {
  private state: KernelState | undefined;
  async read(): Promise<unknown> {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }
  async write(state: KernelState): Promise<void> {
    this.state = structuredClone(state);
  }
}
export const kernelJournal = new KernelJournal(new MemoryKernelStorage());
export async function initializeKernelJournal(profileId: string): Promise<string> {
  const key = 'workbenchKernelBrowserSession';
  const sessionApi = typeof chrome !== 'undefined' ? chrome?.storage?.session : undefined;
  const current: unknown = sessionApi ? (await sessionApi.get(key))[key] : undefined;
  const browserSessionEpoch = typeof current === 'string' ? current : crypto.randomUUID();
  if (sessionApi && typeof current !== 'string')
    await sessionApi.set({ [key]: browserSessionEpoch });
  await kernelJournal.initialize(profileId, browserSessionEpoch);
  return browserSessionEpoch;
}
