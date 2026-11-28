import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import { UI_INPUT_SM } from '../../ui/primitives.js';
export type ControlledNumberInputHandle = { flush(): Promise<number> };
export function ControlledNumberInput({
  value,
  min,
  max,
  defaultValue,
  ariaLabel,
  disabled,
  className = UI_INPUT_SM,
  style,
  debounceMs = 300,
  onChange,
  onCommit,
  ref,
}: {
  value: number;
  min: number;
  max: number;
  defaultValue?: number | undefined;
  ariaLabel: string;
  disabled?: boolean | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  debounceMs?: number | undefined;
  onChange?: ((next: number) => void) | undefined;
  onCommit?: ((next: number) => void | Promise<unknown>) | undefined;
  ref?: Ref<ControlledNumberInputHandle> | undefined;
}) {
  const [text, setText] = useState<string>(() => (Number.isFinite(value) ? String(value) : ''));
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCommittedRef = useRef<number>(value);
  const inFlightCommitRef = useRef<Promise<unknown> | null>(null);
  const textRef = useRef<string>(text);
  textRef.current = text;
  useEffect(() => {
    latestCommittedRef.current = value;
    if (!focusedRef.current && Number.isFinite(value)) setText(String(value));
  }, [value]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  function clampNumber(raw: number): number {
    const fallback = Number.isFinite(defaultValue)
      ? (defaultValue as number)
      : Number.isFinite(latestCommittedRef.current)
        ? latestCommittedRef.current
        : min;
    const candidate = Number.isFinite(raw) ? raw : fallback;
    return Math.min(max, Math.max(min, Math.round(candidate)));
  }
  function runCommit(clamped: number): Promise<unknown> {
    const commitFn = onCommitRef.current;
    if (!commitFn) return Promise.resolve();
    const p = Promise.resolve(commitFn(clamped)).finally(() => {
      if (inFlightCommitRef.current === p) inFlightCommitRef.current = null;
    });
    inFlightCommitRef.current = p;
    return p;
  }
  function commitCurrent(awaitCommit: true): Promise<number>;
  function commitCurrent(awaitCommit: false): number;
  function commitCurrent(awaitCommit: boolean): Promise<number> | number {
    const hadPendingTimer = timerRef.current !== null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rawText = textRef.current;
    const clamped = clampNumber(rawText.trim() === '' ? Number.NaN : Number(rawText));
    setText(String(clamped));
    textRef.current = String(clamped);
    const valueChanged = clamped !== latestCommittedRef.current;
    if (hadPendingTimer || valueChanged || rawText !== String(clamped)) {
      latestCommittedRef.current = clamped;
      if (valueChanged) onChangeRef.current?.(clamped);
      const pending = runCommit(clamped);
      return awaitCommit ? pending.then(() => clamped) : clamped;
    }
    return awaitCommit && inFlightCommitRef.current
      ? inFlightCommitRef.current.then(() => clamped)
      : clamped;
  }
  const flush = () => commitCurrent(true);
  useImperativeHandle(ref, () => ({ flush }));
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      className={className}
      style={style}
      min={min}
      max={max}
      disabled={disabled}
      value={text}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void flush();
        }
      }}
      onChange={(e) => {
        const nextText = e.target.value;
        setText(nextText);
        textRef.current = nextText;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (nextText.trim() === '') return;
        const parsed = Number(nextText);
        if (Number.isFinite(parsed)) {
          const clamped = clampNumber(parsed);
          latestCommittedRef.current = clamped;
          onChangeRef.current?.(clamped);
          if (onCommitRef.current) {
            timerRef.current = setTimeout(() => {
              timerRef.current = null;
              latestCommittedRef.current = clamped;
              void runCommit(clamped);
            }, debounceMs);
          }
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        commitCurrent(false);
      }}
    />
  );
}
