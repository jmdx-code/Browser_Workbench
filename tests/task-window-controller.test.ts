import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskWindowController } from '../extension/task-window-controller.js';
import type { TaskWindow } from '../src/shared/window-layout.js';

const tick = () => new Promise<void>((r) => setImmediate(r));
async function fixture(
  run: (f: {
    controller: TaskWindowController;
    current: TaskWindow;
    writes: object[];
    guard: () => void;
    revoke: () => void;
    setUpdate: (fn: () => Promise<void>) => void;
  }) => Promise<void>,
) {
  const previous = globalThis.chrome;
  const proof = {
    profileId: randomUUID(),
    ownershipId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 7,
    targetId: 'exact-target',
  };
  const current: TaskWindow = {
    proof,
    windowId: 9,
    state: 'normal',
    rect: { x: 100, y: 100, width: 960, height: 720 },
  };
  let live = true;
  let update: (() => Promise<void>) | undefined;
  const writes: object[] = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: { version: 1, proof, windowId: 9, groupId: 1 } }),
      },
    },
    tabs: {
      update: async () => ({}),
      get: async () => ({
        id: 7,
        windowId: current.windowId,
        width: current.rect.width - 16,
        height: current.rect.height - 96,
        url: 'https://www.facebook.com/',
      }),
    },
    debugger: {
      getTargets: async () => [
        { tabId: 7, id: proof.targetId, type: 'page' as const, url: 'https://www.facebook.com/' },
      ],
    },
    windows: {
      get: async () => ({
        id: current.windowId,
        state: current.state,
        left: current.rect.x,
        top: current.rect.y,
        width: current.rect.width,
        height: current.rect.height,
      }),
      update: async (
        _id: number,
        value: {
          left?: number;
          top?: number;
          width?: number;
          height?: number;
          state?: TaskWindow['state'];
        },
      ) => {
        writes.push(value);
        current.rect = {
          x: value.left ?? current.rect.x,
          y: value.top ?? current.rect.y,
          width: value.width ?? current.rect.width,
          height: value.height ?? current.rect.height,
        };
        if (value.state) current.state = value.state;
        await update?.();
      },
    },
  } as unknown as typeof chrome;
  try {
    await run({
      controller: new TaskWindowController(),
      current,
      writes,
      guard: () => {
        if (!live) throw Error('STOPPED');
      },
      revoke: () => {
        live = false;
      },
      setUpdate: (fn) => {
        update = fn;
      },
    });
  } finally {
    globalThis.chrome = previous;
  }
}

test('native layout activates the exact persisted main and requests focus when moving', async () =>
  fixture(async (f) => {
    const before = await f.controller.inspect(f.current.proof, f.guard);
    assert.deepEqual(before.contentInsets, { left: 16, top: 104, right: 16, bottom: 16 });
    const rect = { ...before.rect, x: -2000, y: 600 };
    const result = await f.controller.move(before, rect, f.guard);
    assert.deepEqual(result.rect, rect);
    assert.deepEqual(f.writes, [{ left: -2000, top: 600, focused: true }]);
  }));

test('missing or inconsistent native viewport dimensions cannot admit a frame-only layout', async () =>
  fixture(async (f) => {
    const get = chrome.tabs.get;
    chrome.tabs.get = (async (...args: Parameters<typeof get>) => ({
      ...(await (get as Function)(...args)),
      width: undefined,
    })) as typeof get;
    await assert.rejects(f.controller.inspect(f.current.proof, f.guard), /CONTENT_BOUNDS_REQUIRED/);
    assert.equal(f.writes.length, 0);
  }));

test('foreign proof and recycled/changed containing window cannot be moved', async () =>
  fixture(async (f) => {
    const before = structuredClone(f.current);
    await assert.rejects(
      f.controller.inspect({ ...before.proof, ownershipId: randomUUID() }, f.guard),
      /MAIN_CHANGED/,
    );
    f.current.windowId = 10;
    await assert.rejects(
      f.controller.move(before, { ...before.rect, x: 1 }, f.guard),
      /WINDOW_CHANGED/,
    );
    assert.equal(f.writes.length, 0);
  }));

test('small native frame growth or shrink is returned truthfully', async () =>
  fixture(async (f) => {
    const before = structuredClone(f.current);
    f.setUpdate(async () => {
      f.current.rect.width += 1;
      f.current.rect.height += 2;
    });
    const result = await f.controller.move(before, { ...before.rect, x: -2000 }, f.guard);
    assert.equal(result.rect.width, before.rect.width + 1);
    assert.equal(result.rect.height, before.rect.height + 2);
    assert.deepEqual(f.writes, [{ left: -2000, top: before.rect.y, focused: true }]);
    f.setUpdate(async () => {
      f.current.rect.width -= 1;
    });
    const result2 = await f.controller.move(
      structuredClone(f.current),
      { ...f.current.rect, x: -1900 },
      f.guard,
    );
    assert.equal(result2.rect.width, result.rect.width - 1);
  }));

test('native acknowledgement may precede settled geometry; confirmation only polls without reissuing move', async () =>
  fixture(async (f) => {
    const before = structuredClone(f.current);
    const get = chrome.windows.get;
    let staleReads = 0;
    chrome.windows.get = (async (...args: Parameters<typeof get>) => {
      const value = await (get as Function)(...args);
      if (f.writes.length && staleReads++ < 2)
        return { ...value, left: before.rect.x, top: before.rect.y };
      return value;
    }) as typeof get;
    const target = { ...before.rect, x: -2000, y: 600 };
    assert.deepEqual((await f.controller.move(before, target, f.guard)).rect, target);
    assert.equal(f.writes.length, 1);
    assert.ok(staleReads >= 3);
  }));

