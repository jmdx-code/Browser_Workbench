import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DataCleanupService } from '../dist/src/application/data-cleanup.js';
import { FeatureExecutionRegistry } from '../dist/src/application/feature-execution-registry.js';
import { GroupInviterService } from '../dist/src/application/group-inviter-service.js';
import { WindowLayoutService } from '../dist/src/application/window-layout.js';
import { WorkspaceEventHub } from '../dist/src/application/workspace-event-hub.js';
import { Workboard } from '../dist/src/application/workboard.js';
import { ProductError } from '../dist/src/domain/workspace.js';
import { SqliteDataCleanup } from '../dist/src/infrastructure/data-cleanup-store.js';
import { SqliteGroupBumperRepository } from '../dist/src/infrastructure/group-bumper-store.js';
import { runInviteBatchAndSubmit } from '../dist/src/infrastructure/group-inviter-runner/inviter-flow.js';
import { revealInvitationControl } from '../dist/src/infrastructure/group-inviter-runner/inviter-ops.js';
import { SqliteGroupInviterRepository } from '../dist/src/infrastructure/group-inviter-store.js';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { defaultWindowLayout } from '../dist/src/shared/window-layout.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

const rectsOverlap = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w4-chaos-'));
  const dbPath = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(dbPath);
  const workboard = new Workboard({ browserConcurrency: 5, bluestacksConcurrency: 4 });
  const rawDb = new DatabaseSync(dbPath);

  try {
    // 1. Small-window obscured sendButton scroll recovery (mouse.wheel fallback) + sendDisabled 0 poisoned PENDING rows
    let wheelFallbacks = 0;
    let probeCall = 0;
    await revealInvitationControl({
      page: () => ({
        mouse: {
          move: async () => {},
          wheel: async (_dx, dy) => {
            if (dy > 0) wheelFallbacks++;
          },
        },
      }),
      evaluate: async () => {
        probeCall++;
        if (probeCall === 1) {
          return {
            cx: 320,
            cy: 790,
            stickyTop: 180,
            windowHeight: 680,
            windowWidth: 960,
            rectTop: 770,
            rectBottom: 810,
            inViewport: false,
            canHitCenter: false,
          };
        }
        return {
          cx: 320,
          cy: 420,
          stickyTop: 180,
          windowHeight: 680,
          windowWidth: 960,
          rectTop: 400,
          rectBottom: 440,
          inViewport: true,
          canHitCenter: true,
        };
      },
    });
    assert.equal(wheelFallbacks, 1);

    const inviterRepo = new SqliteGroupInviterRepository(rawDb);
    const retryGroupId = '889900';
    inviterRepo.upsertGroups({ items: [{ groupId: retryGroupId, groupName: 'Obscured Group' }] });
    const retryPid = randomUUID();
    const retryAid = '10008899';
    let sendDisabled = true;
    let friendChecked = false;
    let dlgOpen = true;
    const listeners = new Map();
    const mkLoc = (kind) => ({
      first: () => mkLoc(kind),
      nth: () => mkLoc(kind),
      filter: () => mkLoc(kind),
      locator: (s) =>
        mkLoc(s.includes('checkbox') ? 'checkbox' : s.includes('send') ? 'send' : kind),
      count: async () => 1,
      isVisible: async () => true,
      evaluate: async (fn) => {
        const str = String(fn);
        if (str.includes('aria-checked')) return friendChecked ? 'true' : 'false';
        return {
          cx: 200,
          cy: 300,
          stickyTop: 56,
          windowHeight: 680,
          windowWidth: 960,
          rectTop: 280,
          rectBottom: 320,
          inViewport: true,
          canHitCenter: true,
        };
      },
      click: async () => {
        if (kind === 'checkbox') friendChecked = true;
        if (kind === 'send') {
          dlgOpen = false;
          const req = {
            url: () => 'https://www.facebook.com/api/graphql/',
            method: () => 'POST',
            postData: () =>
              new URLSearchParams({
                fb_api_req_friendly_name: 'useGroupAddMembersMutation',
                variables: JSON.stringify({
                  input: { group_id: retryGroupId, user_ids: ['30001'], actor_id: retryAid },
                  groupID: retryGroupId,
                }),
              }).toString(),
          };
          for (const fn of listeners.get('request') ?? []) fn(req);
          const res = {
            request: () => req,
            status: () => 200,
            text: async () =>
              JSON.stringify({
                data: {
                  group_add_member: {
                    group: { id: retryGroupId },
                    user_facing_alert: null,
                    added_users: [
                      { id: '30001', group_membership: { pending_invite: { id: 'p-30001' } } },
                    ],
                    already_invited_users: [],
                    requested_users: [],
                  },
                },
                extensions: { is_final: true },
              }),
          };
          for (const fn of listeners.get('response') ?? []) fn(res);
        }
      },
    });
    const mockPage = {
      url: () => `https://www.facebook.com/groups/${retryGroupId}/`,
      on: (ev, fn) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
      },
      off: (ev, fn) => listeners.get(ev)?.delete(fn),
      locator: (s) => mkLoc(s.includes('dialog') ? 'dialog' : s),
      getByRole: () => mkLoc('dialog'),
      evaluate: async () => ({
        url: `https://www.facebook.com/groups/${retryGroupId}/`,
        accountId: retryAid,
        visible: true,
        ready: true,
        dialog: dlgOpen,
        dialogIndex: 0,
        menu: false,
        dialogCount: dlgOpen ? 1 : 0,
        joined: true,
        sendButton: dlgOpen ? { index: 0, disabled: sendDisabled } : undefined,
        items: [
          {
            index: 0,
            id: '30001',
            name: 'Bob',
            checked: friendChecked,
            invited: false,
            member: false,
            disabled: false,
          },
        ],
        timeOrigin: 1,
      }),
    };
    const opId = randomUUID();
    const binding = {
      profileId: retryPid,
      accountId: retryAid,
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 1,
      operationId: opId,
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: sha256({ opId }),
    };
    const conn = {
      context: async () => binding,
      enablePostNetworkObservation: async () => {},
      execute: async (_b, work) => ({ value: await work() }),
    };
    const scopes = new WeakMap();
    const scopeRef = { jobId: binding.jobId, stepId: binding.stepId };
    scopes.set(conn, scopeRef);
    const flowCtx = {
      profileId: retryPid,
      group: {
        groupId: retryGroupId,
        groupName: 'Obscured Group',
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalInvitedCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      page: mockPage,
      conn,
      boundAccountId: retryAid,
      guard: () => {},
      atGroup: () => true,
      inviteButton: async () => mkLoc('invite'),
      clickControl: async (l) => l.click(),
      execBoundOp: async (_c, _a, _l, fn, _persist, prepare) => {
        const id = randomUUID();
        if (prepare) await prepare(id);
        return fn(id);
      },
      callbacks: {
        isCancelled: () => false,
        setProfileStatus: () => {},
        addSessionInvited: () => {},
      },
    };
    const flowExtra = {
      effectiveGroupId: retryGroupId,
      invitesPerGroup: 1,
      scopeRef,
      scopes,
      selectedInMemory: new Set(),
      selectingByGroup: new Map(),
      repo: inviterRepo,
      selectRecipient: async (_g, _f, _o, c) => c(),
      releaseSelections: () => {},
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      friendChecked = false;
      dlgOpen = true;
      await assert.rejects(
        runInviteBatchAndSubmit(flowCtx, flowExtra),
        (err) =>
          err instanceof ProductError && err.code === 'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE',
      );
    }
    let pendingPoisonedRows = rawDb
      .prepare("SELECT COUNT(*) AS n FROM group_inviter_logs WHERE confirmation='PENDING'")
      .get().n;
    assert.equal(pendingPoisonedRows, 0);

    // Retry when sendButton becomes enabled -> Bob is invited cleanly
    sendDisabled = false;
    friendChecked = false;
    dlgOpen = true;
    await runInviteBatchAndSubmit(flowCtx, flowExtra);
    assert.equal(inviterRepo.getInvitedFriendIdsForGroup(retryGroupId).has('30001'), true);

    // 2. Concurrent >= 45 Inviter targets (10 profiles x 5 groups = 50) + Q2 closeBrowserOnFinish + real WorkspaceEventHub SSE digest
    const profileIds = Array.from({ length: 10 }, () => randomUUID());
    const groupIds = Array.from({ length: 5 }, (_, i) => String(770000 + i));
    inviterRepo.upsertGroups({
      items: groupIds.map((id, i) => ({ groupId: id, groupName: `Chaos-${i}` })),
    });

    const activeWorkers = new Set();
    const closedCounts = new Map();
    let prematureCloses = 0;
    let totalTargetsAttempted = 0;
    let skippedBadGroups = 0;
    let healthyInvitesDone = 0;

    const fe = new FeatureExecutionRegistry();
    const svc = new GroupInviterService(inviterRepo, {
      isAvailable: () => true,
      isProfileReady: () => true,
      isProfileBusy: async () => false,
      inviteForGroup: async (pid, group, _cap, cb) => {
        activeWorkers.add(pid);
        try {
          totalTargetsAttempted++;
          await sleep(8);
          if (Number(group.groupId) % 3 === 0) {
            skippedBadGroups++;
            throw new ProductError(
              'GROUP_INVITER_SEND_BUTTON_UNAVAILABLE',
              '跳过：邀请发送按钮不可用，未发送',
              409,
            );
          }
          healthyInvitesDone++;
          await cb.addSessionInvited(pid, 1);
        } finally {
          activeWorkers.delete(pid);
        }
      },
    });
    svc.setWorkboard(workboard);
    svc.setFeatureExecutionRegistry(fe);
    fe.register({
      id: 'group-inviter',
      label: '小组邀请',
      isProfileRunning: (pid) => svc.isProfileRunning(pid),
      hasActiveExecution: () => svc.hasActiveExecution(),
      stopProfiles: (pids) => svc.stop(pids),
    });
    svc.setProfileLifecycle({
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
        if (activeWorkers.has(id) || workboard.hasCarrierPermit('browser', id)) prematureCloses++;
        closedCounts.set(id, (closedCounts.get(id) ?? 0) + 1);
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
    });

    const hub = new WorkspaceEventHub({ coalesceMs: 0, keepaliveMs: 0 });
    const sseEvents = [];
    hub.attach({
      closed: false,
      write: (chunk) => {
        if (chunk.includes('event: invalidate')) sseEvents.push(chunk);
        return true;
      },
      end: () => {},
      onClose: () => {},
    });
    hub.startDigestMonitor(async () => {
      const st = await svc.state();
      const s = st.lastRunSummary;
      return {
        'group-inviter': `${st.running}:${st.runId ?? ''}:${st.finishedAt ?? ''}:${st.statusText}:${s ? s.invitedTotal : ''}`,
      };
    }, 15);
    await sleep(30); // capture initial baseline

    await svc.start({
      profileIds,
      groupIds,
      invitesPerGroup: 10,
      maxConcurrentProfiles: 5,
      closeBrowserOnFinish: true,
    });
    const deadline = Date.now() + 90_000;
    while (svc.hasActiveExecution() && Date.now() < deadline) {
      await sleep(20);
    }
    await sleep(60);
    hub.close();

    assert.equal(svc.hasActiveExecution(), false);
    const finalInviterState = await svc.state();
    assert.ok(totalTargetsAttempted >= 45, `Expected >=45 targets, got ${totalTargetsAttempted}`);
    assert.equal(finalInviterState.lastRunSummary?.groupResults.length, 50);
    assert.equal(finalInviterState.lastRunSummary?.failedProfiles.length, 0);
    assert.equal(prematureCloses, 0);
    assert.equal(
      profileIds.filter((id) => closedCounts.get(id) !== 1).length,
      0,
      'Every profile must close atomically once',
    );
    assert.ok(
      sseEvents.length >= 2,
      `Expected >=2 SSE digest transitions, got ${sseEvents.length}`,
    );
    assert.ok(sseEvents.every((e) => e.includes('"group-inviter"')));

    // 3. Multi-monitor Window Layout concurrent auto-tile placements (0 geometric overlaps + failedProfiles)
    const displays = [
      {
        id: 'd1',
        primary: true,
        scaleFactor: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      },
      {
        id: 'd2',
        primary: false,
        scaleFactor: 1,
        workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
      },
    ];
    const layoutIds = Array.from({ length: 10 }, () => randomUUID());
    const windows = new Map(
      layoutIds.map((id, i) => [
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
          rect: { x: 10, y: 10, width: 900, height: 700 },
        },
      ]),
    );
    let failIds = new Set();
    let layoutSettings = {
      ...defaultWindowLayout,
      enabled: true,
      mode: 'tile',
      tileGap: 8,
      tileDisplays: [
        { displayId: 'd1', enabled: true, rows: 2, cols: 3, startSlot: 1 },
        { displayId: 'd2', enabled: true, rows: 2, cols: 3, startSlot: 1 },
      ],
    };
    const layoutSvc = new WindowLayoutService(
      () => displays,
      {
        read: async (id) => structuredClone(windows.get(id)),
        move: async (id, expected, rect) => {
          if (failIds.has(id)) throw new Error('WINDOW_MINIMIZED');
          const next = { ...expected, rect: { ...rect } };
          windows.set(id, next);
          return structuredClone(next);
        },
      },
      async () => layoutSettings,
      async (next) => {
        layoutSettings = next;
      },
    );
    await Promise.all(layoutIds.map((id) => layoutSvc.arrange(id)));
    const placedRects = layoutIds.map((id) => windows.get(id).rect);
    let overlapCount = 0;
    for (let i = 0; i < placedRects.length; i++) {
      for (let j = i + 1; j < placedRects.length; j++) {
        if (rectsOverlap(placedRects[i], placedRects[j])) overlapCount++;
      }
    }
    assert.equal(overlapCount, 0);

    failIds = new Set([layoutIds[2], layoutIds[7]]);
    const applySnap = await layoutSvc.command({
      action: 'apply',
      profileIds: layoutIds,
      mode: 'tile',
    });
    assert.equal(applySnap.movedCount, 8);
    assert.equal(applySnap.failedProfiles.length, 2);

    // 4. DataCleanupService.preview/execute with task_steps=0
    const bumperRepo = new SqliteGroupBumperRepository(rawDb);
    const oldTs = Date.now() - 10 * 86400_000;
    const settledOpId = randomUUID();
    const epoch = randomUUID();
    bumperRepo.prepareOperation({
      binding: {
        operationId: settledOpId,
        profileId: profileIds[0],
        accountId: '10001',
        connectionEpoch: epoch,
        leaseId: randomUUID(),
        generation: 1,
        jobId: randomUUID(),
        stepId: randomUUID(),
        actionDigest: sha256({ settledOpId }),
      },
      runId: randomUUID(),
      actionKind: 'submit_like',
      groupId: groupIds[0],
      groupName: 'Chaos-0',
      pageId: '6150001',
      pageName: 'Page-1',
      postId: '9001',
      postUrl: `https://www.facebook.com/groups/${groupIds[0]}/posts/9001/`,
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
      evidenceDigest: sha256({ r: 1 }),
    });
    bumperRepo.markOperationSettled(settledOpId);
    rawDb
      .prepare('UPDATE group_bumper_operations SET updated_at=? WHERE operation_id=?')
      .run(oldTs, settledOpId);
    rawDb
      .prepare(
        "INSERT INTO post_bump_records(id, record_type, carrier, status, profile_id, account_id, created_at) VALUES(?, 'group_bump', 'browser', 'success', ?, '10001', ?)",
      )
      .run(randomUUID(), profileIds[0], oldTs);

    const cleanupSvc = new DataCleanupService(
      new SqliteDataCleanup(rawDb),
      { preview: async () => [], remove: async () => ({ deleted: 0, bytes: 0, protected: 0 }) },
      undefined,
      async () => {},
      () => {},
    );
    const cleanupPreview = await cleanupSvc.preview({
      kind: 'records',
      scope: { before: Date.now() - 86400_000 },
    });
    assert.equal(cleanupPreview.eligible, 2);
    const cleanupExec = await cleanupSvc.execute({ token: cleanupPreview.token, confirm: true });
    assert.equal(cleanupExec.deleted, 2);

    pendingPoisonedRows = rawDb
      .prepare("SELECT COUNT(*) AS n FROM group_inviter_logs WHERE confirmation='PENDING'")
      .get().n;
    const leakedPermits = workboard.browserPermits.used + workboard.bluestacksPermits.used;
    const fkErrors = rawDb.prepare('PRAGMA foreign_key_check').all().length;
    assert.equal(pendingPoisonedRows, 0);
    assert.equal(leakedPermits, 0);
    assert.equal(fkErrors, 0);

    console.log(
      JSON.stringify(
        {
          ok: true,
          wheelFallbacks,
          totalTargetsAttempted,
          healthyInvitesDone,
          skippedBadGroups,
          pendingPoisonedRows,
          prematureCloses,
          closedProfilesCount: closedCounts.size,
          leakedPermits,
          arrangedTileSlots: placedRects.length,
          tileOverlapCount: overlapCount,
          partialLayoutFailedCount: applySnap.failedProfiles.length,
          sseInviterTransitions: sseEvents.length,
          cleanupZeroStepEligible: cleanupPreview.eligible,
          cleanupZeroStepDeleted: cleanupExec.deleted,
          fkErrors,
        },
        null,
        2,
      ),
    );
  } finally {
    rawDb.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
