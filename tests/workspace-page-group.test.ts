import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkspacePageGroup } from '../extension/workspace-page-group.js';

test('main group uses exact proof, survives worker replacement and never adopts user members', async () => {
  const previous = globalThis.chrome;
  const values: Record<string, unknown> = {};
  const proof = {
    ownershipId: randomUUID(),
    profileId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 11,
    targetId: 'main-target',
  };
  let tab = { id: 11, windowId: 2, groupId: -1 };
  let targetId = 'main-target';
  let groups = 0;
  const grouped: number[][] = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: object) => Object.assign(values, next),
      },
    },
    tabs: {
      get: async () => tab,
      group: async ({ tabIds }: { tabIds: number[] }) => {
        grouped.push(tabIds);
        tab = { ...tab, groupId: ++groups };
        return groups;
      },
    },
    debugger: { getTargets: async () => [{ type: 'page', tabId: 11, id: targetId }] },
    tabGroups: {
      update: async (_id: number, options: { title: string; color: string }) => {
        assert.deepEqual(options, { title: '浏览器工作台', color: 'grey' });
        return {};
      },
    },
  } as unknown as typeof chrome;
  try {
    const group = new WorkspacePageGroup();
    const main = await group.ensure(proof, () => {});
    assert.equal(main.groupId, 1);
    assert.deepEqual(await new WorkspacePageGroup().ensure(proof, () => {}), main);
    assert.deepEqual(grouped, [[11]]);
    // Moving the main to another window recreates only its own presentation group.
    tab = { ...tab, windowId: 3, groupId: 88 };
    assert.equal((await group.ensure(proof, () => {})).groupId, 2);
    assert.deepEqual(grouped, [[11], [11]]);
    await assert.rejects(
      group.ensure({ ...proof, ownershipId: randomUUID(), tabId: 12, targetId: 'other' }, () => {}),
      /MAIN_ALREADY_EXISTS/,
    );
    targetId = 'recycled-id';
    await assert.rejects(
      group.ensure(proof, () => {}),
      /TARGET_CHANGED/,
    );
    assert.equal(groups, 2);
  } finally {
    globalThis.chrome = previous;
  }
});

test('revocation during group lookup prevents group mutation', async () => {
  const previous = globalThis.chrome;
  let allowed = true;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => {
          allowed = false;
          return {};
        },
      },
    },
  } as unknown as typeof chrome;
  try {
    const proof = {
      ownershipId: randomUUID(),
      profileId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 11,
      targetId: 'main',
    };
    await assert.rejects(
      new WorkspacePageGroup().ensure(proof, () => {
        if (!allowed) throw Error('REVOKED');
      }),
      /REVOKED/,
    );
  } finally {
    globalThis.chrome = previous;
  }
});

test('forceBindMain rebinds workspace main page to a newly chosen tab including user-opened tabs', async () => {
  const previous = globalThis.chrome;
  const values: Record<string, unknown> = {};
  const firstProof = {
    ownershipId: randomUUID(),
    profileId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 11,
    targetId: 'main-target-11',
  };
  const secondProof = {
    ownershipId: randomUUID(),
    profileId: firstProof.profileId,
    browserSessionEpoch: firstProof.browserSessionEpoch,
    tabId: 22,
    targetId: 'user-target-22',
  };
  let groups = 0;
  const tabGroupIds = new Map<number, number>([
    [11, -1],
    [22, -1],
  ]);
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: object) => Object.assign(values, next),
      },
    },
    tabs: {
      get: async (id: number) => ({ id, windowId: 2, groupId: tabGroupIds.get(id) ?? -1 }),
      group: async ({ tabIds }: { tabIds: number[] }) => {
        const nextGroup = ++groups;
        for (const id of tabIds) tabGroupIds.set(id, nextGroup);
        return nextGroup;
      },
    },
    debugger: {
      getTargets: async () => [
        { type: 'page', tabId: 11, id: 'main-target-11' },
        { type: 'page', tabId: 22, id: 'user-target-22' },
      ],
    },
    tabGroups: {
      update: async (_id: number, options: { title: string; color: string }) => {
        assert.deepEqual(options, { title: '浏览器工作台', color: 'grey' });
        return {};
      },
    },
  } as unknown as typeof chrome;
  try {
    const group = new WorkspacePageGroup();
    const first = await group.ensure(firstProof, () => {});
    assert.equal(first.proof.tabId, 11);
    const second = await group.forceBindMain(secondProof, () => {});
    assert.equal(second.proof.tabId, 22);
    assert.deepEqual(await group.read(() => {}), second);
  } finally {
    globalThis.chrome = previous;
  }
});
