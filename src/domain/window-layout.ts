import type { Rect, LayoutScreen, LayoutSettings, TaskWindow } from '../shared/window-layout.js';

type PositionedWindow = { id: string; rect: Rect; contentInsets?: TaskWindow['contentInsets'] };

// Large windows may shrink; ordinary windows retain their current size.
export function fitTaskWindow(rect: Rect, display: LayoutScreen): Rect {
  const a = display.workArea;
  const maxWidth = a.width - 24,
    maxHeight = a.height - 24;
  if (maxWidth < 100 || maxHeight < 100) throw Error('WINDOW_LAYOUT_CAPACITY_EXCEEDED');
  const large = rect.width * rect.height > (a.width * a.height) / 2;
  const width = Math.min(
    rect.width,
    maxWidth,
    large ? Math.max(640, Math.floor(a.width * 0.6)) : maxWidth,
  );
  const height = Math.min(
    rect.height,
    maxHeight,
    large ? Math.max(480, Math.floor(a.height * 0.8)) : maxHeight,
  );
  return {
    width,
    height,
    x: Math.max(a.x + 12, Math.min(rect.x, a.x + a.width - 12 - width)),
    y: Math.max(a.y + 12, Math.min(rect.y, a.y + a.height - 12 - height)),
  };
}

// Try nearby peer corners, then screen corners. Real visibility decides success;
// stale peer geometry must never prevent the current task from starting or moving.
export function taskWindowPositions(
  rect: Rect,
  peers: readonly { rect: Rect; contentInsets?: TaskWindow['contentInsets'] }[],
  display: LayoutScreen,
  step: number,
): Rect[] {
  const a = display.workArea;
  const stride = contentLayoutStep(peers, step);
  const candidates = [
    ...overlappingWindowPositions(rect, peers, display, stride),
    ...[a.x + 12, a.x + a.width - 12 - rect.width].flatMap((x) =>
      [a.y + 12, a.y + a.height - 12 - rect.height].map((y) => ({ ...rect, x, y })),
    ),
  ];
  return [...new Map(candidates.map((r) => [`${r.x}:${r.y}`, r])).values()].sort(
    (a, b) =>
      (a.x - rect.x) ** 2 + (a.y - rect.y) ** 2 - ((b.x - rect.x) ** 2 + (b.y - rect.y) ** 2),
  );
}

export function reservedLayoutDisplay(
  display: LayoutScreen,
  settings: LayoutSettings,
): LayoutScreen {
  const screen = display.workArea;
  const saved = settings.reservedArea ?? screen;
  const x = Math.max(saved.x, screen.x),
    y = Math.max(saved.y, screen.y);
  const clipped = {
    x,
    y,
    width: Math.min(saved.x + saved.width, screen.x + screen.width) - x,
    height: Math.min(saved.y + saved.height, screen.y + screen.height) - y,
  };
  // fitTaskWindow needs a 100 DIP minimum window plus 12 DIP on each side.
  const area = clipped.width >= 124 && clipped.height >= 124 ? clipped : screen;
  return { ...display, workArea: { ...area } };
}

export function contentWindowRect(window: Pick<TaskWindow, 'rect' | 'contentInsets'>): Rect {
  const { rect, contentInsets: inset } = window;
  if (!inset) return rect; // Geometry-only legacy callers; production requires measured insets.
  const result = {
    x: rect.x + inset.left,
    y: rect.y + inset.top,
    width: rect.width - inset.left - inset.right,
    height: rect.height - inset.top - inset.bottom,
  };
  if (result.width < 2 || result.height < 2) throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
  return result;
}

export function contentLayoutStep(
  windows: readonly Pick<PositionedWindow, 'contentInsets'>[],
  step: number,
) {
  return (
    step +
    Math.max(
      0,
      ...windows.map((w) => Math.max(w.contentInsets?.left ?? 0, w.contentInsets?.bottom ?? 0)),
    )
  );
}

// Occupied rectangles are overlap anchors, not excluded floor space. Align
// corresponding corners and offset in each direction; real page visibility
// remains the independent check after moving.
export function overlappingWindowPositions(
  rect: Rect,
  peers: readonly { rect: Rect }[],
  display: LayoutScreen,
  stride: number,
): Rect[] {
  const area = display.workArea;
  const points: Rect[] = [];
  for (const peer of peers) {
    for (const x of [peer.rect.x, peer.rect.x + peer.rect.width - rect.width])
      for (const y of [peer.rect.y, peer.rect.y + peer.rect.height - rect.height])
        for (const dx of [-stride, stride])
          for (const dy of [-stride, stride]) {
            const candidate = { ...rect, x: x + dx, y: y + dy };
            if (
              candidate.x >= area.x + 12 &&
              candidate.y >= area.y + 12 &&
              candidate.x + candidate.width <= area.x + area.width - 12 &&
              candidate.y + candidate.height <= area.y + area.height - 12
            )
              points.push(candidate);
          }
  }
  return [...new Map(points.map((p) => [`${p.x}:${p.y}`, p])).values()].sort(
    (a, b) =>
      (a.x - rect.x) ** 2 + (a.y - rect.y) ** 2 - ((b.x - rect.x) ** 2 + (b.y - rect.y) ** 2),
  );
}

