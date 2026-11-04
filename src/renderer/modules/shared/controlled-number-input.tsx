import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

export interface ControlledNumberInputHandle {
  flush(): Promise<number>;
}

export function ControlledNumberInput({
  value,
  min,
  max,
  defaultValue,
  ariaLabel,
  disabled,
  className,
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
  debounceMs?: number | undefined;
  onChange?: ((next: number) => void) | undefined;
  onCommit: (next: number) => void | Promise<unknown>;
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
    if (!focusedRef.current && Number.isFinite(value)) {
      setText(String(value));
    }
  }, [value]);

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
    const p = Promise.resolve(onCommit(clamped)).finally(() => {
      if (inFlightCommitRef.current === p) {
        inFlightCommitRef.current = null;
      }
    });
    inFlightCommitRef.current = p;
    return p;
  }

  async function flush(): Promise<number> {
    const hadPendingTimer = timerRef.current !== null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rawText = textRef.current;
    const raw = rawText.trim() === '' ? Number.NaN : Number(rawText);
    const clamped = clampNumber(raw);
    setText(String(clamped));
    textRef.current = String(clamped);
    if (hadPendingTimer || clamped !== latestCommittedRef.current || rawText !== String(clamped)) {
      latestCommittedRef.current = clamped;
      onChange?.(clamped);
      await runCommit(clamped);
    } else if (inFlightCommitRef.current) {
      await inFlightCommitRef.current;
    }
    return clamped;
  }

  useImperativeHandle(ref, () => ({
    flush,
  }));

  return (
    <input
      type="number"
      aria-label={ariaLabel}
      className={className}
      min={min}
      max={max}
      disabled={disabled}
      value={text}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const nextText = e.target.value;
        setText(nextText);
        textRef.current = nextText;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (nextText.trim() === '') {
          return;
        }
        const parsed = Number(nextText);
        if (Number.isFinite(parsed)) {
          const clamped = clampNumber(parsed);
          onChange?.(clamped);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            latestCommittedRef.current = clamped;
            void runCommit(clamped);
          }, debounceMs);
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        const hadPendingTimer = timerRef.current !== null;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const rawText = textRef.current;
        const raw = rawText.trim() === '' ? Number.NaN : Number(rawText);
        const clamped = clampNumber(raw);
        setText(String(clamped));
        textRef.current = String(clamped);
        if (
          hadPendingTimer ||
          clamped !== latestCommittedRef.current ||
          rawText !== String(clamped)
        ) {
          latestCommittedRef.current = clamped;
          onChange?.(clamped);
          void runCommit(clamped);
        }
      }}
    />
  );
}
