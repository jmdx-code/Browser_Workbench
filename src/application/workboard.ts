export type CarrierKind = 'browser' | 'bluestacks';

export class WorkAbortError extends Error {
  constructor(
    public readonly reason: string,
    message = reason,
  ) {
    super(message);
    this.name = 'WorkAbortError';
  }
}

const abortReason = (signal: AbortSignal | undefined, fallback = 'USER_STOP'): string =>
  typeof signal?.reason === 'string' && signal.reason ? signal.reason : fallback;

export const isWorkAbortError = (error: unknown): boolean =>
  error instanceof WorkAbortError || (error instanceof Error && error.name === 'AbortError');

export function throwIfAborted(signal: AbortSignal | undefined, fallback = 'USER_STOP'): void {
  if (signal?.aborted) throw new WorkAbortError(abortReason(signal, fallback));
}

export async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WorkAbortError(abortReason(signal)));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Semaphore {
  private limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(initialLimit: number) {
    this.limit = Math.max(1, Math.floor(initialLimit));
  }
  get max(): number {
    return this.limit;
  }
  get used(): number {
    return this.active;
  }
  setLimit(next: number): void {
    const normalized = Math.max(1, Math.floor(next));
    if (normalized === this.limit) return;
    this.limit = normalized;
    this.pump();
  }
  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) this.waiters.shift()?.();
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = this.waiters.indexOf(wake);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new WorkAbortError(abortReason(signal)));
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      throwIfAborted(signal);
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.pump();
    };
  }
  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export interface SoldierHandle {
  readonly carrierId: string;
  readonly carrierKind: CarrierKind;
  readonly moduleId: string;
  readonly signal: AbortSignal;
  readonly abort: (reason?: string) => void;
  readonly stopReason: () => string | null;
}

interface ActiveSoldier {
  readonly carrierId: string;
  readonly carrierKind: CarrierKind;
  readonly moduleId: string;
  readonly controller: AbortController;
  stopReasonValue: string | null;
}

export class WorkPool<Item> {
  private readonly queue: Item[];
  private readonly seenKeys = new Set<string>();
  private completed = 0;

  constructor(
    items: readonly Item[],
    private readonly keyOf?: (item: Item) => string,
  ) {
    this.queue = [...items];
  }
  claimNext(predicate?: (item: Item) => boolean): Item | undefined {
    for (let i = 0; i < this.queue.length; i += 1) {
      const candidate = this.queue[i];
      if (candidate === undefined || (predicate && !predicate(candidate))) continue;
      this.queue.splice(i, 1);
      if (this.keyOf) this.seenKeys.add(this.keyOf(candidate));
      return candidate;
    }
    return undefined;
  }
  requeue(item: Item, front = false): void {
    const key = this.keyOf?.(item);
    if (key) this.seenKeys.delete(key);
    if (front) this.queue.unshift(item);
    else this.queue.push(item);
  }
  markDone() {
    this.completed += 1;
  }
  remainingCount() {
    return this.queue.length;
  }
  completedCount() {
    return this.completed;
  }
  hasSeenKey(key: string) {
    return this.seenKeys.has(key);
  }
}

function abortSoldierRecord(soldier: ActiveSoldier, reason: string): void {
  if (soldier.stopReasonValue === null) soldier.stopReasonValue = reason;
  if (!soldier.controller.signal.aborted) soldier.controller.abort(reason);
}

export class Workboard {
  readonly browserPermits: Semaphore;
  readonly bluestacksPermits: Semaphore;
  readonly launchPermits: Semaphore;
  private readonly soldiers = new Map<string, ActiveSoldier>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  constructor(options?: {
    browserConcurrency?: number;
    bluestacksConcurrency?: number;
    launchConcurrency?: number;
  }) {
    this.browserPermits = new Semaphore(options?.browserConcurrency ?? 2);
    this.bluestacksPermits = new Semaphore(options?.bluestacksConcurrency ?? 2);
    this.launchPermits = new Semaphore(options?.launchConcurrency ?? 4);
  }
  isCarrierBusy(carrierId: string) {
    return this.soldiers.has(carrierId);
  }
  carrierModule(carrierId: string) {
    return this.soldiers.get(carrierId)?.moduleId ?? null;
  }
  isModuleActive(moduleId: string): boolean {
    for (const s of this.soldiers.values()) if (s.moduleId === moduleId) return true;
    return false;
  }
  busyCarrierIds(moduleId?: string): string[] {
    return [...this.soldiers.values()]
      .filter((s) => !moduleId || s.moduleId === moduleId)
      .map((s) => s.carrierId);
  }
  hasAnyActive() {
    return this.soldiers.size > 0;
  }

  async runSoldier<T>(
    options: { carrierId: string; carrierKind: CarrierKind; moduleId: string },
    work: (soldier: SoldierHandle) => Promise<T>,
  ): Promise<T> {
    if (this.soldiers.has(options.carrierId)) throw Error(`SOLDIER_BUSY:${options.carrierId}`);
    const controller = new AbortController();
    const record: ActiveSoldier = { ...options, controller, stopReasonValue: null };
    this.soldiers.set(options.carrierId, record);
    try {
      return await work({
        ...options,
        signal: controller.signal,
        abort: (reason = 'USER_STOP') => abortSoldierRecord(record, reason),
        stopReason: () => record.stopReasonValue,
      });
    } finally {
      if (this.soldiers.get(options.carrierId) === record) this.soldiers.delete(options.carrierId);
      const waiters = this.idleWaiters.get(options.carrierId);
      if (waiters) {
        this.idleWaiters.delete(options.carrierId);
        for (const notify of waiters) notify();
      }
    }
  }

  abortCarrier(carrierId: string, reason = 'USER_STOP'): boolean {
    const soldier = this.soldiers.get(carrierId);
    if (!soldier) return false;
    abortSoldierRecord(soldier, reason);
    return true;
  }

  private abortWhere(match: (s: ActiveSoldier) => boolean, reason: string): number {
    let count = 0;
    for (const s of this.soldiers.values()) {
      if (match(s)) {
        abortSoldierRecord(s, reason);
        count++;
      }
    }
    return count;
  }

  abortModule(moduleId: string, reason = 'USER_STOP'): number {
    return this.abortWhere((s) => s.moduleId === moduleId, reason);
  }

  abortAll(reason = 'SHUTDOWN'): number {
    return this.abortWhere(() => true, reason);
  }

  async waitUntilCarrierIdle(carrierId: string, timeoutMs = 8_000): Promise<void> {
    if (!this.soldiers.has(carrierId)) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const set = this.idleWaiters.get(carrierId);
        set?.delete(done);
        if (set && !set.size) this.idleWaiters.delete(carrierId);
        resolve();
      };
      const timer = setTimeout(done, Math.max(50, timeoutMs));
      timer.unref?.();
      let set = this.idleWaiters.get(carrierId);
      if (!set) {
        set = new Set();
        this.idleWaiters.set(carrierId, set);
      }
      set.add(done);
    });
  }

  async waitUntilModuleIdle(moduleId: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + Math.max(50, timeoutMs);
    for (const id of this.busyCarrierIds(moduleId)) {
      const rem = deadline - Date.now();
      if (rem <= 0) break;
      await this.waitUntilCarrierIdle(id, rem);
    }
  }

  createPool<Item>(items: readonly Item[], keyOf?: (item: Item) => string): WorkPool<Item> {
    return new WorkPool(items, keyOf);
  }
}
