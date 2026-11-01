import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WindowLayoutService } from '../src/application/window-layout.js';
import {
  fitTaskWindow,
  taskWindowPositions,
  reservedLayoutDisplay,
  displayForRect,
  normalizeTaskWindowSize,
  gridCascadeSlotRect,
  arrangeTaskWindowsInOrder,
} from '../src/domain/window-layout.js';
import {
  defaultWindowLayout,
  WindowLayoutOverview,
  type LayoutScreen,
  type LayoutSettings,
  type TaskWindow,
  type TaskWindowPort,
  type Rect,
} from '../src/shared/window-layout.js';

const screen: LayoutScreen = {
  id: 'secondary',
  primary: false,
  scaleFactor: 1.25,
  workArea: { x: -2048, y: 556, width: 2048, height: 1233 },
};
const enabled: LayoutSettings = { version: 1, enabled: true, displayId: screen.id, step: 8 };
const tick = () => new Promise<void>((r) => setImmediate(r));
function fixture(count = 2) {
  const ids = Array.from({ length: count }, () => randomUUID());
  const windows = new Map<string, TaskWindow>(
    ids.map((id, i) => [
      id,
      {
        proof: {
          profileId: id,
          ownershipId: randomUUID(),
          browserSessionEpoch: randomUUID(),
          tabId: i + 1,
          targetId: 'native-' + i,
        },
        windowId: i + 1,
        state: 'normal',
        contentInsets: { left: 16, top: 104, right: 16, bottom: 16 },
        rect: { x: -1700, y: 700, width: 960, height: 720 },
      },
    ]),
  );
  let settings: LayoutSettings = defaultWindowLayout;
  let displays = [screen];
  const moves: { id: string; rect: Rect }[] = [];
  const port: TaskWindowPort = {
    async read(id) {
      if (!windows.has(id)) throw Error('WINDOW_LAYOUT_PROFILE_OFFLINE');
      return structuredClone(windows.get(id)!);
    },
    async move(id, expected, rect) {
      assert.deepEqual(expected, windows.get(id));
      const after = { ...expected, rect: { ...rect } };
      windows.set(id, after);
      moves.push({ id, rect });
      return structuredClone(after);
    },
  };
  const service = new WindowLayoutService(
    () => displays,
    port,
    async () => settings,
    async (v) => {
      settings = v;
    },
  );
  return {
    ids,
    windows,
    moves,
    port,
    service,
    settings: () => settings,
    displays: (v: LayoutScreen[]) => {
      displays = v;
    },
  };
}

test('new task adopts current position after manual move, resize and a new ownership proof', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.arrange(id);
  const w = f.windows.get(id)!;
  w.rect.x += 77;
  w.rect.y += 35;
  w.rect.width += 2;
  w.rect.height -= 10;
  w.proof.ownershipId = randomUUID();
  const current = structuredClone(w);
  await f.service.arrange(id);
  assert.deepEqual(f.windows.get(id), current);
  assert.equal((await f.service.snapshot()).error, '');
});

test('hidden recovery accepts current manual movement and content inset changes', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.arrange(id);
  const w = f.windows.get(id)!;
  w.rect.x += 33;
  w.rect.height += 2;
  w.contentInsets!.top += 12;
  await f.service.recover(id, () => {});
  assert.equal(f.moves.length, 2);
  assert.equal((await f.service.snapshot()).recovery[0]?.moves, 1);
});

test('recovery moves only its current task; stale or offscreen peers cannot block it', async () => {
  const f = fixture(),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  for (const own of f.ids) await f.service.arrange(own);
  const other = structuredClone(f.windows.get(f.ids[1]!)!);
  const read = f.port.read;
  f.port.read = async (own) => {
    assert.equal(own, id);
    return read(own);
  };
  await f.service.recover(id, () => {});
  assert.deepEqual(f.windows.get(f.ids[1]!), other);
});

test('ordinary windows keep size; oversized windows shrink and fit primary or negative-origin screen', () => {
  const ordinary = { x: -1700, y: 700, width: 960, height: 720 };
  assert.deepEqual(fitTaskWindow(ordinary, screen), ordinary);
  for (const workArea of [screen.workArea, { x: 0, y: 0, width: 1366, height: 768 }]) {
    const display = { ...screen, workArea };
    const r = fitTaskWindow({ x: 9999, y: -9000, width: 3000, height: 2000 }, display);
    assert.ok(r.width < 3000 && r.height < 2000);
    assert.ok(r.x >= workArea.x && r.y >= workArea.y);
    assert.ok(r.x + r.width <= workArea.x + workArea.width);
    assert.ok(r.y + r.height <= workArea.y + workArea.height);
  }
});

