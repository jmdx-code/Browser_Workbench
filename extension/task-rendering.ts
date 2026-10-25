type Target = { tabId: number; sessionId?: string };
type Send = (target: Target, method: string, params: Record<string, unknown>) => Promise<unknown>;
type Capture = {
  tabId: number;
  targetId: string;
  starting: Promise<void>;
  stopping: boolean;
  acks: number;
  generation: number;
  refreshing?: Promise<void>;
  releasing?: Promise<void>;
  maintaining?: Promise<void>;
};

// A single scoped, tiny native stream. This does not guarantee that Chromium keeps
// occluded pages visible or rendering. Frames are acknowledged locally and discarded,
// never relayed or saved; visibility, focus, viewport and media state are unchanged.
export class TaskRendering {
  private readonly captures = new Map<number, Capture>();
  constructor(private readonly send: Send) {}
  async refresh(tabId: number, targetId: string, guard: () => void) {
    guard();
    const existing = this.captures.get(tabId);
    if (!existing) return this.ensure(tabId, targetId, guard);
    if (existing.targetId !== targetId || existing.stopping)
      throw Error('TASK_RENDERING_SCOPE_CHANGED');
    // Join before ensure(): waiting for an existing restart and then restarting
    // again would turn concurrent callers into sequential duplicate refreshes.
    if (existing.refreshing) {
      await existing.refreshing;
      guard();
      if (existing.stopping || this.captures.get(tabId) !== existing)
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
    if (capture.stopping) throw Error('TASK_RENDERING_REVOKED');
    if (!capture.refreshing) {
      capture.generation++;
      const restart = (async () => {
        // Chromium rejects startScreencast while its old encoder is still active.
        await this.send({ tabId }, 'Page.stopScreencast', {});
        guard();
        if (capture.stopping || this.captures.get(tabId) !== capture)
          throw Error('TASK_RENDERING_REVOKED');
        await this.send({ tabId }, 'Page.startScreencast', {
          format: 'jpeg',
          quality: 1,
          maxWidth: 16,
          maxHeight: 16,
          everyNthFrame: 30,
        });
      })();
      capture.refreshing = restart;
      capture.starting = restart; // STOP and ensure both drain the whole restart.
    }
    const refreshing = capture.refreshing;
    try {
      await refreshing;
      guard();
      if (capture.stopping || this.captures.get(tabId) !== capture)
        throw Error('TASK_RENDERING_REVOKED');
    } catch (error) {
      if (this.captures.get(tabId) === capture) await this.cleanupFailure(capture);
      throw error;
    } finally {
      if (capture.refreshing === refreshing) capture.refreshing = undefined;
    }
  }
  private async cleanupFailure(capture: Capture) {
    const cleanup = this.release(capture.tabId).catch(() => {});
    // A maintenance callback can be the caller that just failed. release() drains
    // it, so awaiting that cleanup here would make the callback wait for itself.
    if (!capture.maintaining) await cleanup;
  }
  async ensure(tabId: number, targetId: string, guard: () => void) {
    guard();
    const current = this.captures.get(tabId);
    if (current) {
      if (current.targetId !== targetId || current.stopping)
        throw Error('TASK_RENDERING_SCOPE_CHANGED');
      await current.starting;
      guard();
      if (current.stopping || this.captures.get(tabId) !== current)
        throw Error('TASK_RENDERING_REVOKED');
      return;
    }
    if (this.captures.size) throw Error('TASK_RENDERING_TARGET_LIMIT');
    const capture: Capture = {
      tabId,
      targetId,
      starting: Promise.resolve(),
      stopping: false,
      acks: 0,
      generation: 0,
    };
    this.captures.set(tabId, capture);
    capture.starting = this.send({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 1,
      maxWidth: 16,
      maxHeight: 16,
      everyNthFrame: 30,
    }).then(() => {});
    try {
      await capture.starting;
      guard();
      if (capture.stopping || this.captures.get(tabId) !== capture)
        throw Error('TASK_RENDERING_REVOKED');
    } catch (error) {
      // Starting may have reached Chromium even when its acknowledgement is lost.
      if (this.captures.get(tabId) === capture) await this.cleanupFailure(capture);
      throw error;
    }
  }
  consume(source: Target, method: string, value: unknown, allowed: () => boolean) {
    if (method !== 'Page.screencastFrame' || source.sessionId) return false;
    const capture = this.captures.get(source.tabId);
    if (!capture) return false; // Do not consume an unrelated developer stream.
    if (capture.stopping || capture.refreshing) return true;
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
        if (this.captures.get(source.tabId) === capture && capture.generation === generation)
          void this.release(source.tabId).catch(() => {});
      })
      .finally(() => capture.acks--);
    return true;
  }
  maintain(work: (tabId: number, targetId: string, guard: () => void) => Promise<void>) {
    for (const capture of this.captures.values()) {
      if (capture.stopping || capture.maintaining) continue;
      const guard = () => {
        if (capture.stopping || this.captures.get(capture.tabId) !== capture)
          throw Error('TASK_RENDERING_REVOKED');
      };
      const pending = (async () => {
        await capture.starting;
        guard();
        await work(capture.tabId, capture.targetId, guard);
        guard();
      })();
      capture.maintaining = pending;
      void pending
        .catch(() => {
          if (this.captures.get(capture.tabId) === capture)
            void this.release(capture.tabId).catch(() => {});
        })
        .finally(() => {
          if (capture.maintaining === pending) capture.maintaining = undefined;
        });
    }
  }
  async release(tabId?: number) {
    const captures = [...this.captures.values()].filter(
      (capture) => tabId === undefined || capture.tabId === tabId,
    );
    for (const capture of captures) capture.stopping = true; // Synchronous fence before awaits.
    await Promise.all(
      captures.map(async (capture) => {
        capture.releasing ??= (async () => {
          await capture.starting.catch(() => {});
          await capture.maintaining?.catch(() => {});
          await this.send({ tabId: capture.tabId }, 'Page.stopScreencast', {});
          if (this.captures.get(capture.tabId) === capture) this.captures.delete(capture.tabId);
        })();
        await capture.releasing;
      }),
    );
  }
  forget(tabId: number) {
    const capture = this.captures.get(tabId);
    if (capture) capture.stopping = true;
    this.captures.delete(tabId);
  } // Native detach destroys its stream.
}
