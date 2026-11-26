import { X } from 'lucide-react';
import { Switch, Tabs } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { FileLocationResult } from '../../shared/desktop.js';

export const UI_INPUT =
  'h-8 min-w-0 rounded-md border border-[var(--line-strong)] bg-white px-2.5 py-1 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)] transition-colors hover:not-disabled:border-slate-400 focus:border-[var(--brand)] focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

export const UI_INPUT_SM =
  'h-7 min-w-0 rounded-md border border-[var(--line-strong)] bg-white px-2 py-0.5 text-xs text-[var(--text)] placeholder:text-[var(--text-3)] transition-colors hover:not-disabled:border-slate-400 focus:border-[var(--brand)] focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

export const UI_SELECT =
  'h-8 min-w-0 rounded-md border border-[var(--line-strong)] bg-white px-2 text-[13px] text-[var(--text)] transition-colors hover:not-disabled:border-slate-400 focus:border-[var(--brand)] focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

export const UI_SELECT_SM =
  'h-7 min-w-0 rounded-md border border-[var(--line-strong)] bg-white px-2 text-xs text-[var(--text)] transition-colors hover:not-disabled:border-slate-400 focus:border-[var(--brand)] focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400';

export const UI_TEXTAREA =
  'min-h-[96px] w-full resize-y rounded-md border border-[var(--line-strong)] bg-white px-2.5 py-2 text-xs leading-relaxed text-[var(--text)] placeholder:text-[var(--text-3)] focus:border-[var(--brand)] focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-50';

export const UI_CHECKBOX =
  'h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-[var(--brand)] disabled:cursor-not-allowed';

export const UI_CARD = 'rounded-xl border border-[var(--line)] bg-white shadow-xs';
export const UI_COUNT_CHIP =
  'count-chip inline-flex h-5 shrink-0 items-center rounded-full bg-slate-100 px-2 text-xs font-semibold tabular-nums text-[var(--text-2)]';
export const UI_MUTED = 'text-xs text-[var(--text-3)]';
export const UI_DANGER_TEXT = 'text-xs font-medium text-rose-600';
export const UI_MODAL_BACKDROP =
  'modal-backdrop fixed inset-0 z-80 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-[2px]';
export const UI_MODAL_CARD =
  'modal flex max-h-[calc(100vh-40px)] flex-col gap-3 overflow-y-auto rounded-2xl border border-[var(--line)] bg-white px-5 py-4 text-[var(--text)] shadow-2xl';
export const UI_DIALOG_CARD =
  'name-dialog m-auto w-[min(420px,calc(100vw-24px))] rounded-2xl border border-[var(--line)] bg-white p-5 text-[var(--text)] shadow-2xl';
export const UI_UNIT_FIELD =
  'unit-field flex h-8 items-center overflow-hidden rounded-md border border-[var(--line-strong)] bg-white focus-within:border-[var(--brand)] focus-within:shadow-[var(--focus)]';
const UI_BTN_DEFAULT =
  'btn inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--line-strong)] bg-white px-3 text-[13px] font-medium whitespace-nowrap text-[var(--text)] transition-colors hover:not-disabled:border-slate-300 hover:not-disabled:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45';
export const UI_BTN_PRIMARY =
  'btn btn-primary inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[var(--brand)] bg-[var(--brand)] px-3 text-[13px] font-semibold whitespace-nowrap text-white transition-colors hover:not-disabled:bg-[var(--brand-hover)] disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-400';

export function UiSwitch(p: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const control = (
    <Switch.Root
      className={
        'group box-border inline-flex h-[19px] w-[34px] shrink-0 cursor-pointer appearance-none items-center rounded-full border-0 bg-slate-300 p-[2px] transition-colors hover:not-[[data-disabled]]:bg-slate-400 focus-visible:shadow-[var(--focus)] data-[state=checked]:bg-[var(--brand)] data-[state=checked]:hover:not-[[data-disabled]]:bg-[var(--brand-hover)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55' +
        (!p.label && p.className ? ' ' + p.className : '')
      }
      checked={p.checked}
      onCheckedChange={p.onCheckedChange}
      disabled={p.disabled}
      aria-label={p.ariaLabel ?? p.label}
    >
      <Switch.Thumb className="block h-[15px] w-[15px] translate-x-0 rounded-full bg-white shadow-xs transition-transform group-data-[state=checked]:translate-x-[15px]" />
    </Switch.Root>
  );
  return p.label ? (
    <label
      className={
        'inline-flex cursor-pointer items-center gap-2 text-[12.5px] whitespace-nowrap select-none text-[var(--text-2)]' +
        (p.className ? ' ' + p.className : '')
      }
    >
      {control}
      <span>{p.label}</span>
    </label>
  ) : (
    control
  );
}

export interface UiSegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number | string | undefined;
  title?: string | undefined;
  disabled?: boolean | undefined;
}

