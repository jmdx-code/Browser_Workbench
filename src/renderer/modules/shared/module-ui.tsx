import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
} from 'react';
import {
  UI_CHECKBOX,
  UI_DIALOG_CARD,
  UI_INPUT_SM,
  UI_MODAL_BACKDROP,
  UI_MODAL_CARD,
  UI_SELECT_SM,
} from '../../ui/primitives.js';
import { ControlledNumberInput } from './controlled-number-input.js';

export function useShowModal(ref: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, [ref]);
}

export const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

export function useAbortQuery<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  revision: number,
  fallbackErr: string,
  timeoutMs = 10_000,
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ctrl = new AbortController();
    void fnRef.current(AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeoutMs)])).then(
      (v) => !ctrl.signal.aborted && (setData(v), setError('')),
      () => !ctrl.signal.aborted && (setData(null), setError(fallbackErr)),
    );
    return () => ctrl.abort();
  }, [revision, fallbackErr, timeoutMs]);
  return { data, setData, error, setError };
}

export function useBusyTask() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const run = async (
    work: () => Promise<void>,
    fallbackErr: string,
    onOk?: () => void,
    onErr?: (msg: string) => void,
  ) => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await work();
      onOk?.();
      return true;
    } catch (e) {
      const m = errMsg(e, fallbackErr);
      setError(m);
      onErr?.(m);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, setError, setNotice, run };
}

export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onEscape();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onEscape]);
}

export function useDropdownDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onClose]);
}

const BTN_VARIANT: Record<'default' | 'primary' | 'danger' | 'ghost' | 'icon', string> = {
  default:
    'border border-[var(--line-strong)] bg-white text-[var(--text)] hover:not-disabled:border-slate-300 hover:not-disabled:bg-slate-100',
  primary:
    'btn-primary border border-[var(--brand)] bg-[var(--brand)] font-semibold text-white hover:not-disabled:border-[var(--brand-hover)] hover:not-disabled:bg-[var(--brand-hover)] disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-400',
  danger:
    'btn-danger border border-rose-200 bg-white text-rose-600 hover:not-disabled:border-rose-300 hover:not-disabled:bg-rose-50',
  ghost:
    'btn-ghost border border-transparent bg-transparent text-[var(--text-2)] hover:not-disabled:bg-slate-100 hover:not-disabled:text-slate-900',
  icon: 'btn-icon btn-ghost h-7 w-7 shrink-0 border border-transparent bg-transparent p-0 text-[var(--text-2)] hover:not-disabled:bg-slate-100 hover:not-disabled:text-slate-900',
};

export function Btn({
  v = 'default',
  sm = true,
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  v?: 'primary' | 'danger' | 'ghost' | 'icon' | 'default';
  sm?: boolean;
}) {
  const sizeCls = v === 'icon' ? '' : sm ? 'btn-sm h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]';
  const base =
    'btn inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors active:not-disabled:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-45';
  const cls = `${base} ${sizeCls} ${BTN_VARIANT[v]}${className ? ` ${className}` : ''}`;
  return <button type="button" {...p} className={cls} />;
}

