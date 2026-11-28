import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
export type ExcelTemporalKind = 'date' | 'time' | 'datetime';
export interface TableReadOptions {
  sheet?: string | number | undefined;
  hasHeader?: boolean | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}
export interface TableReadResult {
  filePath: string;
  format: 'xlsx' | 'csv' | 'tsv' | 'json';
  sheetNames: string[];
  selectedSheet: string | null;
  headers: string[];
  totalRows: number;
  offset: number;
  returnedRows: number;
  hasMore: boolean;
  rows: Array<Record<string, string>>;
}
const DATE_FMTS = new Set([14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 57, 58]);
const TIME_FMTS = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);
const pad2 = (n: number) => String(n).padStart(2, '0');
const xmlAttr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
const XML_ENT: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
const unescapeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16) || 0))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10) || 0))
    .replace(/&(quot|apos|lt|gt|amp);/g, (_, k: string) => XML_ENT[k] ?? '');
const extractTextTags = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1] ?? '')).join('');
const clipCell = (v: unknown, max = 2000) => {
  const s =
    v == null
      ? ''
      : typeof v === 'string'
        ? v.trim()
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
async function readZipEntriesAsUtf8(filePath: string, predicate: (fileName: string) => boolean) {
  const zip = await new Promise<ZipFile>((res, rej) =>
    openZip(filePath, { lazyEntries: true, autoClose: true }, (e, z) =>
      e || !z ? rej(e ?? new Error('XLSX_OPEN_FAILED')) : res(z),
    ),
  );
  const out = new Map<string, string>();
  await new Promise<void>((res, rej) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {}
      rej(err instanceof Error ? err : new Error(String(err)));
    };
    zip
      .on('error', fail)
      .on('end', () => !settled && ((settled = true), res()))
      .on('entry', (entry: Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (!predicate(name) || name.endsWith('/')) return zip.readEntry();
        if (entry.uncompressedSize > 32 * 1024 * 1024)
          return fail(new Error(`XLSX_ENTRY_TOO_LARGE: ${name}`));
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return fail(err ?? new Error(`XLSX_STREAM_FAILED: ${name}`));
          const chunks: Buffer[] = [];
          stream
            .on('data', (c: Buffer) => chunks.push(c))
            .on('error', fail)
            .on(
              'end',
              () => (out.set(name, Buffer.concat(chunks).toString('utf8')), zip.readEntry()),
            );
        });
      });
    zip.readEntry();
  });
  return out;
}
function parseStylesTemporalMap(stylesXml: string): Array<ExcelTemporalKind | null> {
  if (!stylesXml) return [];
  const custom = new Map<number, ExcelTemporalKind | null>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = parseInt(xmlAttr(m[1] ?? '', 'numFmtId') ?? '', 10);
    const code = xmlAttr(m[1] ?? '', 'formatCode');
    if (!Number.isFinite(id) || code === undefined) continue;
    const cleaned = (unescapeXml(code).split(';')[0] ?? '')
      .trim()
      .replace(/"[^"]*"|\\.|_.|\*.|\[(?![hmsHMS]+\])[^\]]*\]/g, '')
      .trim();
    if (!cleaned || /[#%?]|0\.0|e[+-]/i.test(cleaned)) custom.set(id, null);
    else {
      const d = /[yd年日]/i.test(cleaned);
      const t = /[hs时分秒]|am\/pm|a\/p|\[[hms]+\]/i.test(cleaned);
      const mo = !t && /m|月/i.test(cleaned);
      custom.set(id, (d || mo) && t ? 'datetime' : d || mo ? 'date' : t ? 'time' : null);
    }
  }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  return [...block.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)].map((m) => {
    const nfId = parseInt(xmlAttr(m[1] ?? '', 'numFmtId') ?? '0', 10);
    if (custom.has(nfId)) return custom.get(nfId) ?? null;
    return nfId === 22
      ? 'datetime'
      : DATE_FMTS.has(nfId)
        ? 'date'
        : TIME_FMTS.has(nfId)
          ? 'time'
          : null;
  });
}
export function formatExcelSerialValue(
  serial: number,
  kind: ExcelTemporalKind,
  date1904 = false,
): string {
  if (!Number.isFinite(serial) || serial < 0) return String(serial);
  const totalSec = Math.round(serial * 86_400);
  const fmtHms = (s: number) =>
    `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}${s % 60 === 0 ? '' : `:${pad2(s % 60)}`}`;
  if (kind === 'time' || serial < 1) return fmtHms(((totalSec % 86_400) + 86_400) % 86_400);
  const wholeDays = Math.floor(totalSec / 86_400);
  const remSec = totalSec % 86_400;
  const base = date1904
    ? Date.UTC(1904, 0, 1)
    : Date.UTC(1899, 11, 31) - (wholeDays > 60 ? 86_400_000 : 0);
  const dt = new Date(base + wholeDays * 86_400_000);
  const datePart = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  return kind === 'date' && remSec === 0 ? datePart : `${datePart} ${fmtHms(remSec)}`;
}
function parseWorksheetXml(
  xml: string,
  shared: readonly string[],
  styles: readonly (ExcelTemporalKind | null)[],
  date1904: boolean,
): string[][] {
  const rows: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [attrs, inner] = [cm[1] ?? '', cm[2] ?? ''];
      const colRef = /\br="([A-Za-z]+)\d+"/.exec(attrs)?.[1];
      let colIdx = nextCol;
      if (colRef) {
        let c = 0;
        for (const ch of colRef.toUpperCase())
          if (ch >= 'A' && ch <= 'Z') c = c * 26 + (ch.charCodeAt(0) - 64);
        colIdx = Math.max(0, c - 1);
      }
      nextCol = colIdx + 1;
      const t = xmlAttr(attrs, 't') ?? '';
      const sIdx = parseInt(xmlAttr(attrs, 's') ?? '-1', 10);
      let val = '';
      if (t === 'inlineStr') val = extractTextTags(inner);
      else {
        const rawV = unescapeXml(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
        if (t === 's') val = shared[parseInt(rawV, 10)] ?? '';
        else if (t === 'b') val = rawV === '1' ? 'TRUE' : rawV === '0' ? 'FALSE' : rawV;
        else if ((t === '' || t === 'n') && rawV !== '' && sIdx >= 0) {
          const kind = styles[sIdx] ?? null;
          const num = Number(rawV);
          val =
            kind && Number.isFinite(num) && num >= 0 && num < 2958466
              ? formatExcelSerialValue(num, kind, date1904)
              : rawV;
        } else val = rawV;
      }
      while (cells.length < colIdx) cells.push('');
      cells[colIdx] = val.trim();
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}
function parseDelimitedText(text: string, delimiter: string): string[][] {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let [row, cell, inQ] = [[] as string[], '', false];
  const flush = () => (
    row.push(cell.trim()),
    (cell = ''),
    row.some(Boolean) && rows.push(row),
    (row = [])
  );
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQ) {
      if (ch === '"' && cleaned[i + 1] === '"') [cell, i] = [cell + '"', i + 1];
      else if (ch === '"') inQ = false;
      else cell += ch ?? '';
    } else if (ch === '"') inQ = true;
    else if (ch === delimiter) [row, cell] = [[...row, cell.trim()], ''];
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && cleaned[i + 1] === '\n') i++;
      flush();
    } else cell += ch ?? '';
  }
  flush();
  return rows;
}
async function readXlsxGrid(resolved: string, sheetOpt?: string | number) {
  const need = new Set([
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/sharedStrings.xml',
    'xl/styles.xml',
  ]);
  const entries = await readZipEntriesAsUtf8(
    resolved,
    (n) => need.has(n) || /^xl\/worksheets\/[^/]+\.xml$/i.test(n),
  );
  const wbXml = entries.get('xl/workbook.xml') ?? '';
  const shared = [
    ...(entries.get('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g),
  ].map((m) => extractTextTags((m[1] ?? '').replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')));
  const styles = parseStylesTemporalMap(entries.get('xl/styles.xml') ?? '');
  const relMap = new Map<string, string>();
  for (const m of (entries.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b([^>]*?)\/?>/g,
  )) {
    const [id, tgt] = [
      xmlAttr(m[1] ?? '', 'Id'),
      xmlAttr(m[1] ?? '', 'Target')?.replace(/^\/+/, ''),
    ];
    if (id && tgt) relMap.set(id, tgt.startsWith('xl/') ? tgt : `xl/${tgt}`);
  }
  const sheets = [...wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m, i) => {
    const [attrs, rawName, rId] = [
      m[1] ?? '',
      xmlAttr(m[1] ?? '', 'name'),
      xmlAttr(m[1] ?? '', 'r:id'),
    ];
    void attrs;
    return {
      name: rawName ? unescapeXml(rawName) : `Sheet${i + 1}`,
      entryName: (rId ? relMap.get(rId) : undefined) ?? `xl/worksheets/sheet${i + 1}.xml`,
    };
  });
  if (sheets.length === 0)
    [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/i.test(k))
      .sort()
      .forEach((entryName, i) => sheets.push({ name: `Sheet${i + 1}`, entryName }));
  let chosen = typeof sheetOpt === 'number' ? (sheets[sheetOpt] ?? sheets[0]) : sheets[0];
  if (typeof sheetOpt === 'string' && sheetOpt.trim()) {
    const w = sheetOpt.trim().toLowerCase();
    chosen =
      sheets.find((s) => s.name.toLowerCase() === w) ??
      sheets.find((s) => s.name.toLowerCase().includes(w)) ??
      sheets[0];
  }
  if (!chosen) throw new Error('XLSX_NO_WORKSHEET: Excel 文件中未找到工作表');
  return {
    sheetNames: sheets.map((s) => s.name),
    selectedSheet: chosen.name,
    rawGrid: parseWorksheetXml(
      entries.get(chosen.entryName) ?? '',
      shared,
      styles,
      /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(wbXml),
    ),
  };
}
export async function readSpreadsheetOrTableFile(
  rawFilePath: string,
  options?: TableReadOptions,
): Promise<TableReadResult> {
  const resolved = path.resolve(rawFilePath.trim());
  if ((await lstat(resolved)).isSymbolicLink()) throw new Error(`SYMLINK_REJECTED: "${resolved}"`);
  const fsStat = await stat(resolved);
  if (!fsStat.isFile()) throw new Error(`NOT_A_FILE: "${resolved}"`);
  if (fsStat.size > 32 * 1024 * 1024) throw new Error(`FILE_TOO_LARGE: ${fsStat.size} bytes`);
  const ext = path.extname(resolved).toLowerCase();
  if (!new Set(['.xlsx', '.csv', '.tsv', '.json', '.jsonl', '.txt']).has(ext))
    throw new Error(`UNSUPPORTED_TABLE_FILE: "${ext || '(无扩展名)'}"`);
  const [hasHeader, offset, limit] = [
    options?.hasHeader !== false,
    Math.max(0, Math.floor(options?.offset ?? 0)),
    Math.max(1, Math.min(1000, Math.floor(options?.limit ?? 200))),
  ];
  const build = (
    format: TableReadResult['format'],
    sheetNames: string[],
    selectedSheet: string | null,
    headers: string[],
    allRows: Array<Record<string, string>>,
  ): TableReadResult => {
    const rows = allRows.slice(offset, offset + limit);
    return {
      filePath: resolved,
      format,
      sheetNames,
      selectedSheet,
      headers,
      totalRows: allRows.length,
      offset,
      returnedRows: rows.length,
      hasMore: offset + rows.length < allRows.length,
      rows,
    };
  };
  if (ext === '.json' || ext === '.jsonl') {
    const content = await readFile(resolved, 'utf8');
    const root =
      ext === '.jsonl'
        ? content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l) as unknown)
        : (JSON.parse(content) as unknown);
    const items = Array.isArray(root)
      ? root
      : typeof root === 'object' &&
          root !== null &&
          Array.isArray((root as { rows?: unknown }).rows)
        ? (root as { rows: unknown[] }).rows
        : [root];
    const hSet = new Set<string>();
    const rows: Array<Record<string, string>> = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const rec: Record<string, string> = {};
      const pairs = Array.isArray(item)
        ? item.map((c, i) => [`col_${i + 1}`, c] as const)
        : Object.entries(item as Record<string, unknown>);
      for (const [k, v] of pairs) {
        hSet.add(k);
        rec[k] = clipCell(v);
      }
      rows.push(rec);
    }
    return build('json', [], null, [...hSet], rows);
  }
  let rawGrid: string[][] = [];
  let format: 'xlsx' | 'csv' | 'tsv' = 'csv';
  let sheetNames: string[] = [];
  let selectedSheet: string | null = null;
  if (ext === '.xlsx') {
    format = 'xlsx';
    ({ sheetNames, selectedSheet, rawGrid } = await readXlsxGrid(resolved, options?.sheet));
  } else {
    const content = await readFile(resolved, 'utf8');
    const first = content.split(/\r?\n/)[0] ?? '';
    const delim =
      ext === '.tsv' || (first.match(/\t/g) ?? []).length > (first.match(/,/g) ?? []).length
        ? '\t'
        : ',';
    format = delim === '\t' ? 'tsv' : 'csv';
    rawGrid = parseDelimitedText(content, delim);
  }
  if (rawGrid.length === 0) return build(format, sheetNames, selectedSheet, [], []);
  const maxCols = rawGrid.reduce((acc, r) => Math.max(acc, r.length), 0);
  const rawHeaders = hasHeader ? (rawGrid[0] ?? []) : [];
  const headers: string[] = [];
  const used = new Set<string>();
  for (let c = 0; c < maxCols; c++) {
    const base = (rawHeaders[c] ?? '').trim() || `col_${c + 1}`;
    let u = base;
    for (let s = 2; used.has(u); s++) u = `${base}_${s}`;
    used.add(u);
    headers.push(u);
  }
  const rows = (hasHeader ? rawGrid.slice(1) : rawGrid).map((cells, i) => {
    const obj: Record<string, string> = { _rowNumber: String(hasHeader ? i + 2 : i + 1) };
    headers.forEach((h, c) => (obj[h] = clipCell(cells[c] ?? '')));
    return obj;
  });
  return build(format, sheetNames, selectedSheet, headers, rows);
}
