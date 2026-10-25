import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';

test('extension epoch change reobserves the same physical main under a new proof and preserves old history', async () => {
  for (const changed of [false, true]) {
    const previous = globalThis.chrome;
    const storage = new MemoryKernelStorage();
    const original = new KernelJournal(storage);
    const proof = {
      ownershipId: randomUUID(),
      profileId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 'still-same-main',
    };
    await original.initialize(proof.profileId, proof.browserSessionEpoch);
    await original.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
    await original.confirmTab(proof);
    const journal = new KernelJournal(storage);
    const epoch = randomUUID();
    await journal.initialize(proof.profileId, epoch);
    const old = (await journal.snapshot()).tabs[0];
    const values: Record<string, unknown> = {
      workbenchWorkspaceMainPageV1: { version: 1, proof, windowId: 1, groupId: 7 },
    };
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: values[key] }),
          set: async (next: object) => Object.assign(values, next),
        },
      },
      debugger: {
        getTargets: async () => [
          {
            type: 'page',
            id: changed ? 'replacement-target' : proof.targetId,
            tabId: 7,
            url: 'https://www.facebook.com/',
          },
        ],
      },
      tabs: {
        get: async () => ({ id: 7, windowId: 1, groupId: 7 }),
        query: async () => [{ id: 7 }],
      },
    } as unknown as typeof chrome;
    try {
      const backend = new ChromeKernelBackend(
        journal,
        () => false,
        'facebook-task',
        () => true,
      );
      const result = (await backend.inventory()) as { workspaceMain?: typeof proof };
      assert.deepEqual((await journal.snapshot()).tabs[0], old);
      assert.equal(backend.owns(7), false);
      if (changed) assert.equal(result.workspaceMain, undefined);
      else {
        assert.equal(result.workspaceMain?.browserSessionEpoch, epoch);
        assert.equal(result.workspaceMain?.tabId, proof.tabId);
        assert.equal(result.workspaceMain?.targetId, proof.targetId);
        assert.notEqual(result.workspaceMain?.ownershipId, proof.ownershipId);
        assert.equal((await journal.snapshot()).tabs.length, 2);
        assert.deepEqual(
          ((await backend.inventory()) as typeof result).workspaceMain,
          result.workspaceMain,
        );
      }
    } finally {
      globalThis.chrome = previous;
    }
  }
});

test('explicit owned-page display focuses only its exact window and stop revocation prevents the later focus', async () => {
  for (const mode of ['normal', 'cancel-before-focus', 'delayed', 'cancel-during-wait'] as const) {
    const cancel = mode.startsWith('cancel');
    const previous = globalThis.chrome;
    const journal = new KernelJournal(new MemoryKernelStorage());
    const input = {
      ownershipId: randomUUID(),
      profileId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 'shown-main',
    };
    await journal.initialize(input.profileId, input.browserSessionEpoch);
    await journal.prepareTab(input.ownershipId, 'https://www.facebook.com/');
    await journal.confirmTab(input);
    const proof = (await journal.snapshot()).tabs[0]?.proof;
    assert.ok(proof);
    let valid = true,
      active = false,
      focused = false,
      focusCalls = 0,
      focusedReads = 0;
    const values: Record<string, unknown> = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: values[key] }),
          set: async (next: object) => Object.assign(values, next),
        },
      },
      tabGroups: { update: async () => ({}) },
      tabs: {
        get: async () => ({ id: 7, windowId: 3, groupId: 7, active }),
        group: async () => 7,
        update: async (id: number) => {
          assert.equal(id, 7);
          active = true;
          if (mode === 'cancel-before-focus') valid = false;
        },
      },
      windows: {
        get: async (id: number) => {
          assert.equal(id, 3);
          if (focusCalls > 0) {
            focusedReads++;
            if (mode === 'delayed' && focusedReads >= 3) focused = true;
            if (mode === 'cancel-during-wait' && focusedReads >= 2) valid = false;
          }
          return { id, state: 'normal', focused };
        },
        update: async (id: number, value: { focused: boolean }) => {
          assert.equal(id, 3);
          assert.equal(value.focused, true);
          focused = mode === 'normal';
          focusCalls++;
        },
      },
      debugger: {
        getTargets: async () => [
          { id: proof.targetId, tabId: 7, type: 'page', url: 'https://www.facebook.com/' },
        ],
      },
    } as unknown as typeof chrome;
    try {
      const backend = new ChromeKernelBackend(
        journal,
        () => false,
        'facebook-task',
        () => valid,
      );
      await backend.adopt(proof);
      if (cancel) await assert.rejects(backend.revealOwnedPage(proof), /REVOKED/);
      else assert.deepEqual(await backend.revealOwnedPage(proof), { tabId: 7, focused: true });
      assert.equal(focusCalls, mode === 'cancel-before-focus' ? 0 : 1);
      assert.equal((await journal.snapshot()).operations.length, 0);
    } finally {
      globalThis.chrome = previous;
    }
  }
});