test('startup shrinks a large window without rejecting it or changing another window', async () => {
  const f = fixture(),
    id = f.ids[0]!;
  f.windows.get(id)!.rect = { x: -2048, y: 556, width: 2048, height: 1233 };
  const other = structuredClone(f.windows.get(f.ids[1]!)!);
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.arrange(id);
  assert.ok(f.windows.get(id)!.rect.width < 2048);
  assert.deepEqual(f.windows.get(f.ids[1]!), other);
});

test('candidate positions use nearest distance and permit overlap', () => {
  const rect = { x: -1700, y: 700, width: 960, height: 720 };
  const candidates = taskWindowPositions(rect, [{ rect }], screen, 8);
  assert.ok(
    candidates.some(
      (r) => Math.abs(r.x - rect.x) < rect.width && Math.abs(r.y - rect.y) < rect.height,
    ),
  );
  const distances = candidates.map((r) => (r.x - rect.x) ** 2 + (r.y - rect.y) ** 2);
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b),
  );
  assert.equal(new Set(candidates.map((r) => `${r.x}:${r.y}`)).size, candidates.length);
});

test('three failed positions are bounded within a recovery round despite native frame changes; visibility resets it', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.arrange(id);
  const move = f.port.move;
  f.port.move = async (...args) => {
    const after = await move(...args);
    after.rect.width++;
    after.rect.height++;
    f.windows.set(args[0], structuredClone(after));
    return after;
  };
  for (let i = 0; i < 3; i++) {
    await f.service.recover(id, () => {});
    f.service.visible(id, 0);
  }
  assert.equal(f.moves.length, 4);
  await assert.rejects(
    f.service.recover(id, () => {}),
    /RECOVERY_EXHAUSTED/,
  );
  WindowLayoutOverview.parse(await f.service.snapshot());
  assert.equal((await f.service.snapshot()).recovery[0]?.state, 'NEEDS_ATTENTION');
  f.service.visible(id, Date.now() + 1);
  assert.deepEqual((await f.service.snapshot()).recovery, []);
  await f.service.recover(id, () => {});
  assert.equal(f.moves.length, 5);
});

test('exhausted window recovery stays bounded before 15 seconds and automatically starts another round after cooldown', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.arrange(id);
  for (let i = 0; i < 3; i++) await f.service.recover(id, () => {});
  await assert.rejects(
    f.service.recover(id, () => {}),
    /RECOVERY_EXHAUSTED/,
  );
  const moves = f.moves.length;
  now += 14999;
  await assert.rejects(
    f.service.recover(id, () => {}),
    /RECOVERY_EXHAUSTED/,
  );
  assert.equal(f.moves.length, moves);
  now++;
  await f.service.recover(id, () => {});
  assert.equal(f.moves.length, moves + 1);
  assert.equal((await f.service.snapshot()).recovery[0]?.moves, 1);
  assert.equal((await f.service.snapshot()).recovery[0]?.state, 'AWAITING_VISIBILITY');
});

test('disable clears recovery without moving or restoring any window', async () => {
  const f = fixture();
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.command({ action: 'apply', profileIds: f.ids });
  await f.service.recover(f.ids[0]!, () => {});
  const before = structuredClone(f.windows),
    count = f.moves.length;
  await f.service.command({ action: 'restore' });
  assert.deepEqual(f.windows, before);
  assert.equal(f.moves.length, count);
  assert.equal(f.settings().enabled, false);
  assert.deepEqual((await f.service.snapshot()).managed, []);
  await assert.rejects(
    f.service.recover(f.ids[0]!, () => {}),
    /DISABLED/,
  );
});

test('after a covered nearby offset, the next attempt changes screen region', async () => {
  const f = fixture(),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  for (const own of f.ids) await f.service.arrange(own);
  const start = f.moves.length;
  await f.service.recover(id, () => {});
  await f.service.recover(id, () => {});
  const a = f.moves[start]!.rect,
    b = f.moves[start + 1]!.rect;
  assert.ok(Math.abs(a.x - b.x) >= a.width / 2 || Math.abs(a.y - b.y) >= a.height / 2);
});

test('STOP before dispatch and during read prevents any move', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  await assert.rejects(
    f.service.arrange(id, () => {
      throw Error('STOPPED');
    }),
    /STOPPED/,
  );
  let live = true;
  const read = f.port.read;
  f.port.read = async (own) => {
    const v = await read(own);
    live = false;
    return v;
  };
  await assert.rejects(
    f.service.recover(id, () => {
      if (!live) throw Error('STOPPED');
    }),
    /STOPPED/,
  );
  assert.equal(f.moves.length, 0);
});

