import { KernelJournal, type KernelStateStorage } from '../src/application/kernel-journal.js';
import type { KernelState } from '../src/shared/kernel-state.js';

const key = 'workbenchKernelStateV1';
class ChromeKernelStorage implements KernelStateStorage {
  async read(): Promise<unknown> {
    return (await chrome.storage.local.get(key))[key];
  }
  async write(state: KernelState): Promise<void> {
    await chrome.storage.local.set({ [key]: state });
  }
}
export const kernelJournal = new KernelJournal(new ChromeKernelStorage());
export async function initializeKernelJournal(profileId: string): Promise<string> {
  const key = 'workbenchKernelBrowserSession';
  const current: unknown = (await chrome.storage.session.get(key))[key];
  const browserSessionEpoch = typeof current === 'string' ? current : crypto.randomUUID();
  if (typeof current !== 'string') await chrome.storage.session.set({ [key]: browserSessionEpoch });
  await kernelJournal.initialize(profileId, browserSessionEpoch);
  return browserSessionEpoch;
}
