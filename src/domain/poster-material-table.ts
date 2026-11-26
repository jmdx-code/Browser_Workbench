import {
  fillRowsWithMedia,
  formatTsvMatrix,
  mediaReference,
  parseResourceAILabel,
  parseResourceBackground,
  parseTsvClipboardMatrix,
  preparePasteGrid,
} from './resource-table.js';
import type { PosterMaterial, PosterMaterialAiLabel } from '../shared/group-poster.js';
export type MaterialDraft = Omit<PosterMaterial, 'sortOrder'>;
const EMPTY_DRAFT: Omit<MaterialDraft, 'id'> = {
  caption: '',
  mediaSource: '',
  background: 'plain',
  aiLabel: 'default',
  selected: true,
  localFilePath: null,
  mediaKind: 'none',
  cacheStatus: 'ready',
  cacheError: null,
  usedCount: 0,
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  hasThumbnail: false,
};
export const createEmptyMaterialDraft = (
  id: string = globalThis.crypto.randomUUID(),
): MaterialDraft => ({ id, ...EMPTY_DRAFT });
export const toMaterialDraft = (m: PosterMaterial): MaterialDraft => ({
  id: m.id,
  caption: m.caption,
  mediaSource: m.mediaSource,
  background: m.mediaSource.trim() ? 'plain' : m.background,
  aiLabel: m.aiLabel ?? 'default',
  selected: m.selected,
  localFilePath: m.localFilePath,
  mediaKind: m.mediaKind,
  cacheStatus: m.cacheStatus,
  cacheError: m.cacheError,
  usedCount: m.usedCount,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  lastUsedAt: m.lastUsedAt ?? null,
  hasThumbnail: Boolean(m.hasThumbnail),
});
function parsePosterAiLabel(raw: string): PosterMaterialAiLabel {
  const parsed = parseResourceAILabel(raw.trim().toLowerCase() === 'default' ? '默认' : raw);
  return parsed === 'preserve-current' ? 'default' : parsed;
}
export const posterCellValue = (row: MaterialDraft, column: number): string =>
  [
    row.caption,
    row.mediaSource,
    row.mediaSource.trim() || row.background === 'plain' ? '普通文字' : '彩贴',
    row.aiLabel === 'on' ? '开启' : row.aiLabel === 'off' ? '关闭' : '默认',
  ][column] ?? '';
const parsePosterClipboard = (text: string): string[][] =>
  parseTsvClipboardMatrix(text, {
    byteLimit: 4 * 1024 * 1024,
    maxRows: 500,
    maxRowsMsg: '最多粘贴 500 行',
  });
const tryParse = (fn: () => void) => {
  try {
    return (fn(), true);
  } catch {
    return false;
  }
};
const isLikelyMediaCell = (raw: string) => {
  const first = (raw.trim().split('\n')[0] ?? '').trim();
  return Boolean(first) && tryParse(() => mediaReference(first));
};
const isLikelyBackgroundKeyword = (raw: string) => tryParse(() => parseResourceBackground(raw));
export const formatPosterCellsForClipboard = (
  rows: MaterialDraft[],
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
) => formatTsvMatrix(rows, minRow, maxRow, minCol, maxCol, 3, posterCellValue);
function applyMediaRefToDraft(row: MaterialDraft, ref: ReturnType<typeof mediaReference> | null) {
  if (!ref) {
    Object.assign(row, {
      mediaSource: '',
      localFilePath: null,
      mediaKind: 'none',
      cacheStatus: 'ready',
      cacheError: null,
      hasThumbnail: false,
    });
  } else if (row.mediaSource !== ref.source) {
    Object.assign(row, {
      mediaSource: ref.source,
      localFilePath: ref.kind === 'local' ? ref.source : null,
      cacheError: null,
      cacheStatus: ref.kind === 'drive' ? 'downloading' : 'ready',
      mediaKind: ref.mediaType === 'image' ? 'image' : 'video',
      hasThumbnail: false,
    });
  }
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
  let matrix = parsePosterClipboard(text);
  // 若用户在 A 列（文案）或 B 列（媒体）单格粘贴了横向排布的多列 Excel 行，自动转置为纵向多行
  if (
    matrix.length === 1 &&
    (matrix[0]?.length ?? 0) > 1 &&
    endRow === start &&
    endColumn === column
  ) {
    const first = matrix[0] ?? [],
      col0 =
        column === 0 &&
        !(
          first.length <= 4 &&
          (!(first[1] ?? '').trim() || isLikelyMediaCell(first[1] ?? '')) &&
          (!(first[2] ?? '').trim() || isLikelyBackgroundKeyword(first[2] ?? ''))
        ),
      col1 =
        column === 1 &&
        isLikelyMediaCell(first[1] ?? '') &&
        !isLikelyBackgroundKeyword(first[1] ?? '');
    if (col0 || col1) {
      const nonEmpty = first.filter((c) => c.trim().length > 0);
      if (nonEmpty.length > 0) matrix = nonEmpty.map((c) => [c]);
    }
  }
  const { rows, expanded } = preparePasteGrid(
    input,
    matrix,
    start,
    column,
    endRow,
    endColumn,
    500,
    3,
    '粘贴范围超过素材表容量（最多 500 行）',
    () => createEmptyMaterialDraft(createId()),
  );
  expanded.forEach((cells, offset) => {
    const row = rows[start + offset];
    if (!row) throw Error('MATERIAL_ROW_MISSING');
    cells.forEach((cell, cellOffset) => {
      const target = column + cellOffset;
      if (target > 3) return;
      if (target === 0) row.caption = cell;
      else if (target === 1) {
        const line = cell
          .split('\n')
          .map((s) => s.trim())
          .find(Boolean);
        applyMediaRefToDraft(row, line ? mediaReference(line) : null);
      } else if (target === 2) row.background = parseResourceBackground(cell);
      else
        row.aiLabel = parsePosterAiLabel(
          column === 0 && cells.length >= 5 ? (cells[4] ?? '') : cell,
        );
    });
    if (row.mediaSource.trim().length > 0) row.background = 'plain';
  });
  return rows;
}
export const fillPosterMaterialFiles = (
  input: MaterialDraft[],
  start: number,
  sources: string[],
  createId: () => string,
): MaterialDraft[] =>
  fillRowsWithMedia(
    input,
    start,
    sources.map(mediaReference),
    500,
    () => createEmptyMaterialDraft(createId()),
    (r) => Boolean(r.mediaSource.trim()),
    applyMediaRefToDraft,
  );
