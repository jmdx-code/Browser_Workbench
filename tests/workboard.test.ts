import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  isWorkAbortError,
  Semaphore,
  sleepAbortable,
  WorkAbortError,
  Workboard,
} from '../src/application/workboard.js';
import { GroupPosterService } from '../src/application/group-poster-service.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { GroupInviterService } from '../src/application/group-inviter-service.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';

test('WorkPool claims atomically, tracks seen keys, and supports requeue without starvation', () => {
  const wb = new Workboard();
  const pool = wb.createPool(
    [
      { id: '1', key: 'g1:m1' },
      { id: '2', key: 'g2:m1' },
      { id: '3', key: 'g3:m1' },
    ],
    (item) => item.key,
  );
  assert.equal(pool.remainingCount(), 3);
  const first = pool.claimNext((item) => item.id !== '1');
  assert.equal(first?.id, '2');
  assert.equal(pool.hasSeenKey('g2:m1'), true);
  assert.equal(pool.remainingCount(), 2);

  pool.requeue(first!, true);
  assert.equal(pool.hasSeenKey('g2:m1'), false);
  assert.equal(pool.remainingCount(), 3);

  const next = pool.claimNext();
  assert.equal(next?.id, '2');
  pool.markDone();
  assert.equal(pool.completedCount(), 1);
});

