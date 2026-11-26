import { withBoundedWait } from './workspace-page-group.js';
type Target = { tabId: number; sessionId?: string };
type Send = (target: Target, method: string, params: Record<string, unknown>) => Promise<unknown>;
class TabRenderingCapture {
  starting: Promise<void> = Promise.resolve();
  stopping = false;
  acks = 0;
  generation = 0;
  refreshing?: Promise<void>;
  releasing?: Promise<void>;
  private disposed = false;
  private resolveDisposed: () => void = () => {};
  readonly disposedSignal = new Promise<void>((r) => {
    this.resolveDisposed = r;
  });
  constructor(
    readonly tabId: number,
    readonly targetId: string,
  ) {}
  isDisposed = () => this.disposed;
  dispose(): void {
    this.disposed = true;
    this.stopping = true;
    this.resolveDisposed();
  }
}
// Single scoped native stream. Frames are discarded; visibility, focus, viewport and media are unchanged.
export class TaskRendering {
  private readonly captures = new Map<number, TabRenderingCapture>();
  constructor(
    private readonly send: Send,
    private readonly windows?: { forgetTab?(tabId: number): void },
  ) {}
  private alive = (tabId: number, c: TabRenderingCapture) =>
    !c.isDisposed() && !c.stopping && this.captures.get(tabId) === c;
  private assertLive(tabId: number, c: TabRenderingCapture, guard: () => void) {
    guard();
    if (!this.alive(tabId, c)) throw Error('TASK_RENDERING_REVOKED');
  }
  private async activateRendering(
    tabId: number,
    c: TabRenderingCapture,
    resetFirst: boolean,
    guard?: () => void,
  ) {
    if (!this.alive(tabId, c)) return;
    if (resetFirst) {
      await this.send({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      if (c.isDisposed()) return;
      guard?.();
      if (!this.alive(tabId, c)) throw Error('TASK_RENDERING_REVOKED');
    }
    await this.send({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    if (this.alive(tabId, c))
      await this.send({ tabId }, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  }
  private async runCaptureOp(
    tabId: number,
    c: TabRenderingCapture,
    guard: () => void,
    op: Promise<void>,
  ) {
    try {
      await op;
      this.assertLive(tabId, c, guard);
    } catch (error) {
      if (!c.isDisposed() && this.captures.get(tabId) === c)
        await this.release(c.tabId).catch(() => false);
      throw error;
    }
  }
  async refresh(tabId: number, targetId: string, guard: () => void) {
    guard();
    const c = this.captures.get(tabId);
    if (!c) return this.ensure(tabId, targetId, guard);
    if (c.targetId !== targetId || c.stopping || c.isDisposed())
      throw Error('TASK_RENDERING_SCOPE_CHANGED');
    if (c.refreshing) {
      await c.refreshing;
      return this.assertLive(tabId, c, guard);
    }
    await this.ensure(tabId, targetId, guard);
    guard();
    if (!this.alive(tabId, c)) throw Error('TASK_RENDERING_REVOKED');
    if (!c.refreshing) {
      c.generation++;
      const restart = this.activateRendering(tabId, c, true, guard);
      c.refreshing = restart;
      c.starting = restart;
    }
    const refreshing = c.refreshing;
    try {
      await this.runCaptureOp(tabId, c, guard, refreshing);
    } finally {
      if (c.refreshing === refreshing) c.refreshing = undefined;
    }
  }
  async ensure(tabId: number, targetId: string, guard: () => void) {
    guard();
    const cur = this.captures.get(tabId);
    if (cur) {
      if (cur.targetId !== targetId || cur.stopping || cur.isDisposed())
        throw Error('TASK_RENDERING_SCOPE_CHANGED');
      await cur.starting;
      return this.assertLive(tabId, cur, guard);
    }
    if (this.captures.size) throw Error('TASK_RENDERING_TARGET_LIMIT');
    const c = new TabRenderingCapture(tabId, targetId);
    this.captures.set(tabId, c);
    c.starting = this.activateRendering(tabId, c, false);
    await this.runCaptureOp(tabId, c, guard, c.starting);
  }
  consume(source: Target, method: string, value: unknown, allowed: () => boolean) {
    if (method !== 'Page.screencastFrame' || source.sessionId) return false;
    const c = this.captures.get(source.tabId);
    if (!c) return false;
    if (c.stopping || c.isDisposed() || c.refreshing) return true;
    let valid = false;
    try {
      valid = allowed();
    } catch {}
    const sessionId =
      value && typeof value === 'object' && 'sessionId' in value ? value.sessionId : null;
    if (
      !valid ||
      typeof sessionId !== 'number' ||
      !Number.isSafeInteger(sessionId) ||
      sessionId < 0 ||
      c.acks >= 4
    ) {
      void this.release(source.tabId).catch(() => {});
      return true;
    }
    c.acks++;
    const gen = c.generation;
    void this.send({ tabId: source.tabId }, 'Page.screencastFrameAck', { sessionId })
      .catch(() => {
        if (!c.isDisposed() && this.captures.get(source.tabId) === c && c.generation === gen)
          void this.release(source.tabId).catch(() => {});
      })
      .finally(() => c.acks--);
    return true;
  }
  private async releaseCapture(c: TabRenderingCapture, timeoutMs: number): Promise<boolean> {
    c.stopping = true;
    c.releasing ??= (async () => {
      await c.starting.catch(() => {});
      if (c.isDisposed() || this.captures.get(c.tabId) !== c) return;
      await this.send({ tabId: c.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: false });
      if (!c.isDisposed() && this.captures.get(c.tabId) === c) this.captures.delete(c.tabId);
    })();
    const releasing = c.releasing;
    void releasing.catch(() => {});
    const waited = await withBoundedWait(
      Promise.race([
        c.disposedSignal.then(() => false),
        releasing.then(() => {
          if (!c.isDisposed() && this.captures.get(c.tabId) === c) this.captures.delete(c.tabId);
          return !c.isDisposed();
        }),
      ]),
      timeoutMs,
    );
    const completed = waited.completed && waited.value;
    if (!completed && this.captures.get(c.tabId) === c) this.forget(c.tabId);
    return completed;
  }
  async release(tabId?: number, timeoutMs = 2_500): Promise<boolean> {
    if (tabId !== undefined) {
      const c = this.captures.get(tabId);
      return c ? this.releaseCapture(c, timeoutMs) : true;
    }
    const captures = [...this.captures.values()];
    if (!captures.length) return true;
    for (const c of captures) c.stopping = true;
    return (await Promise.all(captures.map((c) => this.releaseCapture(c, timeoutMs)))).every(
      Boolean,
    );
  }
  forget(tabId: number): void {
    this.captures.get(tabId)?.dispose();
    this.captures.delete(tabId);
    this.windows?.forgetTab?.(tabId);
  }
  forgetAll(): void {
    for (const tabId of [...this.captures.keys()]) this.forget(tabId);
  }
}
