import { useEffect, useRef, useState } from 'react';

const storageKey = 'workbench.sidebar-width.v1';
const clamp = (value: number) => Math.min(420, Math.max(240, value));
export function SidebarResizer() {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored >= 240 && stored <= 420 ? stored : 290;
    } catch {
      return 290;
    }
  });
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const body = handle.current?.parentElement;
    body?.style.setProperty('--sidebar-width', width + 'px');
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* Preferences can remain session-local. */
    }
  }, [width]);
  return (
    <div
      ref={handle}
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label="调整浏览器侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={240}
      aria-valuemax={420}
      aria-valuenow={width}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (drag.current) setWidth(clamp(drag.current.width + event.clientX - drag.current.x));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => setWidth(290)}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        setWidth(
          event.key === 'Home' ? 290 : clamp(width + (event.key === 'ArrowRight' ? 10 : -10)),
        );
      }}
    />
  );
}