test('Semaphore enforces max permits dynamically and aborts waiting callers cleanly', async () => {
  const sem = new Semaphore(1);
  const release1 = await sem.acquire();
  assert.equal(sem.used, 1);

  const ac = new AbortController();
  const waiting = sem.acquire(ac.signal);
  ac.abort('CANCELLED');
  await assert.rejects(waiting, (err) => isWorkAbortError(err) && err instanceof WorkAbortError);

  const acquired2: number[] = [];
  const p2 = sem.acquire().then((rel) => {
    acquired2.push(2);
    return rel;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(acquired2, []);
  sem.setLimit(2);
  const rel2 = await p2;
  assert.deepEqual(acquired2, [2]);
  assert.equal(sem.used, 2);
  release1();
  rel2();
  assert.equal(sem.used, 0);
});

test('Workboard soldiers abort immediately per carrier and isolate zero-second failures across batch peers', async () => {
  const wb = new Workboard({ browserConcurrency: 2, launchConcurrency: 2 });
  const events: string[] = [];

  // Offline/bad carrier throws immediately at t=0 without affecting healthy sibling
  const failing = wb.runSoldier(
    { carrierId: 'bad-profile', carrierKind: 'browser', moduleId: 'active-accounts' },
    async () => {
      throw Error('LAUNCH_FAILED_T0');
    },
  );
  const healthy = wb.runSoldier(
    { carrierId: 'good-profile', carrierKind: 'browser', moduleId: 'active-accounts' },
    async (soldier) => {
      events.push('good-started');
      await sleepAbortable(2_000, soldier.signal);
    },
  );

  await assert.rejects(failing, /LAUNCH_FAILED_T0/);
  assert.equal(wb.isCarrierBusy('bad-profile'), false);
  assert.equal(wb.isCarrierBusy('good-profile'), true);

  const idlePromise = wb.waitUntilCarrierIdle('good-profile', 1_000);
  assert.equal(wb.abortCarrier('good-profile', 'USER_STOP'), true);
  await assert.rejects(healthy, (err) => isWorkAbortError(err));
  await idlePromise;
  assert.equal(wb.hasAnyActive(), false);
  assert.deepEqual(events, ['good-started']);
});

function createIsolatedLaunchLifecycle(
  onlineSet: Set<string>,
  badId: string,
  slowDelayMs: number,
  onBadSettled: () => void,
): ProfileLifecyclePort {
  return {
    isLaunching: () => false,
    getStatus: async (ids) =>
      ids.map((profileId) => ({
        profileId,
        browserName: profileId.slice(0, 8),
        action: 'status' as const,
        ok: true,
        online: onlineSet.has(profileId),
        phase: onlineSet.has(profileId) ? 'PAUSED' : 'OFFLINE',
        synced: onlineSet.has(profileId),
        launchable: true,
        elapsedMs: 0,
      })),
    launchProfile: async () => {
      throw Error('unused');
    },
    closeProfile: async () => {
      throw Error('unused');
    },
    restartProfile: async () => {
      throw Error('unused');
    },
    ensureProfilesOnline: async (ids) => {
      await new Promise((r) => setTimeout(r, slowDelayMs));
      onBadSettled();
      return {
        requestedIds: [...ids],
        readyIds: [],
        launchedIds: [],
        failed: ids
          .filter((id) => id === badId)
          .map((profileId) => ({
            profileId,
            errorCode: 'LAUNCH_TIMEOUT',
            reason: '离线启动超时',
          })),
        items: [],
      };
    },
  };
}

test('GroupPosterService, GroupBumperService, and GroupInviterService start in <400ms and run healthy online browser without blocking on slow/failing offline launch', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'wb-cut2-nonblocking-'));
  const store = await WorkspaceStore.open(join(tempRoot, 'workspace.sqlite'));
  const badId = randomUUID();
  const goodId = randomUUID();
  try {
    // 1. GroupPosterService non-blocking launch isolation
    {
      const wb = new Workboard({ browserConcurrency: 2, launchConcurrency: 2 });
      const mat = store.groupPoster.saveMaterials({
        items: [{ caption: 'hello group', mediaSource: '', background: 'plain', selected: true }],
      })[0];
      assert.ok(mat);
      store.groupPoster.upsertTargets({ items: [{ id: 'g-poster-1', name: 'Poster Group' }] });
      const online = new Set<string>([goodId]);
      let badSettled = false;
      let postedWhileBadPending = false;

      const poster = new GroupPosterService(
        store.groupPoster,
        {
          ready: (id) => online.has(id),
          busy: async () => false,
          runProfileWorker: async (pid, _files, _settings, cb) => {
            assert.equal(pid, goodId);
            postedWhileBadPending = !badSettled;
            const claimed = await cb.claimNextTask();
            if (claimed) {
              await cb.onTaskPosted({
                id: randomUUID(),
                profileId: pid,
                accountId: 'acc-good',
                accountName: 'Good Account',
                accountAvatar: null,
                identityType: 'personal',
                groupId: claimed.group.id,
                groupName: claimed.group.name,
                groupAvatar: null,
                materialId: claimed.material.id,
                captionPreview: 'hello group',
                postId: 'post-1',
                postUrl: 'https://www.facebook.com/groups/g-poster-1/posts/1',
                postedAt: Date.now(),
              });
            }
          },
          stop: async () => {},
        },
        { prepare: async (src) => ({ localFilePath: src, mediaKind: 'none' }) },
      );
      poster.setWorkboard(wb);
      poster.setProfileLifecycle(
        createIsolatedLaunchLifecycle(online, badId, 900, () => {
          badSettled = true;
        }),
      );

      const t0 = Date.now();
      await poster.createTask({
        materialId: mat.id,
        groupIds: ['g-poster-1'],
        accountMode: 'selected',
        profileIds: [badId, goodId],
      });
      const startElapsed = Date.now() - t0;
      assert.ok(startElapsed < 400, `Poster createTask took ${startElapsed}ms`);

      for (let i = 0; i < 60 && !postedWhileBadPending; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(postedWhileBadPending, true, 'Good browser posted before slow launch settled');
      await poster.stop();
    }

    // 2. GroupBumperService non-blocking launch isolation
    {
      const wb = new Workboard({ browserConcurrency: 2, launchConcurrency: 2 });
      store.groupBumper.upsertTargets('groups', {
        items: [{ id: 'g-bumper-1', name: 'Bumper Group' }],
      });
      store.groupBumper.upsertTargets('pages', {
        items: [{ id: 'p-bumper-1', name: 'Bumper Page' }],
      });
      const online = new Set<string>([goodId]);
      let badSettled = false;
      let ranWhileBadPending = false;

      const bumper = new GroupBumperService(
        store.groupBumper,
        {
          ready: (id) => online.has(id),
          busy: async () => false,
          run: async (id) => {
            assert.equal(id, goodId);
            ranWhileBadPending = !badSettled;
          },
          stop: async () => {},
          hasControl: () => false,
        },
        async () => ({ comments: [], total: 0 }),
        () => {},
        undefined,
        0,
      );
      bumper.setWorkboard(wb);
      bumper.setProfileLifecycle(
        createIsolatedLaunchLifecycle(online, badId, 900, () => {
          badSettled = true;
        }),
      );

      const t0 = Date.now();
      await bumper.start({
        profileIds: [badId, goodId],
        groupIds: ['g-bumper-1'],
        pageIds: ['p-bumper-1'],
      });
      const startElapsed = Date.now() - t0;
      assert.ok(startElapsed < 400, `Bumper start took ${startElapsed}ms`);

      for (let i = 0; i < 60 && !ranWhileBadPending; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(ranWhileBadPending, true, 'Good browser bumped before slow launch settled');
      await bumper.stop();
    }

    // 3. GroupInviterService non-blocking launch isolation
    {
      const wb = new Workboard({ browserConcurrency: 2, launchConcurrency: 2 });
      store.groupInviter.upsertGroups({
        items: [{ groupId: 'g-inviter-1', groupName: 'Inviter Group' }],
      });
      const online = new Set<string>([goodId]);
      let badSettled = false;
      let invitedWhileBadPending = false;

      const inviter = new GroupInviterService(store.groupInviter, {
        isAvailable: () => true,
        isProfileReady: (id) => online.has(id),
        isProfileBusy: async () => false,
        inviteForGroup: async (profileId) => {
          assert.equal(profileId, goodId);
          invitedWhileBadPending = !badSettled;
        },
      });
      inviter.setWorkboard(wb);
      inviter.setProfileLifecycle(
        createIsolatedLaunchLifecycle(online, badId, 1_900, () => {
          badSettled = true;
        }),
      );

      const t0 = Date.now();
      await inviter.start({
        profileIds: [badId, goodId],
        groupIds: ['g-inviter-1'],
      });
      const startElapsed = Date.now() - t0;
      assert.ok(startElapsed < 400, `Inviter start took ${startElapsed}ms`);

      for (let i = 0; i < 120 && !invitedWhileBadPending; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(invitedWhileBadPending, true, 'Good browser invited before slow launch settled');
      await inviter.stop();
    }
  } finally {
    store.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
