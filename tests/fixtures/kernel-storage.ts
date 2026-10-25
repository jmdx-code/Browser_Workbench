import type { KernelStateStorage } from '../../src/application/kernel-journal.js';
import type { KernelState } from '../../src/shared/kernel-state.js';

export class MemoryKernelStorage implements KernelStateStorage {
  value: unknown;
  fail = false;
  beforeWrite: (() => Promise<void>) | undefined;
  async read(): Promise<unknown> {
    return structuredClone(this.value);
  }
  async write(state: KernelState): Promise<void> {
    await this.beforeWrite?.();
    if (this.fail) throw Error('SIMULATED_STORAGE_FAILURE');
    this.value = structuredClone(state);
  }
}
