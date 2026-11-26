import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  consolidateOpenWorkbenchGroups,
  WorkspacePageGroup,
} from '../extension/workspace-page-group.js';

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

test('reuses existing open workbench group, merges same-window duplicates, dissolves other-window duplicates, and preserves user groups', async () => {
  const previous = globalThis.chrome;
  const values: Record<string, unknown> = {};
  const proof = {
    ownershipId: randomUUID(),
    profileId: randomUUID(),
    browserSessionEpoch: randomUUID(),
    tabId: 11,
    targetId: 'main-target-11',
  };

  type MockTab = { id: number; windowId: number; groupId: number };
  type MockGroup = { id: number; windowId: number; title: string; color: string };
  const tabs = new Map<number, MockTab>([
    [11, { id: 11, windowId: 2, groupId: -1 }],
    [12, { id: 12, windowId: 2, groupId: 101 }],
    [13, { id: 13, windowId: 2, groupId: 102 }],
    [14, { id: 14, windowId: 2, groupId: 103 }],
    [20, { id: 20, windowId: 2, groupId: 200 }], // User group
    [30, { id: 30, windowId: 9, groupId: 301 }], // Duplicate workbench group in another window
  ]);
  const groups = new Map<number, MockGroup>([
    [101, { id: 101, windowId: 2, title: 'Browser Workbench', color: 'blue' }],
    [102, { id: 102, windowId: 2, title: '浏览器工作台', color: 'grey' }],
    [103, { id: 103, windowId: 2, title: '浏览器工作台', color: 'grey' }],
    [200, { id: 200, windowId: 2, title: '我的常用分组', color: 'green' }],
    [301, { id: 301, windowId: 9, title: '浏览器工作台', color: 'grey' }],
  ]);
  let createdNewGroups = 0;
  const ungroupedTabs: number[] = [];

  const pruneEmptyGroups = () => {
    for (const gid of [...groups.keys()]) {
      const hasMembers = [...tabs.values()].some((t) => t.groupId === gid);
      if (!hasMembers) groups.delete(gid);
    }
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: object) => Object.assign(values, next),
      },
    },
    tabs: {
      get: async (id: number) => {
        const found = tabs.get(id);
        if (!found) throw Error('TAB_NOT_FOUND');
        return { ...found };
      },
      query: async (q: { groupId?: number }) =>
        [...tabs.values()]
          .filter((t) => (q.groupId !== undefined ? t.groupId === q.groupId : true))
          .map((t) => ({ ...t })),
      group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        let targetId = groupId;
        if (targetId === undefined) {
          targetId = 500 + ++createdNewGroups;
          const firstTab = tabs.get(tabIds[0] ?? -1);
          groups.set(targetId, {
            id: targetId,
            windowId: firstTab?.windowId ?? 2,
            title: '',
            color: 'grey',
          });
        }
        for (const tid of tabIds) {
          const t = tabs.get(tid);
          if (t) t.groupId = targetId;
        }
        pruneEmptyGroups();
        return targetId;
      },
      ungroup: async (tabIds: number | number[]) => {
        const list = Array.isArray(tabIds) ? tabIds : [tabIds];
        for (const tid of list) {
          const t = tabs.get(tid);
          if (t) {
            t.groupId = -1;
            ungroupedTabs.push(tid);
          }
        }
        pruneEmptyGroups();
      },
    },
    debugger: {
      getTargets: async () => [{ type: 'page', tabId: 11, id: 'main-target-11' }],
    },
    tabGroups: {
      query: async () => [...groups.values()].map((g) => ({ ...g })),
      update: async (id: number, options: { title?: string; color?: string }) => {
        const g = groups.get(id);
        if (!g) throw Error('GROUP_NOT_FOUND');
        if (options.title !== undefined) g.title = options.title;
        if (options.color !== undefined) g.color = options.color;
        return { ...g };
      },
    },
  } as unknown as typeof chrome;

  try {
    const pageGroup = new WorkspacePageGroup();
    const ensured = await pageGroup.ensure(proof, () => {});
    // Must reuse existing canonical '浏览器工作台' group (102) without creating any brand-new group
    assert.equal(createdNewGroups, 0);
    assert.equal(ensured.groupId, 102);
    // All same-window workbench tabs (11, 12, 13, 14) merged into group 102
    assert.equal(tabs.get(11)?.groupId, 102);
    assert.equal(tabs.get(12)?.groupId, 102);
    assert.equal(tabs.get(13)?.groupId, 102);
    assert.equal(tabs.get(14)?.groupId, 102);
    // Duplicate groups 101, 103 and other-window group 301 are gone
    assert.equal(groups.has(101), false);
    assert.equal(groups.has(103), false);
    assert.equal(groups.has(301), false);
    assert.deepEqual(ungroupedTabs, [30]);
    // Tab 30 still exists in window 9 (not closed or moved)
    assert.equal(tabs.get(30)?.windowId, 9);
    assert.equal(tabs.get(30)?.groupId, -1);
    // User's own non-workbench group 200 is completely untouched
    assert.equal(groups.get(200)?.title, '我的常用分组');
    assert.equal(tabs.get(20)?.groupId, 200);

    // Startup helper also normalizes legacy-only 'Browser Workbench' group
    groups.set(102, { id: 102, windowId: 2, title: 'Browser Workbench', color: 'red' });
    const canonical = await consolidateOpenWorkbenchGroups();
    assert.equal(canonical, 102);
    assert.equal(groups.get(102)?.title, '浏览器工作台');
    assert.equal(groups.get(102)?.color, 'grey');
  } finally {
    globalThis.chrome = previous;
  }
});
