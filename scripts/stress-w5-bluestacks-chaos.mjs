import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { BluestacksService } from '../dist/src/application/bluestacks-service.js';
import { resolvePatrolCap } from '../dist/src/application/bluestacks/bs-patrols.js';
import { Workboard } from '../dist/src/application/workboard.js';
import {
  applyLikeOrReaction,
  submitCommentOnActionBar,
} from '../dist/src/infrastructure/bluestacks-bumper-runner.js';
import { BluestacksGroupPosterRunner } from '../dist/src/infrastructure/bluestacks-poster-runner.js';
import { deterministicBluestacksId } from '../dist/src/infrastructure/bluestacks-store.js';
import { parseLiteXml } from '../dist/src/infrastructure/bluestacks-vision.js';
import { WorkspaceStore } from '../dist/src/infrastructure/workspace-store.js';
import { BumperSettings } from '../dist/src/shared/group-bumper.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (x1, y1, x2, y2) => ({
  x1,
  y1,
  x2,
  y2,
  w: x2 - x1,
  h: y2 - y1,
  cx: Math.round((x1 + x2) / 2),
  cy: Math.round((y1 + y2) / 2),
});

function mkPng(draw) {
  const c = createCanvas(900, 1600);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 1600);
  draw?.(ctx);
  return c.toBuffer('image/png');
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w5-chaos-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  const wb = new Workboard({ bluestacksConcurrency: 6 });

  try {
    const mediaFile = path.join(dir, 'chaos-img.jpg');
    await writeFile(mediaFile, Buffer.from('chaos-jpg'));

    // Prepare 30 BS instances
    const keys = Array.from({ length: 30 }, (_, i) => `Pie64_chaos_${i}`);
    const ids = keys.map((k) => deterministicBluestacksId(k));
    store.bluestacks.upsertDiscoveredInstances(
      keys.map((k, i) => ({
        instanceKey: k,
        displayName: `Chaos-${i}`,
        adbPort: 5600 + i,
        fbWidth: 900,
        fbHeight: 1600,
        online: i % 2 === 0,
        fbLiteInstalled: i < 5 ? false : true,
      })),
    );
    for (let i = 5; i < 30; i++) {
      store.bluestacks.saveInspectionResult({
        id: ids[i],
        fbLiteInstalled: true,
        accountState: 'logged-in',
        accountId: String(10005000 + i),
        accountName: `Chaos User ${i}`,
      });
    }
    store.groupBumper.upsertTargets('groups', {
      items: [{ id: '900100100', name: 'Chaos Group', folderId: null }],
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '800100100', name: 'Chaos Page', folderId: null }],
    });
    store.groupPoster.saveMaterials({
      items: [
        {
          id: 'chaos-mat',
          caption: 'Chaos Post',
          mediaSource: mediaFile,
          selected: true,
        },
      ],
    });

    // 1. Null XML poster crashes across 30 concurrent instances -> 0 false-success, 100% media cleaned
    const composerXml = parseLiteXml(
      `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]"><node index="0" text="" resource-id="" class="com.facebook.primitive.textinput.TextInputView" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="true" focused="true" scrollable="false" bounds="[40,220][860,460]" /><node index="1" text="发布" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="发布" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[720,60][880,120]" /><node index="2" text="照片/视频" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="照片/视频" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[20,700][880,770]" /></node></hierarchy>`,
      900,
      1600,
    );
    const galleryXml = parseLiteXml(
      `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]"><node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="photo" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[300,200][560,460]" /><node index="1" text="下一步" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="下一步" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[700,60][880,120]" /></node></hierarchy>`,
      900,
      1600,
    );
    const bluePng = mkPng((c) => {
      c.fillStyle = '#1877f2';
      c.fillRect(720, 60, 160, 60);
    });
    const pushedSet = new Set();
    let posterFalseSuccess = 0;
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    Date.now = () => (fakeNow += 3200);
    try {
      await Promise.all(
        ids.map(async (instId, idx) => {
          const inst = store.bluestacks.getInstance(instId);
          let submitted = false;
          let inGal = false;
          const dev = {
            ensureReadyAndLoggedIn: async () => inst,
            openDeepLink: async () => {
              submitted = false;
              inGal = false;
            },
            detectAbnormalScreen: async () => null,
            dumpXml: async () => (inGal ? galleryXml : !submitted ? composerXml : null),
            screencap: async () => bluePng,
            tap900: async (_s, x, y) => {
              if (y >= 690 && y <= 780) inGal = true;
              else if (inGal && x >= 690 && y <= 140) inGal = false;
              else if (!inGal && x >= 700 && y <= 140) submitted = true;
            },
            swipe900: async () => {},
            keyevent: async () => {},
            pasteIntoFocused: async () => {},
            pushMediaToGallery: async () => {
              const p = `/sdcard/Pictures/Workbench/wb_chaos_${idx}.jpg`;
              pushedSet.add(p);
              return p;
            },
            cleanupPushedMedia: async (_s, paths) => {
              for (const p of paths) pushedSet.delete(p);
            },
          };
          const ocr = {
            recognizeBounds: async (_png, b) => {
              if (b.y1 >= 680 && b.y2 <= 780) return '照片/视频';
              if (b.y1 <= 130 && b.x1 >= 680) return inGal ? '下一步' : '发布';
              return '';
            },
            close: () => {},
          };
          const runner = new BluestacksGroupPosterRunner(dev, ocr, {
            recordPost: () => {
              posterFalseSuccess++;
              return true;
            },
          });
          const out = await runner.run(
            instId,
            [
              {
                id: 'chaos-mat',
                caption: 'Chaos',
                mediaSource: mediaFile,
                localFilePath: mediaFile,
                mediaKind: 'image',
                background: 'plain',
                cacheStatus: 'ready',
                cacheError: null,
                selected: true,
                usedCount: 0,
                sortOrder: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
            [
              {
                id: '900100100',
                name: 'Chaos Group',
                avatarUrl: null,
                folderId: null,
                sortOrder: 0,
                totalBumpedCount: 0,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
            { maxGroupsPerInstance: 1, postToTimeline: false },
            new AbortController().signal,
            { status: () => {}, posted: () => {} },
          );
          if (out.posted > 0) posterFalseSuccess++;
        }),
      );
    } finally {
      Date.now = realDateNow;
    }
    assert.equal(posterFalseSuccess, 0, 'Null XML poster crashes must produce 0 false-success');
    assert.equal(pushedSet.size, 0, 'All pushed /sdcard/ media must be cleaned in finally');

    // 2. Occluded comment box across 30 trials -> 0 fake-success, and Long-press reaction -> 0 self-unlike
    const commentXml = parseLiteXml(
      `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]"><node index="0" text="" resource-id="" class="com.facebook.primitive.textinput.TextInputView" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="true" focused="true" scrollable="false" bounds="[20,1440][760,1520]" /><node index="1" text="发送" resource-id="send" class="android.view.View" package="com.facebook.lite" content-desc="发送" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[780,1440][880,1520]" /></node></hierarchy>`,
      900,
      1600,
    );
    const popupXml = parseLiteXml(
      `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]">${[
        'like',
        'love',
        'care',
        'haha',
        'wow',
        'sad',
        'angry',
      ]
        .map(
          (r, i) =>
            `<node index="${i}" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="${r}" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[${20 + i * 120},660][${120 + i * 120},760]" />`,
        )
        .join('')}</node></hierarchy>`,
      900,
      1600,
    );
    const likeBounds = rect(10, 800, 295, 860);
    const activeLikePng = mkPng((c) => {
      c.fillStyle = '#e0245e';
      c.fillRect(likeBounds.cx - 12, likeBounds.cy - 12, 24, 24);
    });
    const whitePng = mkPng();
    let commentFakeSuccess = 0;
    let selfUnlikeCount = 0;

    await Promise.all(
      Array.from({ length: 30 }, async (_, idx) => {
        const occludedOps = {
          serial: `s-${idx}`,
          sw: 900,
          sh: 1600,
          guard: () => {},
          wait: async () => {},
          xml: async () => (idx % 2 === 0 ? null : commentXml),
          png: async () => whitePng,
          capture: async () => ({ xml: idx % 2 === 0 ? null : commentXml, png: whitePng }),
          tap: async () => {},
          paste: async () => {},
          back: async () => {},
          ocr: async () => '',
        };
        if (await submitCommentOnActionBar(occludedOps, rect(305, 800, 595, 860), 'Amen')) {
          commentFakeSuccess++;
        }
        let active = false;
        const reactOps = {
          serial: `r-${idx}`,
          sw: 900,
          sh: 1600,
          guard: () => {},
          wait: async () => {},
          xml: async () => popupXml,
          png: async () => (active ? activeLikePng : whitePng),
          capture: async () => ({ xml: popupXml, png: active ? activeLikePng : whitePng }),
          tap: async (_x, y) => {
            if (y >= 660 && y <= 760) active = true;
          },
          swipe: async () => {},
          back: async () => {},
          tapLike: async () => {
            selfUnlikeCount++;
            return { ok: false, afterPng: whitePng };
          },
          ocr: async () => '',
        };
        const ok = await applyLikeOrReaction(
          reactOps,
          likeBounds,
          BumperSettings.parse({ useLongPressReaction: true, reactionTypes: ['love'] }),
        );
        if (!ok || !active) selfUnlikeCount++;
      }),
    );
    assert.equal(commentFakeSuccess, 0);
    assert.equal(selfUnlikeCount, 0);

    // 3. 30-instance concurrency chaos: apk-missing patrols, Workboard.bluestacksPermits strict cap (6), 0 overwrites, 0 leaked permits, & closeWindowOnFinish queue drain
    let maxObservedPermits = 0;
    let currentRunning = 0;
    let maxConcurrentLaunch = 0;
    const closedSet = new Set();
    const origAcquire = wb.acquireCarrierPermit.bind(wb);
    wb.acquireCarrierPermit = async (kind, cid, sig) => {
      const rel = await origAcquire(kind, cid, sig);
      maxObservedPermits = Math.max(maxObservedPermits, wb.bluestacksPermits.used);
      return rel;
    };

    const service = new BluestacksService(
      store.bluestacks,
      {
        getOnlineKeys: () => new Set(keys.filter((_, i) => i % 2 === 0)),
        discoverInstances: async () => ({
          instances: store.bluestacks.listInstances(keys.filter((_, i) => i % 2 === 0)),
          config: {
            installDir: null,
            confPath: null,
            detectedInstallDir: null,
            detectedConfPath: null,
            adbReady: true,
            playerReady: true,
          },
        }),
        launchInstance: async (id) => {
          const idx = ids.indexOf(id);
          if (idx === 1) throw new Error('FAULT_INJECTED_LAUNCH_FAIL');
          return store.bluestacks.getInstance(id);
        },
        closeInstance: async (id) => {
          await sleep(5);
          closedSet.add(id);
        },
        inspectAccount: async (id) => store.bluestacks.getInstance(id),
        probeFbLiteInstalled: async (serial) => {
          const port = Number(serial.split(':')[1] ?? 5600);
          return port - 5600 >= 5;
        },
      },
      {
        run: async () => {
          currentRunning++;
          maxConcurrentLaunch = Math.max(maxConcurrentLaunch, currentRunning);
          await sleep(12);
          currentRunning--;
        },
      },
      undefined,
      {
        activeRunner: {
          run: async () => {
            await sleep(10);
            return {
              completedSteps: 1,
              skippedSteps: 0,
              likes: 0,
              acceptedFriends: 0,
              published: 0,
              notes: [],
            };
          },
        },
        posterRunner: {
          run: async () => {
            await sleep(10);
            return { posted: 1, skipped: 0, notes: [] };
          },
        },
        listPosterMaterials: () => store.groupPoster.materials(),
      },
    );
    service.setWorkboard(wb);

    assert.equal(resolvePatrolCap({ workboard: wb }, 25), 6);

    // Run batch health check across first 10 instances (0..4 apk-missing, 1 faulted launch)
    await service.startHealthCheck({
      instanceIds: ids.slice(0, 10),
      maxConcurrency: 10,
      autoLaunch: true,
      autoInstallApk: false,
      closeOnFinish: true,
    });
    for (let i = 0; i < 100 && (await service.state(false)).healthCheck?.running; i++) {
      await sleep(15);
    }
    const hcState = (await service.state(false)).healthCheck;
    assert.ok(hcState);
    assert.equal(
      hcState.missingApp,
      4,
      'Online/launched instances 0,2,3,4 must classify as missing-app',
    );
    assert.equal(
      hcState.launchFailed,
      1,
      'Instance 1 launch error must classify as launch-failed without leaking permit',
    );
    assert.equal(wb.bluestacksPermits.used, 0, '0 leaked permits after patrol fault injection');

    // Race 20 concurrent bumper instances (closeWindowOnFinish=true) + overlapping scheduled steps + sheets runs
    closedSet.clear();
    await service.startBumper({
      profileIds: ids.slice(5, 25),
      groupIds: ['900100100'],
      pageIds: ['800100100'],
      closeWindowOnFinish: true,
    });
    const concurrentChaosResults = await Promise.all([
      ...ids.slice(5, 15).map((id) =>
        service.runScheduledActiveStep({
          instanceId: id,
          quickStep: { type: 'marketplace', durationMinutes: 1 },
          onProgress: () => {},
        }),
      ),
      ...ids.slice(25, 30).map((id) =>
        service.runScheduledHealthCheckStep({
          instanceId: id,
          autoInstallApk: false,
          onProgress: () => {},
        }),
      ),
    ]);
    for (let i = 0; i < 400; i++) {
      const st = await service.state(false);
      if (!st.running && !st.activeRunning && st.closingIds.length === 0) break;
      await sleep(25);
    }
    assert.ok(maxObservedPermits <= 6, `Permits exceeded cap: ${maxObservedPermits}`);
    assert.ok(maxConcurrentLaunch <= 6, `Concurrent runners exceeded cap: ${maxConcurrentLaunch}`);
    assert.equal(wb.bluestacksPermits.used, 0, '0 leaked permits after 30-instance chaos');
    assert.equal(
      closedSet.size,
      20,
      'All 20 closeWindowOnFinish bumper instances closed after queue drain',
    );
    assert.equal(concurrentChaosResults.length, 15);

    console.log(
      JSON.stringify({
        ok: true,
        instancesSimulated: 30,
        posterFalseSuccess,
        leakedMediaCount: pushedSet.size,
        commentFakeSuccess,
        selfUnlikeCount,
        patrolMissingApp: hcState.missingApp,
        patrolLaunchFailed: hcState.launchFailed,
        maxObservedPermits,
        leakedPermits: wb.bluestacksPermits.used,
        closedOnDrain: closedSet.size,
      }),
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