export function Chk(p: {
  label: ReactNode;
  checked: boolean;
  onChange: (c: boolean) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-2)] ${p.className ?? ''}`}
      title={p.title}
    >
      <input
        type="checkbox"
        className={UI_CHECKBOX}
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.target.checked)}
      />
      <span>{p.label}</span>
    </label>
  );
}

export function Fld(p: { label: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label
      className={`flex flex-col gap-1 text-xs font-medium text-[var(--text-2)] ${p.className ?? ''}`}
    >
      <span>{p.label}</span>
      {p.children}
    </label>
  );
}

export function InFld({
  label,
  wrapClass,
  onVal,
  className = UI_INPUT_SM,
  ...p
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  label: ReactNode;
  wrapClass?: string;
  onVal: (v: string) => void;
}) {
  return (
    <Fld label={label} className={wrapClass}>
      <input {...p} className={className} onChange={(e) => onVal(e.target.value)} />
    </Fld>
  );
}

export function SelFld({
  label,
  wrapClass,
  onVal,
  className = UI_SELECT_SM,
  children,
  ...p
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & {
  label: ReactNode;
  wrapClass?: string;
  onVal: (v: string) => void;
}) {
  return (
    <Fld label={label} className={wrapClass}>
      <select {...p} className={className} onChange={(e) => onVal(e.target.value)}>
        {children}
      </select>
    </Fld>
  );
}

export function CtrlNum(p: {
  label?: ReactNode;
  aria: string;
  val: number;
  min: number;
  max: number;
  def?: number;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  debounceMs?: number;
  onChange: (n: number) => void;
}) {
  const input = (
    <ControlledNumberInput
      ariaLabel={p.aria}
      value={p.val}
      min={p.min}
      max={p.max}
      defaultValue={p.def ?? p.val}
      disabled={p.disabled}
      className={p.className ?? UI_INPUT_SM}
      style={p.style}
      debounceMs={p.debounceMs}
      onChange={p.onChange}
    />
  );
  return p.label !== undefined ? <Fld label={p.label}>{input}</Fld> : input;
}

export function ModalFoot(p: {
  busy?: boolean;
  cancelText?: string;
  okText?: string;
  okDisabled?: boolean;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] bg-slate-50 px-4 py-2.5">
      <Btn disabled={p.busy} onClick={p.onCancel}>
        {p.cancelText ?? '取消'}
      </Btn>
      <Btn v="primary" disabled={p.busy || p.okDisabled} onClick={p.onOk}>
        {p.okText ?? '保存'}
      </Btn>
    </footer>
  );
}

export function DataTbl<T>(p: {
  headers: ReactNode[];
  rows: readonly T[];
  empty: string;
  colSpan?: number;
  wrapClass?: string;
  renderRow: (r: T, i: number) => ReactNode;
}) {
  return (
    <div
      className={
        p.wrapClass ?? 'max-h-[340px] overflow-auto rounded-lg border border-[var(--line)] bg-white'
      }
    >
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="sticky top-0 border-b border-[var(--line)] bg-slate-50 text-left text-[11px] font-semibold text-[var(--text-3)]">
            {p.headers.map((h, i) => (
              <th key={i} className="px-2.5 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {p.rows.length === 0 ? (
            <tr>
              <td
                colSpan={p.colSpan ?? p.headers.length}
                className="p-5 text-center text-[var(--text-2)]"
              >
                {p.empty}
              </td>
            </tr>
          ) : (
            p.rows.map(p.renderRow)
          )}
        </tbody>
      </table>
    </div>
  );
}

export function NoticeBanner(p: { tone: 'ok' | 'err'; children: ReactNode }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${p.tone === 'err' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}
      role={p.tone === 'err' ? 'alert' : undefined}
    >
      {p.children}
    </div>
  );
}

export function ProgressBar({ pct, active }: { pct: number; active: boolean }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div
        className="h-full transition-all"
        style={{ width: `${pct}%`, background: active ? 'var(--brand, #2563eb)' : '#16a34a' }}
      />
    </div>
  );
}

export function SegTabs<T extends string>(p: {
  value: T;
  options: ReadonlyArray<readonly [T, ReactNode]>;
  onChange: (n: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex flex-wrap rounded-lg border border-[var(--line)] bg-slate-100 p-0.5 ${p.className ?? ''}`}
      role="tablist"
    >
      {p.options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={p.value === k}
          disabled={p.disabled}
          onClick={() => p.onChange(k)}
          className={
            p.value === k
              ? 'inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-900 shadow-2xs'
              : 'inline-flex items-center gap-1.5 rounded-md bg-transparent px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900'
          }
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function ModalHeading(p: {
  title: ReactNode;
  subtitle?: ReactNode;
  disabled?: boolean;
  closeText?: string;
  className?: string;
  onClose: () => void;
}) {
  return (
    <header
      className={`flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3 ${p.className ?? ''}`}
    >
      <div className="min-w-0">
        <h3 className="m-0 text-[15px] font-semibold text-slate-900">{p.title}</h3>
        {p.subtitle && <p className="mt-0.5 mb-0 text-xs text-[var(--muted)]">{p.subtitle}</p>}
      </div>
      <Btn
        v="ghost"
        className="shrink-0"
        aria-label="关闭弹窗"
        disabled={p.disabled}
        onClick={p.onClose}
      >
        {p.closeText ?? '关闭'}
      </Btn>
    </header>
  );
}

export function DropdownPopover(p: {
  label: string;
  ariaLabel?: string;
  warn?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    wrapRef = useRef<HTMLDivElement | null>(null);
  useDropdownDismiss(open, wrapRef, () => setOpen(false));
  return (
    <div className="relative" ref={wrapRef}>
      <Btn
        className={`inline-flex items-center gap-1.5 ${p.warn ? 'border-amber-300 bg-amber-50 text-amber-800' : ''}`}
        disabled={p.disabled}
        aria-expanded={open}
        aria-label={p.ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{p.label}</span>
        <span className="text-[10px] opacity-60">▾</span>
      </Btn>
      {open && (
        <div
          className="gs-dropdown-menu absolute top-[calc(100%+4px)] left-0 z-50 max-w-[320px] min-w-[240px] rounded-xl border border-[var(--line)] bg-white p-2 shadow-lg"
          role="menu"
        >
          {p.children}
        </div>
      )}
    </div>
  );
}

export function NativeModalShell(p: {
  title: ReactNode;
  subtitle?: ReactNode;
  width?: string;
  headerRight?: ReactNode;
  footer?: ReactNode;
  error?: string;
  notice?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useShowModal(dialogRef);
  return (
    <dialog
      ref={dialogRef}
      className="modal m-auto overflow-hidden rounded-2xl border border-[var(--line)] bg-white p-0 text-[var(--text)] shadow-2xl"
      style={{ width: p.width ?? 'min(860px, 94vw)', maxWidth: '95vw' }}
      onCancel={(e) => {
        e.preventDefault();
        p.onClose();
      }}
      onClick={(e) => e.target === dialogRef.current && p.onClose()}
    >
      <div className="flex max-h-[88vh] flex-col bg-white">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="m-0 text-[15px] font-semibold text-slate-900">{p.title}</h3>
            {p.subtitle && <p className="mt-0.5 text-xs text-[var(--text-2)]">{p.subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {p.headerRight}
            <Btn v="ghost" aria-label="关闭弹窗" onClick={p.onClose}>
              关闭
            </Btn>
          </div>
        </header>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-3.5">
          {p.error && <NoticeBanner tone="err">{p.error}</NoticeBanner>}
          {p.notice && <NoticeBanner tone="ok">{p.notice}</NoticeBanner>}
          {p.children}
        </div>
        {p.footer && (
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] bg-slate-50 px-5 py-3">
            {p.footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}

export function NativeFormDialog(p: {
  title: ReactNode;
  subtitle?: ReactNode;
  ariaLabel?: string;
  busy: boolean;
  error?: string;
  submitLabel: string;
  submitDisabled?: boolean;
  danger?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useShowModal(dialogRef);
  return (
    <dialog
      ref={dialogRef}
      className={UI_DIALOG_CARD}
      aria-label={p.ariaLabel}
      onCancel={(e) => (p.busy ? e.preventDefault() : p.onClose())}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSubmit();
        }}
      >
        <h3 className="m-0 text-base font-semibold text-slate-900">{p.title}</h3>
        {p.subtitle && (
          <p className="m-0 text-xs leading-relaxed text-[var(--text-3)]">{p.subtitle}</p>
        )}
        <div className="flex flex-col gap-2 text-xs text-[var(--text-2)]">{p.children}</div>
        {p.error && (
          <p className="m-0 text-xs font-medium text-rose-600" role="alert">
            {p.error}
          </p>
        )}
        <footer className="mt-1 flex justify-end gap-2">
          <Btn sm={false} disabled={p.busy} onClick={p.onClose}>
            取消
          </Btn>
          <Btn
            v={p.danger ? 'danger' : 'primary'}
            sm={false}
            type="submit"
            disabled={p.busy || p.submitDisabled}
          >
            {p.submitLabel}
          </Btn>
        </footer>
      </form>
    </dialog>
  );
}

export function BackdropModal(p: {
  label: string;
  backdropClass?: string;
  modalClass?: string;
  busy?: boolean;
  blockEscape?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscapeKey(!p.busy && !p.blockEscape, p.onClose);
  const innerClass =
    p.modalClass === 'contents'
      ? 'contents'
      : p.modalClass
        ? `${UI_MODAL_CARD} ${p.modalClass}`
        : UI_MODAL_CARD;
  return (
    <div
      className={p.backdropClass ?? UI_MODAL_BACKDROP}
      role="dialog"
      aria-modal="true"
      aria-label={p.label}
      onMouseDown={(e) => e.target === e.currentTarget && !p.busy && p.onClose()}
    >
      <div className={innerClass}>{p.children}</div>
    </div>
  );
}

export function TonePill({
  label,
  color,
  bg,
  title,
}: {
  label: string;
  color: string;
  bg: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{ color, background: bg }}
    >
      {label}
    </span>
  );
}
