type Target = { tabId: number; sessionId?: string };
type Send = (target: Target, method: string, params: Record<string, unknown>) => Promise<unknown>;

export class TabRenderingCapture {
  starting: Promise<void> = Promise.resolve();
  stopping = false;
  acks = 0;
  generation = 0;
  refreshing?: Promise<void>;
  releasing?: Promise<void>;
  maintaining?: Promise<void>;
  private disposed = false;
  private resolveDisposed!: () => void;
  readonly disposedSignal = new Promise<void>((resolve) => {
    this.resolveDisposed = resolve;
  });
  constructor(
    readonly tabId: number,
    readonly targetId: string,
  ) {}
  isDisposed(): boolean {
    return this.disposed;
  }
  dispose(): void {
    this.disposed = true;
    this.stopping = true;
    this.resolveDisposed();
  }
}

type Capture = TabRenderingCapture;

// A single scoped, tiny native stream. This does not guarantee that Chromium keeps
// occluded pages visible or rendering. Frames are acknowledged locally and discarded,
// never relayed or saved; visibility, focus, viewport and media state are unchanged.
export class TaskRendering {
  private readonly captures = new Map<number, Capture>();
  constructor(
    private readonly send: Send,
    private readonly windows?: { forgetTab?(tabId: number): void },
  ) {}
  async refresh(tabId: number, targetId: string, guard: () => void) {
    guard();
    const existing = this.captures.get(tabId);
    if (!existing) return this.ensure(tabId, targetId, guard);
    if (existing.targetId !== targetId || existing.stopping || existing.isDisposed())
      throw Error('TASK_RENDERING_SCOPE_CHANGED');
    // Join before ensure(): waiting for an existing restart and then restarting
    // again would turn concurrent callers into sequential duplicate refreshes.
    if (existing.refreshing) {
      await existing.refreshing;
      guard();
      if (existing.stopping || existing.isDisposed() || this.captures.get(tabId) !== existing)
        throw Error('TASK_RENDERING_REVOKED');
      return;
    }
    await this.ensure(tabId, targetId, guard);
    guard();
    if (this.captures.get(tabId) !== existing) throw Error('TASK_RENDERING_REVOKED');
    const capture = existing;
    // A main-document navigation or Windows occlusion can suspend a native stream
    // while its scoped entry still exists. Restart capture, never page visibility
    // or media state. STOP marks this capture before any asynchronous cleanup.
    if (capture.stopping || capture.isDisposed()) throw Error('TASK_RENDERING_REVOKED');
    if (!capture.refreshing) {
      capture.generation++;
      const restart = (async () => {
        if (capture.isDisposed() || capture.stopping || this.captures.get(tabId) !== capture)
          return;
        await this.send({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
        if (capture.isDisposed()) return;
        guard();
        if (capture.stopping || capture.isDisposed() || this.captures.get(tabId) !== capture)
          throw Error('TASK_RENDERING_REVOKED');
        await this.send({ tabId }, 'Emulation.setFocusEmulationEnabled', {
          enabled: true,
        });
        if (capture.isDisposed() || capture.stopping || this.captures.get(tabId) !== capture)
          return;
        await this.send({ tabId }, 'Page.setWebLifecycleState', { state: 'active' }).catch(
          () => {},
        );
      })();
      capture.refreshing = restart;
      capture.starting = restart; // STOP and ensure both drain the whole restart.
    }
    const refreshing = capture.refreshing;
    try {
      await refreshing;
      guard();
      if (capture.stopping || capture.isDisposed() || this.captures.get(tabId) !== capture)
        throw Error('TASK_RENDERING_REVOKED');
    } catch (error) {
      if (!capture.isDisposed() && this.captures.get(tabId) === capture)
        await this.cleanupFailure(capture);
      throw error;
    } finally {
      if (capture.refreshing === refreshing) capture.refreshing = undefined;
    }
  }
  private async cleanupFailure(capture: Capture) {
    if (capture.isDisposed()) return;
    const cleanup = this.release(capture.tabId).catch(() => false);
    // A maintenance callback can be the caller that just failed. release() drains
    // it, so awaiting that cleanup here would make the callback wait for itself.
    if (!capture.maintaining) await cleanup;
  }
  async ensure(tabId: number, targetId: string, guard: () => void) {
    guard();
    const current = this.captures.get(tabId);
    if (current) {
      if (current.targetId !== targetId || current.stopping || current.isDisposed())
        throw Error('TASK_RENDERING_SCOPE_CHANGED');
      await current.starting;
      guard();
      if (current.stopping || current.isDisposed() || this.captures.get(tabId) !== current)
        throw Error('TASK_RENDERING_REVOKED');
      return;
    }
    if (this.captures.size) throw Error('TASK_RENDERING_TARGET_LIMIT');
    const capture = new TabRenderingCapture(tabId, targetId);
    this.captures.set(tabId, capture);
    capture.starting = (async () => {
      if (capture.isDisposed() || capture.stopping || this.captures.get(tabId) !== capture) return;
      await this.send({ tabId }, 'Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      if (capture.isDisposed() || capture.stopping || this.captures.get(tabId) !== capture) return;
      await this.send({ tabId }, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    })();
    try {
      await capture.starting;
      guard();
      if (capture.stopping || capture.isDisposed() || this.captures.get(tabId) !== capture)
        throw Error('TASK_RENDERING_REVOKED');
    } catch (error) {
      // Starting may have reached Chromium even when its acknowledgement is lost.
      if (!capture.isDisposed() && this.captures.get(tabId) === capture)
        await this.cleanupFailure(capture);
      throw error;
    }
  }
  consume(source: Target, method: string, value: unknown, allowed: () => boolean) {
    if (method !== 'Page.screencastFrame' || source.sessionId) return false;
    const capture = this.captures.get(source.tabId);
    if (!capture) return false; // Do not consume an unrelated developer stream.
    if (capture.stopping || capture.isDisposed() || capture.refreshing) return true;
    let valid = false;
    try {
      valid = allowed();
    } catch {}
    if (!valid) {
      void this.release(source.tabId).catch(() => {});
      return true;
    }
    const sessionId =
      value && typeof value === 'object' && 'sessionId' in value ? value.sessionId : null;
    if (
      typeof sessionId !== 'number' ||
      !Number.isSafeInteger(sessionId) ||
      sessionId < 0 ||
      capture.acks >= 4
    ) {
      void this.release(source.tabId).catch(() => {});
      return true;
    }
    capture.acks++;
    const generation = capture.generation;
    void this.send({ tabId: source.tabId }, 'Page.screencastFrameAck', { sessionId })
      .catch(() => {
        if (
          !capture.isDisposed() &&
          this.captures.get(source.tabId) === capture &&
          capture.generation === generation
        )
          void this.release(source.tabId).catch(() => {});
      })
      .finally(() => capture.acks--);
    return true;
  }
  maintain(work: (tabId: number, targetId: string, guard: () => void) => Promise<void>) {
    for (const capture of this.captures.values()) {
      if (capture.stopping || capture.isDisposed() || capture.maintaining) continue;
      const guard = () => {
        if (
          capture.stopping ||
          capture.isDisposed() ||
          this.captures.get(capture.tabId) !== capture
        )
          throw Error('TASK_RENDERING_REVOKED');
      };
      const pending = (async () => {
        await capture.starting;
        if (capture.isDisposed()) return;
        guard();
        await work(capture.tabId, capture.targetId, guard);
        if (capture.isDisposed()) return;
        guard();
      })();
      capture.maintaining = pending;
      void pending
        .catch(() => {
          if (!capture.isDisposed() && this.captures.get(capture.tabId) === capture)
            void this.release(capture.tabId).catch(() => {});
        })
        .finally(() => {
          if (capture.maintaining === pending) capture.maintaining = undefined;
        });
    }
  }
  private async releaseCapture(capture: Capture, timeoutMs: number): Promise<boolean> {
    capture.stopping = true; // Synchronous fence before awaits.
    capture.releasing ??= (async () => {
      await capture.starting.catch(() => {});
      if (capture.isDisposed() || this.captures.get(capture.tabId) !== capture) return;
      await capture.maintaining?.catch(() => {});
      if (capture.isDisposed() || this.captures.get(capture.tabId) !== capture) return;
      await this.send({ tabId: capture.tabId }, 'Emulation.setFocusEmulationEnabled', {
        enabled: false,
      });
      if (!capture.isDisposed() && this.captures.get(capture.tabId) === capture)
        this.captures.delete(capture.tabId);
    })();
    const releasing = capture.releasing;
    void releasing.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        capture.disposedSignal.then(() => false as const),
        releasing.then(() => {
          if (!capture.isDisposed() && this.captures.get(capture.tabId) === capture)
            this.captures.delete(capture.tabId);
          return !capture.isDisposed();
        }),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (!completed) {
        if (this.captures.get(capture.tabId) === capture) this.forget(capture.tabId);
        return false;
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async release(tabId?: number, timeoutMs = 2_500): Promise<boolean> {
    if (tabId !== undefined) {
      const capture = this.captures.get(tabId);
      if (!capture) return true;
      return this.releaseCapture(capture, timeoutMs);
    }
    const captures = [...this.captures.values()];
    if (!captures.length) return true;
    for (const capture of captures) capture.stopping = true;
    const results = await Promise.all(
      captures.map((capture) => this.releaseCapture(capture, timeoutMs)),
    );
    return results.every(Boolean);
  }
  forget(tabId: number): void {
    const capture = this.captures.get(tabId);
    capture?.dispose();
    this.captures.delete(tabId);
    this.windows?.forgetTab?.(tabId);
  } // Native detach destroys its stream.
  forgetAll(): void {
    for (const tabId of [...this.captures.keys()]) {
      this.forget(tabId);
    }
  }
}
