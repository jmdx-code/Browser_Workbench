import type { Awaitable } from '../domain/persistence.js';
import {
  GetResourceTable,
  SaveResourceTable,
  ResourceTable,
  ResourceSummaries,
  ResourceUsageSummaries,
  ResourceMediaPreviewRequest,
} from '../shared/resource-table.js';
import type { ResourceTableRepository } from '../domain/resource-table.js';
import { ProductError } from '../domain/workspace.js';
import type { ResourceSourceReader } from '../domain/resource-source.js';
import {
  CheckResourceSources,
  ResourceSourceReport,
  ResourceSourceRow,
  type ResourceCheckProgressValue,
} from '../shared/resource-source.js';
import { BROWSER_TEXT_INPUT_LIMIT } from '../shared/browser-actions.js';
import { normalizeMaterialText } from '../domain/materials.js';
import type { ResourceDownloadService } from './resource-download-service.js';
import type { ResourceDownloadProgressValue } from '../shared/resource-download.js';
export class ResourceTableService {
  private checking = false;
  private previewing = false;
  constructor(
    private readonly repository: ResourceTableRepository,
    private readonly sourceReader?: ResourceSourceReader,
    private readonly now = Date.now,
    private readonly downloads?: ResourceDownloadService,
  ) {}
  downloadSources(
    input: unknown,
    assertConnected: () => Awaitable<void>,
    onProgress: (value: ResourceDownloadProgressValue) => Promise<void>,
  ) {
    if (!this.downloads)
      throw new ProductError(
        'RESOURCE_DOWNLOAD_UNAVAILABLE',
        '网盘下载服务未启用，请更新软件',
        409,
      );
    return this.downloads.download(input, assertConnected, onProgress);
  }
  async previewMedia(
    input: unknown,
    assertConnected: () => Awaitable<void> = () => {},
    deliver: (media: { bytes: Uint8Array; contentType: string }) => Promise<void>,
  ) {
    const request = ResourceMediaPreviewRequest.parse(input);
    const reader = this.sourceReader;
    if (!reader?.previewMedia)
      throw new ProductError('RESOURCE_PREVIEW_UNAVAILABLE', '资源预览服务未启用', 409);
    if (this.previewing)
      throw new ProductError('RESOURCE_PREVIEW_BUSY', '另一份媒体正在读取，请稍后重试', 409);
    const started = this.now();
    const current = async () => {
      await assertConnected();
      const now = this.now();
      if (!Number.isFinite(now) || now < started || now - started > 30000)
        throw new ProductError('RESOURCE_PREVIEW_TIMEOUT', '媒体读取超时，请重试', 409);
      if ((await this.repository.revision(request.combinationId)) !== request.expectedRevision)
        throw new ProductError('RESOURCE_REVISION_CONFLICT', '资源表已修改，请重新打开预览', 409);
    };
    await current();
    const row = (await this.repository.read(request.combinationId)).rows.find(
      (row) => row.id === request.rowId,
    );
    if (!row)
      throw new ProductError('RESOURCE_ROW_NOT_FOUND', '这行资源已删除，请重新打开资源表', 404);
    const media = row.media[request.fileIndex];
    if (!media || media.kind !== 'local')
      throw new ProductError(
        'RESOURCE_PREVIEW_LOCAL_MEDIA_REQUIRED',
        '网盘素材需先下载；当前不会为预览自动下载',
        409,
      );
    this.previewing = true;
    try {
      const result = await reader.previewMedia(row, request.fileIndex, current);
      await current();
      await deliver(result);
    } catch (failure) {
      if (failure instanceof ProductError) throw failure;
      const code = failure instanceof Error ? failure.message : '';
      throw new ProductError(
        'RESOURCE_PREVIEW_FAILED',
        code === 'RESOURCE_PREVIEW_MEDIA_LIMIT'
          ? '媒体超过预览上限：图片20MiB、视频128MiB；原文件保留'
          : '媒体无法读取、类型不符或文件已变化；原文件保留，请重新检查',
        409,
      );
    } finally {
      this.previewing = false;
    }
  }
  async checkSources(
    input: unknown,
    assertConnected: () => Awaitable<void> = () => {},
    onProgress?: (value: ResourceCheckProgressValue) => void | Promise<void>,
  ) {
    const request = CheckResourceSources.parse(input);
    const reader = this.sourceReader;
    if (!reader) throw new ProductError('RESOURCE_CHECK_UNAVAILABLE', '来源检查服务未启用', 409);
    if (this.checking)
      throw new ProductError('RESOURCE_CHECK_BUSY', '正在检查其他资源，请稍后再试', 409);
    const table = await this.repository.read(request.combinationId);
    if (table.revision !== request.expectedRevision)
      throw new ProductError(
        'RESOURCE_REVISION_CONFLICT',
        '资源表已修改，请重新打开后检查；当前编辑保留',
        409,
      );
    const selected = request.rowIds ? new Set(request.rowIds) : null;
    const selectedRows = selected ? table.rows.filter((row) => selected.has(row.id)) : table.rows;
    if (selected && selectedRows.length !== selected.size)
      throw new ProductError(
        'RESOURCE_ROW_NOT_FOUND',
        '选中的资源行不在当前版本中，请重新打开后检查',
        404,
      );
    let lastProgressAt = this.now();
    let readBytes = 0;
    const current = async (bytesRead = 0) => {
      await assertConnected();
      const now = this.now();
      if (
        !Number.isFinite(now) ||
        !Number.isFinite(lastProgressAt) ||
        now < lastProgressAt ||
        now - lastProgressAt > 30_000
      )
        throw new ProductError(
          'RESOURCE_CHECK_TIMEOUT',
          '来源读取长时间没有进展，请检查文件后重试',
          409,
        );
      if (bytesRead > 0) lastProgressAt = now;
      readBytes += bytesRead;
      if (
        !Number.isSafeInteger(bytesRead) ||
        bytesRead < 0 ||
        !Number.isSafeInteger(readBytes) ||
        readBytes > 10 * 1024 ** 3
      )
        throw new ProductError('RESOURCE_CHECK_BUDGET', '本次检查超过10GiB，请分批整理资源', 409);
    };
    const assertRevision = async () => {
      if ((await this.repository.revision(request.combinationId)) !== request.expectedRevision)
        throw new ProductError(
          'RESOURCE_REVISION_CONFLICT',
          '资源表已修改，请重新打开后检查；当前编辑保留',
          409,
        );
    };
    await current();
    this.checking = true;
    try {
      const first = new Map<string, string>();
      const rows = [];
      await onProgress?.({ completed: 0, total: selectedRows.length });
      for (const row of selectedRows) {
        await current();
        await assertRevision();
        const source = await reader.verify(row, current);
        await assertRevision();
        await current();
        const fingerprint = source.verified ? source.fingerprint : null;
        const result = ResourceSourceRow.parse({
          rowId: row.id,
          sourceVerified: source.verified,
          issue: source.verified ? null : source.issue,
          fingerprint,
          files: source.verified ? source.files : [],
          duplicateOf: fingerprint ? (first.get(fingerprint) ?? null) : null,
          blockers: [
            ...(normalizeMaterialText(row.text).length > BROWSER_TEXT_INPUT_LIMIT
              ? ['TEXT_INPUT_LIMIT']
              : []),
            ...(!row.media.length && row.text.trim() && row.background === 'color'
              ? ['BACKGROUND_UNVERIFIED']
              : []),
          ],
        });
        if (fingerprint && !first.has(fingerprint)) first.set(fingerprint, row.id);
        rows.push(result);
        lastProgressAt = this.now();
        await onProgress?.({ completed: rows.length, total: selectedRows.length });
        await current();
      }
      await current();
      return ResourceSourceReport.parse({
        ...request,
        checkedAt: this.now(),
        readonly: true,
        publishingReady: false,
        fingerprintVersion: 1,
        rows,
        verifiedSources: rows.filter((row) => row.sourceVerified).length,
        uniqueContents: first.size,
      });
    } catch (failure) {
      if (failure instanceof ProductError) throw failure;
      throw new ProductError(
        'RESOURCE_CHECK_FAILED',
        '来源检查未完成；已保存资源保持，请重试',
        409,
      );
    } finally {
      this.checking = false;
    }
  }
  async read(input: unknown) {
    return ResourceTable.parse(
      await this.repository.read(GetResourceTable.parse(input).combinationId),
    );
  }
  async save(input: unknown) {
    const value = SaveResourceTable.parse(input);
    return ResourceTable.parse(
      await this.repository.save(value.combinationId, value.expectedRevision, value.rows),
    );
  }
  async summaries() {
    return ResourceSummaries.parse(await this.repository.summaries());
  }
  async usageSummaries() {
    try {
      return ResourceUsageSummaries.parse(await this.repository.usageSummaries());
    } catch {
      throw new ProductError('RESOURCE_USAGE_UNAVAILABLE', '资源执行记录读取失败，请稍后重试', 409);
    }
  }
}
