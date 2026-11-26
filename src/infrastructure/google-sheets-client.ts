import { ProductError } from '../domain/workspace.js';
import type {
  GoogleOAuthPort,
  GoogleSheetsApiPort,
  SheetValuesDualRead,
} from '../application/google-sheets-ports.js';
import {
  columnIndexToA1,
  normalizeHeaderKey,
  sanitizeSheetCellValue,
  type SpreadsheetMeta,
} from '../shared/google-sheets.js';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('ABORTED'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('ABORTED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
const quoteSheetName = (name: string) => `'${name.replace(/'/g, "''")}'`;
function normalizeGridRows(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
      : [],
  );
}
export class GoogleSheetsRestClient implements GoogleSheetsApiPort {
  constructor(
    private readonly oauth: GoogleOAuthPort,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async requestJson<T>(
    url: string,
    init: RequestInit = {},
    attempt = 0,
    refreshedAuth = false,
    options?: { idempotent?: boolean | undefined },
  ): Promise<T> {
    const token = await this.oauth.getValidAccessToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type'))
      headers.set('content-type', 'application/json; charset=utf-8');
    const signal = init.signal ?? AbortSignal.timeout(30_000);
    const idempotent = options?.idempotent ?? (init.method ?? 'GET').toUpperCase() === 'GET';
    const retryAfter = async (baseMs: number, jitterMs: number) => {
      await sleepAbortable(
        Math.min(15_000, baseMs + Math.floor(Math.random() * jitterMs)),
        init.signal,
      );
      return this.requestJson<T>(url, init, attempt + 1, refreshedAuth, options);
    };
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { ...init, headers, signal });
    } catch (netErr) {
      if (idempotent && attempt < 3 && !init.signal?.aborted)
        return retryAfter(800 * 2 ** attempt, 250);
      throw netErr;
    }
    if (resp.status === 401 && !refreshedAuth && this.oauth.invalidateAccessToken) {
      await resp.body?.cancel().catch(() => {});
      await this.oauth.invalidateAccessToken(token);
      return this.requestJson<T>(url, init, attempt, true, options);
    }
    if (
      (resp.status === 429 || (resp.status >= 500 && idempotent)) &&
      attempt < 4 &&
      !init.signal?.aborted
    ) {
      await resp.body?.cancel().catch(() => {});
      const retryRaw = resp.headers.get('retry-after')?.trim() ?? '';
      return retryAfter(
        /^\d+$/.test(retryRaw) ? Number(retryRaw) * 1000 : 1000 * 2 ** attempt,
        350,
      );
    }
    const rawText = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {}
    if (!resp.ok) {
      const errObj =
        parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as Record<string, unknown>)
          : undefined;
      const errMsg =
        typeof errObj?.message === 'string'
          ? errObj.message
          : rawText.slice(0, 200) || `HTTP ${resp.status}`;
      if (resp.status === 403)
        throw new ProductError(
          'GOOGLE_SHEETS_FORBIDDEN',
          `无权访问该 Google 表格（请确认已用当前授权 Gmail 拥有编辑权限）：${errMsg}`,
          403,
        );
      if (resp.status === 404)
        throw new ProductError(
          'GOOGLE_SHEETS_NOT_FOUND',
          `找不到该 Google 表格或工作表标签：${errMsg}`,
          404,
        );
      throw new ProductError(
        'GOOGLE_SHEETS_API_ERROR',
        `Google Sheets 接口错误 (${resp.status})：${errMsg}`,
        resp.status >= 400 && resp.status < 500 ? resp.status : 502,
      );
    }
    return parsed as T;
  }
  private async readValuesRange(
    spreadsheetId: string,
    range: string,
    renderOption: 'FORMULA' | 'FORMATTED_VALUE',
  ): Promise<string[][]> {
    const res = await this.requestJson<{ values?: unknown }>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=${renderOption}`,
    );
    return normalizeGridRows(res.values);
  }
  async getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta> {
    const fields =
      'spreadsheetId,spreadsheetUrl,properties.title,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))';
    const data = await this.requestJson<{
      spreadsheetId?: string;
      spreadsheetUrl?: string;
      properties?: { title?: string };
      sheets?: Array<{
        properties?: {
          sheetId?: number;
          title?: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }>;
    }>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    );
    const tabs = (data.sheets ?? [])
      .map((s) => s.properties)
      .filter((p): p is NonNullable<typeof p> => Boolean(p && typeof p.title === 'string'))
      .map((p) => ({
        sheetId: Number(p.sheetId ?? 0),
        title: p.title ?? '',
        rowCount: Number(p.gridProperties?.rowCount ?? 0),
        columnCount: Number(p.gridProperties?.columnCount ?? 0),
      }));
    return {
      spreadsheetId: data.spreadsheetId ?? spreadsheetId,
      title: data.properties?.title ?? spreadsheetId,
      url:
        data.spreadsheetUrl ??
        `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
      tabs,
    };
  }
  async readSheetValues(spreadsheetId: string, sheetName: string): Promise<SheetValuesDualRead> {
    const range = `${quoteSheetName(sheetName)}!A:ZZ`;
    const [formulaRows, formattedRows] = await Promise.all([
      this.readValuesRange(spreadsheetId, range, 'FORMULA'),
      this.readValuesRange(spreadsheetId, range, 'FORMATTED_VALUE'),
    ]);
    return { formulaRows, formattedRows };
  }
  async readHeaderRow(spreadsheetId: string, sheetName: string): Promise<string[]> {
    return (
      (
        await this.readValuesRange(
          spreadsheetId,
          `${quoteSheetName(sheetName)}!1:1`,
          'FORMATTED_VALUE',
        )
      )[0] ?? []
    );
  }
  async readColumnValues(
    spreadsheetId: string,
    sheetName: string,
    colIndex: number,
  ): Promise<string[]> {
    if (colIndex < 0) return [];
    const col = columnIndexToA1(colIndex);
    return (
      await this.readValuesRange(
        spreadsheetId,
        `${quoteSheetName(sheetName)}!${col}:${col}`,
        'FORMATTED_VALUE',
      )
    ).map((r) => (r[0] ?? '').trim());
  }
  async batchUpdateCells(
    spreadsheetId: string,
    sheetName: string,
    updates: ReadonlyArray<{ rowNumber: number; colIndex: number; value: string }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    const quoted = quoteSheetName(sheetName);
    for (let i = 0; i < updates.length; i += 200) {
      const data = updates.slice(i, i + 200).map((item) => ({
        range: `${quoted}!${columnIndexToA1(item.colIndex)}${item.rowNumber}`,
        values: [[sanitizeSheetCellValue(item.value)]],
      }));
      await this.requestJson(
        `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        {
          method: 'POST',
          body: JSON.stringify({
            valueInputOption: 'USER_ENTERED',
            includeValuesInResponse: false,
            data,
          }),
        },
        0,
        false,
        { idempotent: true },
      );
    }
  }
  async appendRows(
    spreadsheetId: string,
    sheetName: string,
    rows: readonly (readonly (string | null)[])[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const range = `${quoteSheetName(sheetName)}!A1`;
    const sanitizedRows = rows.map((row) =>
      row.map((cell) => (cell === null ? null : sanitizeSheetCellValue(cell))),
    );
    await this.requestJson(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values: sanitizedRows }) },
      0,
      false,
      { idempotent: false },
    );
  }
  async deleteRowsDescending(
    spreadsheetId: string,
    numericSheetId: number,
    rowNumbersDesc: readonly number[],
  ): Promise<void> {
    const sorted = [...new Set(rowNumbersDesc)].filter((n) => n >= 2).sort((a, b) => b - a);
    if (sorted.length === 0) return;
    const ranges: Array<{ startIndex: number; endIndex: number }> = [];
    let rangeEnd = sorted[0] ?? 2;
    let rangeStart = rangeEnd - 1;
    for (let i = 1; i < sorted.length; i++) {
      const rowNum = sorted[i] ?? 2;
      if (rowNum === rangeStart) rangeStart = rowNum - 1;
      else {
        ranges.push({ startIndex: rangeStart, endIndex: rangeEnd });
        rangeEnd = rowNum;
        rangeStart = rowNum - 1;
      }
    }
    ranges.push({ startIndex: rangeStart, endIndex: rangeEnd });
    await this.requestJson(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: ranges.map((r) => ({
            deleteDimension: {
              range: {
                sheetId: numericSheetId,
                dimension: 'ROWS',
                startIndex: r.startIndex,
                endIndex: r.endIndex,
              },
            },
          })),
        }),
      },
      0,
      false,
      { idempotent: false },
    );
  }
  async ensureHeaderColumn(
    spreadsheetId: string,
    sheetName: string,
    headers: readonly string[],
    columnTitle: string,
  ): Promise<number> {
    const trimmed = columnTitle.trim();
    const targetNorm = normalizeHeaderKey(trimmed);
    const findMatch = (row: readonly string[]) =>
      row.findIndex((h) => {
        const clean = h.trim();
        return (
          clean.toLowerCase() === trimmed.toLowerCase() ||
          (targetNorm.length > 0 && normalizeHeaderKey(clean) === targetNorm)
        );
      });
    const existingIdx = findMatch(headers);
    if (existingIdx >= 0) return existingIdx;
    let currentHeaders: readonly string[] = headers;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (typeof this.readHeaderRow === 'function') {
        const fresh = await this.readHeaderRow(spreadsheetId, sheetName).catch(() => null);
        if (fresh) {
          currentHeaders = fresh;
          const freshIdx = findMatch(currentHeaders);
          if (freshIdx >= 0) return freshIdx;
        }
      }
      let lastNonEmpty = -1;
      for (let i = 0; i < currentHeaders.length; i++)
        if ((currentHeaders[i] ?? '').trim()) lastNonEmpty = i;
      const targetCol = Math.max(lastNonEmpty + 1, currentHeaders.length);
      await this.batchUpdateCells(spreadsheetId, sheetName, [
        { rowNumber: 1, colIndex: targetCol, value: trimmed },
      ]);
      if (typeof this.readHeaderRow !== 'function') return targetCol;
      const verified = await this.readHeaderRow(spreadsheetId, sheetName).catch(() => null);
      if (!verified) return targetCol;
      const verifiedIdx = findMatch(verified);
      if (verifiedIdx >= 0) return verifiedIdx;
      currentHeaders = verified;
    }
    return currentHeaders.length;
  }
}
