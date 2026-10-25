import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import type { BrowserProfileSource } from '../src/domain/workspace.js';
import type { Profile } from '../src/shared/contracts.js';
import {
  inspectionAvatarURL,
  inspectionDisplayName,
} from '../src/renderer/inspection-presentation.js';
import { inspectedFacebookAccount } from '../src/domain/facebook-page-analysis.js';
import { facebookIdentityProjection } from '../src/infrastructure/facebook-read-adapter.js';

function createMockSource(initialProfiles: Profile[]): BrowserProfileSource & {
  rows: Map<string, Profile>;
  deleted: string[];
} {
  const rows = new Map(initialProfiles.map((p) => [p.id, p]));
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    profiles: () => [...rows.values()],
    records: () => [],
    stop: () => {},
    deleteProfile: (id: string) => {
      deleted.push(id);
      rows.delete(id);
    },
  };
}

test('persistent account cache keeps accountId/name/avatar offline and clears avatar to null on restricted/banned state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sidebar-cache-'));
  try {
    const store = await WorkspaceStore.open(join(dir, 'workspace.sqlite'));
    const profileId = randomUUID();
    const avatarUrl =
      'https://scontent.example.fbcdn.net/v/t39.30808-1/avatar_test.jpg?stp=dst-jpg';
    const source = createMockSource([
      {
        id: profileId,
        alias: 'Profile 1',
        groupId: null,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        unresolved: 0,
        extensionVersion: '0.3.7',
        capabilities: ['facebook-readonly-v2'],
        account: { state: 'unknown', id: null, name: null, avatar: null },
      },
    ]);
    const service = new WorkspaceService(store, source);

    store.updateProfileAccountCache(profileId, {
      state: 'logged-in',
      id: '10000000000002',
      name: 'Test Account',
      avatar: avatarUrl,
      avatarUpdatedAt: 1000,
    });

    const snapOffline = await service.snapshot();
    const pOffline = snapOffline.profiles.find((p) => p.id === profileId);
    assert.ok(pOffline);
    assert.equal(pOffline.account.id, '10000000000002');
    assert.equal(pOffline.account.name, 'Test Account');
    assert.equal(pOffline.account.avatar, avatarUrl);
    assert.equal(inspectionAvatarURL(pOffline, undefined, true, 2000), avatarUrl);
    assert.equal(inspectionDisplayName(pOffline, undefined, true, 2000), 'Test Account');

    // Simulate encountering a banned/restricted page during task execution
    store.updateProfileAccountCache(profileId, {
      state: 'restricted',
      avatar: null,
    });

    const snapRestricted = await service.snapshot();
    const pRestricted = snapRestricted.profiles.find((p) => p.id === profileId);
    assert.ok(pRestricted);
    assert.equal(pRestricted.account.state, 'restricted');
    assert.equal(pRestricted.account.id, '10000000000002');
    assert.equal(pRestricted.account.name, 'Test Account');
    assert.equal(pRestricted.account.avatar, null);
    // Must return null so ProfileAvatar renders WhiteAvatar ("小白头")
    assert.equal(inspectionAvatarURL(pRestricted, undefined, true, 3000), null);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restriction-looking routes without page evidence do not establish account restriction', () => {
  for (const url of [
    'https://www.facebook.com/disabled/',
    'https://www.facebook.com/suspended/',
    'https://www.facebook.com/account_status/',
  ]) {
    const result = inspectedFacebookAccount(
      {
        url,
        timeOrigin: 1000,
        ready: 'complete',
        visibility: 'visible',
        rows: facebookIdentityProjection.queries.map((q) => ({ key: q.key, nodes: [] })),
      },
      null,
      1000,
    );
    assert.equal(result.account.state, 'unknown', url);
    assert.equal(result.reason, 'ACTING_ACCOUNT_UNVERIFIED');
    assert.equal(result.account.id, null);
  }
});

