import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  autoTileGrid,
  computeCascadeRects,
  computeMultiDisplayTilePlan,
  computeMultiDisplayTileRects,
} from '../src/domain/window-layout.js';
import { WindowLayoutService } from '../src/application/window-layout.js';
import {
  defaultWindowLayout,
  type LayoutScreen,
  type LayoutSettings,
  type Rect,
  type TaskWindow,
  type TaskWindowPort,
} from '../src/shared/window-layout.js';

const primaryDisplay: LayoutScreen = {
  id: 'primary',
  primary: true,
  scaleFactor: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

const secondaryDisplay: LayoutScreen = {
  id: 'secondary',
  primary: false,
  scaleFactor: 1,
  workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
};

test('autoTileGrid chooses compact symmetric grids across window counts', () => {
  assert.deepEqual(autoTileGrid(1), { rows: 1, cols: 1 });
  assert.deepEqual(autoTileGrid(2), { rows: 1, cols: 2 });
  assert.deepEqual(autoTileGrid(4), { rows: 2, cols: 2 });
  assert.deepEqual(autoTileGrid(6), { rows: 2, cols: 3 });
  assert.deepEqual(autoTileGrid(9), { rows: 3, cols: 3 });
  assert.deepEqual(autoTileGrid(12), { rows: 3, cols: 4 });
});

test('computeMultiDisplayTileRects respects startSlot, cross-display spillover and keep overflow', () => {
  const rects = computeMultiDisplayTileRects(
    7,
    [primaryDisplay, secondaryDisplay],
    [
      { displayId: 'primary', enabled: true, rows: 2, cols: 2, startSlot: 2 },
      { displayId: 'secondary', enabled: true, rows: 2, cols: 2, startSlot: 1 },
    ],
    10,
    'keep',
  );
  // Primary offers slots 2, 3, 4 (3 slots). Secondary offers slots 1..4 (4 slots) -> total 7 exact.
  assert.equal(rects.length, 7);
  assert.ok(rects.every((r) => r !== null));
  // First window starts at slot 2 (top-right of primary).
  assert.ok((rects[0]?.x ?? 0) > 900 && (rects[0]?.x ?? 0) < 1920);
  // Fourth window spills onto secondary top-left.
  assert.ok((rects[3]?.x ?? 0) >= 1920);

  const overflowKeep = computeMultiDisplayTileRects(
    9,
    [primaryDisplay, secondaryDisplay],
    [
      { displayId: 'primary', enabled: true, rows: 2, cols: 2, startSlot: 2 },
      { displayId: 'secondary', enabled: true, rows: 2, cols: 2, startSlot: 1 },
    ],
    10,
    'keep',
  );
  assert.equal(overflowKeep[7], null);
  assert.equal(overflowKeep[8], null);
});

test('computeCascadeRects honors explicit dimensions, start offset and step intervals', () => {
  const rects = computeCascadeRects(3, primaryDisplay, {
    width: 800,
    height: 600,
    stepX: 30,
    stepY: 40,
    startX: 50,
    startY: 60,
  });
  assert.deepEqual(rects, [
    { x: 50, y: 60, width: 800, height: 600 },
    { x: 80, y: 100, width: 800, height: 600 },
    { x: 110, y: 140, width: 800, height: 600 },
  ]);
});

test('WindowLayoutService supports tile apply, focus_all without moving, and targetDisplayId move', async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const windows = new Map<string, TaskWindow>(
    ids.map((id, i) => [
      id,
      {
        proof: {
          profileId: id,
          ownershipId: randomUUID(),
          browserSessionEpoch: randomUUID(),
          tabId: i + 1,
          targetId: 't-' + i,
        },
        windowId: i + 1,
        state: 'normal',
        contentInsets: { left: 16, top: 96, right: 16, bottom: 16 },
        rect: { x: 40 + i * 20, y: 40 + i * 20, width: 900, height: 680 },
      },
    ]),
  );
  let settings: LayoutSettings = defaultWindowLayout;
  const moves: { id: string; rect: Rect; focus?: boolean }[] = [];
  const port: TaskWindowPort = {
    async read(id) {
      const hit = windows.get(id);
      if (!hit) throw Error('WINDOW_LAYOUT_PROFILE_OFFLINE');
      return structuredClone(hit);
    },
    async move(id, expected, rect, _exposed, _deadline, focus) {
      const after = { ...expected, rect: { ...rect } };
      windows.set(id, after);
      moves.push({ id, rect, focus });
      return structuredClone(after);
    },
  };
  const service = new WindowLayoutService(
    () => [primaryDisplay, secondaryDisplay],
    port,
    async () => settings,
    async (next) => {
      settings = next;
    },
  );

  await service.command({
    action: 'configure',
    settings: {
      version: 1,
      enabled: true,
      displayId: 'primary',
      step: 8,
      mode: 'tile',
      tileDisplays: [
        { displayId: 'primary', enabled: true, rows: 1, cols: 2, startSlot: 1 },
        { displayId: 'secondary', enabled: true, rows: 1, cols: 2, startSlot: 1 },
      ],
      tileGap: 10,
    },
  });

  await service.command({ action: 'apply', profileIds: ids });
  assert.equal(moves.length, 3);
  assert.ok((windows.get(ids[0] ?? '')?.rect.x ?? 9999) < 1920);
  assert.ok((windows.get(ids[2] ?? '')?.rect.x ?? 0) >= 1920);

  moves.length = 0;
  await service.command({ action: 'focus_all', profileIds: ids });
  assert.equal(moves.length, 3);
  assert.ok(moves.every((m) => m.focus === true));
  assert.deepEqual(moves[0]?.rect, windows.get(ids[0] ?? '')?.rect);

  moves.length = 0;
  await service.command({
    action: 'apply',
    profileIds: ids,
    targetDisplayId: 'secondary',
  });
  assert.equal(moves.length, 3);
  assert.ok(ids.every((id) => (windows.get(id)?.rect.x ?? 0) >= 1920));
});

