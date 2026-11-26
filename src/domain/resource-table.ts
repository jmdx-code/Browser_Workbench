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
const throwRes = (code: string, message: string): never => {
  throw new ProductError(code, message);
};
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
      throwRes('RESOURCE_LINK_INVALID', '请使用 Google Drive 的文件分享链接');
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
    throwRes('RESOURCE_PATH_INVALID', '请选择或拖入本机图片、视频，不能使用临时文件名');
  const name = value.split(/[\\/]/).at(-1) ?? '',
    ext = name.split('.').at(-1)?.toLowerCase() ?? '',
    mediaType = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
      ? 'image'
      : ['mp4', 'mov'].includes(ext)
        ? 'video'
        : throwRes('RESOURCE_FORMAT_INVALID', '支持 PNG、JPG、WEBP、GIF、MP4、MOV；本批次尚未添加');
  return ResourceMedia.parse({ kind: 'local', source: value, name, mediaType });
}
export function validateResourceRows(input: ResourceRowValue[]): ResourceRowValue[] {
  const rows = ResourceRows.parse(input);
  if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > RESOURCE_TABLE_BODY_LIMIT - 4096)
    throwRes('RESOURCE_TABLE_TOO_LARGE', '资源表超过4MiB，请拆分到不同组合');
  for (const row of rows) {
    for (const item of row.media) {
      const a = mediaReference(item.source);
      if (a.kind !== item.kind || a.mediaType !== item.mediaType || a.name !== item.name)
        throwRes('RESOURCE_REFERENCE_MISMATCH', '媒体引用与类型不一致');
    }
    if (row.media.length > 1 && row.media.some((item) => item.mediaType !== 'image'))
      throwRes('RESOURCE_MEDIA_MIXED', '一个帖子可以包含多张图片，视频需要独占一行');
  }
  return rows;
}
// Parse quoted Sheets TSV without interpreting formulas or HTML. Trailing clipboard newline is not a new row.
export function parseTsvClipboardMatrix(
  text: string,
  opts: {
    byteLimit: number;
    maxRows: number;
    maxCols?: number;
    strictQuotes?: boolean;
    maxColsMsg?: string;
    maxRowsMsg: string;
  },
): string[][] {
  if (new TextEncoder().encode(text).byteLength > opts.byteLimit)
    throw new ProductError('RESOURCE_TABLE_TOO_LARGE', '粘贴内容超过4MiB');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
    if (opts.maxCols !== undefined && row.length > opts.maxCols)
      throw new ProductError('RESOURCE_COLUMNS', opts.maxColsMsg ?? '列数超出限制');
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
    if (rows.length > opts.maxRows) throw new ProductError('RESOURCE_ROWS', opts.maxRowsMsg);
  };
  const isProperQuote = (s: string, start: number) => {
    for (let i = start + 1; i < s.length; i++) {
      if (s[i] !== '"') continue;
      if (s[i + 1] === '"') {
        i++;
        continue;
      }
      const nxt = s[i + 1];
      return nxt === undefined || nxt === '\t' || nxt === '\n';
    }
    return false;
  };
  const norm = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i] ?? '';
    if (quoted) {
      if (ch === '"' && norm[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else cell += ch;
    } else if (ch === '\t') endCell();
    else if (ch === '\n') endRow();
    else if (ch === '"' && !cell && (opts.strictQuotes ? !closed : isProperQuote(norm, i)))
      quoted = true;
    else {
      if (opts.strictQuotes && closed)
        throw new ProductError('RESOURCE_CLIPBOARD_INVALID', '粘贴内容的引号未正确闭合');
      cell += ch;
    }
  }
  if (opts.strictQuotes && quoted)
    throw new ProductError('RESOURCE_CLIPBOARD_INVALID', '粘贴内容的引号未正确闭合');
  if (cell || row.length || !rows.length || !norm.endsWith('\n')) endRow();
  return rows;
}
function expandClipboardMatrix(
  matrix: string[][],
  start: number,
  col: number,
  endRow: number,
  endCol: number,
  maxRows: number,
  maxCols: number,
  rangeMsg: string,
): string[][] {
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    col < 0 ||
    col > maxCols ||
    !Number.isInteger(endRow) ||
    !Number.isInteger(endCol) ||
    endRow < start ||
    endCol < col ||
    endRow >= maxRows ||
    endCol > maxCols ||
    start + matrix.length > maxRows
  )
    throw new ProductError('RESOURCE_RANGE', rangeMsg);
  const rc = endRow - start + 1,
    cc = endCol - col + 1;
  if (matrix.length === 1 && (endRow > start || endCol > col)) {
    const first = matrix[0] ?? [];
    if (first.length === 1)
      return Array.from({ length: rc }, () => Array.from({ length: cc }, () => first[0] ?? ''));
    if (endRow > start) return Array.from({ length: rc }, () => [...first]);
  } else if (matrix.length > 1 && matrix.every((r) => r.length === 1) && endCol > col) {
    return matrix.map((r) => Array.from({ length: cc }, () => r[0] ?? ''));
  }
  return matrix;
}
export function formatTsvMatrix<T>(
  rows: readonly T[],
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
  maxColBound: number,
  cellValue: (row: T, col: number) => string,
): string {
  if (
    ![minRow, maxRow, minCol, maxCol].every(Number.isInteger) ||
    minRow < 0 ||
    maxRow >= rows.length ||
    maxRow < minRow ||
    minCol < 0 ||
    maxCol > maxColBound ||
    maxCol < minCol
  )
    throw new ProductError('RESOURCE_RANGE', '复制范围无效');
  const q = (s: string) => (/[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return rows
    .slice(minRow, maxRow + 1)
    .map((r) =>
      Array.from({ length: maxCol - minCol + 1 }, (_, i) => q(cellValue(r, minCol + i))).join('\t'),
    )
    .join('\n');
}
export const parseResourceClipboard = (text: string): string[][] =>
  parseTsvClipboardMatrix(text, {
    byteLimit: RESOURCE_TABLE_BODY_LIMIT,
    maxRows: 1000,
    maxCols: 5,
    strictQuotes: true,
    maxColsMsg: '最多粘贴文案、媒体、背景、用途、AI声明五列',
    maxRowsMsg: '最多1000行',
  });
export function preparePasteGrid<Row>(
  input: readonly Row[],
  matrix: string[][],
  start: number,
  column: number,
  endRow: number,
  endColumn: number,
  maxRows: number,
  maxCols: number,
  rangeMsg: string,
  createRow: () => Row,
): { rows: Row[]; expanded: string[][] } {
  const expanded = expandClipboardMatrix(
      matrix,
      start,
      column,
      endRow,
      endColumn,
      maxRows,
      maxCols,
      rangeMsg,
    ),
    rows = structuredClone([...input]);
  while (rows.length < start + expanded.length) rows.push(createRow());
  return { rows, expanded };
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
  const { rows, expanded } = preparePasteGrid(
    input,
    parseResourceClipboard(text),
    start,
    column,
    endRow,
    endColumn,
    1000,
    4,
    '粘贴范围超过资源表容量',
    () => emptyResourceRow(createId()),
  );
  expanded.forEach((cells, offset) => {
    const row = rows[start + offset];
    if (!row) throw Error('RESOURCE_ROW_MISSING');
    cells.forEach((cell, cellOffset) => {
      const target = column + cellOffset;
      if (target > 4) throw new ProductError('RESOURCE_COLUMNS', '粘贴超过五列');
      if (target === 0) row.text = cell;
      else if (target === 1)
        row.media = cell.trim()
          ? cell
              .split('\n')
              .filter((v) => v.trim())
              .map(mediaReference)
          : [];
      else if (target === 2) row.background = parseResourceBackground(cell);
      else if (target === 3) row.purpose = parseResourcePurpose(cell);
      else row.aiLabel = parseResourceAILabel(cell);
    });
    if (row.media.length > 0) row.background = 'plain';
  });
  return validateResourceRows(rows);
}
const parseChoice = <T extends string>(
  raw: string,
  choices: ReadonlyArray<readonly [T, string]>,
  code: string,
  msg: string,
): T => {
  const v = raw.trim().toLowerCase();
  for (const [val, alts] of choices) if (alts.split('|').includes(v)) return val;
  throw new ProductError(code, msg);
};
export const parseResourceBackground = (raw: string): 'color' | 'plain' =>
  parseChoice(
    raw,
    [
      ['plain', '普通文字|文字|普通|白底|plain'],
      ['color', '彩贴|彩色|彩底|color|'],
    ],
    'RESOURCE_BACKGROUND',
    '背景列请填写“彩贴”或“普通文字”',
  );
export const parseResourcePurpose = (raw: string): 'post' | 'story' | 'both' =>
  parseChoice(
    raw,
    [
      ['story', '快拍|story'],
      ['both', '通用|两者通用|帖子及快拍|全部|both'],
      ['post', '帖子|发帖|post|'],
    ],
    'RESOURCE_PURPOSE',
    '用途列请填写“帖子”、“快拍”或“通用”',
  );
export const parseResourceAILabel = (raw: string): 'preserve-current' | 'on' | 'off' =>
  parseChoice(
    raw,
    [
      ['on', '开启|开启声明|是|声明|ai|on|true|1'],
      ['off', '关闭|关闭声明|否|不声明|off|false|0'],
      ['preserve-current', '默认|保持默认|保持|保持 facebook 当前设置|preserve-current|'],
    ],
    'RESOURCE_AI_LABEL',
    'AI 声明列请填写“开启”、“关闭”或“默认”',
  );
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
export const formatResourceCellsForClipboard = (
  rows: ResourceRowValue[],
  minRow: number,
  maxRow: number,
  minCol: number,
  maxCol: number,
) => formatTsvMatrix(rows, minRow, maxRow, minCol, maxCol, 4, resourceCellValue);
export function fillRowsWithMedia<Row extends { background: 'color' | 'plain' }, Item>(
  input: readonly Row[],
  start: number,
  items: readonly Item[],
  maxRows: number,
  createRow: () => Row,
  hasMedia: (row: Row) => boolean,
  assignItem: (row: Row, item: Item) => void,
): Row[] {
  if (!Number.isInteger(start) || start < 0 || start > input.length || !items.length)
    throw new ProductError('RESOURCE_RANGE', '请选择媒体填充起始行');
  const rows = structuredClone([...input]);
  let cursor = start;
  for (const item of items) {
    while (cursor < rows.length) {
      const candidate = rows[cursor];
      if (!candidate || !hasMedia(candidate)) break;
      cursor++;
    }
    if (cursor >= maxRows)
      throw new ProductError(
        'RESOURCE_ROWS',
        maxRows === 500 ? '最多 500 行，本批次尚未添加' : `最多${maxRows}行，本批次尚未添加`,
      );
    while (rows.length <= cursor) rows.push(createRow());
    const row = rows[cursor];
    if (!row) throw Error('RESOURCE_ROW_MISSING');
    assignItem(row, item);
    row.background = 'plain';
    cursor++;
  }
  return rows;
}
export function fillResourceMedia(
  input: ResourceRowValue[],
  start: number,
  media: ResourceMediaValue[],
  createId: () => string,
): ResourceRowValue[] {
  return validateResourceRows(
    fillRowsWithMedia(
      input,
      start,
      media,
      1000,
      () => emptyResourceRow(createId()),
      (r) => r.media.length > 0,
      (r, item) => {
        r.media = [item];
      },
    ),
  );
}