test('STOP during dispatched move never rolls it back or moves another window', async () => {
  const f = fixture(),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  let live = true;
  const move = f.port.move;
  f.port.move = async (...args) => {
    const result = await move(...args);
    live = false;
    return result;
  };
  await assert.rejects(
    f.service.arrange(id, () => {
      if (!live) throw Error('STOPPED');
    }),
    /STOPPED/,
  );
  assert.equal(f.moves.length, 1);
});

test('queued operation checks STOP after preceding move drains', async () => {
  const f = fixture();
  await f.service.command({ action: 'configure', settings: enabled });
  let resume!: () => void;
  const move = f.port.move;
  f.port.move = async (...args) => {
    await new Promise<void>((r) => {
      resume = r;
    });
    return move(...args);
  };
  const first = f.service.arrange(f.ids[0]!);
  await tick();
  const second = assert.rejects(
    f.service.arrange(f.ids[1]!, () => {
      throw Error('STOPPED');
    }),
    /STOPPED/,
  );
  resume();
  await Promise.all([first, second]);
  assert.equal(f.moves.length, 1);
});

test('changed proof resets in-progress recovery and adopts the updated main tab', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  await f.service.arrange(id);
  f.windows.get(id)!.proof.ownershipId = randomUUID();
  await f.service.recover(id, () => {});
  await f.service.arrange(id);
  await f.service.recover(id, () => {});
});

test('partial manual arrange failure keeps completed moves and never auto-restores', async () => {
  const f = fixture();
  await f.service.command({ action: 'configure', settings: enabled });
  const move = f.port.move;
  f.port.move = async (...args) => {
    if (args[0] === f.ids[1]) throw Error('NATIVE_FAILED');
    return move(...args);
  };
  await assert.rejects(f.service.command({ action: 'apply', profileIds: f.ids }), /NATIVE_FAILED/);
  assert.equal(f.moves.length, 1);
  assert.equal((await f.service.snapshot()).managed.length, 1);
});

test('invalid saved region is clipped; missing viewport or all displays still fails without moves', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  const configured = await f.service.command({
    action: 'configure',
    settings: { ...enabled, reservedArea: { ...screen.workArea, x: -3000 } },
  });
  assert.deepEqual(configured.settings.reservedArea, {
    x: -2048,
    y: 556,
    width: 1096,
    height: 1233,
  });
  await f.service.command({ action: 'configure', settings: enabled });
  delete f.windows.get(id)!.contentInsets;
  await assert.rejects(f.service.arrange(id), /CONTENT_BOUNDS_REQUIRED/);
  f.displays([]);
  await assert.rejects(
    f.service.command({ action: 'configure', settings: enabled }),
    /DISPLAY_MISSING/,
  );
  assert.equal(f.moves.length, 0);
});

test('display unplug and DPI changes fall back or clamp without blocking ordinary arrange', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({
    action: 'configure',
    settings: { ...enabled, reservedArea: screen.workArea },
  });
  const primary: LayoutScreen = {
    id: 'primary',
    primary: true,
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  f.displays([{ ...screen, id: 'other-secondary' }, primary]);
  await f.service.arrange(id);
  assert.equal(f.moves.length, 1);
  assert.deepEqual(
    f.moves[0]?.rect,
    fitTaskWindow({ x: -1700, y: 700, width: 960, height: 720 }, primary),
  );
  assert.equal((await f.service.snapshot()).error, '');
  const configured = await f.service.command({
    action: 'configure',
    settings: { ...enabled, reservedArea: screen.workArea },
  });
  assert.equal(configured.settings.displayId, 'primary');
  assert.deepEqual(configured.settings.reservedArea, primary.workArea);
  const clipped = reservedLayoutDisplay(primary, {
    ...enabled,
    reservedArea: { x: -200, y: -100, width: 1500, height: 900 },
  });
  assert.deepEqual(clipped.workArea, { x: 0, y: 0, width: 1300, height: 800 });
  for (const area of [
    { x: 1900, y: 0, width: 400, height: 700 },
    { x: 0, y: 1000, width: 700, height: 400 },
    { x: 9000, y: 9000, width: 700, height: 700 },
  ])
    assert.deepEqual(
      reservedLayoutDisplay(primary, { ...enabled, reservedArea: area }).workArea,
      primary.workArea,
    );
  await f.service.command({
    action: 'configure',
    settings: {
      ...enabled,
      displayId: primary.id,
      reservedArea: { x: 400, y: 100, width: 1500, height: 900 },
    },
  });
  const smaller = { ...primary, workArea: { x: 0, y: 0, width: 1280, height: 720 } };
  f.displays([smaller]);
  const beforeResize = structuredClone(f.windows.get(id)!.rect);
  await f.service.arrange(id);
  assert.deepEqual(
    f.windows.get(id)!.rect,
    fitTaskWindow(beforeResize, {
      ...smaller,
      workArea: { x: 400, y: 100, width: 880, height: 620 },
    }),
  );
  // No primary flag: use the first connected screen; do not require a stale ID.
  f.displays([{ ...primary, primary: false }]);
  await f.service.command({
    action: 'configure',
    settings: { ...enabled, displayId: 'unplugged' },
  });
  await f.service.arrange(id);
});