test('stopped main reobservation restores only exact same-epoch withdrawn proof, without attachment or input', async () => {
  for (const changed of [false, true]) {
    const previous = globalThis.chrome;
    const journal = new KernelJournal(new MemoryKernelStorage());
    const proof = {
      ownershipId: randomUUID(),
      profileId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 'original-main',
    };
    await journal.initialize(proof.profileId, proof.browserSessionEpoch);
    await journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
    await journal.confirmTab(proof);
    await journal.tabState(proof.ownershipId, 'LOST', 'TASK_ENDED_OWNERSHIP_WITHDRAWN');
    globalThis.chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: { version: 1, proof, windowId: 1, groupId: 7 } }),
        },
      },
      debugger: {
        getTargets: async () => [
          {
            type: 'page',
            id: changed ? 'replaced' : proof.targetId,
            tabId: 7,
            url: 'https://www.facebook.com/',
          },
        ],
      },
      tabs: { query: async () => [{ id: 7 }] },
    } as unknown as typeof chrome;
    try {
      const backend = new ChromeKernelBackend(
        journal,
        () => false,
        'facebook-task',
        () => true,
      );
      const result = (await backend.inventory()) as { tabs: { state: string }[] };
      assert.equal(result.tabs[0]?.state, changed ? 'LOST' : 'READY');
      assert.equal(backend.owns(7), false);
      assert.deepEqual((await journal.snapshot()).tabs[0]?.proof, proof);
    } finally {
      globalThis.chrome = previous;
    }
  }
});

test('foreground creation activates only the new owned tab and still rejects a revoked read lease', async () => {
  const previous = globalThis.chrome;
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(randomUUID(), randomUUID());
  const creates: { url: string; active: boolean }[] = [];
  const values: Record<string, unknown> = {};
  const groups = new Map<number, number>();
  let valid = true,
    focused = true,
    focusCalls = 0;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: object) => Object.assign(values, next),
      },
    },
    tabGroups: { update: async () => ({}) },
    tabs: {
      get: async (id: number) => ({ id, windowId: 1, groupId: groups.get(id) ?? -1 }),
      group: async ({ tabIds, groupId = 7 }: { tabIds: number[]; groupId?: number }) => {
        for (const id of tabIds) groups.set(id, groupId);
        return groupId;
      },
      create: async (input: { url: string; active: boolean }) => {
        creates.push(input);
        return { id: creates.length, windowId: 1 };
      },
    },
    windows: {
      getAll: async () => [{ id: 1, focused, type: 'normal' }],
      update: async () => {
        focusCalls++;
        return {};
      },
    },
    debugger: {
      getTargets: async () =>
        creates.map((input, index) => ({
          tabId: index + 1,
          id: 'target-' + (index + 1),
          type: 'page',
          url: input.url,
        })),
    },
  } as unknown as typeof chrome;
  try {
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'facebook-task',
      () => valid,
    );
    await backend.create('https://www.facebook.com/');
    await backend.create('https://www.facebook.com/reel/123/', randomUUID(), true);
    assert.deepEqual(
      creates.map((row) => row.active),
      [false, true],
    );
    assert.equal((await journal.snapshot()).tabs.filter((row) => row.state === 'READY').length, 2);
    focused = false;
    await backend.create('https://www.facebook.com/reel/789/', randomUUID(), true);
    assert.equal(creates[2]?.active, false);
    assert.equal(focusCalls, 1);
    valid = false;
    await assert.rejects(
      backend.create('https://www.facebook.com/reel/456/', randomUUID(), true),
      /READ_FENCED/,
    );
    assert.equal(creates.length, 3);
    assert.equal((await journal.snapshot()).operations.length, 0);
  } finally {
    globalThis.chrome = previous;
  }
});

