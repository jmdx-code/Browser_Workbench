import {
  mediaReference,
  parseResourceBackground,
  parseResourceClipboard,
} from './resource-table.js';
import { ProductError } from './workspace.js';
import type { PosterMaterial, PosterMaterialBackground } from '../shared/group-poster.js';

export interface MaterialDraft {
  id: string;
  caption: string;
  mediaSource: string;
  background: PosterMaterialBackground;
  selected: boolean;
  localFilePath: string | null;
  mediaKind: PosterMaterial['mediaKind'];
  cacheStatus: PosterMaterial['cacheStatus'];
  cacheError: string | null;
  usedCount: number;
  updatedAt?: number | undefined;
  lastUsedAt?: number | null | undefined;
  hasThumbnail?: boolean | undefined;
}

export function createEmptyMaterialDraft(
  id: string = globalThis.crypto.randomUUID(),
): MaterialDraft {
  return {
    id,
    caption: '',
    mediaSource: '',
    background: 'plain',
    selected: true,
    localFilePath: null,
    mediaKind: 'none',
    cacheStatus: 'ready',
    cacheError: null,
    usedCount: 0,
    updatedAt: 0,
    lastUsedAt: null,
    hasThumbnail: false,
  };
}

export function toMaterialDraft(m: PosterMaterial): MaterialDraft {
  return {
    id: m.id,
    caption: m.caption,
    mediaSource: m.mediaSource,
    background: m.mediaSource.trim() ? 'plain' : m.background,
    selected: m.selected,
    localFilePath: m.localFilePath,
    mediaKind: m.mediaKind,
    cacheStatus: m.cacheStatus,
    cacheError: m.cacheError,
    usedCount: m.usedCount,
    updatedAt: m.updatedAt,
    lastUsedAt: m.lastUsedAt ?? null,
    hasThumbnail: Boolean(m.hasThumbnail),
  };
}

export function posterCellValue(row: MaterialDraft, column: number): string {
  return (
    [
      row.caption,
      row.mediaSource,
      row.mediaSource.trim() || row.background === 'plain' ? '普通文字' : '彩贴',
    ][column] ?? ''
  );
}

export function formatPosterCellsForClipboard(
  rows: MaterialDraft[],
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
): string {
  if (
    ![minRow, maxRow, minCol, maxCol].every(Number.isInteger) ||
    minRow < 0 ||
    maxRow >= rows.length ||
    maxRow < minRow ||
    minCol < 0 ||
    maxCol > 2 ||
    maxCol < minCol
  ) {
    throw new ProductError('RESOURCE_RANGE', '复制范围无效');
  }
  const quote = (s: string) => (/[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return rows
    .slice(minRow, maxRow + 1)
    .map((row) =>
      Array.from({ length: maxCol - minCol + 1 }, (_, i) =>
        quote(posterCellValue(row, minCol + i)),
      ).join('\t'),
    )
    .join('\n');
}

export function pastePosterMaterialCells(
  input: MaterialDraft[],
  start: number,
  column: number,
  text: string,
  createId: () => string,
  endRow = start,
  endColumn = column,
): MaterialDraft[] {
  let matrix = parseResourceClipboard(text);
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    ![0, 1, 2].includes(column) ||
    !Number.isInteger(endRow) ||
    !Number.isInteger(endColumn) ||
    endRow < start ||
    endColumn < column ||
    endRow >= 500 ||
    endColumn > 2 ||
    start + matrix.length > 500
  ) {
    throw new ProductError('RESOURCE_RANGE', '粘贴范围超过素材表容量（最多 500 行）');
  }
  if (matrix.length === 1 && (endRow > start || endColumn > column)) {
    const first = matrix[0] ?? [];
    if (first.length === 1) {
      matrix = Array.from({ length: endRow - start + 1 }, () =>
        Array.from({ length: endColumn - column + 1 }, () => first[0] ?? ''),
      );
    } else if (endRow > start) {
      matrix = Array.from({ length: endRow - start + 1 }, () => [...first]);
    }
  } else if (matrix.length > 1 && matrix.every((row) => row.length === 1) && endColumn > column) {
    matrix = matrix.map((row) =>
      Array.from({ length: endColumn - column + 1 }, () => row[0] ?? ''),
    );
  }
  const rows = structuredClone(input);
  while (rows.length < start + matrix.length) {
    rows.push(createEmptyMaterialDraft(createId()));
  }
  matrix.forEach((cells, offset) => {
    const row = rows[start + offset];
    if (!row) throw Error('MATERIAL_ROW_MISSING');
    cells.forEach((cell, cellOffset) => {
      const target = column + cellOffset;
      if (target > 2) return;
      if (target === 0) {
        row.caption = cell;
      } else if (target === 1) {
        const lines = cell
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const firstLine = lines[0];
        if (firstLine) {
          const ref = mediaReference(firstLine);
          if (row.mediaSource !== ref.source) {
            row.mediaSource = ref.source;
            row.localFilePath = ref.kind === 'local' ? ref.source : null;
            row.cacheError = null;
            row.cacheStatus = ref.kind === 'drive' ? 'downloading' : 'ready';
            row.mediaKind = ref.mediaType === 'image' ? 'image' : 'video';
            row.hasThumbnail = false;
          }
        } else {
          row.mediaSource = '';
          row.localFilePath = null;
          row.mediaKind = 'none';
          row.cacheStatus = 'ready';
          row.cacheError = null;
          row.hasThumbnail = false;
        }
      } else if (target === 2) {
        row.background = parseResourceBackground(cell);
      }
    });
    if (row.mediaSource.trim().length > 0) {
      row.background = 'plain';
    }
  });
  return rows;
}

export function fillPosterMaterialFiles(
  input: MaterialDraft[],
  start: number,
  sources: string[],
  createId: () => string,
): MaterialDraft[] {
  if (!Number.isInteger(start) || start < 0 || start > input.length || !sources.length) {
    throw new ProductError('RESOURCE_RANGE', '请选择媒体填充起始行');
  }
  const refs = sources.map(mediaReference);
  const rows = structuredClone(input);
  let cursor = start;
  for (const ref of refs) {
    while (rows[cursor]?.mediaSource.trim()) cursor++;
    if (cursor >= 500) throw new ProductError('RESOURCE_ROWS', '最多 500 行，本批次尚未添加');
    while (rows.length <= cursor) rows.push(createEmptyMaterialDraft(createId()));
    const row = rows[cursor];
    if (!row) throw Error('MATERIAL_ROW_MISSING');
    row.mediaSource = ref.source;
    row.localFilePath = ref.kind === 'local' ? ref.source : null;
    row.cacheError = null;
    row.cacheStatus = ref.kind === 'drive' ? 'downloading' : 'ready';
    row.mediaKind = ref.mediaType === 'image' ? 'image' : 'video';
    row.hasThumbnail = false;
    row.background = 'plain';
    cursor++;
  }
  return rows;
}
