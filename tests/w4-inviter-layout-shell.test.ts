import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import yauzl from 'yauzl';
import type { Locator, Page, Request, Response } from 'playwright-core';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import {
  GroupInviterService,
  type GroupInviterBrowserRunner,
} from '../src/application/group-inviter-service.js';
import { DataCleanupService } from '../src/application/data-cleanup.js';
import { SoftwareUpdateService } from '../src/application/software-update-service.js';
import { WindowLayoutService } from '../src/application/window-layout.js';
import { WorkspaceEventHub, type SseClientStream } from '../src/application/workspace-event-hub.js';
import type { Core } from '../src/bridge/core.js';
import { computeTileSlotCapacity } from '../src/domain/window-layout.js';
import { ProductError } from '../src/domain/workspace.js';
import { arrangeBlueStacksWindows } from '../src/infrastructure/bluestacks-win32.js';
import { SqliteDataCleanup } from '../src/infrastructure/data-cleanup-store.js';
import {
  createDiagnosticSnapshotBuilder,
  revealDiagnosticPackage,
} from '../src/infrastructure/diagnostic-package.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { runInviteBatchAndSubmit } from '../src/infrastructure/group-inviter-runner/inviter-flow.js';
import {
  revealInvitationControl,
  type InviterConnection,
  type InviterFlowCtx,
  type InviterScope,
} from '../src/infrastructure/group-inviter-runner/inviter-ops.js';
import { SqliteGroupInviterRepository } from '../src/infrastructure/group-inviter-store.js';
import type { WorkbenchMcpDependencies } from '../src/infrastructure/mcp/mcp-context.js';
import { createAgentBrowserTools } from '../src/infrastructure/mcp/tools-browser.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { InviterGroupRow } from '../src/shared/group-inviter.js';
import type { ProfileLifecyclePort } from '../src/shared/profile-lifecycle.js';
import type { Binding } from '../src/shared/task-execution.js';
import {
  defaultWindowLayout,
  type LayoutScreen,
  type LayoutSettings,
  type Rect,
  type TaskWindow,
  type TaskWindowPort,
} from '../src/shared/window-layout.js';

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function openTempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w4-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  return { dir, file, store };
}

const mkGroup = (groupId: string, groupName = `Group ${groupId}`): InviterGroupRow => ({
  groupId,
  groupName,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalInvitedCount: 0,
  createdAt: 1,
  updatedAt: 1,
});

const mkBinding = (profileId: string, accountId = '100088'): Binding => ({
  profileId,
  accountId,
  connectionEpoch: randomUUID(),
  leaseId: randomUUID(),
  generation: 1,
  operationId: randomUUID(),
  jobId: randomUUID(),
  stepId: randomUUID(),
  actionDigest: createHash('sha256').update(`d-${randomUUID()}`).digest('hex'),
});

const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function readZipTextEntry(zipPath: string, entryName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error('OPEN_ZIP_FAILED'));
        return;
      }
      let settled = false;
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            settled = true;
            zipfile.close();
            reject(streamErr ?? new Error('STREAM_FAILED'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            settled = true;
            zipfile.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          stream.on('error', (err) => {
            settled = true;
            zipfile.close();
            reject(err);
          });
        });
      });
      zipfile.on('end', () => {
        if (!settled) {
          zipfile.close();
          reject(new Error(`ENTRY_NOT_FOUND:${entryName}`));
        }
      });
      zipfile.on('error', reject);
    });
  });
}

