import { useEffect, useRef, useState, type ReactNode } from 'react';

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
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setEffectiveAlign(align);
  }, [align]);
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
            const rect = root.current.getBoundingClientRect();
            if (align === 'end' && rect.right < 200) {
              setEffectiveAlign('start');
            } else if (
              align === 'start' &&
              typeof window !== 'undefined' &&
              rect.left + 200 > window.innerWidth
            ) {
              setEffectiveAlign('end');
            } else {
              setEffectiveAlign(align);
            }
          }
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={'popover-panel align-' + effectiveAlign}
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