test('100 starts use current windows without capacity rejection from historical placements', async () => {
  const f = fixture(100);
  await f.service.command({ action: 'configure', settings: enabled });
  await Promise.all(f.ids.map((id) => f.service.arrange(id)));
  assert.equal(f.moves.length, 100);
  assert.equal((await f.service.snapshot()).managed.length, 100);
});

test('normal task startup arranges without focusing; actual hidden recovery requests focus', async () => {
  const f = fixture(1),
    id = f.ids[0]!;
  await f.service.command({ action: 'configure', settings: enabled });
  const focuses: (boolean | undefined)[] = [],
    move = f.port.move;
  f.port.move = async (...args) => {
    focuses.push(args[5]);
    return move(...args);
  };
  await f.service.arrange(id);
  await f.service.recover(id, () => {});
  assert.deepEqual(focuses, [false, true]);
});

test('gridCascadeSlotRect and arrangeTaskWindowsInOrder produce uniform sizes and fixed offsets on the active display', async () => {
  const f = fixture(5);
  const primary: LayoutScreen = {
    id: 'primary',
    primary: true,
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  f.displays([primary, screen]);
  // Put focused browser on secondary display
  f.windows.get(f.ids[2]!)!.rect = { x: -1600, y: 650, width: 920, height: 700 };
  assert.equal(displayForRect(f.windows.get(f.ids[2]!)!.rect, [primary, screen])?.id, 'secondary');

  const size = normalizeTaskWindowSize(screen, f.windows.get(f.ids[2]!)!.rect);
  const arranged = arrangeTaskWindowsInOrder(f.ids, screen, 8, f.windows.get(f.ids[2]!)!.rect);
  assert.equal(arranged.size, 5);
  for (const [idx, id] of f.ids.entries()) {
    const r = arranged.get(id)!;
    assert.equal(r.width, size.width);
    assert.equal(r.height, size.height);
    assert.deepEqual(r, gridCascadeSlotRect(idx, size, screen, 8));
    assert.ok(r.x >= screen.workArea.x + 12);
    assert.ok(r.y >= screen.workArea.y + 12);
  }

  let focusedId: string | null = f.ids[2]!;
  const activeService = new WindowLayoutService(
    () => [primary, screen],
    f.port,
    async () => ({ version: 1, enabled: true, displayId: null, step: 8 }),
    async () => {},
    undefined,
    () => focusedId,
  );
  await activeService.command({ action: 'apply', profileIds: f.ids });
  const r0 = f.windows.get(f.ids[0]!)!.rect;
  const r1 = f.windows.get(f.ids[1]!)!.rect;
  const r2 = f.windows.get(f.ids[2]!)!.rect;
  const r3 = f.windows.get(f.ids[3]!)!.rect;
  assert.equal(r0.width, r1.width);
  assert.equal(r0.height, r1.height);
  assert.ok(
    r0.x < 0,
    'expected window to be arranged on secondary display where focusedId resides',
  );
  assert.ok(r1.x > r0.x && r1.y > r0.y, 'expected diagonal cascade step for slot 0 -> 1');
  assert.ok(r2.x > r1.x && r2.y > r1.y, 'expected diagonal cascade step for slot 1 -> 2');
  assert.ok(r3.x > r2.x && r3.y > r2.y, 'expected diagonal cascade step for slot 2 -> 3');

  const fullScreenSize = normalizeTaskWindowSize(primary, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1040,
  });
  assert.ok(
    fullScreenSize.height <= Math.floor(primary.workArea.height * 0.75),
    'expected at least 25% vertical cascade headroom even for full-screen reference window',
  );
});

