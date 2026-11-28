import type {
  Rect,
  LayoutScreen,
  LayoutSettings,
  TaskWindow,
  TileDisplayConfig,
} from '../shared/window-layout.js';
const clamp = (min: number, max: number, v: number) => Math.max(min, Math.min(max, v));
const clampRect = (
  r: { width: number; height: number },
  x: number,
  y: number,
  a: Rect,
  m = 12,
) => ({
  width: r.width,
  height: r.height,
  x: clamp(a.x + m, a.x + a.width - m - r.width, x),
  y: clamp(a.y + m, a.y + a.height - m - r.height, y),
});
export function fitTaskWindow(rect: Rect, display: LayoutScreen): Rect {
  const a = display.workArea,
    maxW = a.width - 24,
    maxH = a.height - 24;
  if (maxW < 100 || maxH < 100) throw Error('WINDOW_LAYOUT_CAPACITY_EXCEEDED');
  const large = rect.width * rect.height > (a.width * a.height) / 2;
  return clampRect(
    {
      width: Math.min(rect.width, maxW, large ? Math.max(640, Math.floor(a.width * 0.6)) : maxW),
      height: Math.min(rect.height, maxH, large ? Math.max(480, Math.floor(a.height * 0.8)) : maxH),
    },
    rect.x,
    rect.y,
    a,
  );
}
export function reservedLayoutDisplay(
  display: LayoutScreen,
  settings: LayoutSettings,
): LayoutScreen {
  const s = display.workArea,
    saved = settings.reservedArea ?? s,
    x = Math.max(saved.x, s.x),
    y = Math.max(saved.y, s.y),
    w = Math.min(saved.x + saved.width, s.x + s.width) - x,
    h = Math.min(saved.y + saved.height, s.y + s.height) - y;
  return { ...display, workArea: w >= 124 && h >= 124 ? { x, y, width: w, height: h } : { ...s } };
}
export function contentWindowRect(window: Pick<TaskWindow, 'rect' | 'contentInsets'>): Rect {
  const { rect, contentInsets: i } = window;
  if (!i) return rect;
  const r = {
    x: rect.x + i.left,
    y: rect.y + i.top,
    width: rect.width - i.left - i.right,
    height: rect.height - i.top - i.bottom,
  };
  if (r.width < 2 || r.height < 2) throw Error('WINDOW_LAYOUT_CONTENT_BOUNDS_REQUIRED');
  return r;
}
export function displayForRect(
  rect: Rect,
  displays: readonly LayoutScreen[],
): LayoutScreen | undefined {
  if (!displays.length) return undefined;
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  return (
    displays.find(
      ({ workArea: a }) => cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height,
    ) ??
    displays.reduce((best, d) => {
      const dist = ({ workArea: a }: LayoutScreen) =>
        Math.max(a.x - cx, 0, cx - (a.x + a.width)) ** 2 +
        Math.max(a.y - cy, 0, cy - (a.y + a.height)) ** 2;
      return dist(d) < dist(best) ? d : best;
    })
  );
}
export function normalizeTaskWindowSize(
  display: LayoutScreen,
  referenceRect?: Rect,
): { width: number; height: number } {
  const a = display.workArea,
    hw = Math.max(100, a.width - 24),
    hh = Math.max(100, a.height - 24),
    minW = Math.min(hw, Math.max(760, Math.floor(a.width * 0.44))),
    maxW = Math.min(hw, Math.max(minW, Math.min(1140, Math.floor(a.width * 0.58)))),
    minH = Math.min(hh, Math.max(520, Math.floor(a.height * 0.52))),
    maxH = Math.min(hh, Math.max(minH, Math.min(780, Math.floor(a.height * 0.66)))),
    src = referenceRect
      ? fitTaskWindow(referenceRect, display)
      : { width: Math.floor(a.width * 0.5), height: Math.floor(a.height * 0.6) };
  return { width: clamp(minW, maxW, src.width), height: clamp(minH, maxH, src.height) };
}
export const gridCascadeSlotRect = (
  slotIndex: number,
  size: { width: number; height: number },
  display: LayoutScreen,
  step: number,
): Rect => cascadeSlotRect(slotIndex, display, { ...size, step, maxRows: 10, maxColStride: 220 });
function cascadeSlotRect(
  slotIndex: number,
  display: LayoutScreen,
  opts: {
    width: number;
    height: number;
    stepX?: number;
    stepY?: number;
    startX?: number;
    startY?: number;
    step?: number;
    maxRows: number;
    maxColStride: number;
  },
): Rect {
  const a = display.workArea,
    m = 12,
    width = Math.min(opts.width, Math.max(100, a.width - m * 2)),
    height = Math.min(opts.height, Math.max(100, a.height - m * 2)),
    fbStep = opts.step ?? 8,
    stepX = Math.max(8, opts.stepX ?? Math.max(24, fbStep * 3)),
    stepY = Math.max(8, opts.stepY ?? Math.max(28, fbStep * 4)),
    startX = clamp(m, Math.max(m, a.width - width - m), opts.startX ?? m),
    startY = clamp(m, Math.max(m, a.height - height - m), opts.startY ?? m),
    availX = Math.max(0, a.width - m - width - startX),
    availY = Math.max(0, a.height - m - height - startY),
    rowsPerCol = availY >= stepY ? clamp(2, opts.maxRows, Math.floor(availY / stepY) + 1) : 1,
    index = Math.max(0, slotIndex),
    row = index % rowsPerCol,
    colGroup = Math.floor(index / rowsPerCol),
    colStrideX = Math.max(
      stepX * 3,
      Math.min(opts.maxColStride, Math.floor(availX / 3) || stepX * 3),
    ),
    maxColSpan = Math.max(1, availX - (rowsPerCol - 1) * stepX),
    groupOffsetX = availX > 0 ? (colGroup * colStrideX) % (maxColSpan + colStrideX) : 0;
  return clampRect(
    { width, height },
    a.x + startX + groupOffsetX + row * stepX,
    a.y + startY + row * stepY,
    a,
    m,
  );
}
const TILE_PRESETS: [number, number, number][] = [
  [1, 1, 1],
  [2, 1, 2],
  [4, 2, 2],
  [6, 2, 3],
  [9, 3, 3],
  [12, 3, 4],
  [16, 4, 4],
];
export function autoTileGrid(count: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.floor(count)),
    hit = TILE_PRESETS.find(([cap]) => n <= cap);
  if (hit) return { rows: hit[1], cols: hit[2] };
  const cols = Math.min(8, Math.ceil(Math.sqrt(n)));
  return { rows: Math.min(8, Math.ceil(n / cols)), cols };
}
export function computeDisplayTileSlots(
  display: LayoutScreen,
  rows: number,
  cols: number,
  gap = 8,
): Rect[] {
  const sr = clamp(1, 8, Math.floor(rows)),
    sc = clamp(1, 8, Math.floor(cols)),
    sg = clamp(0, 48, Math.floor(gap)),
    a = display.workArea,
    cw = Math.max(100, Math.floor((a.width - sg * (sc + 1)) / sc)),
    ch = Math.max(100, Math.floor((a.height - sg * (sr + 1)) / sr)),
    slots: Rect[] = [];
  for (let r = 0; r < sr; r++)
    for (let c = 0; c < sc; c++) {
      const rx = a.x + sg + c * (cw + sg),
        ry = a.y + sg + r * (ch + sg);
      slots.push({
        x: Math.min(rx, a.x + a.width - 100),
        y: Math.min(ry, a.y + a.height - 100),
        width: Math.min(cw, Math.max(100, a.x + a.width - sg - rx)),
        height: Math.min(ch, Math.max(100, a.y + a.height - sg - ry)),
      });
    }
  return slots;
}
interface DisplayTilePlanEntry {
  display: LayoutScreen;
  config: TileDisplayConfig;
  rows: number;
  cols: number;
  startIdx: number;
  slots: Rect[];
  slotWindowIndices: number[][];
}
function resolveActiveTileDisplays(
  displays: readonly LayoutScreen[],
  tileConfigs?: readonly TileDisplayConfig[],
): Array<{ display: LayoutScreen; config: TileDisplayConfig }> {
  const byId = new Map(displays.map((d) => [d.id, d])),
    active = (tileConfigs ?? []).flatMap((c) => {
      const d = byId.get(c.displayId);
      return c.enabled && d ? [{ display: d, config: c }] : [];
    });
  if (!active.length) {
    const primary = displays.find((d) => d.primary) ?? displays[0];
    if (primary)
      active.push({
        display: primary,
        config: { displayId: primary.id, enabled: true, rows: 0, cols: 0, startSlot: 1 },
      });
  }
  return active;
}
export function computeTileSlotCapacity(
  displays: readonly LayoutScreen[],
  tileConfigs?: readonly TileDisplayConfig[],
): number {
  const active = resolveActiveTileDisplays(displays, tileConfigs);
  if (!active.length) return 1;
  let total = 0;
  for (const { config } of active) {
    if (config.rows > 0 && config.cols > 0) {
      const cap = clamp(1, 8, Math.floor(config.rows)) * clamp(1, 8, Math.floor(config.cols));
      const startIdx = clamp(0, Math.max(0, cap - 1), config.startSlot - 1);
      total += Math.max(0, cap - startIdx);
    } else {
      const autoCap = Math.max(
        4,
        config.rows > 0 ? config.rows * 2 : config.cols > 0 ? config.cols * 2 : 4,
      );
      const startIdx = clamp(0, autoCap - 1, config.startSlot - 1);
      total += Math.max(1, autoCap - startIdx);
    }
  }
  return Math.max(1, total);
}
export function computeMultiDisplayTilePlan(
  count: number,
  displays: readonly LayoutScreen[],
  tileConfigs?: readonly TileDisplayConfig[],
  gap = 8,
  overflow: 'wrap' | 'keep' = 'wrap',
): { entries: DisplayTilePlanEntry[]; rects: Array<Rect | null> } {
  if (count <= 0 || !displays.length)
    return { entries: [], rects: Array.from({ length: Math.max(0, count) }, () => null) };
  const active = resolveActiveTileDisplays(displays, tileConfigs);
  const entries: DisplayTilePlanEntry[] = [],
    pool: Array<{ rect: Rect; display: LayoutScreen; entryIndex: number; slotIndex: number }> = [];
  let rem = count;
  for (const { display, config } of active) {
    const auto = autoTileGrid(Math.max(1, rem)),
      rows = config.rows > 0 ? config.rows : auto.rows,
      cols = config.cols > 0 ? config.cols : auto.cols,
      slots = computeDisplayTileSlots(display, rows, cols, gap),
      startIdx = clamp(0, Math.max(0, slots.length - 1), config.startSlot - 1),
      entryIndex = entries.length;
    entries.push({
      display,
      config,
      rows,
      cols,
      startIdx,
      slots,
      slotWindowIndices: Array.from({ length: slots.length }, () => []),
    });
    for (let s = startIdx; s < slots.length; s++) {
      const rect = slots[s];
      if (rect) pool.push({ rect, display, entryIndex, slotIndex: s });
    }
    rem = Math.max(0, rem - Math.max(0, slots.length - startIdx));
  }
  if (!pool.length) return { entries, rects: Array.from({ length: count }, () => null) };
  return {
    entries,
    rects: Array.from({ length: count }, (_, i) => {
      const slot = i >= pool.length && overflow === 'keep' ? undefined : pool[i % pool.length];
      if (!slot) return null;
      entries[slot.entryIndex]?.slotWindowIndices[slot.slotIndex]?.push(i);
      const shift = i < pool.length ? 0 : Math.floor(i / pool.length) * 16;
      return shift
        ? clampRect(slot.rect, slot.rect.x + shift, slot.rect.y + shift, slot.display.workArea, 0)
        : { ...slot.rect };
    }),
  };
}
export const computeMultiDisplayTileRects = (
  count: number,
  displays: readonly LayoutScreen[],
  tileConfigs?: readonly TileDisplayConfig[],
  gap = 8,
  overflow: 'wrap' | 'keep' = 'wrap',
): Array<Rect | null> =>
  computeMultiDisplayTilePlan(count, displays, tileConfigs, gap, overflow).rects;
export function computeCascadeRects(
  count: number,
  display: LayoutScreen,
  opts?: {
    width?: number;
    height?: number;
    stepX?: number;
    stepY?: number;
    startX?: number;
    startY?: number;
    step?: number;
    referenceRect?: Rect;
  },
): Rect[] {
  if (count <= 0) return [];
  const def = normalizeTaskWindowSize(display, opts?.referenceRect);
  return Array.from({ length: count }, (_, i) =>
    cascadeSlotRect(i, display, {
      ...opts,
      width: opts?.width ?? def.width,
      height: opts?.height ?? def.height,
      maxRows: 12,
      maxColStride: 240,
    }),
  );
}
