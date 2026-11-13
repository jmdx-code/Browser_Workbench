import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      title?: string;
      danger?: boolean;
    }
  | { separator: true; label?: string };

function resolveClippingBounds(triggerEl: HTMLElement): { minX: number; maxX: number } {
  const viewportW =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280;
  const container = triggerEl.closest(
    '.workspace, .sidebar, .modal, .dialog-card, .confirm-dialog',
  );
  const containerRect = container?.getBoundingClientRect();
  const rawMin = containerRect && containerRect.width > 0 ? Math.max(0, containerRect.left) : 0;
  const rawMax =
    containerRect && containerRect.width > 0 ? Math.min(viewportW, containerRect.right) : viewportW;
  const minX = rawMin + 8;
  const maxX = Math.max(minX + 120, rawMax - 8);
  return { minX, maxX };
}

export function computePopoverPlacement(
  triggerEl: HTMLElement,
  panelWidth: number,
  preferred: 'start' | 'end',
): { effectiveAlign: 'start' | 'end'; offsetPx: number } {
  const rect = triggerEl.getBoundingClientRect();
  if (rect.width === 0 && rect.left === 0 && rect.right === 0) {
    return { effectiveAlign: preferred, offsetPx: 0 };
  }
  const { minX, maxX } = resolveClippingBounds(triggerEl);

  if (preferred === 'end') {
    if (rect.right - panelWidth >= minX && rect.right <= maxX) {
      return { effectiveAlign: 'end', offsetPx: 0 };
    }
    if (rect.left >= minX && rect.left + panelWidth <= maxX) {
      return { effectiveAlign: 'start', offsetPx: 0 };
    }
  } else {
    if (rect.left >= minX && rect.left + panelWidth <= maxX) {
      return { effectiveAlign: 'start', offsetPx: 0 };
    }
    if (rect.right - panelWidth >= minX && rect.right <= maxX) {
      return { effectiveAlign: 'end', offsetPx: 0 };
    }
  }

  let shift = Math.min(0, maxX - (rect.left + panelWidth));
  shift = Math.max(minX - rect.left, shift);
  return { effectiveAlign: 'start', offsetPx: Math.round(shift) };
}

// Lightweight dropdown: closes on outside click, Escape or selection.
export function PopoverMenu({
  label,
  trigger,
  items,
  align = 'end',
  className = '',
  disabled,
  children,
}: {
  label: string;
  trigger: ReactNode;
  items?: MenuItem[];
  align?: 'start' | 'end';
  className?: string;
  disabled?: boolean;
  children?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [effectiveAlign, setEffectiveAlign] = useState<'start' | 'end'>(align);
  const [offsetPx, setOffsetPx] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEffectiveAlign(align);
    setOffsetPx(0);
  }, [align]);

  useLayoutEffect(() => {
    if (!open || !root.current || !panelRef.current) return;
    const updatePlacement = () => {
      if (!root.current || !panelRef.current) return;
      const measuredWidth =
        panelRef.current.offsetWidth ||
        Math.round(panelRef.current.getBoundingClientRect().width) ||
        252;
      const next = computePopoverPlacement(root.current, measuredWidth, align);
      setEffectiveAlign(next.effectiveAlign);
      setOffsetPx(next.offsetPx);
    };
    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    return () => window.removeEventListener('resize', updatePlacement);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div className={'popover ' + className} ref={root}>
      <button
        type="button"
        className="btn btn-icon btn-ghost"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (!open && root.current) {
            const initial = computePopoverPlacement(root.current, 256, align);
            setEffectiveAlign(initial.effectiveAlign);
            setOffsetPx(initial.offsetPx);
          }
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panelRef}
          className={'popover-panel align-' + effectiveAlign}
          style={offsetPx !== 0 ? { left: `${offsetPx}px`, right: 'auto' } : undefined}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          {children?.(close)}
          {items?.map((item, index) =>
            'separator' in item ? (
              <div className="popover-separator" key={'s' + index}>
                {item.label}
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                key={item.label + index}
                className={'popover-item' + (item.danger ? ' danger-text' : '')}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                <span className="popover-icon">{item.icon}</span>
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
