import type { Awaitable } from '../domain/persistence.js';
import type { ResourceTableRepository } from '../domain/resource-table.js';
import type { ResourceDriveDownloader } from '../domain/resource-download.js';
import { ProductError } from '../domain/workspace.js';
import {
  DownloadResourceSources,
  ResourceDownloadReport,
  type ResourceDownloadProgressValue,
} from '../shared/resource-download.js';
import { ResourceMedia, type ResourceMediaValue } from '../shared/resource-table.js';

const issueText = (failure: unknown) => {
  const code = failure instanceof Error ? failure.message : '';
  if (/PERMISSION|CONFIRMATION|PUBLIC_DOWNLOAD_UNAVAILABLE/.test(code))
    return '链接不公开、需要登录或暂时无法下载，请检查共享权限';
  if (/TIMEOUT/.test(code)) return '下载超时，可单独重试此行';
  if (/NO_SPACE/.test(code)) return '本机可用空间不足';
  if (/SIZE_LIMIT/.test(code)) return '文件超过下载容量';
  if (/MEDIA_TYPE|ENCODING/.test(code)) return '不支持的媒体格式或传输编码';
  return '下载未完成，请检查链接后重试此行';
};

export class ResourceDownloadService {
  private downloading = false;
  constructor(
    private readonly repository: ResourceTableRepository,
    private readonly downloader: ResourceDriveDownloader,
    private readonly now = Date.now,
  ) {}
  async download(
    input: unknown,
    assertConnected: () => Awaitable<void>,
    onProgress: (value: ResourceDownloadProgressValue) => Promise<void>,
  ) {
    const request = DownloadResourceSources.parse(input);
    if (this.downloading)
      throw new ProductError('RESOURCE_DOWNLOAD_BUSY', '另一批网盘素材正在下载，请稍后再试', 409);
    let table = await this.repository.read(request.combinationId);
    if (table.revision !== request.expectedRevision)
      throw new ProductError('RESOURCE_REVISION_CONFLICT', '资源表已修改，请重新读取后下载', 409);
    const selected = request.rowIds ? new Set(request.rowIds) : null;
    if (selected && table.rows.filter((row) => selected.has(row.id)).length !== selected.size)
      throw new ProductError('RESOURCE_ROW_NOT_FOUND', '选中的资源行已变化', 404);
    const members = table.rows.flatMap((row) =>
      selected && !selected.has(row.id)
        ? []
        : row.media.flatMap((media, index) =>
            media.kind === 'drive' ? [{ rowId: row.id, index, source: media.source }] : [],
          ),
    );
    const started = this.now();
    let lastProgressAt = started;
    const progress: ResourceDownloadProgressValue = {
      completed: 0,
      total: members.length,
      downloaded: 0,
      failed: 0,
      bytes: 0,
    };
    const issues: { rowId: string; fileIndex: number; error: string }[] = [];
    let failure: unknown;
    const current = async (bytes = 0) => {
      if (failure) throw failure;
      await assertConnected();
      const now = this.now();
      if (!Number.isFinite(now) || now < started || now - started > 30 * 60_000)
        throw new ProductError(
          'RESOURCE_DOWNLOAD_TIMEOUT',
          '本批下载达到30分钟，请继续下载剩余行',
          409,
        );
      if ((await this.repository.revision(request.combinationId)) !== table.revision)
        throw new ProductError(
          'RESOURCE_REVISION_CONFLICT',
          '资源表已被其他窗口修改，下载已停止；此前下载保持',
          409,
        );
      if (!Number.isSafeInteger(bytes) || bytes < 0 || progress.bytes + bytes > 64 * 1024 ** 3)
        throw new ProductError('RESOURCE_DOWNLOAD_BUDGET', '本批下载达到64GiB，请分批继续', 409);
      progress.bytes += bytes;
      if (bytes > 0 && now - lastProgressAt >= 500) {
        lastProgressAt = now;
        void emit().catch((error: unknown) => {
          failure ??= error;
        });
      }
    };
    let delivery = Promise.resolve();
    const emit = () => {
      const snapshot = { ...progress };
      delivery = delivery
        .then(async () => {
          await current();
          return onProgress(snapshot);
        })
        .catch((error: unknown) => {
          failure = error;
        });
      return delivery.then(async () => await current());
    };
    await current();
    this.downloading = true;
    let next = 0;
    let commits = Promise.resolve();
    try {
      await emit();
      const worker = async () => {
        try {
          for (;;) {
            await current();
            const member = members[next++];
            if (!member) return;
            let media: ResourceMediaValue | undefined;
            try {
              const downloaded = ResourceMedia.parse(
                await this.downloader.download(member.source, member.index, current),
              );
              await current();
              if (downloaded.kind !== 'local' || downloaded.mediaType === 'unknown')
                throw Error('DRIVE_MEDIA_TYPE_UNSUPPORTED');
              media = downloaded;
            } catch (error) {
              await current(); // Cancellation/version revocation is never disguised as a bad link.
              issues.push({
                rowId: member.rowId,
                fileIndex: member.index,
                error: issueText(error),
              });
              progress.failed++;
            }
            if (media) {
              const downloadedMedia = media;
              commits = commits.then(async () => {
                await current();
                const row = table.rows.find((value) => value.id === member.rowId);
                if (row?.media[member.index]?.source !== member.source)
                  throw Error('RESOURCE_DOWNLOAD_MEMBER_CHANGED');
                const local = downloadedMedia;
                const rows = table.rows.map((value) =>
                  value.id === member.rowId
                    ? {
                        ...value,
                        media: value.media.map((old, index) =>
                          index === member.index ? local : old,
                        ),
                        background: 'plain' as const,
                      }
                    : value,
                );
                // Per-member CAS uses original immutable resource revisions, not a download ledger.
                // Completed downloads survive cancel/disconnect. In-flight plans retain old revisions.
                table = await this.repository.save(request.combinationId, table.revision, rows);
                progress.downloaded++;
              });
              await commits;
            }
            progress.completed++;
            await emit();
          }
        } catch (error) {
          failure ??= error;
          throw error;
        }
      };
      const work = await Promise.allSettled(
        Array.from({ length: Math.min(3, members.length) }, worker),
      );
      await delivery;
      const rejected = work.find((value) => value.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      await current();
      return ResourceDownloadReport.parse({
        combinationId: request.combinationId,
        expectedRevision: request.expectedRevision,
        table,
        progress,
        issues,
      });
    } catch (error) {
      if (error instanceof ProductError) throw error;
      throw new ProductError(
        'RESOURCE_DOWNLOAD_INTERRUPTED',
        '下载已停止；成功下载的行已保存，未完成链接保留，可重新读取后继续',
        409,
      );
    } finally {
      this.downloading = false;
    }
  }
}
