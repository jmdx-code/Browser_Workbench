import type { BumperRefreshResult, BumperTarget } from '../shared/group-bumper.js';
import type { GroupBumperBrowserAdapter } from './group-bumper-runner.js';
export interface TargetMetadataRefreshOptions {
  signal?: AbortSignal;
  onUpdated?: () => void;
}
export type TargetMetadataRefreshAdapter = Pick<GroupBumperBrowserAdapter, 'refreshTargetBatch'> & {
  hasMetadataReads?(): boolean;
};
export class TargetMetadataRefreshService {
  private readonly controllers = new Map<'groups' | 'pages', AbortController>();
  constructor(private readonly adapter: TargetMetadataRefreshAdapter) {}
  stopRefresh(kind?: 'groups' | 'pages'): boolean {
    if (kind) {
      const controller = this.controllers.get(kind);
      if (!controller) return false;
      this.controllers.delete(kind);
      controller.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      return true;
    }
    let stopped = false;
    for (const [k, controller] of [...this.controllers.entries()]) {
      this.controllers.delete(k);
      controller.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      stopped = true;
    }
    return stopped;
  }
  async refreshTargetBatch(
    kind: 'groups' | 'pages',
    items: BumperTarget[],
    options?: TargetMetadataRefreshOptions,
  ): Promise<BumperRefreshResult> {
    const previous = this.controllers.get(kind);
    if (previous) {
      previous.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
    }
    const controller = new AbortController();
    this.controllers.set(kind, controller);
    const externalSignal = options?.signal;
    const onExternalAbort = () => {
      controller.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    try {
      return await this.adapter.refreshTargetBatch(kind, items, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (this.controllers.get(kind) === controller) {
        this.controllers.delete(kind);
      }
    }
  }
}
