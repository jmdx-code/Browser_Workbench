import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GroupBumperService } from '../dist/src/application/group-bumper-service.js';
import {
  GroupPosterService,
  PosterAccountRestrictedError,
} from '../dist/src/application/group-poster-service.js';
import { Workboard } from '../dist/src/application/workboard.js';
import { inspectPosterGraphQLResponse } from '../dist/src/infrastructure/group-poster-runner/poster-network.js';
import { waitMediaAndSubmitPost } from '../dist/src/infrastructure/group-poster-runner/poster-publish.js';
import { SqlitePostBumpRecordsRepository } from '../dist/src/infrastructure/post-bump-records-store.js';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { BumperSettings } from '../dist/src/shared/group-bumper.js';
import {
  createRelativePostAge,
  relativePostAge,
  stripAnsi,
} from '../dist/src/shared/relative-post-age.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ANSI_RX = /[\u001b\u009b]/;

const mkBinding = (profileId, accountId, operationId = randomUUID()) => ({
  profileId,
  accountId,
  connectionEpoch: randomUUID(),
  leaseId: randomUUID(),
  generation: 1,
  operationId,
  jobId: randomUUID(),
  stepId: randomUUID(),
  actionDigest: sha256({ operationId, profileId }),
});

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w3-chaos-'));
  const dbPath = path.join(dir, 'workspace.sqlite');
  let store = await WorkspaceStore.open(dbPath);
  const workboard = new Workboard({ browserConcurrency: 12, bluestacksConcurrency: 6 });

  try {
    const profileIds = Array.from({ length: 8 }, () => randomUUID());
    const groupIds = Array.from({ length: 28 }, (_, i) => String(8000000000 + i));
    const pageIds = Array.from({ length: 28 }, (_, i) => String(6150000000 + i));

    store.groupPoster.upsertTargets({
      items: groupIds.map((id, i) => ({ id, name: `Chaos Group ${i}` })),
    });
    store.groupBumper.upsertTargets('groups', {
      items: groupIds.map((id, i) => ({ id, name: `Chaos Group ${i}` })),
    });
    store.groupBumper.upsertTargets('pages', {
      items: pageIds.map((id, i) => ({ id, name: `Chaos Page ${i}` })),
    });

    const materials = store.groupPoster.saveMaterials({
      items: [
        { id: 'chaos-mat-1', caption: 'Chaos Post 1 🔥', selected: true },
        { id: 'chaos-mat-2', caption: 'Chaos Post 2 🙏', selected: true },
      ],
    });
    assert.equal(materials.length, 2);

    // 1. 1,000 mixed CJK/EN/TH/VI/MY relativePostAge evaluations + self-contained createRelativePostAge()
    const now = new Date(2026, 10, 27, 16, 0, 0).getTime();
    const selfParser = new Function(`return (${createRelativePostAge.toString()})();`)();
    const samples = [
      ['3分钟前', true],
      ['3分鐘前', true],
      ['2小时前', true],
      ['1天前', true],
      ['30秒前', true],
      ['刚刚', true],
      ['今天 10:30', true],
      ['昨天', true],
      ['11月27日', true],
      ['4m', true],
      ['3 hrs', true],
      ['just now', true],
      ['Yesterday', true],
      ['5 นาทีที่แล้ว', true],
      ['เมื่อสักครู่', true],
      ['5 phút trước', true],
      ['vừa xong', true],
      ['၅ မိနစ်', true],
      ['ယခုလေးတင်', true],
      ['Sponsored', false],
    ];
    let ageEvalCount = 0;
    for (let i = 0; i < 1000; i++) {
      const [token, expectValid] = samples[i % samples.length];
      const a = relativePostAge(token, now);
      const b = selfParser.relativePostAge(token, now);
      assert.equal(a, b, `self-contained parser mismatch on ${token}`);
      if (expectValid) assert.ok(typeof a === 'number' && Number.isFinite(a));
      else assert.equal(a, null);
      ageEvalCount++;
    }

    // 2. Concurrent Emoji + multi-line comment saves & rapid group/page scope switches
    const groupBatches = Array.from({ length: 12 }, (_, round) => [
      `G-${round}-🙏🔥`,
      `G-${round}-行1\n行2`,
      `G-${round}-收尾`,
    ]);
    const pageBatches = Array.from({ length: 12 }, (_, round) => [
      `P-${round}-✨`,
      `P-${round}-多行A\n多行B`,
    ]);
    for (let i = 0; i < 12; i++) {
      const gSaved = store.groupBumper.saveComments(
        { texts: groupBatches[i], scope: 'group' },
        'group',
      );
      const pSaved = store.groupBumper.saveComments(
        { texts: pageBatches[i], scope: 'page' },
        'page',
      );
      assert.deepEqual(
        gSaved.map((c) => c.text),
        groupBatches[i],
      );
      assert.deepEqual(
        pSaved.map((c) => c.text),
        pageBatches[i],
      );
      for (let k = 1; k < gSaved.length; k++) {
        assert.ok(
          gSaved[k - 1].createdAt < gSaved[k].createdAt,
          'monotonic group comment timestamps',
        );
      }
      assert.ok(gSaved.every((c) => c.scope === 'group'));
      assert.ok(pSaved.every((c) => c.scope === 'page'));
    }
    const finalGroupComments = store.groupBumper.comments('group').map((c) => c.text);
    const finalPageComments = store.groupBumper.comments('page').map((c) => c.text);
    assert.deepEqual(finalGroupComments, groupBatches.at(-1));
    assert.deepEqual(finalPageComments, pageBatches.at(-1));
    assert.equal(
      finalGroupComments.some((t) => t.startsWith('P-')),
      false,
    );
    assert.equal(
      finalPageComments.some((t) => t.startsWith('G-')),
      false,
    );

    // 3. GraphQL code 368/613 + ANSI-tainted error reasons + duplicate failure suppression + PENDING_REVIEW vs late pfbid0...
    const rawInspectDb = new DatabaseSync(dbPath);
    const recordsRepo = new SqlitePostBumpRecordsRepository(rawInspectDb);
    const faultOps = [];
    for (let i = 0; i < 10; i++) {
      const code = i % 2 === 0 ? 368 : 613;
      const body =
        'for (;;);' +
        JSON.stringify({
          errors: [
            {
              code,
              summary: code === 368 ? 'Temporarily Blocked' : 'Rate Limit',
              description: `\x1B[31mFault-${i}\x1B[0m \x1B]8;;https://fb.com\x07details\x1B]8;;\x07`,
            },
          ],
        });
      const ins = inspectPosterGraphQLResponse(body);
      assert.equal(ins.hasStoryCreate, false);
      assert.equal(ins.restricted, true);
      assert.equal(ins.primaryError?.code, code);
      assert.equal(ANSI_RX.test(ins.primaryError?.message ?? ''), false);

      const opId = randomUUID();
      const pid = profileIds[i % profileIds.length];
      // Insert same failed operationId 3 times -> must suppress duplicates to 1 row
      for (let retry = 0; retry < 3; retry++) {
        recordsRepo.insert({
          recordType: 'post',
          carrier: 'browser',
          status: 'failed',
          profileId: pid,
          accountId: `10000${i}`,
          groupId: groupIds[i],
          sourceLogId: opId,
          errorReason: `\x1B[31m[${code}] ${ins.primaryError?.message}\x1B[0m`,
        });
      }
      faultOps.push(opId);
    }
    const failedTotalAfterDupes = recordsRepo.list({ status: 'failed' }).total;
    assert.equal(failedTotalAfterDupes, 10, 'Duplicate failed rows must be suppressed');
    const failedRows = recordsRepo.list({ status: 'failed', limit: 100 }).records;
    assert.ok(failedRows.every((r) => !ANSI_RX.test(r.errorReason)));

    // 4. Ambiguous close + late pfbid0... DOM read-back vs real PENDING_REVIEW (not_applied & confirmed)
    const latePid = profileIds[0];
    const lateBinding = mkBinding(latePid, '100099');
    let latePostedId = '';
    let domReads = 0;
    const lateMockPage = {
      url: () => `https://www.facebook.com/groups/${groupIds[15]}/`,
      on: () => {},
      off: () => {},
      evaluate: async (fn) => {
        const s = String(fn);
        if (s.includes('data-wb-poster-next')) return { kind: 'post', label: 'Post' };
        if (s.includes('restrictedDialog')) return { hasComposer: false, restrictedDialog: false };
        if (s.includes('candidates')) {
          domReads++;
          return {
            candidates: [
              { postId: 'pfbid0ChaosLateReadback1234', authorMatched: true, timeTexts: ['刚刚'] },
            ],
            transcoding: false,
          };
        }
        return [];
      },
      locator: () => ({
        first: () => ({ evaluate: async () => {}, click: async () => {} }),
      }),
    };
    await waitMediaAndSubmitPost({
      profileId: latePid,
      getPage: () => lateMockPage,
      getConn: () => ({
        context: async () => lateBinding,
        execute: async (_b, fn) => ({ value: await fn() }),
        reconcile: async () => {},
      }),
      peer: {
        profileId: latePid,
        epoch: lateBinding.connectionEpoch,
        online: true,
        synced: true,
        phase: 'PAUSED',
      },
      kernel: {},
      core: undefined,
      accountId: '100099',
      accountName: 'Late Readback Acc',
      jobId: lateBinding.jobId,
      stepId: lateBinding.stepId,
      effectiveGroupId: groupIds[15],
      effectiveGroupName: 'Chaos Group 15',
      isPageTimeline: false,
      groupAvatarUrl: null,
      resolvedGroupAvatar: null,
      surface: {
        visible: true,
        ready: true,
        restricted: false,
        blockingDialog: false,
        groupIds: [groupIds[15]],
        posts: [],
        avatarUrl: null,
      },
      material: materials[0],
      identityMeta: { identityType: 'personal', accountAvatar: null },
      paceScale: 0,
      posterRepo: store.groupPoster,
      callbacks: {
        runId: randomUUID(),
        cancelled: () => false,
        status: () => {},
        onTaskPosted: async (log) => {
          latePostedId = log.postId;
          store.groupPoster.recordPost(log);
        },
      },
      markedPendingReviewRef: { value: false },
      guard: () => {},
      assertIdentity: async () => {},
      execOp: async (_label, work) => work(),
      stopProfile: async () => {},
      reconnectAfterUncertainOp: async () => {},
    });
    assert.equal(latePostedId, 'pfbid0ChaosLateReadback1234');
    assert.ok(domReads >= 1);

    // Pending review operations: 2 poster + 2 bumper -> 1 not_applied, 1 confirmed each
    const pRev1 = mkBinding(profileIds[1], '100001');
    const pRev2 = mkBinding(profileIds[2], '100002');
    store.groupPoster.prepareOperation({
      binding: pRev1,
      runId: randomUUID(),
      actionKind: 'submit_post',
      groupId: groupIds[16],
      groupName: 'Chaos Group 16',
      materialId: materials[0].id,
    });
    store.groupPoster.markOperationReview(pRev1.operationId, '\x1B[31mPoster Review 1\x1B[0m');
    store.groupPoster.prepareOperation({
      binding: pRev2,
      runId: randomUUID(),
      actionKind: 'submit_post',
      groupId: groupIds[17],
      groupName: 'Chaos Group 17',
      materialId: materials[0].id,
      postId: 'pfbid0Confirmed17',
      postUrl: `https://www.facebook.com/groups/${groupIds[17]}/posts/pfbid0Confirmed17/`,
    });
    store.groupPoster.markOperationReview(pRev2.operationId, '\x1B[33mPoster Review 2\x1B[0m');
    assert.ok(
      store.groupPoster.pendingReviewOperations().every((o) => !ANSI_RX.test(o.reason ?? '')),
    );

    store.groupPoster.resolvePendingOperation({
      operationId: pRev1.operationId,
      resolution: 'not_applied',
    });
    store.groupPoster.resolvePendingOperation({
      operationId: pRev2.operationId,
      resolution: 'confirmed',
    });
    assert.equal(store.groupPoster.hasGroupPostedMaterial(groupIds[16], materials[0].id), false);
    assert.equal(store.groupPoster.hasGroupPostedMaterial(groupIds[17], materials[0].id), true);

    const bRev1 = mkBinding(profileIds[3], '100003');
    const bRev2 = mkBinding(profileIds[4], '100004');
    const bRun = randomUUID();
    store.groupBumper.prepareOperation({
      binding: bRev1,
      runId: bRun,
      actionKind: 'submit_comment',
      groupId: groupIds[18],
      groupName: 'Chaos Group 18',
      pageId: pageIds[0],
      pageName: 'Chaos Page 0',
      postId: '99110018',
      postUrl: `https://www.facebook.com/groups/${groupIds[18]}/posts/99110018/`,
      commentText: 'Check comment',
      status: 'PREPARED',
      reason: '',
      resolution: null,
    });
    store.groupBumper.markOperationReview(bRev1.operationId, '\x1B[31mBumper Review 1\x1B[0m');
    store.groupBumper.prepareOperation({
      binding: bRev2,
      runId: bRun,
      actionKind: 'submit_like',
      groupId: groupIds[19],
      groupName: 'Chaos Group 19',
      pageId: pageIds[1],
      pageName: 'Chaos Page 1',
      postId: '99110019',
      postUrl: `https://www.facebook.com/groups/${groupIds[19]}/posts/99110019/`,
      status: 'PREPARED',
      reason: '',
      resolution: null,
    });
    store.groupBumper.markOperationReview(bRev2.operationId, '\x1B[33mBumper Review 2\x1B[0m');
    assert.ok(
      store.groupBumper.pendingReviewOperations().every((o) => !ANSI_RX.test(o.reason ?? '')),
    );

    store.groupBumper.resolvePendingOperation({
      operationId: bRev1.operationId,
      resolution: 'not_applied',
    });
    store.groupBumper.resolvePendingOperation({
      operationId: bRev2.operationId,
      resolution: 'confirmed',
    });
    assert.equal(
      store.groupBumper.eligibility('100003', profileIds[3], '99110018', Date.now(), 'group')
        .allowed,
      true,
    );
    assert.equal(
      store.groupBumper.eligibility('100004', profileIds[4], '99110019', Date.now(), 'group')
        .duplicate,
      true,
    );

    // 5. >= 40 concurrent Poster + Group/Page Bumper targets + Q2 closeBrowserOnFinish across multi-card Chrome profiles
    const posterProfiles = profileIds.slice(0, 4);
    const bumperProfiles = profileIds.slice(4, 8);
    const closedProfiles = new Map();
    let prematureCloses = 0;
    let posterTargetsDone = 0;
    let bumperTargetsDone = 0;
    let falseSuccessRecords = 0;

    const mkLifecycle = (hasPendingForProfile) => ({
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
        if (hasPendingForProfile(id)) prematureCloses++;
        closedProfiles.set(id, (closedProfiles.get(id) ?? 0) + 1);
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

    const posterPendingByProfile = new Map(posterProfiles.map((id) => [id, true]));
    const posterService = new GroupPosterService(
      store.groupPoster,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        runProfileWorker: async (pid, _files, _settings, cb) => {
          try {
            while (true) {
              const item = await cb.claimNextTask();
              if (!item) break;
              await sleep(5);
              const idx = Number(item.group.id.slice(-2));
              if (idx === 12) {
                // Fault injection: restricted 368 must NOT emit success record
                cb.onTargetError(item.group.id, '\x1B[31m[368] Restricted\x1B[0m');
                throw new PosterAccountRestrictedError('受限 · 368');
              }
              posterTargetsDone++;
              await cb.onTaskPosted({
                id: randomUUID(),
                profileId: pid,
                accountId: `100${posterProfiles.indexOf(pid)}`,
                accountName: `Chrome-${posterProfiles.indexOf(pid)}`,
                accountAvatar: null,
                identityType: 'personal',
                groupId: item.group.id,
                groupName: item.group.name,
                groupAvatar: null,
                materialId: item.material.id,
                captionPreview: item.material.caption,
                postId: `pfbid0Chaos${posterTargetsDone}`,
                postUrl: `https://www.facebook.com/groups/${item.group.id}/posts/pfbid0Chaos${posterTargetsDone}/`,
                postedAt: Date.now(),
              });
              if (!(await cb.canContinueAccount(pid))) break;
            }
          } finally {
            posterPendingByProfile.set(pid, false);
          }
        },
      },
      { prepare: async () => ({ localFilePath: 'C:\\tmp\\chaos.mp4', mediaKind: 'video' }) },
    );
    posterService.setWorkboard(workboard);
    posterService.setPostBumpRecords(recordsRepo);
    posterService.setProfileLifecycle(
      mkLifecycle((pid) => {
        const st = Reflect.get(posterService, 'runtime');
        return (
          st.taskQueue.some((it) => !it.allowedProfileIds || it.allowedProfileIds.has(pid)) ||
          posterPendingByProfile.get(pid) === true
        );
      }),
    );

    const bumperService = new GroupBumperService(
      store.groupBumper,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (pid, groups, pages, settings, cb) => {
          let localCount = 0;
          const groupSlice = groups[0]?.id === '-' ? groups : groups.slice(0, 4);
          const pageSlice = groups[0]?.id === '-' ? pages.slice(0, 6) : pages.slice(0, 3);
          for (const g of groupSlice) {
            for (const pg of pageSlice) {
              await sleep(4);
              localCount++;
              bumperTargetsDone++;
              const postId = String(9500000 + bumperTargetsDone);
              store.groupBumper.record({
                id: randomUUID(),
                profileId: pid,
                accountId: `200${bumperProfiles.indexOf(pid)}`,
                groupId: g.id,
                groupName: g.name,
                pageId: pg.id,
                pageName: pg.name,
                postId,
                postUrl:
                  g.id === '-'
                    ? `https://www.facebook.com/${pg.id}/posts/${postId}/`
                    : `https://www.facebook.com/groups/${g.id}/posts/${postId}/`,
                liked: true,
                commentText: 'Chaos 🙏🔥\n顶贴',
                bumpedAt: Date.now(),
                sourceMode: g.id === '-' ? 'page' : 'group',
              });
              cb.added(localCount);
              if (
                cb.shouldStopAfterCurrentPost?.() ||
                localCount >= settings.dailyMaxLikesPerAccount
              )
                return;
            }
          }
        },
      },
      async () => ({
        comments: store.groupBumper.comments('group'),
        total: store.groupBumper.total('group'),
      }),
      () => {},
      undefined,
      0,
    );
    bumperService.setWorkboard(workboard);
    bumperService.setPostBumpRecords(recordsRepo);
    bumperService.setProfileLifecycle(mkLifecycle(() => false));
    store.groupBumper.saveSettings(
      BumperSettings.parse({ dailyMaxLikesPerAccount: 10, closeBrowserOnFinish: true }),
    );
    store.groupBumper.savePageSettings(
      BumperSettings.parse({ dailyMaxLikesPerAccount: 10, closeBrowserOnFinish: true }),
    );

    // Launch 15 Poster group targets x 2 materials = 30 poster items + >=30 Group/Page bumper targets concurrently!
    const posterBatchTargets = groupIds.slice(0, 15);
    await Promise.all([
      posterService.createBatchTasks({
        materialIds: ['chaos-mat-1', 'chaos-mat-2'],
        groupIds: posterBatchTargets,
        accountMode: 'selected',
        profileIds: posterProfiles,
        closeBrowserOnFinish: true,
      }),
      bumperService.start({
        profileIds: bumperProfiles.slice(0, 2),
        groupIds: groupIds.slice(15, 22),
        pageIds: pageIds.slice(0, 4),
        closeBrowserOnFinish: true,
      }),
      bumperService.startPageBumper({
        profileIds: bumperProfiles.slice(2, 4),
        pageIds: pageIds.slice(4, 12),
        closeBrowserOnFinish: true,
      }),
    ]);

    const deadline = Date.now() + 15_000;
    while (
      (posterService.hasActiveExecution() || bumperService.hasActiveExecution()) &&
      Date.now() < deadline
    ) {
      await sleep(20);
    }
    assert.equal(posterService.hasActiveExecution(), false, 'Poster execution must finish');
    assert.equal(bumperService.hasActiveExecution(), false, 'Bumper execution must finish');

    // Group 12 restricted must have 0 success records
    const g12Success = recordsRepo
      .list({ recordType: 'post', status: 'success', groupQuery: groupIds[12], limit: 50 })
      .records.filter((r) => r.groupId === groupIds[12]);
    falseSuccessRecords = g12Success.length;
    assert.equal(falseSuccessRecords, 0, 'Restricted group 12 must have 0 false success records');

    const unclosedFinishedProfiles = profileIds.filter((id) => !closedProfiles.has(id)).length;
    const leakedPermits = workboard.browserPermits.used + workboard.bluestacksPermits.used;
    const fkErrors = rawInspectDb.prepare('PRAGMA foreign_key_check').all().length;
    rawInspectDb.close();

    const totalConcurrentTargets = posterTargetsDone + bumperTargetsDone;
    assert.ok(totalConcurrentTargets >= 40, `Expected >=40 targets, got ${totalConcurrentTargets}`);
    assert.equal(prematureCloses, 0, `prematureCloses=${prematureCloses}`);
    assert.equal(
      unclosedFinishedProfiles,
      0,
      `unclosedFinishedProfiles=${unclosedFinishedProfiles}`,
    );
    assert.equal(leakedPermits, 0, `leakedPermits=${leakedPermits}`);
    assert.equal(fkErrors, 0, `fkErrors=${fkErrors}`);

    const summary = {
      ok: true,
      totalConcurrentTargets,
      posterTargetsDone,
      bumperTargetsDone,
      ageEvalCount,
      failedTotalAfterDupes,
      falseSuccessRecords,
      prematureCloses,
      unclosedFinishedProfiles,
      closedProfilesCount: closedProfiles.size,
      leakedPermits,
      fkErrors,
      groupCommentsPreserved: finalGroupComments.length,
      pageCommentsPreserved: finalPageComments.length,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