describe('W4 Inviter, Window Layout & Shell Hardening Suite', () => {
  it('releasePendingInvites removes poisoned PENDING rows on sendDisabled / GROUP_INVITER_SEND_BUTTON_UNAVAILABLE', async () => {
    const { store, file } = await openTempStore();
    try {
      const db = new DatabaseSync(file);
      try {
        const repo = new SqliteGroupInviterRepository(db);
        const profileId = randomUUID();
        const accountId = '100012345';
        const groupId = '88001';
        repo.upsertGroups({ items: [{ groupId, groupName: 'G1' }] });

        // 1. Direct reserveInvites + releasePendingInvites unit check
        const op1 = randomUUID();
        repo.reserveInvites(op1, [
          { profileId, accountId, friendId: '20001', friendName: 'Alice', groupId },
        ]);
        assert.equal(repo.getInvitedFriendIdsForGroup(groupId).has('20001'), true);
        assert.equal(repo.releasePendingInvites(op1), 1);
        assert.equal(repo.getInvitedFriendIdsForGroup(groupId).has('20001'), false);

        // 2. End-to-end runInviteBatchAndSubmit: sendDisabled: true -> GROUP_INVITER_SEND_BUTTON_UNAVAILABLE -> 0 PENDING rows
        let sendDisabled = true;
        let checked = false;
        let dialogOpen = true;
        const pageListeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const emitPage = (ev: string, arg: unknown) => {
          for (const fn of pageListeners.get(ev) ?? []) fn(arg);
        };

        const makeLoc = (kind: string): Locator =>
          ({
            first: () => makeLoc(kind),
            nth: () => makeLoc(kind),
            filter: () => makeLoc(kind),
            locator: (sub: string) =>
              makeLoc(
                sub.includes('checkbox')
                  ? 'checkbox'
                  : sub.includes('send')
                    ? 'send'
                    : sub.includes('close')
                      ? 'close'
                      : kind,
              ),
            count: async () => 1,
            isVisible: async () => true,
            evaluate: async (fn: (el: Element, arg?: unknown) => unknown) => {
              const s = String(fn);
              if (s.includes('aria-checked')) return checked ? 'true' : 'false';
              if (s.includes('scrollIntoView')) {
                return {
                  cx: 200,
                  cy: 300,
                  stickyTop: 56,
                  windowHeight: 720,
                  windowWidth: 1280,
                  rectTop: 280,
                  rectBottom: 320,
                  inViewport: true,
                  canHitCenter: true,
                };
              }
              return undefined;
            },
            click: async () => {
              if (kind === 'checkbox') {
                checked = true;
                return;
              }
              if (kind === 'send') {
                dialogOpen = false;
                const req = {
                  url: () => 'https://www.facebook.com/api/graphql/',
                  method: () => 'POST',
                  postData: () =>
                    new URLSearchParams({
                      fb_api_req_friendly_name: 'useGroupAddMembersMutation',
                      variables: JSON.stringify({
                        input: { group_id: groupId, user_ids: ['20001'], actor_id: accountId },
                        groupID: groupId,
                      }),
                    }).toString(),
                } as unknown as Request;
                emitPage('request', req);
                const res = {
                  request: () => req,
                  status: () => 200,
                  text: async () =>
                    JSON.stringify({
                      data: {
                        group_add_member: {
                          group: { id: groupId },
                          user_facing_alert: null,
                          added_users: [
                            {
                              id: '20001',
                              group_membership: { pending_invite: { id: 'p-20001' } },
                            },
                          ],
                          already_invited_users: [],
                          requested_users: [],
                        },
                      },
                      extensions: { is_final: true },
                    }),
                } as unknown as Response;
                emitPage('response', res);
              }
            },
          }) as unknown as Locator;

        const mockPage = {
          url: () => `https://www.facebook.com/groups/${groupId}/`,
          on: (ev: string, fn: (...args: unknown[]) => void) => {
            if (!pageListeners.has(ev)) pageListeners.set(ev, new Set());
            pageListeners.get(ev)?.add(fn);
          },
          off: (ev: string, fn: (...args: unknown[]) => void) => {
            pageListeners.get(ev)?.delete(fn);
          },
          locator: (sel: string) => makeLoc(sel.includes('dialog') ? 'dialog' : sel),
          getByRole: () => makeLoc('dialog'),
          evaluate: async () => ({
            url: `https://www.facebook.com/groups/${groupId}/`,
            accountId,
            visible: true,
            ready: true,
            dialog: dialogOpen,
            dialogIndex: 0,
            menu: false,
            dialogCount: dialogOpen ? 1 : 0,
            joined: true,
            sendButton: dialogOpen ? { index: 0, disabled: sendDisabled } : undefined,
            items: [
              {
                index: 0,
                id: '20001',
                name: 'Alice',
                checked,
                invited: false,
                member: false,
                disabled: false,
              },
            ],
            timeOrigin: 1,
          }),
        } as unknown as Page;

        const binding = mkBinding(profileId, accountId);
        const conn = {
          context: async () => binding,
          enablePostNetworkObservation: async () => {},
          execute: async (_b: Binding, work: () => Promise<unknown>) => ({
            value: await work(),
            binding,
            targetUnavailableBeforeInput: false,
          }),
        } as unknown as InviterConnection;
        const scopes = new WeakMap<InviterConnection, InviterScope>();
        const scopeRef: InviterScope = {
          guard: () => {},
          page: mockPage,
          groupId,
          jobId: binding.jobId,
          stepId: binding.stepId,
          stopId: '',
          pendingSetup: new Map(),
        };
        scopes.set(conn, scopeRef);
        const selectedInMemory = new Set<string>();
        const selectingByGroup = new Map<string, Set<string>>();

        const ctx: InviterFlowCtx = {
          profileId,
          group: mkGroup(groupId),
          page: mockPage,
          conn,
          boundAccountId: accountId,
          guard: () => {},
          atGroup: () => true,
          inviteButton: async () => makeLoc('invite'),
          clickControl: async (loc) => {
            await loc.click();
          },
          execBoundOp: async (_c, _a, _l, fn, _persist, prepare) => {
            const opId = randomUUID();
            if (prepare) await prepare(opId);
            return fn(opId);
          },
          callbacks: {
            isCancelled: () => false,
            setProfileStatus: () => {},
            addSessionInvited: () => {},
          },
        };

        const extra = {
          effectiveGroupId: groupId,
          invitesPerGroup: 1,
          scopeRef,
          scopes,
          selectedInMemory,
          selectingByGroup,
          repo,
          selectRecipient: async (
            _gid: string,
            _fid: string,
            _owned: Set<string>,
            click: () => Promise<boolean>,
          ) => click(),
          releaseSelections: () => {},
        };

        await assert.rejects(
          runInviteBatchAndSubmit(ctx, extra),
          (err: unknown) =>
            err instanceof ProductError && err.code === 'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE',
        );
        const pendingRows = db
          .prepare("SELECT COUNT(*) AS n FROM group_inviter_logs WHERE confirmation='PENDING'")
          .get() as { n: number };
        assert.equal(pendingRows.n, 0, 'Must leave 0 poisoned PENDING rows when sendDisabled=true');

        // Retry with sendDisabled = false -> Alice is still eligible and confirmed!
        sendDisabled = false;
        checked = false;
        dialogOpen = true;
        await runInviteBatchAndSubmit(ctx, extra);
        const confirmedRows = db
          .prepare("SELECT COUNT(*) AS n FROM group_inviter_logs WHERE confirmation='CONFIRMED'")
          .get() as { n: number };
        assert.equal(confirmedRows.n, 1);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });

  it('revealInvitationControl uses dynamic header clearance and falls back to mouse.wheel when obscured', async () => {
    let evalCall = 0;
    const moves: Array<[number, number]> = [];
    const wheels: Array<[number, number]> = [];
    const mockPage = {
      mouse: {
        move: async (x: number, y: number) => {
          moves.push([x, y]);
        },
        wheel: async (dx: number, dy: number) => {
          wheels.push([dx, dy]);
        },
      },
    };
    const mockLoc = {
      page: () => mockPage,
      evaluate: async () => {
        evalCall += 1;
        if (evalCall === 1) {
          return {
            cx: 400,
            cy: 750,
            stickyTop: 184,
            windowHeight: 720,
            windowWidth: 1280,
            rectTop: 730,
            rectBottom: 770,
            inViewport: false,
            canHitCenter: false,
          };
        }
        return {
          cx: 400,
          cy: 420,
          stickyTop: 184,
          windowHeight: 720,
          windowWidth: 1280,
          rectTop: 400,
          rectBottom: 440,
          inViewport: true,
          canHitCenter: true,
        };
      },
    } as unknown as Locator;

    await revealInvitationControl(mockLoc, 0);
    assert.equal(evalCall, 2);
    assert.equal(moves.length, 1);
    assert.equal(wheels.length, 1);
    assert.ok((wheels[0]?.[1] ?? 0) >= 140);
  });

  it('GroupInviterService covers per-group skip, groupIds dedupe, scheduled 1..200 cap, startupDelay, refreshGroups guard, syncMaxConcurrency, lastRunSummary, and Q2 closeBrowserOnFinish', async () => {
    const { store, file } = await openTempStore();
    try {
      const db = new DatabaseSync(file);
      try {
        const repo = new SqliteGroupInviterRepository(db);
        const p1 = randomUUID();
        const p2 = randomUUID();
        repo.upsertGroups({
          items: [
            { groupId: '88001', groupName: 'Bad Send Group' },
            { groupId: '88002', groupName: 'Missing Entry Group' },
            { groupId: '88003', groupName: 'Healthy Group' },
          ],
        });

        const calls: Array<{ pid: string; gid: string; cap: number; at: number }> = [];
        let busyInFeature = false;
        const closedProfiles: string[] = [];
        let holdP1Finish: (() => void) | null = null;
        let markBusyInFlight = false;
        const runner: GroupInviterBrowserRunner = {
          isAvailable: () => true,
          isProfileReady: () => true,
          isProfileBusy: async () => false,
          inviteForGroup: async (pid, group, cap, cb) => {
            calls.push({ pid, gid: group.groupId, cap, at: Date.now() });
            if (markBusyInFlight) busyInFeature = true;
            if (group.groupId === '88001') {
              throw new ProductError(
                'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE',
                '跳过：邀请发送按钮不可用，未发送',
                409,
              );
            }
            if (group.groupId === '88002') {
              throw new Error('GROUP_INVITER_INVITE_ENTRY_REQUIRED');
            }
            if (pid === p1 && holdP1Finish) {
              await new Promise<void>((r) => {
                holdP1Finish = r;
              });
            }
            await cb.addSessionInvited(pid, 2);
          },
        };

        const fe = new FeatureExecutionRegistry();
        fe.register({
          id: 'group-poster',
          label: '小组发帖',
          hasActiveExecution: () => busyInFeature,
          isProfileRunning: () => busyInFeature,
          stopProfiles: async () => {},
        });
        const lifecycle: ProfileLifecyclePort = {
          isLaunching: () => false,
          getStatus: async () => [],
          launchProfile: async (id) => ({
            profileId: id,
            browserName: id,
            action: 'open',
            ok: true,
            online: true,
            phase: 'PAUSED',
            synced: true,
            launchable: true,
            elapsedMs: 1,
          }),
          restartProfile: async (id) => ({
            profileId: id,
            browserName: id,
            action: 'restart',
            ok: true,
            online: true,
            phase: 'PAUSED',
            synced: true,
            launchable: true,
            elapsedMs: 1,
          }),
          ensureProfilesOnline: async (ids) => ({
            requestedIds: [...ids],
            readyIds: [...ids],
            launchedIds: [],
            failed: [],
            items: [],
          }),
          closeProfile: async (id) => {
            closedProfiles.push(id);
            return {
              profileId: id,
              browserName: id,
              action: 'close',
              ok: true,
              online: false,
              phase: 'OFFLINE',
              synced: false,
              launchable: true,
              elapsedMs: 1,
            };
          },
        };

        const service = new GroupInviterService(repo, runner);
        service.setFeatureExecutionRegistry(fe);
        service.setProfileLifecycle(lifecycle);

        // syncMaxConcurrency clamps 1..50 and updates workboard limit
        await service.syncMaxConcurrency(9);
        assert.equal(service.getWorkboard().browserPermits.max, 9);
        await service.syncMaxConcurrency(0);
        assert.equal(service.getWorkboard().browserPermits.max, 1);
        await service.syncMaxConcurrency(200);
        assert.equal(service.getWorkboard().browserPermits.max, 50);

        // refreshGroups without refreshAvatars never stalls on '正在刷新…'
        const noRefreshState = await service.refreshGroups(['88001']);
        assert.equal(noRefreshState.groupAvatarRefreshing, false);
        assert.equal(noRefreshState.avatarRefreshStatusText, '当前未启用小组资料刷新服务');

        // Run with duplicate groupIds + per-group skip + Q2 closeBrowserOnFinish blocked when busyInFeature flips true in-flight
        markBusyInFlight = true;
        await service.start({
          profileIds: [p1],
          groupIds: ['88001', '88001', '88002', '88003'],
          invitesPerGroup: 30,
          closeBrowserOnFinish: true,
        });
        while (service.hasActiveExecution()) await new Promise((r) => setTimeout(r, 15));
        markBusyInFlight = false;
        assert.deepEqual(
          [...calls.map((c) => c.gid)].sort(),
          ['88001', '88002', '88003'],
          'Duplicate groupIds must be deduped and bad groups skipped without aborting 88003',
        );
        assert.equal(calls.length, 3);
        assert.equal(
          closedProfiles.length,
          0,
          'Must NOT close profile while another module is busy',
        );

        const afterSkipState = await service.state();
        assert.equal(afterSkipState.lastRunSummary?.invitedTotal, 2);
        assert.deepEqual(afterSkipState.lastRunSummary?.failedProfiles, []);
        assert.equal(afterSkipState.lastRunSummary?.groupResults.length, 3);
        assert.equal(
          afterSkipState.lastRunSummary?.groupResults.find((g) => g.groupId === '88001')?.status,
          'failed',
        );
        assert.equal(
          afterSkipState.lastRunSummary?.groupResults.find((g) => g.groupId === '88002')?.status,
          'failed',
        );
        assert.equal(
          afterSkipState.lastRunSummary?.groupResults.find((g) => g.groupId === '88003')?.status,
          'invited',
        );

        // Q2 closeBrowserOnFinish closes cleanly when idle
        busyInFeature = false;
        await service.start({
          profileIds: [p1],
          groupIds: ['88003'],
          closeBrowserOnFinish: true,
        });
        while (service.hasActiveExecution()) await new Promise((r) => setTimeout(r, 15));
        assert.deepEqual(closedProfiles, [p1]);

        // Scheduled step honors cap 150 (not clamped to 50) & dedupes groupIds
        calls.length = 0;
        const schedRes = await service.runScheduledProfileStep({
          profileId: p2,
          groupIds: ['88003', '88003'],
          invitesPerGroup: 150,
          playSoundOnComplete: false,
          onProgress: () => {},
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.cap, 150);
        assert.equal(schedRes.invitedCount, 2);
        assert.equal(schedRes.playSoundOnComplete, false);

        // Concurrent 2 profiles with maxConcurrentProfiles=1: startupDelay keeps workboard bounded
        await service.updateSettings({ maxConcurrentProfiles: 1, closeBrowserOnFinish: false });
        let p1Start = 0;
        let p2Start = 0;
        let activeUsedMax = 0;
        const wb = service.getWorkboard();
        const delayRunner: GroupInviterBrowserRunner = {
          isAvailable: () => true,
          isProfileReady: () => true,
          inviteForGroup: async (pid) => {
            activeUsedMax = Math.max(activeUsedMax, wb.browserPermits.used);
            if (pid === p1) p1Start = Date.now();
            else p2Start = Date.now();
            await new Promise((r) => setTimeout(r, 40));
          },
        };
        const delaySvc = new GroupInviterService(repo, delayRunner);
        const delayWb = delaySvc.getWorkboard();
        delayRunner.inviteForGroup = async (pid) => {
          activeUsedMax = Math.max(activeUsedMax, delayWb.browserPermits.used);
          if (pid === p1) p1Start = Date.now();
          else p2Start = Date.now();
          await new Promise((r) => setTimeout(r, 40));
        };
        await delaySvc.start({
          profileIds: [p1, p2],
          groupIds: ['88003'],
          maxConcurrentProfiles: 1,
        });
        while (delaySvc.hasActiveExecution()) await new Promise((r) => setTimeout(r, 20));
        assert.equal(activeUsedMax, 1);
        assert.ok(
          p2Start - p1Start >= 750,
          `Expected staggered startupDelay, got ${p2Start - p1Start}ms`,
        );
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });

  it('GroupInviterService refreshGroups error resets groupAvatarRefreshing cleanly', async () => {
    const { store, file } = await openTempStore();
    try {
      const db = new DatabaseSync(file);
      try {
        const repo = new SqliteGroupInviterRepository(db);
        repo.upsertGroups({ items: [{ groupId: '88009', groupName: '' }] });
        const svc = new GroupInviterService(
          repo,
          undefined,
          () => {},
          async () => {
            throw new Error('NETWORK_FAIL');
          },
        );
        await svc.refreshGroups(['88009']);
        await new Promise((r) => setTimeout(r, 30));
        const st = await svc.state();
        assert.equal(st.groupAvatarRefreshing, false);
        assert.equal(st.avatarRefreshStatusText, '刷新小组头像失败，请稍后重试');
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });

  it('WindowLayoutService auto-tile avoids overlaps across concurrent slots and reports partial failedProfiles', async () => {
    const screen: LayoutScreen = {
      id: 'disp-1',
      primary: true,
      scaleFactor: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
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
            targetId: `t-${i}`,
          },
          windowId: i + 1,
          state: 'normal',
          contentInsets: { left: 8, top: 80, right: 8, bottom: 8 },
          rect: { x: 20, y: 20, width: 900, height: 700 },
        },
      ]),
    );
    let settings: LayoutSettings = {
      ...defaultWindowLayout,
      enabled: true,
      mode: 'tile',
      tileDisplays: [{ displayId: screen.id, enabled: true, rows: 2, cols: 2, startSlot: 1 }],
      tileGap: 10,
    };
    assert.equal(computeTileSlotCapacity([screen], settings.tileDisplays), 4);
    let failMoveId = '';
    const port: TaskWindowPort = {
      async read(id) {
        const w = windows.get(id);
        if (!w) throw new Error('OFFLINE');
        return structuredClone(w);
      },
      async move(id, expected, rect) {
        if (id === failMoveId) throw new Error('WINDOW_MINIMIZED');
        const next = { ...expected, rect: { ...rect } };
        windows.set(id, next);
        return structuredClone(next);
      },
    };
    const svc = new WindowLayoutService(
      () => [screen],
      port,
      async () => settings,
      async (next) => {
        settings = next;
      },
    );

    await Promise.all(ids.map((id) => svc.arrange(id)));
    const placed = ids.map((id) => windows.get(id)?.rect).filter((r): r is Rect => Boolean(r));
    assert.equal(placed.length, 3);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        assert.ok(a && b);
        assert.equal(rectsOverlap(a, b), false, `Slots ${i} and ${j} must not overlap`);
      }
    }

    failMoveId = ids[1] ?? '';
    const snap = await svc.command({ action: 'apply', profileIds: ids, mode: 'tile' });
    assert.equal(snap.movedCount, 2);
    assert.deepEqual(snap.failedProfiles, [failMoveId]);
  });

  it('arrangeBlueStacksWindows emits monitorBounds PS area expression and falls back to PrimaryScreen', async () => {
    if (process.platform !== 'win32') return;
    const scripts: string[] = [];
    const mockProc = async (_exe: string, args: string[]) => {
      scripts.push(args[args.length - 1] ?? '');
      return Buffer.from('1', 'utf8');
    };
    const count1 = await arrangeBlueStacksWindows(mockProc, [{ hwnd: '123456', pid: 4321 }], {
      columns: 2,
      gap: 16,
      monitorBounds: { left: 1920, top: 0, width: 1920, height: 1040 },
    });
    assert.equal(count1, 1);
    assert.ok(
      scripts[0]?.includes(
        '[PSCustomObject]@{ Left = 1920; Top = 0; Width = 1920; Height = 1040 }',
      ),
    );
    const count2 = await arrangeBlueStacksWindows(mockProc, [{ hwnd: '123456', pid: 4321 }], {
      columns: 2,
      gap: 16,
    });
    assert.equal(count2, 1);
    assert.ok(scripts[1]?.includes('[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea'));
  });

  it('SoftwareUpdateService.status() returns non-blocking while background check captures errors cleanly', async () => {
    const svc = new SoftwareUpdateService(
      {
        readConfig: async () => ({ githubRepo: 'org/wb', autoCheck: true }),
        saveConfig: async () => {},
        check: async () => {
          await new Promise((r) => setTimeout(r, 60));
          throw new Error('GitHub 限流');
        },
        assertCanApply: async () => {},
        install: async () => {},
        reloadExtensions: async () => ({
          reloaded: 0,
          skippedBusy: 0,
          skippedOffline: 0,
          extensionDir: 'C:\\ext',
          bundledVersion: '0.3.92',
        }),
        openExtensionDirectory: async () => {},
        restart: () => {},
      },
      { software: '0.1.272', extension: '0.3.92', directory: 'C:\\ext' },
    );
    const t0 = Date.now();
    const fast = await svc.status();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 45, `status() must be non-blocking, took ${elapsed}ms`);
    assert.equal(fast.checking, true);
    await new Promise((r) => setTimeout(r, 100));
    const settled = await svc.status();
    assert.equal(settled.checking, false);
    assert.equal(settled.error, 'GitHub 限流');
  });

  it('DataCleanupService.preview() counts expired feature records when task_steps=0 and execute purges them', async () => {
    const { store, file } = await openTempStore();
    try {
      const db = new DatabaseSync(file);
      try {
        const bumperRepo = new SqliteGroupBumperRepository(db);
        const oldTs = Date.now() - 10 * 86400_000;
        const pid = randomUUID();
        const epoch = randomUUID();

        // 1. Expired settled bumper op
        const settledOpId = randomUUID();
        bumperRepo.prepareOperation({
          binding: {
            operationId: settledOpId,
            profileId: pid,
            accountId: '10001',
            connectionEpoch: epoch,
            leaseId: randomUUID(),
            generation: 1,
            jobId: randomUUID(),
            stepId: randomUUID(),
            actionDigest: 'a'.repeat(64),
          },
          runId: randomUUID(),
          actionKind: 'submit_like',
          groupId: '111222',
          groupName: 'G1',
          pageId: '444555',
          pageName: 'P1',
          postId: '1001',
          postUrl: 'https://www.facebook.com/groups/111222/posts/1001/',
          commentId: null,
          commentText: null,
          logId: randomUUID(),
          resolution: null,
          status: 'PREPARED',
          reason: '',
        });
        bumperRepo.setOperationResolution(settledOpId, {
          id: randomUUID(),
          outcome: 'NOT_APPLIED',
          evidenceDigest: 'b'.repeat(64),
        });
        bumperRepo.markOperationSettled(settledOpId);
        db.prepare('UPDATE group_bumper_operations SET updated_at=? WHERE operation_id=?').run(
          oldTs,
          settledOpId,
        );

        // 2. Unsettled (protected) bumper op
        const unsettledOpId = randomUUID();
        bumperRepo.prepareOperation({
          binding: {
            operationId: unsettledOpId,
            profileId: pid,
            accountId: '10001',
            connectionEpoch: epoch,
            leaseId: randomUUID(),
            generation: 1,
            jobId: randomUUID(),
            stepId: randomUUID(),
            actionDigest: 'c'.repeat(64),
          },
          runId: randomUUID(),
          actionKind: 'submit_like',
          groupId: '111222',
          groupName: 'G1',
          pageId: '444555',
          pageName: 'P1',
          postId: '1002',
          postUrl: 'https://www.facebook.com/groups/111222/posts/1002/',
          commentId: null,
          commentText: null,
          logId: randomUUID(),
          resolution: null,
          status: 'PREPARED',
          reason: '',
        });
        db.prepare('UPDATE group_bumper_operations SET updated_at=? WHERE operation_id=?').run(
          oldTs,
          unsettledOpId,
        );

        // 3. Expired post_bump_records row + auto_scheduler_runs row
        db.prepare(
          "INSERT INTO post_bump_records(id, record_type, carrier, status, profile_id, account_id, created_at) VALUES(?, 'group_bump', 'browser', 'success', ?, '10001', ?)",
        ).run(randomUUID(), pid, oldTs);
        db.prepare(
          "INSERT INTO auto_scheduler_runs(id, schedule_id, schedule_name, carrier, phase, slot_key, trigger_mode, status, status_reason, total_targets, completed_count, soft_issue_count, hard_blocked_count, scheduled_for, started_at, finished_at) VALUES(?, ?, 'Sched', 'browser', 'finished', 'slot-1', 'daily', 'completed', '', 1, 1, 0, 0, ?, ?, ?)",
        ).run(randomUUID(), randomUUID(), oldTs, oldTs, oldTs + 1000);

        const cleanupRepo = new SqliteDataCleanup(db);
        const svc = new DataCleanupService(
          cleanupRepo,
          { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
          undefined,
          async () => {},
          () => {},
        );
        const prev = await svc.preview({
          kind: 'records',
          scope: { before: Date.now() - 86400_000 },
        });
        assert.equal(prev.eligible, 3);
        assert.equal(prev.protected, 1);
        const execRes = await svc.execute({ token: prev.token, confirm: true });
        assert.equal(execRes.deleted, 3);
        assert.equal(execRes.protected, 1);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });

  it('WorkspaceEventHub emits real group-inviter SSE digest transitions across start, progress, and finish', async () => {
    const hub = new WorkspaceEventHub({ coalesceMs: 0, keepaliveMs: 0 });
    const chunks: string[] = [];
    const stream: SseClientStream = {
      closed: false,
      write: (c) => {
        chunks.push(c);
        return true;
      },
      end: () => {},
      onClose: () => {},
    };
    assert.equal(hub.attach(stream), true);

    let phase = 'idle';
    hub.startDigestMonitor(async () => ({ 'group-inviter': phase }), 15);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      chunks.filter((c) => c.includes('event: invalidate')).length,
      0,
      'Initial baseline digest must not emit spurious invalidate',
    );

    phase = 'running:1/3';
    await new Promise((r) => setTimeout(r, 35));
    phase = 'running:2/3';
    await new Promise((r) => setTimeout(r, 35));
    phase = 'finished:3/3';
    await new Promise((r) => setTimeout(r, 35));
    hub.close();

    const invalidations = chunks.filter((c) => c.includes('event: invalidate'));
    assert.equal(invalidations.length, 3);
    for (const frame of invalidations) {
      assert.ok(frame.includes('"group-inviter"'));
    }
  });

  it('MCP arrange_windows defaults to online profiles and rejects when none are online', async () => {
    const online1 = randomUUID();
    const online2 = randomUUID();
    const offline1 = randomUUID();
    const commands: unknown[] = [];
    const peers = new Map([
      [online1, { profileId: online1, online: true, phase: 'PAUSED', synced: true }],
      [online2, { profileId: online2, online: true, phase: 'PAUSED', synced: true }],
      [offline1, { profileId: offline1, online: false, phase: 'OFFLINE', synced: false }],
    ]);
    const deps = {
      core: { peers } as unknown as Core,
      store: { unresolved: async () => [] },
      featureExecution: { busyModuleLabels: async () => [] },
      workspaceService: {
        snapshot: async () => ({
          groups: [],
          profiles: [
            {
              id: online1,
              alias: 'O1',
              browserName: 'O1',
              order: 0,
              account: { state: 'unknown', id: null, name: null, avatar: null },
            },
            {
              id: online2,
              alias: 'O2',
              browserName: 'O2',
              order: 1,
              account: { state: 'unknown', id: null, name: null, avatar: null },
            },
            {
              id: offline1,
              alias: 'F1',
              browserName: 'F1',
              order: 2,
              account: { state: 'unknown', id: null, name: null, avatar: null },
            },
          ],
          combinations: [],
          records: [],
        }),
      },
      windowLayout: {
        command: async (cmd: unknown) => {
          commands.push(cmd);
          return { settings: defaultWindowLayout, displays: [], managed: [], error: '' };
        },
      },
      agentBrowser: { listSessions: () => [] },
    } as unknown as WorkbenchMcpDependencies;

    const tools = createAgentBrowserTools(deps);
    const lifecycleTool = tools.find((t) => t.name === 'wb_browser_lifecycle');
    assert.ok(lifecycleTool);
    await lifecycleTool.handler({ action: 'arrange_windows' });
    assert.deepEqual(commands[0], { action: 'apply', profileIds: [online1, online2] });

    peers.clear();
    const emptyRes = await lifecycleTool.handler({ action: 'arrange_windows' });
    assert.equal(emptyRes.isError, true);
    assert.equal(emptyRes.structuredContent?.errorCode, 'WINDOW_LAYOUT_SELECTION_REQUIRED');
  });

  it('diagnostic-package redacts secrets/commentPool and revealDiagnosticPackage rejects path traversal', async () => {
    const { store, dir } = await openTempStore();
    try {
      const buildDiag = createDiagnosticSnapshotBuilder({
        dataDir: dir,
        softwareVersion: '0.1.272',
        extensionVersion: '0.3.92',
        workspaceService: {
          snapshot: async () => ({
            groups: [],
            profiles: [],
            combinations: [],
            records: [],
          }),
        } as never,
        taskService: { runtimeOverview: async () => ({ plans: [], settings: {} }) } as never,
        groupInviterService: {
          state: async () => ({
            groups: [],
            invitesPerGroup: 30,
            running: false,
            runId: null,
            startedAt: null,
            finishedAt: null,
            statusText: '就绪',
            profileCounts: {},
          }),
          logs: async () => [],
        } as never,
        getGroupBumperService: () => undefined,
        groupPosterService: {
          state: async () => ({
            groups: [],
            materials: [],
            settings: {},
            total: 0,
            running: false,
            statusText: '',
            profileCounts: {},
          }),
          logs: async () => [],
        } as never,
        getWindowLayout: () =>
          ({
            snapshot: async () => ({
              settings: defaultWindowLayout,
              displays: [],
              managed: [],
              error: '',
              failedProfiles: [],
            }),
          }) as never,
        getAutoSchedulerService: () =>
          ({
            state: async () => ({
              settings: { browserConcurrency: 4, bluestacksConcurrency: 2 },
              running: false,
              powerLockMode: 'off',
              activeBrowserWorkers: 0,
              queuedBrowserTargets: 0,
              activeBluestacksWorkers: 0,
              queuedBluestacksTargets: 0,
              schedules: [],
              activeRuns: [],
              recentRuns: [],
            }),
          }) as never,
        getGoogleSheetsService: () =>
          ({
            overview: async () => ({
              auth: {
                hasCredentials: true,
                clientIdHint: 'abc***',
                authorized: true,
                scopes: ['sheets'],
                pendingAuthUrl: 'https://secret.example/oauth?code=SECRET_TOKEN',
                pendingAuthStartedAt: 1,
                lastError: '',
              },
              imageHost: {
                preferredHost: 'gyazo',
                hasGyazoToken: true,
                gyazoTokenCount: 1,
                gyazoTokenPreviews: ['gyp_***123'],
                driveFolderId: 'drv-1',
                defaultMachineName: 'M1',
                cachedImageCount: 0,
              },
              runningScheduleCount: 0,
              runningRecordsCount: 0,
              activeProfiles: [],
              links: [
                {
                  id: 'lnk-1',
                  kind: 'records',
                  title: 'Records',
                  spreadsheetId: 'sheet-1',
                  sheetId: 0,
                  sheetName: 'Sheet1',
                  enabled: true,
                  recordsConfig: { commentPool: ['SECRET_COMMENT_1', 'SECRET_COMMENT_2'] },
                },
              ],
              logs: [],
            }),
          }) as never,
        tasksRepository: {
          list: async () => [],
          steps: async () => [],
          events: async () => [],
        } as never,
        core: { peers: new Map() } as unknown as Core,
        getMainKernel: () => undefined,
        controllerLoopDelay: { count: 0, max: 0, percentile: () => 0 },
        devDiagFlush: async () => {},
        devDiagFilePath: path.join(dir, 'logs', 'dev-diagnostics.jsonl'),
      });

      const pkg = await buildDiag({ note: 'test redaction', reveal: false });
      const jsonText = await readZipTextEntry(pkg.filePath, '1-snapshot.json');
      const snap = JSON.parse(jsonText) as Record<string, unknown>;
      assert.ok(snap.windowLayout);
      assert.ok(snap.autoScheduler);
      assert.ok(snap.googleSheets);
      assert.equal(jsonText.includes('SECRET_TOKEN'), false);
      assert.equal(jsonText.includes('SECRET_COMMENT_1'), false);
      assert.ok(jsonText.includes('[2]'));

      await assert.rejects(
        () => revealDiagnosticPackage(dir, '..\\evil.zip'),
        (err: unknown) => err instanceof ProductError && err.code === 'DIAGNOSTIC_PACKAGE_INVALID',
      );
      await assert.rejects(
        () => revealDiagnosticPackage(dir, path.join(tmpdir(), 'outside-evil.zip')),
        (err: unknown) => err instanceof ProductError && err.code === 'DIAGNOSTIC_PACKAGE_INVALID',
      );
      await assert.rejects(
        () => revealDiagnosticPackage(dir, 'ok.zip', '..\\outside'),
        (err: unknown) => err instanceof ProductError && err.code === 'DIAGNOSTIC_PACKAGE_INVALID',
      );
    } finally {
      await store.close();
    }
  });
});
