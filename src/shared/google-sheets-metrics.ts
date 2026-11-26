import { extractFacebookGroupId, extractFacebookPageId } from './facebook-target-id.js';
export const extractFacebookTargetId = (raw: string, kind: 'group' | 'page'): string => {
  const t = raw.trim();
  return !t ? '' : kind === 'group' ? extractFacebookGroupId(t) : extractFacebookPageId(t);
};
type SheetPollingMode = 'idle' | 'active' | 'semi_active';
export const sanitizeSheetCellValue = (value: string): string =>
  /^\d{11,}$/.test(value.trim()) ? `'${value.trim()}` : value;
export const isScientificNotationCell = (raw: string): boolean =>
  /^\s*\d+(?:\.\d+)?e[+-]\d+\s*$/i.test(raw);
type LibrarySyncRowInput = {
  rowNumber: number;
  values: string[];
  displayValues?: string[];
  isHintRow: boolean;
};
type LocalLibraryItem = {
  id: string;
  category: string;
  name: string;
  avatarCellValue: string;
};
type LibrarySyncDiffPlan = {
  cellUpdates: Array<{ rowNumber: number; colIndex: number; value: string }>;
  appends: string[][];
  deleteRowNumbersDesc: number[];
  stats: { updated: number; added: number; deleted: number; unchanged: number };
};
export function computeLibrarySyncDiff({
  sheetRows,
  localItems,
  columns,
  kind,
}: {
  sheetRows: readonly LibrarySyncRowInput[];
  localItems: readonly LocalLibraryItem[];
  columns: { category: number; id: number; name: number; avatar: number };
  kind: 'group' | 'page';
}): LibrarySyncDiffPlan {
  const idOf = (raw: string) => extractFacebookTargetId(raw, kind).toLowerCase(),
    localById = new Map(
      localItems.map((i) => [idOf(i.id), i] as const).filter(([k]) => Boolean(k)),
    ),
    matched = new Set<string>(),
    cellUpdates: LibrarySyncDiffPlan['cellUpdates'] = [],
    deleteRowNumbersDesc: number[] = [];
  let updated = 0,
    unchanged = 0;
  for (const row of sheetRows) {
    if (row.isHintRow) continue;
    const key = idOf(columns.id >= 0 ? (row.values[columns.id] ?? '') : '');
    if (!key) continue;
    const local = localById.get(key);
    if (!local || matched.has(key)) {
      deleteRowNumbersDesc.push(row.rowNumber);
      continue;
    }
    matched.add(key);
    let rowChanged = false;
    const setCol = (colIndex: number, desired: string, force = false) => {
      if (colIndex >= 0 && (force || (row.values[colIndex] ?? '').trim() !== desired.trim())) {
        cellUpdates.push({ rowNumber: row.rowNumber, colIndex, value: desired });
        rowChanged = true;
      }
    };
    setCol(columns.category, local.category);
    setCol(
      columns.id,
      local.id,
      columns.id >= 0 && isScientificNotationCell((row.displayValues?.[columns.id] ?? '').trim()),
    );
    setCol(columns.name, local.name);
    if (local.avatarCellValue) setCol(columns.avatar, local.avatarCellValue);
    if (rowChanged) updated++;
    else unchanged++;
  }
  const colValues = (item: LocalLibraryItem) =>
      [
        [columns.category, item.category],
        [columns.id, item.id],
        [columns.name, item.name],
        [columns.avatar, item.avatarCellValue],
      ] as const,
    maxCol = Math.max(columns.category, columns.id, columns.name, columns.avatar, 0),
    appends = localItems
      .filter((i) => {
        const k = idOf(i.id);
        return Boolean(k && !matched.has(k));
      })
      .map((item) => {
        const cells = new Array<string>(maxCol + 1).fill('');
        for (const [col, val] of colValues(item)) if (col >= 0) cells[col] = val;
        return cells;
      });
  return {
    cellUpdates,
    appends,
    deleteRowNumbersDesc: deleteRowNumbersDesc.sort((a, b) => b - a),
    stats: { updated, added: appends.length, deleted: deleteRowNumbersDesc.length, unchanged },
  };
}
export function evaluateMetricsEligibility(
  postedAtMs: number | null,
  metricsStage: number,
  nowMs = Date.now(),
  maxAgeHours?: number,
): '24h' | '72h' | null {
  if (!postedAtMs || !Number.isFinite(postedAtMs) || postedAtMs <= 0) return null;
  const ageHours = (nowMs - postedAtMs) / 3_600_000;
  if (typeof maxAgeHours === 'number' && maxAgeHours > 0 && ageHours > maxAgeHours) return null;
  return metricsStage <= 0 && ageHours >= 24
    ? '24h'
    : metricsStage === 1 && ageHours >= 72
      ? '72h'
      : null;
}
export function nextTieredPollingState(input: {
  currentMode: SheetPollingMode;
  consecutiveIdlePolls: number;
  hasNewActivity: boolean;
  activePollMinutes: number;
  semiActivePollMinutes: number;
  semiActiveAfterIdlePolls: number;
  nowMs?: number;
}): { pollingMode: SheetPollingMode; consecutiveIdlePolls: number; nextPollAt: number } {
  const now = input.nowMs ?? Date.now(),
    nextIdle = input.hasNewActivity ? 0 : input.consecutiveIdlePolls + 1,
    semi =
      !input.hasNewActivity &&
      (input.currentMode === 'semi_active' ||
        nextIdle >= Math.max(1, input.semiActiveAfterIdlePolls));
  return {
    pollingMode: semi ? 'semi_active' : 'active',
    consecutiveIdlePolls: nextIdle,
    nextPollAt:
      now +
      (semi ? Math.max(2, input.semiActivePollMinutes) : Math.max(1, input.activePollMinutes)) *
        60_000,
  };
}
export function extractFacebookPostIdFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim()),
      m =
        /\/(?:posts|permalink|videos|reel|reels|watch)\/(\d{1,30})/i.exec(u.pathname) ??
        /\/(?:posts|permalink)\/(pfbid[A-Za-z0-9]+)/i.exec(u.pathname),
      queryId =
        m?.[1] ??
        u.searchParams.get('story_fbid') ??
        u.searchParams.get('fbid') ??
        (/^\/watch\/?$/i.test(u.pathname) ? u.searchParams.get('v') : null);
    return queryId && /^(?:\d{1,30}|pfbid[A-Za-z0-9]+)$/i.test(queryId) ? queryId : null;
  } catch {
    return null;
  }
}
export function isDirectFacebookPostUrl(rawUrl: string | null | undefined): boolean {
  const t = rawUrl?.trim() ?? '';
  if (!/^https?:\/\//i.test(t)) return false;
  try {
    const u = new URL(t),
      host = u.hostname.toLowerCase();
    return (
      (/(?:^|\.)(?:facebook\.com|fb\.com)$/.test(host) || host === 'fb.watch') &&
      !/^\/(?:login|checkpoint|recover|home\.php|me)(?:\/|$)/i.test(u.pathname) &&
      ((host === 'fb.watch' && /^\/[A-Za-z0-9_-]{4,}\/?$/.test(u.pathname)) ||
        /^\/share\/[pvr]\/[A-Za-z0-9_-]{4,}\/?$/i.test(u.pathname) ||
        extractFacebookPostIdFromUrl(t) !== null)
    );
  } catch {
    return false;
  }
}
export function inferBumperSourceMode(input: {
  groupId?: string | null | undefined;
  postUrl?: string | null | undefined;
}): 'group' | 'page' {
  if (/\/groups\/[^/]+\//i.test((input.postUrl ?? '').trim())) return 'group';
  const gid = (input.groupId ?? '').trim();
  return !gid || gid === '-' || gid === '__page_timeline__' ? 'page' : 'group';
}
export function extractGroupIdFromPostUrl(rawUrl: string): string | null {
  try {
    const m = /^\/groups\/([^/]+)\//i.exec(new URL(rawUrl.trim()).pathname);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}
