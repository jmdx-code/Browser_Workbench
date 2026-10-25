import {
  MaterialArrangementRequest,
  type Arrangement,
  type ArrangementRequest,
} from '../shared/material-arrangement.js';
import { BROWSER_TEXT_INPUT_LIMIT } from '../shared/browser-actions.js';
import { ProductError } from './workspace.js';

export function arrangeMaterial(
  request: ArrangementRequest,
  candidates: Arrangement['candidates'],
): Pick<Arrangement, 'rows' | 'missing' | 'conflicted'> {
  const input = MaterialArrangementRequest.parse(request);
  const first = new Map<string, number>();
  candidates.forEach((item, index) => {
    if (!first.has(item.source)) first.set(item.source, index);
  });
  const pool = [...first.values()];
  const rows: Arrangement['rows'] = [];
  for (const [profileIndex, profileId] of input.profileIds.entries()) {
    for (let ordinal = 1; ordinal <= input.count; ordinal++) {
      const offset = input.allowRepeat
        ? pool.length
          ? (ordinal - 1) % pool.length
          : 0
        : profileIndex * input.count + ordinal - 1;
      rows.push({ profileId, ordinal, sourceIndex: pool[offset] ?? null, blockers: [] });
    }
  }
  const byKey = new Map(rows.map((row) => [row.profileId + ':' + row.ordinal, row]));
  const changed = new Set<string>();
  for (const override of input.overrides ?? []) {
    const key = override.profileId + ':' + override.ordinal;
    const row = byKey.get(key);
    if (
      !row ||
      changed.has(key) ||
      (override.sourceIndex !== null && !candidates[override.sourceIndex])
    )
      throw new ProductError(
        'MATERIAL_ARRANGEMENT_OVERRIDE_INVALID',
        '调整行或素材已不在当前范围',
        400,
      );
    changed.add(key);
    row.sourceIndex = override.sourceIndex;
  }
  const global = new Map<string, number>(),
    local = new Map<string, number>();
  for (const row of rows) {
    const item = row.sourceIndex === null ? null : candidates[row.sourceIndex];
    if (!item) continue;
    global.set(item.source, (global.get(item.source) ?? 0) + 1);
    const key = row.profileId + ':' + item.source;
    local.set(key, (local.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    const item = row.sourceIndex === null ? null : candidates[row.sourceIndex];
    if (!item) {
      row.blockers.push('MISSING_CONTENT');
      continue;
    }
    if (item.textLength > BROWSER_TEXT_INPUT_LIMIT) row.blockers.push('TEXT_INPUT_LIMIT');
    if (!input.allowRepeat && (global.get(item.source) ?? 0) > 1)
      row.blockers.push('DUPLICATE_CONTENT');
    if (!input.allowRepeat && (local.get(row.profileId + ':' + item.source) ?? 0) > 1)
      row.blockers.push('SAME_PROFILE_CONTENT_REPEATED');
  }
  return {
    rows,
    missing: rows.filter((row) => row.sourceIndex === null).length,
    conflicted: rows.filter((row) => row.blockers.some((blocker) => blocker !== 'MISSING_CONTENT'))
      .length,
  };
}
