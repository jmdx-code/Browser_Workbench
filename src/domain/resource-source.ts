import type { Awaitable } from './persistence.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
import type { MaterialMediaType } from '../shared/materials.js';
import type {
  ResourceSourceFileValue,
  ResourceSourceIssueValue,
} from '../shared/resource-source.js';

export type ResourceSourceResult =
  | { verified: true; fingerprint: string; files: ResourceSourceFileValue[] }
  | { verified: false; issue: ResourceSourceIssueValue };
export interface ResourceSourceReader {
  // Explicit saved-row inspection only; no download, upload, file writes or publishing authority.
  verify(
    row: ResourceRowValue,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<ResourceSourceResult>;
  previewMedia?(
    row: ResourceRowValue,
    fileIndex: number,
    assertCurrent: () => Awaitable<void>,
  ): Promise<{ bytes: Uint8Array; contentType: MaterialMediaType }>;
}
export const resourceSourceIssueText: Record<ResourceSourceIssueValue, string> = {
  EMPTY: '空行',
  DRIVE_DOWNLOAD_PENDING: '网盘文件待下载核验',
  FILE_UNAVAILABLE: '文件不存在或无法读取',
  PATH_UNSUPPORTED: '文件路径不受支持',
  FILE_CHANGED: '文件或所在目录检查期间发生变化',
  TYPE_MISMATCH: '实际文件类型与扩展名不符',
  FILE_SIZE_LIMIT: '文件超出本次检查容量',
};
