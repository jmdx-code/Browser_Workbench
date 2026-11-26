import {
  kernelRequiresOperation,
  kernelFacebookReadURL,
  type KernelAccess,
} from '../shared/kernel-policy.js';
import { validateProjection, type PageProjectionRequest } from '../shared/page-read.js';
import type { Awaitable } from '../domain/persistence.js';
import type { KernelTarget, KernelJsonObject } from '../shared/kernel-protocol.js';

export interface NativeInputCommand {
  target: KernelTarget;
  method: string;
  params: KernelJsonObject;
}
export type NativeInputGuard = (command: NativeInputCommand) => Promise<void>;

// Every SDK Input/file command passes here after asynchronous SDK waits and before transport send.
export async function guardNativeInput(
  command: NativeInputCommand,
  assertCurrent: () => Awaitable<void>,
  inspectResources?: NativeInputGuard,
  access: KernelAccess = 'fixture',
): Promise<NativeInputCommand> {
  const original = structuredClone(command);
  if (!kernelRequiresOperation(original.method, access)) return original;
  await assertCurrent();
  if (inspectResources) {
    const inspected = structuredClone(original);
    await inspectResources(inspected);
    if (JSON.stringify(inspected) !== JSON.stringify(original))
      throw Error('NATIVE_INPUT_GUARD_MUTATED_COMMAND');
  }
  await assertCurrent();
  return original;
}

function pruneOlderThan(
  map: Map<string, number>,
  now: number,
  maxAgeMs: number,
  inclusive = true,
): void {
  for (const [id, at] of map)
    if (inclusive ? now - at >= maxAgeMs : now - at > maxAgeMs) map.delete(id);
}

export class PresentationFocusGate {
  private nextAt = 0;
  private readonly waiting = new Map<string, number>();
  private readonly recovered = new Map<string, number>();

  constructor(
    private readonly globalGap = 1500,
    private readonly profileGap = 15000,
  ) {}

  cancel(key: string) {
    this.waiting.delete(key);
  }

  request(key: string, now: number): boolean {
    pruneOlderThan(this.waiting, now, 10000, false);
    pruneOlderThan(this.recovered, now, 60000, true);
    if (now - (this.recovered.get(key) ?? -Infinity) < this.profileGap) return false;
    if (!this.waiting.has(key) && this.waiting.size >= 100) return false;
    this.waiting.set(key, now);
    if (now < this.nextAt || this.waiting.keys().next().value !== key) return false;
    this.waiting.delete(key);
    this.recovered.set(key, now);
    this.nextAt = now + this.globalGap;
    return true;
  }
}

export class PositionRecoveryGate {
  private readonly recovered = new Map<string, number>();

  request(key: string, now: number): boolean {
    pruneOlderThan(this.recovered, now, 60000, true);
    if (now - (this.recovered.get(key) ?? -Infinity) < 2000) return false;
    if (!this.recovered.has(key) && this.recovered.size >= 100) return false;
    this.recovered.set(key, now);
    return true;
  }

  cancel(key: string) {
    this.recovered.delete(key);
  }
}

export interface PageReadSamplingPort {
  assertCurrent(): Awaitable<void>;
  read(): Promise<unknown>;
  wait(): Promise<void>;
}

// Reads may be sampled during an initial navigation; no action is retried or dispatched here.
export async function sampleFacebookPage(
  request: PageProjectionRequest,
  port: PageReadSamplingPort,
) {
  for (let attempt = 0; attempt < 16; attempt++) {
    await port.assertCurrent();
    try {
      const page = validateProjection(request, await port.read());
      await port.assertCurrent();
      if (!kernelFacebookReadURL(page.url)) throw Error('PAGE_READ_FOREIGN_DOCUMENT');
      if (page.ready === 'complete' && page.rows.some((row) => row.nodes.length)) return page;
      if (attempt === 15) return page;
    } catch (error) {
      await port.assertCurrent();
      if (
        !(error instanceof Error) ||
        !['KERNEL_SCOPE_CHANGED', 'KERNEL_INITIAL_DOCUMENT_PENDING'].includes(error.message) ||
        attempt === 15
      ) {
        throw error;
      }
    }
    await port.wait();
    await port.assertCurrent();
  }
  throw Error('PAGE_READ_EXHAUSTED');
}

type Pong = {
  type: 'PONG';
  connectionEpoch: string;
  windowCount?: number;
  profileWindowFocused?: boolean;
  lastFocusedAt?: number;
};

export class ProfileHeartbeat {
  private observing = false;

  constructor(
    private readonly current: () => boolean,
    private readonly epoch: () => string,
    private readonly send: (message: Pong) => void,
    private readonly windows: () => Promise<readonly { focused?: boolean }[]>,
    private readonly onObservation?: (focused: boolean) => number | undefined,
  ) {}

  pulse(): void {
    if (!this.current()) return;
    const epoch = this.epoch();
    if (!epoch) return;
    this.send({ type: 'PONG', connectionEpoch: epoch });
    if (this.observing) return;
    this.observing = true;
    const valid = () => this.current() && this.epoch() === epoch;
    void Promise.resolve()
      .then(() => this.windows())
      .then(
        (windows) => {
          if (!valid()) return;
          const profileWindowFocused = windows.some((window) => window.focused);
          const lastFocusedAt = this.onObservation?.(profileWindowFocused);
          this.send({
            type: 'PONG',
            connectionEpoch: epoch,
            windowCount: windows.length,
            profileWindowFocused,
            ...(typeof lastFocusedAt === 'number' && lastFocusedAt > 0 ? { lastFocusedAt } : {}),
          });
        },
        () => {
          if (valid())
            this.send({ type: 'PONG', connectionEpoch: epoch, profileWindowFocused: false });
        },
      )
      .catch(() => {})
      .finally(() => {
        this.observing = false;
      });
  }
}

// Bounded FIFO for expensive phases. A permit never grants account or input authority.
export class AsyncWorkBudget {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly limit: number,
    private readonly capacity: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(capacity) || capacity < 1)
      throw Error('WORK_BUDGET_INVALID');
  }

  run<T>(guard: () => Awaitable<void>, work: () => Promise<T>): Promise<T> {
    if (this.waiting.length >= this.capacity)
      return Promise.reject(Error('HEAVY_PHASE_QUEUE_FULL'));
    const admission = Promise.resolve().then(guard);
    void admission.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        void admission
          .then(guard)
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift();
      if (!next) break;
      this.active++;
      next();
    }
  }

  status() {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }
}
