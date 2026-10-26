import type { TaskRecord } from '../shared/task-contracts.js';

export const endedTask = (state: string) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(state);
export type TaskRunGroup = {
  key: string;
  rows: TaskRecord[];
  sortTime: number;
  startedAt: number | null;
  finishedAt: number | null;
  completed: number;
  state: string;
};
export function groupTaskRecords(records: readonly TaskRecord[]): TaskRunGroup[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const row of records) {
    const key = `${row.planId}:${row.round}`;
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }
  return [...groups]
    .map(([key, rows]) => {
      rows.sort((a, b) => a.position - b.position);
      const first = rows[0];
      const completed = rows.filter((r) => r.status === 'COMPLETED').length;
      const starts = rows.flatMap((r) => (r.startedAt === null ? [] : [r.startedAt]));
      const finishes = rows.flatMap((r) => (r.finishedAt === null ? [] : [r.finishedAt]));
      return {
        key,
        rows,
        completed,
        sortTime: Math.max(...rows.map((r) => r.finishedAt ?? r.startedAt ?? r.planCreatedAt)),
        startedAt: starts.length ? Math.min(...starts) : null,
        finishedAt:
          finishes.length &&
          (endedTask(first?.planState ?? '') ||
            rows.every((r) => ['COMPLETED', 'FAILED', 'SKIPPED'].includes(r.status)))
            ? Math.max(...finishes)
            : null,
        state:
          completed === rows.length
            ? 'COMPLETED'
            : rows.some((r) => r.status === 'FAILED')
              ? 'FAILED'
              : (first?.planState ?? 'QUEUED'),
      };
    })
    .sort(
      (a, b) =>
        b.sortTime - a.sortTime ||
        (b.rows[0]?.planCreatedAt ?? 0) - (a.rows[0]?.planCreatedAt ?? 0) ||
        (b.rows[0]?.round ?? 0) - (a.rows[0]?.round ?? 0) ||
        (b.rows[0]?.planId ?? '').localeCompare(a.rows[0]?.planId ?? ''),
    );
}
