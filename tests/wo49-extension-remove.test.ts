import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';

const url = 'https://www.facebook.com/';
async function setup(
  chromeOverrides: {
    targets?: () => unknown[];
    tabs?: () => unknown[];
    remove?: (id: number) => Promise<void>;
  },
  operation?: () => undefined | object,
) {
  const journal = new KernelJournal(new MemoryKernelStorage());
  const profileId = randomUUID(),
    epoch = randomUUID();
  await journal.initialize(profileId, epoch);
  const original: unknown = Reflect.get(globalThis, 'chrome');
  const values: Record<string, unknown> = {};
  let present = true;
  Reflect.set(globalThis, 'chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: object) => Object.assign(values, next),
      },
    },
    tabGroups: { update: async () => ({}) },
    tabs: {
      get: async (id: number) => ({ id, windowId: 8, groupId: 7 }),
      group: async () => 7,
      create: async () => ({ id: 7 }),
      query: async () =>
        chromeOverrides.tabs ? chromeOverrides.tabs() : present ? [{ id: 7 }] : [],
      remove: async (id: number) => {
        if (chromeOverrides.remove) return chromeOverrides.remove(id);
        present = false;
      },
    },
    debugger: {
      getTargets: async () =>
        chromeOverrides.targets
          ? chromeOverrides.targets()
          : present
            ? [{ id: 'target-1', tabId: 7, type: 'page', url, attached: false }]
            : [],
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
    },
  });
  const backend = new ChromeKernelBackend(
    journal,
    () => false,
    'facebook-task',
    () => true,
    operation as never,
  );
  return {
    backend,
    journal,
    gone: () => {
      present = false;
    },
    restore: () => Reflect.set(globalThis, 'chrome', original),
  };
}

test('WO49-5: remove after the page vanished is idempotent and closes the journal row', async () => {
  const s = await setup({});
  try {
    await s.backend.create(url);
    s.gone();
    await s.backend.remove(7);
    assert.equal((await s.journal.snapshot()).tabs[0]?.state, 'CLOSED');
    assert.equal(s.backend.owns(7), false);
  } finally {
    s.restore();
  }
});

test('WO49-5: chrome.tabs.remove "No tab with id" is confirmed against fresh targets and tabs', async () => {
  let gone = false;
  const s = await setup({
    remove: async () => {
      gone = true;
      throw Error('No tab with id: 7.');
    },
    targets: () => (gone ? [] : [{ id: 'target-1', tabId: 7, type: 'page', url, attached: false }]),
    tabs: () => (gone ? [] : [{ id: 7 }]),
  });
  try {
    await s.backend.create(url);
    await s.backend.remove(7);
    assert.equal((await s.journal.snapshot()).tabs[0]?.state, 'CLOSED');
  } finally {
    s.restore();
  }
});

test('WO49-5: remove after tabRemoved already closed the journal row returns normally', async () => {
  const s = await setup({});
  try {
    await s.backend.create(url);
    s.gone();
    s.backend.tabRemoved(7);
    // tabRemoved journals asynchronously; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.backend.remove(7);
    assert.equal((await s.journal.snapshot()).tabs[0]?.state, 'CLOSED');
  } finally {
    s.restore();
  }
});

test('WO49-5: a tab that is still present after a failed remove is rejected, not marked closed', async () => {
  const s = await setup({
    remove: async () => {
      throw Error('No tab with id: 7.');
    },
  });
  try {
    await s.backend.create(url);
    await assert.rejects(s.backend.remove(7), /No tab with id/);
    assert.notEqual((await s.journal.snapshot()).tabs[0]?.state, 'CLOSED');
  } finally {
    s.restore();
  }
});

test('WO49-5: a vanished tab is not closed idempotently while a business operation is in flight', async () => {
  let inFlight = false;
  const s = await setup({}, () => (inFlight ? { operationId: randomUUID() } : undefined));
  try {
    await s.backend.create(url);
    s.gone();
    inFlight = true;
    await assert.rejects(s.backend.remove(7), /KERNEL_CLOSE_DURING_OPERATION/);
    assert.notEqual((await s.journal.snapshot()).tabs[0]?.state, 'CLOSED');
  } finally {
    s.restore();
  }
});