export function displayForRect(
  rect: Rect,
  displays: readonly LayoutScreen[],
): LayoutScreen | undefined {
  if (!displays.length) return undefined;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const containing = displays.find(
    (d) =>
      cx >= d.workArea.x &&
      cx <= d.workArea.x + d.workArea.width &&
      cy >= d.workArea.y &&
      cy <= d.workArea.y + d.workArea.height,
  );
  if (containing) return containing;
  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const dx = Math.max(d.workArea.x - cx, 0, cx - (d.workArea.x + d.workArea.width));
    const dy = Math.max(d.workArea.y - cy, 0, cy - (d.workArea.y + d.workArea.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

export function normalizeTaskWindowSize(
  display: LayoutScreen,
  referenceRect?: Rect,
): { width: number; height: number } {
  const a = display.workArea;
  const margin = 24;
  const hardMaxWidth = Math.max(100, a.width - margin);
  const hardMaxHeight = Math.max(100, a.height - margin);
  const minWidth = Math.min(hardMaxWidth, Math.max(760, Math.floor(a.width * 0.44)));
  const maxWidth = Math.min(
    hardMaxWidth,
    Math.max(minWidth, Math.min(1140, Math.floor(a.width * 0.58))),
  );
  const minHeight = Math.min(hardMaxHeight, Math.max(520, Math.floor(a.height * 0.52)));
  const maxHeight = Math.min(
    hardMaxHeight,
    Math.max(minHeight, Math.min(780, Math.floor(a.height * 0.66))),
  );
  const defaultWidth = Math.min(maxWidth, Math.max(minWidth, Math.floor(a.width * 0.5)));
  const defaultHeight = Math.min(maxHeight, Math.max(minHeight, Math.floor(a.height * 0.6)));
  if (!referenceRect) {
    return { width: defaultWidth, height: defaultHeight };
  }
  const fitted = fitTaskWindow(referenceRect, display);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, fitted.width)),
    height: Math.min(maxHeight, Math.max(minHeight, fitted.height)),
  };
}

export function gridCascadeSlotRect(
  slotIndex: number,
  size: { width: number; height: number },
  display: LayoutScreen,
  step: number,
): Rect {
  const a = display.workArea;
  const margin = 12;
  const width = Math.min(size.width, Math.max(100, a.width - margin * 2));
  const height = Math.min(size.height, Math.max(100, a.height - margin * 2));
  const availX = Math.max(0, a.width - margin * 2 - width);
  const availY = Math.max(0, a.height - margin * 2 - height);
  const stepX = Math.max(24, step * 3);
  const stepY = Math.max(28, step * 4);
  // 每一斜列从上到下最多排 rowsPerCol 个窗口（至少 2 个，最多 10 个），确保每个窗口垂直方向都错开 stepY
  const rowsPerCol =
    availY >= stepY ? Math.max(2, Math.min(10, Math.floor(availY / stepY) + 1)) : 1;
  const index = Math.max(0, slotIndex);
  const row = index % rowsPerCol;
  const colGroup = Math.floor(index / rowsPerCol);
  // 每一大列之间的水平跨度，使多列斜向阶梯在屏幕上均匀展开
  const colStrideX = Math.max(stepX * 3, Math.min(220, Math.floor(availX / 3) || stepX * 3));
  const maxColSpan = Math.max(1, availX - (rowsPerCol - 1) * stepX);
  const groupOffsetX = availX > 0 ? (colGroup * colStrideX) % (maxColSpan + colStrideX) : 0;
  const rawX = a.x + margin + groupOffsetX + row * stepX;
  const rawY = a.y + margin + row * stepY;
  const x = Math.max(a.x + margin, Math.min(a.x + a.width - margin - width, rawX));
  const y = Math.max(a.y + margin, Math.min(a.y + a.height - margin - height, rawY));
  return { x, y, width, height };
}

export function arrangeTaskWindowsInOrder(
  ids: readonly string[],
  display: LayoutScreen,
  step: number,
  referenceRect?: Rect,
): Map<string, Rect> {
  const size = normalizeTaskWindowSize(display, referenceRect);
  const result = new Map<string, Rect>();
  ids.forEach((id, i) => {
    result.set(id, gridCascadeSlotRect(i, size, display, step));
  });
  return result;
}