test('window layout apply tolerates offline or failed individual browsers and arranges online ones concurrently', async () => {
  const f = fixture(5);
  // Remove one profile to simulate offline browser
  const offlineId = f.ids[1]!;
  f.windows.delete(offlineId);
  const moveFailId = f.ids[3]!;
  const origMove = f.port.move;
  let concurrentInFlight = 0;
  let maxConcurrent = 0;
  f.port.move = async (...args) => {
    concurrentInFlight++;
    maxConcurrent = Math.max(maxConcurrent, concurrentInFlight);
    try {
      await new Promise<void>((r) => setImmediate(r));
      if (args[0] === moveFailId) throw Error('WINDOW_MINIMIZED_OR_BUSY');
      return await origMove(...args);
    } finally {
      concurrentInFlight--;
    }
  };
  const service = new WindowLayoutService(
    () => [screen],
    f.port,
    async () => enabled,
    async () => {},
    undefined,
    () => f.ids[0]!,
  );
  await service.command({ action: 'apply', profileIds: f.ids });
  // 4 online profiles inspected, 1 move failed -> 3 moves succeeded without throwing 409/500
  assert.equal(f.moves.length, 3);
  assert.ok(maxConcurrent >= 2, 'expected concurrent window positioning');
});

test('window layout apply follows user-dragged browser to primary display instead of sticking to cached secondary display', async () => {
  const f = fixture(5);
  const primary: LayoutScreen = {
    id: 'primary',
    primary: true,
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  let focusedId: string | null = f.ids[0]!;
  const service = new WindowLayoutService(
    () => [primary, screen],
    f.port,
    async () => ({ version: 1, enabled: true, displayId: 'secondary', step: 8 }),
    async () => {},
    undefined,
    () => focusedId,
  );
  // First arrange all 5 windows on secondary display
  await service.command({ action: 'apply', profileIds: f.ids });
  for (const id of f.ids) {
    assert.ok(f.windows.get(id)!.rect.x < 0, 'initially arranged on secondary display');
  }
  assert.equal((await service.snapshot()).settings.displayId, 'secondary');

  // Simulate user dragging ids[3] onto primary display without changing focusedId first
  f.windows.get(f.ids[3]!)!.rect = { x: 200, y: 160, width: 960, height: 720 };
  await service.command({ action: 'apply', profileIds: f.ids });
  for (const id of f.ids) {
    const r = f.windows.get(id)!.rect;
    assert.ok(r.x >= 0 && r.x < 1920, `expected ${id} to move to primary display, got x=${r.x}`);
  }
  assert.equal((await service.snapshot()).settings.displayId, 'primary');

  // Also verify when focusedId is explicitly ids[3] after moving back to secondary and then dragging to primary
  for (const id of f.ids) {
    f.windows.get(id)!.rect = { x: -1600, y: 650, width: 960, height: 720 };
  }
  focusedId = f.ids[0]!;
  await service.command({ action: 'apply', profileIds: f.ids });
  assert.equal((await service.snapshot()).settings.displayId, 'secondary');

  f.windows.get(f.ids[3]!)!.rect = { x: 200, y: 160, width: 960, height: 720 };
  focusedId = f.ids[3]!;
  await service.command({ action: 'apply', profileIds: f.ids });
  for (const id of f.ids) {
    const r = f.windows.get(id)!.rect;
    assert.ok(
      r.x >= 0 && r.x < 1920,
      `expected ${id} on primary display when focusedId=${focusedId}`,
    );
  }
  assert.equal((await service.snapshot()).settings.displayId, 'primary');
});

test('window layout apply arranges selected subset onto the display of an unselected last-focused window', async () => {
  const f = fixture(5);
  const primary: LayoutScreen = {
    id: 'primary',
    primary: true,
    scaleFactor: 1,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  // Place ids[4] on primary display as the last-focused window, while ids[0..2] are on secondary display
  f.windows.get(f.ids[4]!)!.rect = { x: 300, y: 180, width: 960, height: 720 };
  const focusedId = f.ids[4]!;
  const service = new WindowLayoutService(
    () => [primary, screen],
    f.port,
    async () => ({ version: 1, enabled: true, displayId: 'secondary', step: 8 }),
    async () => {},
    undefined,
    () => focusedId,
  );
  const subset = f.ids.slice(0, 3);
  await service.command({ action: 'apply', profileIds: subset });
  for (const id of subset) {
    const r = f.windows.get(id)!.rect;
    assert.ok(
      r.x >= 0 && r.x < 1920,
      `expected subset window ${id} to arrange onto primary display where focused window resides, got x=${r.x}`,
    );
  }
  assert.equal((await service.snapshot()).settings.displayId, 'primary');
});