export function UiSegmented<T extends string>(p: {
  value: T;
  options: readonly UiSegmentedOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <Tabs.Root
      value={p.value}
      onValueChange={(next) => p.options.some((opt) => opt.value === next) && p.onChange(next as T)}
      className={p.className ?? ''}
    >
      <Tabs.List
        className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--line)] bg-[var(--surface-3)] p-0.5"
        aria-label={p.ariaLabel}
      >
        {p.options.map((opt) => {
          const active = p.value === opt.value;
          return (
            <Tabs.Trigger
              key={opt.value}
              value={opt.value}
              disabled={opt.disabled}
              title={opt.title}
              className={
                'inline-flex min-h-[24px] cursor-pointer items-center justify-center gap-[5px] rounded-[6px] border-0 px-2.5 py-[3px] text-xs transition-colors ' +
                (active
                  ? 'bg-white font-semibold text-slate-900 shadow-2xs'
                  : 'bg-transparent font-medium text-[var(--text-2)] hover:not-disabled:bg-slate-900/5 hover:not-disabled:text-slate-900')
              }
            >
              <span>{opt.label}</span>
              {opt.count !== undefined && (
                <span className="text-[11px] font-semibold tabular-nums text-[var(--text-3)]">
                  {opt.count}
                </span>
              )}
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
    </Tabs.Root>
  );
}

const WEEKDAYS = [
  [1, '一', '周一'],
  [2, '二', '周二'],
  [3, '三', '周三'],
  [4, '四', '周四'],
  [5, '五', '周五'],
  [6, '六', '周六'],
  [7, '日', '周日'],
] as const;

export function DayPillGroup(p: {
  weekdays: readonly number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <div className="inline-flex items-center gap-[5px]" role="group" aria-label="重复星期">
        {WEEKDAYS.map(([day, short, title]) => {
          const active = p.weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              disabled={p.disabled}
              title={title}
              aria-pressed={active}
              className={
                'inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] border p-0 text-xs leading-none font-semibold transition-colors ' +
                (active
                  ? 'border-[var(--brand)] bg-[var(--brand)] text-white'
                  : 'border-[var(--line-strong)] bg-white text-[var(--text-2)] hover:not-disabled:border-slate-400 hover:not-disabled:bg-slate-100 hover:not-disabled:text-slate-900')
              }
              onClick={() =>
                p.onChange(
                  active
                    ? p.weekdays.length > 1
                      ? p.weekdays.filter((d) => d !== day)
                      : [...p.weekdays]
                    : [...p.weekdays, day].sort((a, b) => a - b),
                )
              }
            >
              {short}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        {(
          [
            ['每天', [1, 2, 3, 4, 5, 6, 7]],
            ['工作日', [1, 2, 3, 4, 5]],
            ['周末', [6, 7]],
          ] as const
        ).map(([label, days]) => (
          <button
            key={label}
            type="button"
            className="cursor-pointer rounded bg-transparent px-1.5 py-0.5 text-xs font-medium text-[var(--brand)] hover:underline"
            disabled={p.disabled}
            onClick={() => p.onChange([...days])}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SlideDrawer(p: {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  headerActions?: ReactNode | undefined;
  onClose: () => void;
  widthClass?: string | undefined;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.open, p.onClose]);

  if (!p.open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/35 backdrop-blur-[1px]"
      onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={p.title}
        className={`flex h-full w-full ${p.widthClass ?? 'max-w-[540px]'} flex-col border-l border-slate-200 bg-white shadow-2xl`}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-slate-900">{p.title}</h2>
            {p.subtitle && <p className="mt-0.5 truncate text-xs text-slate-500">{p.subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {p.headerActions}
            <button
              type="button"
              className="btn btn-icon btn-ghost inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-900"
              aria-label="关闭抽屉"
              onClick={p.onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{p.children}</div>
      </aside>
    </div>
  );
}

export function PageHeader(p: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 pb-3">
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-slate-900">{p.title}</h1>
        {p.subtitle && <p className="mt-0.5 text-xs text-slate-500">{p.subtitle}</p>}
      </div>
      {p.actions && <div className="flex flex-wrap items-center gap-2">{p.actions}</div>}
    </header>
  );
}

export function EmptyState(p: {
  icon?: ReactNode | undefined;
  title: string;
  description?: string | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center">
      {p.icon && <div className="mb-2.5 text-slate-400">{p.icon}</div>}
      <div className="text-sm font-semibold text-slate-700">{p.title}</div>
      {p.description && <p className="mt-1 max-w-md text-xs text-slate-500">{p.description}</p>}
      {p.action && <div className="mt-4">{p.action}</div>}
    </div>
  );
}

export function FileLocationButton({ source, label }: { source: string; label: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const desktop = window.workbenchDesktop;
  if (!desktop?.revealLocalFile) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={UI_BTN_DEFAULT + ' h-7 px-2.5 text-xs'}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void desktop
            .revealLocalFile(source)
            .then((v) => {
              const r = FileLocationResult.parse(v);
              if (!r.ok) setError(r.error);
            })
            .catch(() => setError('文件位置未打开，请重试'))
            .finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
      {error && (
        <small className="text-xs text-rose-600" role="alert">
          {error}
        </small>
      )}
    </span>
  );
}

export function downloadJsonFile(filename: string, payload: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
