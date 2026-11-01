import type { TargetFolder } from '../shared/target-list.js';
export interface FinderItem {
  id: string;
  name: string;
  folderId: string | null;
  sortOrder: number;
  avatarUrl: string | null;
  count: number;
}
export function orderedFinderItems<T extends { folderId?: string | null; sortOrder?: number }>(
  items: T[],
  folders: TargetFolder[],
): T[] {
  const rank = new Map(folders.map((f, i) => [f.id, i]));
  return [...items].sort(
    (a, b) =>
      (rank.get(a.folderId ?? '') ?? folders.length) -
        (rank.get(b.folderId ?? '') ?? folders.length) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
}
export function insertFinderIds(
  existing: string[],
  moved: string[],
  target?: string,
  after = false,
) {
  const drag = new Set(moved),
    rest = existing.filter((id) => !drag.has(id));
  const at = target ? rest.indexOf(target) : -1;
  rest.splice(at < 0 ? rest.length : at + (after ? 1 : 0), 0, ...moved);
  return rest;
}
export function nudgeFinderIds(ids: string[], selected: ReadonlySet<string>, direction: -1 | 1) {
  const next = [...ids];
  if (direction === -1) {
    for (let i = 1; i < next.length; i++)
      if (selected.has(next[i] ?? '') && !selected.has(next[i - 1] ?? ''))
        [next[i - 1], next[i]] = [next[i] ?? '', next[i - 1] ?? ''];
  } else {
    for (let i = next.length - 2; i >= 0; i--)
      if (selected.has(next[i] ?? '') && !selected.has(next[i + 1] ?? ''))
        [next[i], next[i + 1]] = [next[i + 1] ?? '', next[i] ?? ''];
  }
  return next;
}
export function rangeFinderSelection(
  selected: ReadonlySet<string>,
  visible: string[],
  anchor: string | null,
  id: string,
  checked: boolean,
  shift: boolean,
) {
  const start = visible.indexOf(anchor ?? ''),
    end = visible.indexOf(id),
    next = new Set(selected);
  const ids =
    shift && start >= 0 && end >= 0
      ? visible.slice(Math.min(start, end), Math.max(start, end) + 1)
      : [id];
  for (const key of ids)
    if (checked) next.add(key);
    else next.delete(key);
  return next;
}
