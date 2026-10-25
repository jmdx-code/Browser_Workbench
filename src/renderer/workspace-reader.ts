import type { Workspace } from '../shared/contracts.js';

export class WorkspaceReader {
  private pending: { controller: AbortController; work: Promise<void> } | null = null;
  private disposed = false;
  constructor(
    private readonly read: (signal: AbortSignal) => Promise<Workspace>,
    private readonly emit: (value: Workspace | null, error: string) => void,
    private readonly timeoutMs = 10_000,
  ) {}
  refresh(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending && !force) return this.pending.work;
    this.pending?.controller.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    let removeAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const listener = () => reject(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => signal.removeEventListener('abort', listener);
    });
    const work = Promise.resolve()
      .then(() => Promise.race([this.read(signal), aborted]))
      .then(
        (value) => {
          if (!this.disposed && this.pending?.controller === controller && !signal.aborted)
            this.emit(value, '');
        },
        () => {
          if (!this.disposed && this.pending?.controller === controller)
            this.emit(null, '控制服务连接失败或超时；当前列表可能是旧状态，请重新连接。');
        },
      )
      .finally(() => {
        removeAbort();
        if (this.pending?.controller === controller) this.pending = null;
      });
    this.pending = { controller, work };
    return work;
  }
  dispose() {
    this.disposed = true;
    this.pending?.controller.abort();
    this.pending = null;
  }
}
