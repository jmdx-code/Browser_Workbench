import type { BumperRefreshResult, BumperTarget } from '../shared/group-bumper.js';
import type { GroupBumperBrowserAdapter } from './group-bumper-runner.js';
import { resolveBumperTargetMetadata, type ResolvedTargetMetadata } from './group-bumper-avatar.js';

export interface TargetMetadataRefreshOptions {
  signal?: AbortSignal;
  onUpdated?: () => void;
}

export type TargetMetadataRefreshAdapter = Pick<
  GroupBumperBrowserAdapter,
  'refreshTargetBatch' | 'resolveTargetMetadata'
> & {
  hasMetadataReads?(): boolean;
};

export class TargetMetadataRefreshService {
  private readonly controllers = new Map<'groups' | 'pages', AbortController>();
  private readonly statusTexts = new Map<'groups' | 'pages', string>();

  constructor(private readonly adapter: TargetMetadataRefreshAdapter) {}

  hasActiveReads(): boolean {
    return this.controllers.size > 0 || (this.adapter.hasMetadataReads?.() ?? false);
  }

  isRefreshing(kind?: 'groups' | 'pages'): boolean {
    if (kind) {
      return this.controllers.has(kind);
    }
    return this.controllers.size > 0 || (this.adapter.hasMetadataReads?.() ?? false);
  }

  statusText(kind: 'groups' | 'pages'): string {
    return this.statusTexts.get(kind) ?? '';
  }

  stopRefresh(kind?: 'groups' | 'pages'): boolean {
    if (kind) {
      const controller = this.controllers.get(kind);
      if (!controller) return false;
      this.controllers.delete(kind);
      this.statusTexts.set(kind, kind === 'pages' ? '已停止刷新专页头像' : '已停止刷新小组头像');
      controller.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      return true;
    }
    let stopped = false;
    for (const [k, controller] of [...this.controllers.entries()]) {
      this.controllers.delete(k);
      this.statusTexts.set(k, k === 'pages' ? '已停止刷新专页头像' : '已停止刷新小组头像');
      controller.abort(new Error('FACEBOOK_METADATA_BATCH_ABORTED'));
      stopped = true;
    }
    return stopped;
  }

  async resolveTargetMetadata(
    kind: 'groups' | 'pages',
    rawId: string,
    allowIdleBrowser = true,
  ): Promise<ResolvedTargetMetadata & { unavailable?: boolean }> {
    const httpMeta = await resolveBumperTargetMetadata(kind, rawId);
    if (!allowIdleBrowser || (httpMeta.canonicalId && httpMeta.name && httpMeta.avatarUrl)) {
      return httpMeta;
    }
    const browserMeta = await this.adapter.resolveTargetMetadata(kind, rawId);
    return {
      canonicalId: browserMeta.canonicalId ?? httpMeta.canonicalId,
      name: browserMeta.name ?? httpMeta.name,
      avatarUrl: browserMeta.avatarUrl ?? httpMeta.avatarUrl,
      unavailable: browserMeta.unavailable,
    };
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
    this.statusTexts.set(
      kind,
      kind === 'pages'
        ? `正在刷新 ${items.length} 个专页信息...`
        : `正在刷新 ${items.length} 个小组信息...`,
    );

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
      const res = await this.adapter.refreshTargetBatch(kind, items, {
        ...options,
        signal: controller.signal,
      });
      if (this.controllers.get(kind) === controller) {
        this.statusTexts.set(
          kind,
          res.error
            ? res.error
            : res.needsBrowser > 0
              ? `已更新 ${res.updated} 个，另有 ${res.needsBrowser} 个需打开闲置已登录浏览器后再刷新`
              : res.failed > 0
                ? `已更新 ${res.updated} 个，${res.failed} 个未能获取完整信息`
                : `刷新完成（更新 ${res.updated} 个）`,
        );
      }
      return res;
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      if (this.controllers.get(kind) === controller) {
        this.controllers.delete(kind);
      }
    }
  }

  startRefresh(
    kind: 'groups' | 'pages',
    items: BumperTarget[],
    options?: TargetMetadataRefreshOptions & {
      onFinished?: (res: BumperRefreshResult, aborted: boolean) => void;
    },
  ): Promise<BumperRefreshResult> {
    if (items.length === 0) {
      const empty: BumperRefreshResult = { updated: 0, needsBrowser: 0, failed: 0 };
      options?.onFinished?.(empty, false);
      return Promise.resolve(empty);
    }
    const promise = this.refreshTargetBatch(kind, items, options);
    void promise
      .then((res) => {
        const aborted = this.statusText(kind).startsWith('已停止刷新');
        options?.onFinished?.(res, aborted);
      })
      .catch(() => {
        options?.onFinished?.({ updated: 0, needsBrowser: 0, failed: 0 }, true);
      });
    return promise;
  }
}
