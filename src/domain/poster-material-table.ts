import { mediaReference, parseResourceBackground } from './resource-table.js';
import { ProductError } from './workspace.js';
import type {
  PosterMaterial,
  PosterMaterialAiLabel,
  PosterMaterialBackground,
} from '../shared/group-poster.js';

export interface MaterialDraft {
  id: string;
  caption: string;
  mediaSource: string;
  background: PosterMaterialBackground;
  aiLabel: PosterMaterialAiLabel;
  selected: boolean;
  localFilePath: string | null;
  mediaKind: PosterMaterial['mediaKind'];
  cacheStatus: PosterMaterial['cacheStatus'];
  cacheError: string | null;
  usedCount: number;
  createdAt?: number | undefined;
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
}

export function toMaterialDraft(m: PosterMaterial): MaterialDraft {
  return {
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
  };
}

export function parsePosterAiLabel(raw: string): PosterMaterialAiLabel {
  const v = raw.trim().toLowerCase();
  if (['开启', '开启声明', '是', '声明', 'ai', 'on', 'true', '1'].includes(v)) return 'on';
  if (['关闭', '关闭声明', '否', '不声明', 'off', 'false', '0'].includes(v)) return 'off';
  if (
    [
      '默认',
      '保持默认',
      '保持',
      '保持 facebook 当前设置',
      'default',
      'preserve-current',
      '',
    ].includes(v)
  ) {
    return 'default';
  }
  throw new ProductError('RESOURCE_AI_LABEL', 'AI 声明列请填写“开启”、“关闭”或“默认”');
}

export function posterCellValue(row: MaterialDraft, column: number): string {
  return (
    [
      row.caption,
      row.mediaSource,
      row.mediaSource.trim() || row.background === 'plain' ? '普通文字' : '彩贴',
      row.aiLabel === 'on' ? '开启' : row.aiLabel === 'off' ? '关闭' : '默认',
    ][column] ?? ''
  );
}

function isProperlyQuotedTsvCell(text: string, startQuoteIdx: number): boolean {
  let i = startQuoteIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      if (text[i + 1] === '"') {
        i += 2;
        continue;
      }
      const nextCh = text[i + 1];
      return nextCh === undefined || nextCh === '\t' || nextCh === '\n';
    }
    i++;
  }
  return false;
}

export function parsePosterClipboard(text: string): string[][] {
  if (new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) {
    throw new ProductError('RESOURCE_TABLE_TOO_LARGE', '粘贴内容超过4MiB');
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    if (rows.length > 500) {
      throw new ProductError('RESOURCE_ROWS', '最多粘贴 500 行');
    }
  };
  const normalized = text.replace(/\r\n?/g, '\n');
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index] ?? '';
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '\t') {
      endCell();
    } else if (char === '\n') {
      endRow();
    } else if (char === '"' && !cell && isProperlyQuotedTsvCell(normalized, index)) {
      quoted = true;
    } else {
      cell += char;
    }
  }
  if (cell || row.length || !rows.length || !normalized.endsWith('\n')) {
    endRow();
  }
  return rows;
}

function isLikelyMediaCell(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const firstLine = (trimmed.split('\n')[0] ?? '').trim();
  try {
    mediaReference(firstLine);
    return true;
  } catch {
    return false;
  }
}

function isLikelyBackgroundKeyword(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return [
    '普通文字',
    '文字',
    '普通',
    '白底',
    'plain',
    '彩贴',
    '彩色',
    '彩底',
    'color',
    '',
  ].includes(v);
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
    maxCol > 3 ||
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
  let matrix = parsePosterClipboard(text);
  // 若用户在 A 列（文案）或 B 列（媒体）单格粘贴了横向排布的多列 Excel 行（如每列代表一条贴文），自动转置为纵向多行
  if (
    matrix.length === 1 &&
    (matrix[0]?.length ?? 0) > 1 &&
    endRow === start &&
    endColumn === column
  ) {
    const firstRow = matrix[0] ?? [];
    if (column === 0) {
      const c1 = firstRow[1] ?? '';
      const c2 = firstRow[2] ?? '';
      const looksLikeStandardRow =
        firstRow.length <= 4 &&
        (!c1.trim() || isLikelyMediaCell(c1)) &&
        (!c2.trim() || isLikelyBackgroundKeyword(c2));
      if (!looksLikeStandardRow) {
        const nonEmpty = firstRow.filter((c) => c.trim().length > 0);
        if (nonEmpty.length > 0) {
          matrix = nonEmpty.map((c) => [c]);
        }
      }
    } else if (column === 1) {
      const c1 = firstRow[1] ?? '';
      if (isLikelyMediaCell(c1) && !isLikelyBackgroundKeyword(c1)) {
        const nonEmpty = firstRow.filter((c) => c.trim().length > 0);
        if (nonEmpty.length > 0) {
          matrix = nonEmpty.map((c) => [c]);
        }
      }
    }
  }
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    ![0, 1, 2, 3].includes(column) ||
    !Number.isInteger(endRow) ||
    !Number.isInteger(endColumn) ||
    endRow < start ||
    endColumn < column ||
    endRow >= 500 ||
    endColumn > 3 ||
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
      if (target > 3) return;
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
      } else if (target === 3) {
        // 兼容从活跃账号复制的 5 列 TSV（A文案 B媒体 C背景 D用途 E·AI声明）
        const aiRaw = column === 0 && cells.length >= 5 ? (cells[4] ?? '') : cell;
        row.aiLabel = parsePosterAiLabel(aiRaw);
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
