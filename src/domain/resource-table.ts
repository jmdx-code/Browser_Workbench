import type { Awaitable } from './persistence.js';
import {
  ResourceRows,
  ResourceMedia,
  RESOURCE_TABLE_BODY_LIMIT,
  type ResourceRowValue,
  type ResourceMediaValue,
  type ResourceTableValue,
  type ResourceSummaryValue,
  type ResourceUsageSummaryValue,
} from '../shared/resource-table.js';
import { ProductError } from './workspace.js';

export interface ResourceTableRepository {
  read(combinationId: string): Awaitable<ResourceTableValue>;
  readVersion(combinationId: string, revision: number): Awaitable<ResourceTableValue>;
  revision(combinationId: string): Awaitable<number>;
  save(
    combinationId: string,
    expectedRevision: number,
    rows: ResourceRowValue[],
  ): Awaitable<ResourceTableValue>;
  summaries(): Awaitable<ResourceSummaryValue[]>;
  usageSummaries(): Awaitable<ResourceUsageSummaryValue[]>;
}
export function emptyResourceRow(id: string): ResourceRowValue {
  return { id, text: '', media: [], background: 'color' };
}
export function hasResource(row: ResourceRowValue) {
  return Boolean(row.text.trim() || row.media.length);
}
export function resourceSupportsDestination(row: ResourceRowValue, destination: 'post' | 'story') {
  return (row.purpose ?? 'post') === destination || row.purpose === 'both';
}
export function resourceType(row: ResourceRowValue): string {
  if (!hasResource(row)) return '空行';
  if (!row.media.length) return row.background === 'color' ? '彩贴' : '纯文字';
  if (row.media.some((item) => item.mediaType === 'unknown')) return '媒体 · 待核验';
  return row.media[0]?.mediaType === 'video' ? '视频' : row.media.length > 1 ? '多图' : '单图';
}
export function mediaReference(source: string): ResourceMediaValue {
  const value = source.trim();
  if (/^https:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ProductError('RESOURCE_LINK_INVALID', '媒体链接格式不正确');
    }
    const file =
      /^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ??
      (['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null);
    if (
      url.hostname !== 'drive.google.com' ||
      url.username ||
      url.password ||
      url.port ||
      !file ||
      !/^[a-zA-Z0-9_-]+$/.test(file) ||
      /[\x00-\x20]/.test(value)
    )
      throw new ProductError('RESOURCE_LINK_INVALID', '请使用 Google Drive 的文件分享链接');
    return ResourceMedia.parse({
      kind: 'drive',
      source: value,
      name: 'Google Drive · ' + file,
      mediaType: 'unknown',
    });
  }
  if (
    !/^(?:[a-zA-Z]:[\\/]|\/)/.test(value) ||
    /[\x00\r\n]/.test(value) ||
    /[\\/]fakepath[\\/]/i.test(value)
  )
    throw new ProductError(
      'RESOURCE_PATH_INVALID',
      '请选择或拖入本机图片、视频，不能使用临时文件名',
    );
  const name = value.split(/[\\/]/).at(-1) ?? '';
  const extension = name.split('.').at(-1)?.toLowerCase();
  const mediaType = ['png', 'jpg', 'jpeg', 'webp'].includes(extension ?? '')
    ? 'image'
    : ['mp4', 'mov'].includes(extension ?? '')
      ? 'video'
      : null;
  if (!mediaType)
    throw new ProductError(
      'RESOURCE_FORMAT_INVALID',
      '支持 PNG、JPG、WEBP、MP4、MOV；本批次尚未添加',
    );
  return ResourceMedia.parse({ kind: 'local', source: value, name, mediaType });
}
export function validateResourceRows(input: ResourceRowValue[]): ResourceRowValue[] {
  const rows = ResourceRows.parse(input);
  if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > RESOURCE_TABLE_BODY_LIMIT - 4096)
    throw new ProductError('RESOURCE_TABLE_TOO_LARGE', '资源表超过4MiB，请拆分到不同组合');
  for (const row of rows) {
    for (const item of row.media) {
      const actual = mediaReference(item.source);
      if (
        actual.kind !== item.kind ||
        actual.mediaType !== item.mediaType ||
        actual.name !== item.name
      )
        throw new ProductError('RESOURCE_REFERENCE_MISMATCH', '媒体引用与类型不一致');
    }
    if (row.media.length > 1 && row.media.some((item) => item.mediaType !== 'image'))
      throw new ProductError('RESOURCE_MEDIA_MIXED', '一个帖子可以包含多张图片，视频需要独占一行');
  }
  return rows;
}
// Parse quoted Sheets TSV without interpreting formulas or HTML. Trailing clipboard newline is not a new row.
export function parseResourceClipboard(text: string): string[][] {
  if (new TextEncoder().encode(text).byteLength > RESOURCE_TABLE_BODY_LIMIT)
    throw new ProductError('RESOURCE_TABLE_TOO_LARGE', '粘贴内容超过4MiB');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  function endCell() {
    row.push(cell);
    cell = '';
    closed = false;
    if (row.length > 5)
      throw new ProductError('RESOURCE_COLUMNS', '最多粘贴文案、媒体、背景、用途、AI声明五列');
  }
  function endRow() {
    endCell();
    rows.push(row);
    row = [];
    if (rows.length > 1000) throw new ProductError('RESOURCE_ROWS', '最多1000行');
  }
  const normalized = text.replace(/\r\n?/g, '\n');
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else cell += char;
    } else if (char === '\t') endCell();
    else if (char === '\n') endRow();
    else if (char === '"' && !cell && !closed) quoted = true;
    else {
      if (closed) throw new ProductError('RESOURCE_CLIPBOARD_INVALID', '粘贴内容的引号未正确闭合');
      cell += char;
    }
  }
  if (quoted) throw new ProductError('RESOURCE_CLIPBOARD_INVALID', '粘贴内容的引号未正确闭合');
  if (cell || row.length || !rows.length || !normalized.endsWith('\n')) endRow();
  return rows;
}
export function pasteResourceCells(
  input: ResourceRowValue[],
  start: number,
  column: number,
  text: string,
  createId: () => string,
  endRow = start,
  endColumn = column,
): ResourceRowValue[] {
  let matrix = parseResourceClipboard(text);
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    ![0, 1, 2, 3, 4].includes(column) ||
    !Number.isInteger(endRow) ||
    !Number.isInteger(endColumn) ||
    endRow < start ||
    endColumn < column ||
    endRow >= 1000 ||
    endColumn > 4 ||
    start + matrix.length > 1000
  )
    throw new ProductError('RESOURCE_RANGE', '粘贴范围超过资源表容量');
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
  while (rows.length < start + matrix.length) rows.push(emptyResourceRow(createId()));
  matrix.forEach((cells, offset) => {
    const row = rows[start + offset];
    if (!row) throw Error('RESOURCE_ROW_MISSING');
    cells.forEach((cell, cellOffset) => {
      const target = column + cellOffset;
      if (target > 4) throw new ProductError('RESOURCE_COLUMNS', '粘贴超过五列');
      if (target === 0) {
        row.text = cell;
      } else if (target === 1) {
        const media = cell.trim()
          ? cell
              .split('\n')
              .filter((value) => value.trim())
              .map(mediaReference)
          : [];
        row.media = media;
      } else if (target === 2) row.background = parseResourceBackground(cell);
      else if (target === 3) row.purpose = parseResourcePurpose(cell);
      else row.aiLabel = parseResourceAILabel(cell);
    });
    if (row.media.length > 0) row.background = 'plain';
  });
  return validateResourceRows(rows);
}
export function parseResourceBackground(raw: string): 'color' | 'plain' {
  const v = raw.trim().toLowerCase();
  if (['普通文字', '文字', '普通', '白底', 'plain'].includes(v)) return 'plain';
  if (['彩贴', '彩色', '彩底', 'color', ''].includes(v)) return 'color';
  throw new ProductError('RESOURCE_BACKGROUND', '背景列请填写“彩贴”或“普通文字”');
}
export function parseResourcePurpose(raw: string): 'post' | 'story' | 'both' {
  const v = raw.trim().toLowerCase();
  if (['快拍', 'story'].includes(v)) return 'story';
  if (['通用', '两者通用', '帖子及快拍', '全部', 'both'].includes(v)) return 'both';
  if (['帖子', '发帖', 'post', ''].includes(v)) return 'post';
  throw new ProductError('RESOURCE_PURPOSE', '用途列请填写“帖子”、“快拍”或“通用”');
}
export function parseResourceAILabel(raw: string): 'preserve-current' | 'on' | 'off' {
  const v = raw.trim().toLowerCase();
  if (['开启', '开启声明', '是', '声明', 'ai', 'on', 'true', '1'].includes(v)) return 'on';
  if (['关闭', '关闭声明', '否', '不声明', 'off', 'false', '0'].includes(v)) return 'off';
  if (['默认', '保持默认', '保持', '保持 facebook 当前设置', 'preserve-current', ''].includes(v))
    return 'preserve-current';
  throw new ProductError('RESOURCE_AI_LABEL', 'AI 声明列请填写“开启”、“关闭”或“默认”');
}
export function resourceCellValue(row: ResourceRowValue, column: number): string {
  return (
    [
      row.text,
      row.media.map((m) => m.source).join('\n'),
      row.media.length > 0 || row.background === 'plain' ? '普通文字' : '彩贴',
      row.purpose === 'story' ? '快拍' : row.purpose === 'both' ? '通用' : '帖子',
      row.aiLabel === 'on' ? '开启' : row.aiLabel === 'off' ? '关闭' : '默认',
    ][column] ?? ''
  );
}
export function formatResourceCellsForClipboard(
  rows: ResourceRowValue[],
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
    maxCol > 4 ||
    maxCol < minCol
  )
    throw new ProductError('RESOURCE_RANGE', '复制范围无效');
  const quote = (s: string) => (/[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return rows
    .slice(minRow, maxRow + 1)
    .map((row) =>
      Array.from({ length: maxCol - minCol + 1 }, (_, i) =>
        quote(resourceCellValue(row, minCol + i)),
      ).join('\t'),
    )
    .join('\n');
}
export function fillResourceMedia(
  input: ResourceRowValue[],
  start: number,
  media: ResourceMediaValue[],
  createId: () => string,
): ResourceRowValue[] {
  if (!Number.isInteger(start) || start < 0 || start > input.length || !media.length)
    throw new ProductError('RESOURCE_RANGE', '请选择媒体填充起始行');
  const rows = structuredClone(input);
  let cursor = start;
  for (const item of media) {
    while (rows[cursor]?.media.length) cursor++;
    if (cursor >= 1000) throw new ProductError('RESOURCE_ROWS', '最多1000行，本批次尚未添加');
    while (rows.length <= cursor) rows.push(emptyResourceRow(createId()));
    const row = rows[cursor];
    if (!row) throw Error('RESOURCE_ROW_MISSING');
    row.media = [item];
    row.background = 'plain';
    cursor++;
  }
  return validateResourceRows(rows);
}