test('account status information and incomplete restriction pages do not prove restriction', () => {
  for (const [url, ready] of [
    ['https://www.facebook.com/account_status/', 'complete'],
    ['https://www.facebook.com/disabled-preview/', 'complete'],
    ['https://www.facebook.com/disabled/', 'loading'],
    ['https://www.facebook.com/suspended/', 'interactive'],
  ] as const) {
    const result = inspectedFacebookAccount(
      {
        url,
        timeOrigin: 1000,
        ready,
        visibility: 'visible',
        rows: facebookIdentityProjection.queries.map((q) => ({ key: q.key, nodes: [] })),
      },
      null,
      1000,
    );
    assert.equal(result.account.state, 'unknown', url);
    assert.equal(result.account.id, null);
  }
});

test('deleteProfiles and deleteCombination remove items cleanly from workspace snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-delete-items-'));
  try {
    const store = await WorkspaceStore.open(join(dir, 'workspace.sqlite'));
    const p1 = randomUUID();
    const p2 = randomUUID();
    const source = createMockSource([
      {
        id: p1,
        alias: 'Browser 1',
        groupId: null,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        unresolved: 0,
        extensionVersion: '0.3.7',
        capabilities: [],
        account: { state: 'unknown', id: null, name: null, avatar: null },
      },
      {
        id: p2,
        alias: 'Browser 2',
        groupId: null,
        online: false,
        phase: 'OFFLINE',
        synced: false,
        unresolved: 0,
        extensionVersion: '0.3.7',
        capabilities: [],
        account: { state: 'unknown', id: null, name: null, avatar: null },
      },
    ]);
    const service = new WorkspaceService(store, source);
    await service.renameProfile(p1, 'Custom Alias 1');
    store.updateProfileAccountCache(p1, {
      state: 'logged-in',
      id: '10001',
      name: 'User 1',
    });

    const delRes = await service.deleteProfiles([p1]);
    assert.deepEqual(delRes.deletedIds, [p1]);
    assert.deepEqual(source.deleted, [p1]);
    const snapAfterProfileDelete = await service.snapshot();
    assert.deepEqual(
      snapAfterProfileDelete.profiles.map((p) => p.id),
      [p2],
    );
    assert.equal(store.profileAccountCache().has(p1), false);

    const combo = store.createCombination({
      name: 'To Be Deleted',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 3, maxLikes: 0, minLikeCount: 0 }],
    });
    assert.ok((await service.snapshot()).combinations.some((c) => c.id === combo.id));

    await service.deleteCombination(combo.id);
    assert.equal(
      (await service.snapshot()).combinations.some((c) => c.id === combo.id),
      false,
    );

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseErroredPausedPlans releases non-user errored paused plans and preserves USER_PAUSE plans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-errored-pause-'));
  let store: WorkspaceStore | undefined;
  try {
    store = await WorkspaceStore.open(join(dir, 'workspace.sqlite'));
    const p1 = randomUUID();
    const p2 = randomUUID();
    const combo = await store.createCombination({
      name: 'Browse Feed',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 3, maxLikes: 0, minLikeCount: 0 }],
    });
    const profiles = [
      {
        id: p1,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in' as const, id: '10001', name: 'U1', avatar: null },
      },
      {
        id: p2,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in' as const, id: '10002', name: 'U2', avatar: null },
      },
    ];
    const [plan1, plan2] = await store.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: combo.id,
        version: combo.version,
        profileIds: [p1, p2],
      },
      profiles,
    );
    assert.ok(plan1 && plan2);

    // Pause plan1 due to an execution error, and pause plan2 due to USER_PAUSE
    const paused1 = await store.tasks.requestControl(
      plan1.id,
      'pause',
      'INITIAL_SESSION_FAILED:该资料已有未释放的专用任务标签页',
    );
    if (!paused1.controlConfirmed && paused1.controlRequestId) {
      await store.tasks.confirmControl(plan1.id, paused1.controlRequestId);
    }

    const paused2 = await store.tasks.requestControl(plan2.id, 'pause', 'USER_PAUSE');
    if (!paused2.controlConfirmed && paused2.controlRequestId) {
      await store.tasks.confirmControl(plan2.id, paused2.controlRequestId);
    }

    const released = await store.tasks.releaseErroredPausedPlans([p1, p2]);
    assert.equal(released, 1);
    assert.equal((await store.tasks.get(plan1.id)).state, 'STOPPED');
    assert.equal((await store.tasks.get(plan2.id)).state, 'PAUSED');
  } finally {
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
