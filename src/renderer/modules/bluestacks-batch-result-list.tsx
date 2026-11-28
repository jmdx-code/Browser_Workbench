import type { ReactNode } from 'react';
import { UI_CARD, UI_MUTED } from '../ui/primitives.js';
import { Btn, DataTbl, ProgressBar, TonePill } from './shared/module-ui.js';
export const BATCH_RESULT_PILL_CLS =
  'inline-flex items-center rounded-full border border-[var(--line)] bg-white px-2.5 py-0.5 text-xs font-medium text-[var(--text-2)]';
export const BATCH_TONES = {
  slate: ['#475569', 'rgba(100,116,139,0.12)'],
  muted: ['#64748b', 'rgba(148,163,184,0.16)'],
  blue: ['#1d4ed8', 'rgba(59,130,246,0.14)'],
  green: ['#15803d', 'rgba(34,197,94,0.14)'],
  amber: ['#b45309', 'rgba(245,158,11,0.16)'],
  orange: ['#c2410c', 'rgba(249,115,22,0.16)'],
  red: ['#b91c1c', 'rgba(239,68,68,0.14)'],
  purple: ['#6d28d9', 'rgba(139,92,246,0.14)'],
  sky: ['#0369a1', 'rgba(14,165,233,0.14)'],
} as const;
export type BatchTone = keyof typeof BATCH_TONES;
export function BatchStatusPill({ label, tone }: { label: string; tone: BatchTone }) {
  const [color, bg] = BATCH_TONES[tone];
  return <TonePill label={label} color={color} bg={bg} />;
}
export function BluestacksBatchResultList<T, F extends string = string>({
  total,
  completed,
  running,
  statusText,
  showSummaryHeader = false,
  summaryCard = false,
  pills,
  filters,
  activeFilter,
  onFilterChange,
  onCancel,
  canceling = false,
  cancelLabel = '停止任务',
  headers,
  rows,
  empty,
  renderRow,
}: {
  total: number;
  completed: number;
  running: boolean;
  statusText?: string;
  showSummaryHeader?: boolean;
  summaryCard?: boolean;
  pills?: ReadonlyArray<readonly [string, number, string?]>;
  filters?: ReadonlyArray<readonly [F, string]>;
  activeFilter?: F;
  onFilterChange?: (next: F) => void;
  onCancel?: () => void;
  canceling?: boolean;
  cancelLabel?: string;
  headers: ReactNode[];
  rows: readonly T[];
  empty: string;
  renderRow: (row: T, index: number) => ReactNode;
}) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <>
      <div
        className={
          summaryCard
            ? `${UI_CARD} flex flex-col gap-2.5 bg-[var(--surface-2)] px-3.5 py-3`
            : 'flex flex-col gap-2'
        }
      >
        {(showSummaryHeader || (running && onCancel)) && (
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {showSummaryHeader ? (
              <strong className="text-[13px] font-semibold text-slate-900">{statusText}</strong>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              {showSummaryHeader && <span className={UI_MUTED}>{pct}%</span>}
              {running && onCancel && (
                <Btn v="danger" disabled={canceling} onClick={onCancel}>
                  {canceling ? '正在停止…' : cancelLabel}
                </Btn>
              )}
            </div>
          </div>
        )}
        <ProgressBar pct={pct} active={running} />
        {pills && pills.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {pills.map(([label, count, cls]) => (
              <span key={label} className={`${BATCH_RESULT_PILL_CLS}${cls ? ` ${cls}` : ''}`}>
                {label} {count}
              </span>
            ))}
          </div>
        )}
        {filters && filters.length > 0 && onFilterChange && (
          <div className="flex flex-wrap gap-1.5">
            {filters.map(([key, label]) => (
              <Btn
                key={key}
                v={activeFilter === key ? 'primary' : undefined}
                className="px-2.5 py-0.5 text-xs"
                onClick={() => onFilterChange(key)}
              >
                {label}
              </Btn>
            ))}
          </div>
        )}
      </div>
      <DataTbl headers={headers} rows={rows} empty={empty} renderRow={renderRow} />
    </>
  );
}