test('manual movement since preview does not reject a live target and resize is supported', async () =>
  fixture(async (f) => {
    const before = structuredClone(f.current);
    f.current.rect.x++;
    const result = await f.controller.move(
      before,
      { ...before.rect, x: 1, width: 640, height: 500 },
      f.guard,
    );
    assert.deepEqual(result.rect, { ...before.rect, x: 1, width: 640, height: 500 });
    assert.deepEqual(f.writes, [{ left: 1, top: 100, width: 640, height: 500, focused: true }]);
  }));

test('minimized and maximized task windows are restored and viewport is read again', async () =>
  fixture(async (f) => {
    for (const state of ['minimized', 'maximized'] as const) {
      f.current.state = state;
      const result = await f.controller.inspect(f.current.proof, f.guard);
      assert.equal(result.state, 'normal');
    }
    assert.deepEqual(f.writes, [{ state: 'normal' }, { state: 'normal' }]);
  }));

test('STOP before dispatch prevents window mutation', async () =>
  fixture(async (f) => {
    f.revoke();
    await assert.rejects(
      f.controller.move(f.current, { ...f.current.rect, x: 1 }, f.guard),
      /STOPPED/,
    );
    assert.equal(f.writes.length, 0);
  }));

test('STOP drains already-dispatched native move and never confirms its late result as usable', async () =>
  fixture(async (f) => {
    let resume!: () => void;
    f.setUpdate(
      async () =>
        new Promise<void>((r) => {
          resume = r;
        }),
    );
    const moving = assert.rejects(
      f.controller.move(structuredClone(f.current), { ...f.current.rect, x: -2000 }, f.guard),
      /STOPPED/,
    );
    await tick();
    f.revoke();
    let stopped = false;
    const drain = f.controller.drain().then(() => {
      stopped = true;
    });
    await tick();
    assert.equal(stopped, false);
    resume();
    await Promise.all([moving, drain]);
    assert.equal(f.writes.length, 1);
  }));

test('duplicate native moves are fenced; a later recovery can reactivate the same position', async () =>
  fixture(async (f) => {
    let resume!: () => void;
    f.setUpdate(
      async () =>
        new Promise<void>((r) => {
          resume = r;
        }),
    );
    const before = structuredClone(f.current),
      target = { ...before.rect, x: -2000 };
    const first = f.controller.move(before, target, f.guard);
    await tick();
    await assert.rejects(f.controller.move(before, target, f.guard), /PENDING/);
    resume();
    await first;
    f.setUpdate(async () => {});
    await f.controller.move(f.current, target, f.guard);
    assert.equal(f.writes.length, 2);
  }));

test('locked fullscreen refuses movement', async () =>
  fixture(async (f) => {
    f.current.state = 'locked-fullscreen';
    await assert.rejects(f.controller.inspect(f.current.proof, f.guard), /NORMAL_WINDOW_REQUIRED/);
    assert.equal(f.writes.length, 0);
  }));

test('passive movement never sends a foreground request, recovery still can', async () =>
  fixture(async (f) => {
    await f.controller.move(
      f.current,
      { ...f.current.rect, x: f.current.rect.x + 20 },
      f.guard,
      false,
    );
    assert.ok(f.writes.every((w) => !('focused' in w)));
    await f.controller.move(f.current, f.current.rect, f.guard, true);
    assert.equal((f.writes.at(-1) as { focused?: boolean }).focused, true);
  }));

test('native target URL admits the exact task when tabs.get omits its optional URL', async () =>
  fixture(async (f) => {
    const get = chrome.tabs.get;
    chrome.tabs.get = (async () => ({ ...(await get(7)), url: undefined })) as typeof get;
    const result = await f.controller.inspect(f.current.proof, f.guard);
    assert.equal(result.windowId, 9);
  }));
test('loading native target is read again, but a changed target is never substituted', async () =>
  fixture(async (f) => {
    let reads = 0;
    chrome.debugger.getTargets = async () => [
      {
        tabId: 7,
        id: f.current.proof.targetId,
        type: 'page' as const,
        attached: true,
        title: '',
        url: ++reads === 1 ? 'about:blank' : 'https://www.facebook.com/',
      },
    ];
    await f.controller.inspect(f.current.proof, f.guard);
    assert.equal(reads, 2);
    chrome.debugger.getTargets = async () => [
      {
        tabId: 7,
        id: 'other-target',
        type: 'page' as const,
        attached: true,
        title: '',
        url: 'https://www.facebook.com/',
      },
    ];
    await assert.rejects(f.controller.inspect(f.current.proof, f.guard), /TARGET_CHANGED/);
    assert.equal(f.writes.length, 0);
  }));
test('foreign native URL is a document scope error, not a target mismatch', async () =>
  fixture(async (f) => {
    chrome.debugger.getTargets = async () => [
      {
        tabId: 7,
        id: f.current.proof.targetId,
        type: 'page' as const,
        attached: true,
        title: '',
        url: 'https://example.com/',
      },
    ];
    await assert.rejects(f.controller.inspect(f.current.proof, f.guard), /DOCUMENT_SCOPE_CHANGED/);
    assert.equal(f.writes.length, 0);
  }));