test('retained-tab inspection confirms absence without adopting pages or settling old UNKNOWN', async () => {
  const previous = globalThis.chrome;
  const journal = new KernelJournal(new MemoryKernelStorage());
  const profileId = randomUUID(),
    browserSessionEpoch = randomUUID();
  await journal.initialize(profileId, browserSessionEpoch);
  const proofs = [];
  for (let tabId = 1; tabId <= 5; tabId++) {
    const proof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch,
      tabId,
      targetId: 'retained-target-' + tabId,
    };
    await journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
    await journal.confirmTab(proof);
    proofs.push(proof);
  }
  await journal.tabState(proofs[4]!.ownershipId, 'LOST', 'old browser identity');
  const binding = {
    profileId,
    accountId: '123456',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'a'.repeat(64),
  };
  await journal.begin(binding);
  await journal.finish(binding, 'UNKNOWN', 'old unknown upload');
  const before = await journal.snapshot();
  let queries = 0;
  globalThis.chrome = {
    tabs: { query: async () => (++queries === 1 ? [{ id: 2 }] : [{ id: 2 }, { id: 4 }]) },
    debugger: { getTargets: async () => [{ tabId: 3, id: 'retained-target-3' }] },
  } as unknown as typeof chrome;
  try {
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'fixture',
      () => true,
    );
    await backend.inventory();
    const after = await journal.snapshot();
    assert.equal(queries, 2);
    assert.deepEqual(
      after.tabs.map((row) => row.state),
      ['CLOSED', 'READY', 'READY', 'READY', 'LOST'],
    );
    assert.equal(after.tabs[0]?.reason, 'RETAINED_TARGET_ABSENT');
    assert.deepEqual(after.tabs[0]?.proof, proofs[0]);
    assert.deepEqual(after.operations, before.operations);
    assert.ok(proofs.every((proof) => !backend.owns(proof.tabId)));
  } finally {
    globalThis.chrome = previous;
  }
});

test('revoked read cannot mark a retained target CLOSED and an inventory failure remains unknown', async () => {
  const previous = globalThis.chrome;
  const journal = new KernelJournal(new MemoryKernelStorage());
  const profileId = randomUUID(),
    browserSessionEpoch = randomUUID();
  await journal.initialize(profileId, browserSessionEpoch);
  const proof = {
    ownershipId: randomUUID(),
    profileId,
    browserSessionEpoch,
    tabId: 8,
    targetId: 'retained-target',
  };
  await journal.prepareTab(proof.ownershipId, 'https://www.facebook.com/');
  await journal.confirmTab(proof);
  const before = await journal.snapshot();
  let valid = true;
  globalThis.chrome = {
    tabs: {
      query: async () => {
        valid = false;
        return [];
      },
    },
    debugger: { getTargets: async () => [] },
  } as unknown as typeof chrome;
  try {
    const backend = new ChromeKernelBackend(
      journal,
      () => false,
      'fixture',
      () => valid,
    );
    await assert.rejects(backend.inventory(), /READ_FENCED/);
    assert.deepEqual(await journal.snapshot(), before);
    valid = true;
    chrome.tabs.query = async () => {
      throw Error('BROWSER_INVENTORY_UNAVAILABLE');
    };
    await assert.rejects(backend.inventory(), /INVENTORY_UNAVAILABLE/);
    assert.deepEqual(await journal.snapshot(), before);
  } finally {
    globalThis.chrome = previous;
  }
});