test('Stage 2 M2: preserves null displayId in tile mode, tracks actual movedCount, fails when zero moved, and uses custom cascade in arrange', async () => {
  const plan = computeMultiDisplayTilePlan(
    4,
    [primaryDisplay, secondaryDisplay],
    [
      { displayId: 'primary', enabled: true, rows: 1, cols: 2, startSlot: 1 },
      { displayId: 'secondary', enabled: true, rows: 1, cols: 2, startSlot: 1 },
    ],
    10,
    'keep',
  );
  assert.equal(plan.entries.length, 2);
  assert.deepEqual(plan.entries[0]?.slotWindowIndices, [[0], [1]]);
  assert.deepEqual(plan.entries[1]?.slotWindowIndices, [[2], [3]]);

  const id1 = randomUUID();
  const id2 = randomUUID();
  const baseWin = (id: string): TaskWindow => ({
    proof: {
      profileId: id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 1,
      targetId: id,
    },
    windowId: 1,
    state: 'normal',
    contentInsets: { left: 16, top: 80, right: 16, bottom: 16 },
    rect: { x: 20, y: 20, width: 900, height: 680 },
  });
  const live = new Map<string, TaskWindow>([
    [id1, baseWin(id1)],
    [id2, baseWin(id2)],
  ]);
  let settings: LayoutSettings = defaultWindowLayout;
  let failMoves = false;
  const moves: { id: string; rect: Rect }[] = [];
  const port: TaskWindowPort = {
    async read(id) {
      const hit = live.get(id);
      if (!hit) throw Error('WINDOW_LAYOUT_PROFILE_OFFLINE');
      return structuredClone(hit);
    },
    async move(id, expected, rect) {
      if (failMoves) throw Error('WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED');
      const after = { ...expected, rect: { ...rect } };
      live.set(id, after);
      moves.push({ id, rect });
      return structuredClone(after);
    },
  };
  const service = new WindowLayoutService(
    () => [primaryDisplay, secondaryDisplay],
    port,
    async () => settings,
    async (next) => {
      settings = next;
    },
  );

  // Tile configure keeps displayId: null rather than overwriting it with 'primary'
  const configured = await service.command({
    action: 'configure',
    settings: {
      version: 1,
      enabled: true,
      displayId: null,
      step: 8,
      mode: 'tile',
      tileDisplays: [
        { displayId: 'primary', enabled: true, rows: 1, cols: 2, startSlot: 1 },
        { displayId: 'secondary', enabled: true, rows: 1, cols: 2, startSlot: 1 },
      ],
    },
  });
  assert.equal(configured.settings.displayId, null);

  // Zero moved propagates error & keeps managed empty
  failMoves = true;
  await assert.rejects(
    () => service.command({ action: 'apply', profileIds: [id1, id2], mode: 'tile' }),
    /WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED/,
  );
  assert.equal((await service.snapshot()).managed.length, 0);

  // Partial / full success accurately reports movedCount
  failMoves = false;
  const applied = await service.command({ action: 'apply', profileIds: [id1, id2], mode: 'tile' });
  assert.equal(applied.movedCount, 2);

  // Custom cascade dimensions apply in single-window arrange()
  await service.command({
    action: 'configure',
    settings: {
      version: 1,
      enabled: true,
      displayId: 'primary',
      step: 8,
      mode: 'cascade',
      cascadeWidth: 720,
      cascadeHeight: 540,
      cascadeStartX: 40,
      cascadeStartY: 50,
    },
  });
  moves.length = 0;
  await service.arrange(id1);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0]?.rect, { x: 40, y: 50, width: 720, height: 540 });
});
