import { createPortal } from 'react-dom';
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
export function computeDragAutoScrollDelta(
  clientY: number,
  containerTop: number,
  containerBottom: number,
  edgeZonePx = 64,
  maxStepPx = 18,
): number {
  const height = containerBottom - containerTop;
  if (height <= 0 || edgeZonePx <= 0 || maxStepPx <= 0) return 0;
  const zone = Math.min(edgeZonePx, height / 3);
  if (clientY < containerTop + zone) {
    const ratio = Math.min(1, Math.max(0, (containerTop + zone - clientY) / zone));
    return -Math.max(2, Math.round(ratio * maxStepPx));
  }
  if (clientY > containerBottom - zone) {
    const ratio = Math.min(1, Math.max(0, (clientY - (containerBottom - zone)) / zone));
    return Math.max(2, Math.round(ratio * maxStepPx));
  }
  return 0;
}
export type DropTarget =
  | { kind: 'row'; folderId: string; rowId: string; after: boolean; key: string }
  | { kind: 'folder'; folderId: string; key: string };
export interface PointerDragRowProps {
  'data-drag-row-id': string;
  'data-drag-folder-id': string;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
}
type PendingDrag = { itemId: string; startX: number; startY: number };
type ActiveDrag = { ids: string[]; label: string; x: number; y: number };
const DRAG_THRESHOLD_PX = 6;
const HOVER_EXPAND_DELAY_MS = 400;
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      '[data-no-drag="true"], input, select, textarea, a, .finder-check-cell, .row-menu, .group-menu',
    )
  )
    return true;
  const btn = target.closest('button, [role="button"], [role="menuitem"]');
  return Boolean(btn && !btn.hasAttribute('data-drag-allow'));
}
function resolveDropTarget(
  container: HTMLElement | null,
  clientX: number,
  clientY: number,
  dragIds: ReadonlySet<string>,
): DropTarget | null {
  if (!container) return null;
  const hitCandidates: HTMLElement[] = [];
  if (typeof document.elementsFromPoint === 'function') {
    for (const node of document.elementsFromPoint(clientX, clientY)) {
      if (!(node instanceof HTMLElement) || node.hasAttribute('data-drag-ghost')) continue;
      if (container.contains(node)) hitCandidates.push(node);
    }
  }
  const matchElement = (el: HTMLElement): DropTarget | null => {
    const rowEl = el.closest<HTMLElement>('[data-drag-row-id]');
    if (rowEl && container.contains(rowEl)) {
      const rowId = rowEl.dataset.dragRowId ?? '';
      if (rowId && !dragIds.has(rowId)) {
        const rect = rowEl.getBoundingClientRect();
        const after = clientY >= rect.top + rect.height / 2;
        return {
          kind: 'row',
          folderId: rowEl.dataset.dragFolderId ?? '',
          rowId,
          after,
          key: (after ? 'a:' : 'b:') + rowId,
        };
      }
      return null;
    }
    const folderEl = el.closest<HTMLElement>('[data-drag-drop-folder-id]');
    if (folderEl && container.contains(folderEl)) {
      const folderId = folderEl.dataset.dragDropFolderId ?? '';
      return { kind: 'folder', folderId, key: 'f:' + folderId };
    }
    return null;
  };
  for (const el of hitCandidates) {
    const hit = matchElement(el);
    if (hit) return hit;
  }
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>('[data-drag-row-id], [data-drag-drop-folder-id]'),
  );
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (clientY >= rect.top && clientY <= rect.bottom) {
      if (rect.width > 0 && (clientX < rect.left || clientX > rect.right)) continue;
      const hit = matchElement(node);
      if (hit) return hit;
    }
  }
  return null;
}
export function usePointerDragReorder(opts: {
  disabled: boolean;
  scrollContainerRef: RefObject<HTMLElement | null>;
  unitLabel: string;
  getDragIds: (rowId: string) => string[];
  isFolderCollapsed?: (folderId: string) => boolean;
  onAutoExpandFolder?: (folderId: string) => void;
  onDropOnRow: (folderId: string, movedIds: string[], targetRowId: string, after: boolean) => void;
  onDropOnFolder: (folderId: string, movedIds: string[]) => void;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [dropKey, setDropKey] = useState('');
  const pendingRef = useRef<PendingDrag | null>(null);
  const activeRef = useRef<ActiveDrag | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const justDraggedRef = useRef(false);
  const velRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const hoverFolderRef = useRef<string | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStyleRef = useRef<{ userSelect: string; cursor: string } | null>(null);
  const listenersRef = useRef<(() => void) | null>(null);
  const clearHoverExpand = useCallback(() => {
    hoverFolderRef.current = null;
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  const stopAutoScroll = useCallback(() => {
    velRef.current = 0;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);
  const updateDropAt = useCallback(
    (clientX: number, clientY: number) => {
      const drag = activeRef.current;
      if (!drag) return;
      const target = resolveDropTarget(
        optsRef.current.scrollContainerRef.current,
        clientX,
        clientY,
        new Set(drag.ids),
      );
      dropRef.current = target;
      const nextKey = target?.key ?? '';
      setDropKey((prev) => (prev === nextKey ? prev : nextKey));
      if (
        target?.kind === 'folder' &&
        optsRef.current.isFolderCollapsed?.(target.folderId) &&
        optsRef.current.onAutoExpandFolder
      ) {
        if (hoverFolderRef.current !== target.folderId) {
          clearHoverExpand();
          hoverFolderRef.current = target.folderId;
          const fid = target.folderId;
          hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null;
            hoverFolderRef.current = null;
            optsRef.current.onAutoExpandFolder?.(fid);
          }, HOVER_EXPAND_DELAY_MS);
        }
      } else clearHoverExpand();
    },
    [clearHoverExpand],
  );
  const ensureAutoScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    const step = () => {
      const el = optsRef.current.scrollContainerRef.current;
      const v = velRef.current;
      if (!el || v === 0 || !activeRef.current) {
        rafRef.current = null;
        return;
      }
      el.scrollTop += v;
      updateDropAt(lastPosRef.current.x, lastPosRef.current.y);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [updateDropAt]);
  const cleanup = useCallback(() => {
    listenersRef.current?.();
    listenersRef.current = null;
    pendingRef.current = null;
    activeRef.current = null;
    dropRef.current = null;
    stopAutoScroll();
    clearHoverExpand();
    setActiveDrag(null);
    setDropKey('');
    if (savedStyleRef.current && typeof document !== 'undefined') {
      document.body.style.userSelect = savedStyleRef.current.userSelect;
      document.body.style.cursor = savedStyleRef.current.cursor;
      savedStyleRef.current = null;
    }
  }, [clearHoverExpand, stopAutoScroll]);
  useEffect(() => cleanup, [cleanup]);
  const beginListening = useCallback(() => {
    if (listenersRef.current || typeof window === 'undefined') return;
    const onMove = (e: PointerEvent) => {
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      const pending = pendingRef.current;
      if (pending && !activeRef.current) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        const ids = optsRef.current.getDragIds(pending.itemId);
        if (!ids.length) {
          cleanup();
          return;
        }
        const drag: ActiveDrag = {
          ids,
          label: `移动 ${ids.length} 个${optsRef.current.unitLabel}`,
          x: e.clientX,
          y: e.clientY,
        };
        activeRef.current = drag;
        pendingRef.current = null;
        setActiveDrag(drag);
        window.getSelection()?.removeAllRanges();
        savedStyleRef.current = {
          userSelect: document.body.style.userSelect,
          cursor: document.body.style.cursor,
        };
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      }
      if (!activeRef.current) return;
      const nextDrag = { ...activeRef.current, x: e.clientX, y: e.clientY };
      activeRef.current = nextDrag;
      setActiveDrag(nextDrag);
      updateDropAt(e.clientX, e.clientY);
      const el = optsRef.current.scrollContainerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const delta = computeDragAutoScrollDelta(e.clientY, rect.top, rect.bottom);
        velRef.current = delta;
        if (delta !== 0) ensureAutoScroll();
        else stopAutoScroll();
      }
    };
    const onUp = (e: PointerEvent) => {
      const drag = activeRef.current;
      if (!drag) {
        cleanup();
        return;
      }
      updateDropAt(e.clientX, e.clientY);
      const target = dropRef.current;
      justDraggedRef.current = true;
      setTimeout(() => {
        justDraggedRef.current = false;
      }, 0);
      cleanup();
      if (!optsRef.current.disabled && target) {
        if (target.kind === 'row') {
          optsRef.current.onDropOnRow(target.folderId, drag.ids, target.rowId, target.after);
        } else optsRef.current.onDropOnFolder(target.folderId, drag.ids);
      }
    };
    const onCancel = () => cleanup();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (activeRef.current || pendingRef.current)) {
        e.preventDefault();
        cleanup();
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current) return;
      const el = optsRef.current.scrollContainerRef.current;
      if (!el) return;
      e.preventDefault();
      if (e.deltaY !== 0) el.scrollTop += e.deltaY;
      if (e.deltaX !== 0) el.scrollLeft += e.deltaX;
      updateDropAt(lastPosRef.current.x, lastPosRef.current.y);
    };
    const specs: Array<[string, EventListenerOrEventListenerObject, AddEventListenerOptions?]> = [
      ['pointermove', onMove as EventListener, { capture: true }],
      ['pointerup', onUp as EventListener, { capture: true }],
      ['pointercancel', onCancel, { capture: true }],
      ['blur', onCancel],
      ['keydown', onKey as EventListener, { capture: true }],
      ['wheel', onWheel as EventListener, { capture: true, passive: false }],
    ];
    for (const [ev, fn, o] of specs) window.addEventListener(ev, fn, o);
    listenersRef.current = () => {
      for (const [ev, fn, o] of specs) window.removeEventListener(ev, fn, o);
    };
  }, [cleanup, ensureAutoScroll, stopAutoScroll, updateDropAt]);
  const getRowProps = useCallback(
    (rowId: string, folderId: string, rowDisabled = false): PointerDragRowProps => ({
      'data-drag-row-id': rowId,
      'data-drag-folder-id': folderId,
      onPointerDown: (e) => {
        if (
          e.button !== 0 ||
          optsRef.current.disabled ||
          rowDisabled ||
          isInteractiveTarget(e.target)
        )
          return;
        if (typeof window !== 'undefined' && window.getSelection()?.toString().trim()) return;
        pendingRef.current = { itemId: rowId, startX: e.clientX, startY: e.clientY };
        lastPosRef.current = { x: e.clientX, y: e.clientY };
        beginListening();
      },
    }),
    [beginListening],
  );
  const onContainerClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const ghost: ReactNode =
    activeDrag && typeof document !== 'undefined'
      ? createPortal(
          createElement(
            'div',
            {
              'data-drag-ghost': 'true',
              className:
                'pointer-events-none fixed top-0 left-0 z-[9999] rounded-lg border border-[var(--brand)] bg-[var(--graphite)] px-2.5 py-1 text-xs font-medium text-white shadow-lg',
              style: {
                transform: `translate3d(${activeDrag.x + 14}px, ${activeDrag.y + 12}px, 0)`,
              },
            },
            activeDrag.label,
          ),
          document.body,
        )
      : null;
  return { isDragging: Boolean(activeDrag), dropKey, getRowProps, onContainerClickCapture, ghost };
}
