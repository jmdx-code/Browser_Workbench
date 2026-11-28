import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { BluestacksService } from '../src/application/bluestacks-service.js';
import {
  closeInstancesOp,
  launchInstancesOp,
  showInstanceOp,
} from '../src/application/bluestacks/bs-instance-ops.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { Workboard } from '../src/application/workboard.js';
import { BluestacksActiveRunner } from '../src/infrastructure/bluestacks-active-runner.js';
import { BluestacksGroupInviterRunner } from '../src/infrastructure/bluestacks-inviter-runner.js';
import {
  BluestacksGroupBumperRunner,
  executeBarActions,
  findCommentSendButtonNode,
  submitCommentWithReason,
} from '../src/infrastructure/bluestacks-bumper-runner.js';
import {
  extractGalleryGridTiles,
  type BluestacksDeviceManager,
  type ScreenOps,
} from '../src/infrastructure/bluestacks-device-manager.js';
import { extractActiveProfileNumericId } from '../src/infrastructure/bluestacks-device/device-identity-and-inspect.js';
import {
  createDeviceRuntimeContext,
  readLiveScreenSize,
} from '../src/infrastructure/bluestacks-device/device-runtime-and-adb.js';
import { isLoginOrLoggedOutXml } from '../src/infrastructure/bluestacks-device/device-ui-and-media.js';
import { BluestacksGroupPosterRunner } from '../src/infrastructure/bluestacks-poster-runner.js';
import { deterministicBluestacksId } from '../src/infrastructure/bluestacks-store.js';
import {
  extractActionBars,
  extractPostCards,
  isGalleryCameraTile,
  parseDumpsysTop,
  parseLiteXml,
  type RectBounds,
} from '../src/infrastructure/bluestacks-vision.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  isCompositePlaceholderBsAccountId,
  relativePostAge,
  resolveEffectiveBsAccountId,
  type BluestacksInstance,
} from '../src/shared/bluestacks.js';
import { devDiag } from '../src/shared/dev-diagnostics.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';
import type { PosterLog, PosterMaterial } from '../src/shared/group-poster.js';

const rect = (x1: number, y1: number, x2: number, y2: number): RectBounds => ({
  x1,
  y1,
  x2,
  y2,
  w: x2 - x1,
  h: y2 - y1,
  cx: Math.round((x1 + x2) / 2),
  cy: Math.round((y1 + y2) / 2),
});
const xmlDoc = (inner: string) =>
  parseLiteXml(
    `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]">${inner}</node></hierarchy>`,
    900,
    1600,
  );
const nodeXml = (
  i: number,
  text: string,
  bounds: string,
  opts: {
    cls?: string;
    click?: boolean;
    long?: boolean;
    focused?: boolean;
    rid?: string;
    desc?: string;
  } = {},
) =>
  `<node index="${i}" text="${text}" resource-id="${opts.rid ?? ''}" class="${opts.cls ?? 'android.view.View'}" package="com.facebook.lite" content-desc="${opts.desc ?? text}" clickable="${Boolean(opts.click)}" long-clickable="${Boolean(opts.long)}" focused="${Boolean(opts.focused)}" scrollable="false" bounds="${bounds}" />`;
const mkPng = (
  draw?: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void,
): Buffer => {
  const c = createCanvas(900, 1600);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 1600);
  draw?.(ctx);
  return c.toBuffer('image/png');
};
const mkInst = (key: string, overrides: Partial<BluestacksInstance> = {}): BluestacksInstance => ({
  id: deterministicBluestacksId(key),
  instanceKey: key,
  displayName: key,
  alias: null,
  folderId: null,
  sortOrder: 0,
  adbPort: 5565,
  serial: '127.0.0.1:5565',
  fbWidth: 900,
  fbHeight: 1600,
  online: true,
  fbLiteInstalled: true,
  accountState: 'logged-in',
  accountId: '100011223344',
  accountName: 'Grace Helper',
  numericAccountId: '100011223344',
  identityType: 'personal',
  managedIdentities: [],
  avatarUrl: null,
  lastStatus: null,
  updatedAt: Date.now(),
  fbLiteVersion: '524.0.0.7.106',
  ...overrides,
});
const grp = (id: string, name = `Group ${id}`): BumperTarget => ({
  id,
  name,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});
const mat = (id: string, overrides: Partial<PosterMaterial> = {}): PosterMaterial => ({
  id,
  caption: 'Blessings 2026',
  mediaSource: '',
  mediaKind: 'none',
  background: 'plain',
  aiLabel: 'default',
  localFilePath: null,
  hasThumbnail: false,
  cacheStatus: 'ready',
  cacheError: null,
  selected: true,
  usedCount: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test('W7 BUG-03/04/05: offline missing-app classification, closeWindowOnFinish ordering, launching 409, parallel close & fast deadlines', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w7-ops-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const k1 = 'Pie64_off_missing';
    const k2 = 'Pie64_close_race';
    const k3 = 'Pie64_close_p2';
    const id1 = deterministicBluestacksId(k1);
    const id2 = deterministicBluestacksId(k2);
    const id3 = deterministicBluestacksId(k3);
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: k1,
        displayName: 'p001',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: false,
        fbLiteInstalled: false,
      },
      {
        instanceKey: k2,
        displayName: 'p002',
        adbPort: 5566,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
      {
        instanceKey: k3,
        displayName: 'p003',
        adbPort: 5567,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    store.bluestacks.saveInspectionResult({
      id: id2,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '10002',
      accountName: 'User2',
    });

    const observedDuringClose: Array<{ running: boolean; status: string }> = [];
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((r) => {
      releaseClose = r;
    });
    const parallelCloseStarted: string[] = [];
    const svc = new BluestacksService(
      store.bluestacks,
      {
        getOnlineKeys: () => new Set([k2, k3]),
        discoverInstances: async () => ({
          instances: store.bluestacks.listInstances([k2, k3]),
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
          await new Promise((r) => setTimeout(r, 40));
          return store.bluestacks.getInstance(id)!;
        },
        closeInstance: async (id) => {
          parallelCloseStarted.push(id);
          if (id === id2) {
            const st = await svc.state(false);
            const entry = st.activeProfileCounts?.[id2];
            if (entry) observedDuringClose.push({ running: entry.running, status: entry.status });
            await closeGate;
          }
          await new Promise((r) => setTimeout(r, 25));
        },
        inspectAccount: async (id) => store.bluestacks.getInstance(id)!,
        showInstance: async () => true,
      },
      { run: async () => {} },
      new FeatureExecutionRegistry(),
      {
        activeRunner: {
          run: async () => ({
            completedSteps: 1,
            skippedSteps: 0,
            likes: 0,
            acceptedFriends: 0,
            published: 0,
            notes: [],
          }),
        },
      },
    );
    svc.setWorkboard(new Workboard({ bluestacksConcurrency: 3 }));

    // BUG-03: offline missing-app classifies as missing-app (not launch-failed)
    await svc.startHealthCheck({
      instanceIds: [id1],
      maxConcurrency: 1,
      autoLaunch: false,
      autoInstallApk: false,
      closeOnFinish: false,
    });
    for (let i = 0; i < 40 && (await svc.state(false)).healthCheck?.running; i++)
      await new Promise((r) => setTimeout(r, 10));
    const hc = (await svc.state(false)).healthCheck;
    assert.equal(hc?.missingApp, 1);
    assert.equal(hc?.launchFailed, 0);
    assert.equal(hc?.items[0]?.category, 'missing-app');

    // BUG-04: closeWindowOnFinish keeps status "正在关窗…" until closeInstance finishes, then "已关闭窗口"
    await svc.startActive({
      instanceIds: [id2],
      quickStep: { type: 'marketplace', durationMinutes: 1 },
      closeWindowOnFinish: true,
    });
    for (let i = 0; i < 40 && observedDuringClose.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(observedDuringClose.length, 1);
    assert.match(observedDuringClose[0]?.status ?? '', /正在关窗/);
    releaseClose();
    for (
      let i = 0;
      i < 40 && (await svc.state(false)).activeProfileCounts?.[id2]?.status.includes('正在关窗');
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const afterClose = (await svc.state(false)).activeProfileCounts?.[id2];
    assert.equal(afterClose?.running, false);
    assert.match(afterClose?.status ?? '', /已关闭窗口/);

    // BUG-04: showInstanceOp throws 409 BLUESTACKS_LAUNCHING while launching
    const ctx = (svc as unknown as { ctx: Parameters<typeof showInstanceOp>[0] }).ctx;
    await launchInstancesOp(ctx, { instanceIds: [id3] });
    await assert.rejects(
      () => showInstanceOp(ctx, { instanceId: id3 }),
      (err: unknown) =>
        (err as { code?: string; status?: number }).code === 'BLUESTACKS_LAUNCHING' &&
        (err as { status?: number }).status === 409,
    );
    await new Promise((r) => setTimeout(r, 70));

    // BUG-05: closeInstancesOp closes multiple instances in parallel + fast timeouts in win32 & lifecycle
    parallelCloseStarted.length = 0;
    const t0 = Date.now();
    await closeInstancesOp(ctx, { instanceIds: [id2, id3] });
    assert.deepEqual(new Set(parallelCloseStarted), new Set([id2, id3]));
    assert.ok(Date.now() - t0 < 200);
    const win32Src = readFileSync(
      path.join(process.cwd(), 'src/infrastructure/bluestacks-win32.ts'),
      'utf8',
    );
    assert.match(win32Src, /AddSeconds\(3\.5\)/);
    assert.match(win32Src, /AddSeconds\(6\)/);
    assert.match(win32Src, /TotalMilliseconds -ge 800/);
    const lifeSrc = readFileSync(
      path.join(process.cwd(), 'src/infrastructure/bluestacks-device/device-instance-lifecycle.ts'),
      'utf8',
    );
    assert.match(lifeSrc, /\['disconnect', existing\.serial\], \{ timeoutMs: 1500 \}/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 BUG-06: composite placeholder accountId helpers, SQLite sanitization, and FB Lite 488 moreBtn OCR fallback', async () => {
  assert.equal(isCompositePlaceholderBsAccountId('p023 (Mawi Lee)', 'p023'), true);
  assert.equal(isCompositePlaceholderBsAccountId('p023 (Mawi Lee)'), true);
  assert.equal(isCompositePlaceholderBsAccountId('蓝蝶 #1 (FB Lite)'), true);
  assert.equal(isCompositePlaceholderBsAccountId('100011223344', 'p023'), false);
  assert.equal(
    resolveEffectiveBsAccountId({
      id: 'uuid-1',
      accountId: 'p023 (Mawi Lee)',
      numericAccountId: '',
      displayName: 'p023',
    }),
    'uuid-1',
  );
  assert.equal(
    resolveEffectiveBsAccountId({
      id: 'uuid-1',
      accountId: 'p023 (Mawi Lee)',
      numericAccountId: '100099887766',
      displayName: 'p023',
    }),
    '100099887766',
  );

  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w7-id-'));
  const sqliteFile = path.join(dir, 'workspace.sqlite');
  const store1 = await WorkspaceStore.open(sqliteFile);
  const k = 'Pie64_p023';
  const id = deterministicBluestacksId(k);
  store1.bluestacks.upsertDiscoveredInstances([
    {
      instanceKey: k,
      displayName: 'p023',
      adbPort: 5565,
      fbWidth: 900,
      fbHeight: 1600,
      online: true,
      fbLiteInstalled: true,
    },
  ]);
  // Simulate legacy composite account_id persisted in SQLite
  (store1 as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
    .prepare(
      "UPDATE bluestacks_instances SET account_state='logged-in', account_id='p023 (Mawi Lee)', account_name='Mawi Lee', numeric_account_id='' WHERE id=?",
    )
    .run(id);
  assert.equal(store1.bluestacks.getInstance(id)?.accountId, '');
  store1.close();

  // Re-opening store cleans legacy composite account_id row in DB
  const store2 = await WorkspaceStore.open(sqliteFile);
  try {
    assert.equal(store2.bluestacks.getInstance(id)?.accountId, '');

    // FB Lite 488 moreBtn OCR fallback & no composite accountId generation when numericId is missing
    const pngBuf = mkPng();
    let screen: 'profile' | 'more' = 'profile';
    let tappedMore = false;
    const ctx = createDeviceRuntimeContext(
      store2.bluestacks,
      {
        recognizeBounds: async (_png: Buffer, b: RectBounds) => {
          if (screen === 'profile' && b.x1 >= 640 && b.y1 >= 1000) return '...';
          if (screen === 'more') return '复制公共主页链接';
          return '';
        },
        close: () => {},
      },
      {
        adbPath: 'adb.exe',
        runProc: async (_exe, args) => {
          const joined = args.join(' ');
          if (joined.includes('screencap')) return pngBuf;
          if (joined.includes('input tap')) {
            if (screen === 'profile' && joined.includes('785') && joined.includes('1145')) {
              tappedMore = true;
              screen = 'more';
            }
            return Buffer.from('');
          }
          if (joined.includes('exec-out cat')) {
            return Buffer.from(
              screen === 'profile'
                ? '<?xml version="1.0"?><hierarchy rotation="0"><node bounds="[0,0][900,1600]" package="com.facebook.lite"><node bounds="[720,1110][850,1180]" clickable="false" /></node></hierarchy>'
                : '<?xml version="1.0"?><hierarchy rotation="0"><node bounds="[0,0][900,1600]" package="com.facebook.lite"><node bounds="[40,600][860,680]" text="复制公共主页链接" clickable="true" /></node></hierarchy>',
            );
          }
          return Buffer.from('');
        },
      },
    );
    const res488 = await extractActiveProfileNumericId(
      ctx,
      '127.0.0.1:5565',
      rect(20, 120, 880, 230),
      900,
      1600,
    );
    assert.equal(tappedMore, true);
    assert.equal(res488.identityHint, 'page');

    // Save inspection without numericId must NOT produce "p023 (Mawi Lee)"
    const saved = store2.bluestacks.saveInspectionResult({
      id,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '',
      accountName: 'Mawi Lee',
      fbLiteVersion: '488.0.0.10.107',
    });
    assert.equal(saved.accountId, '');
    assert.equal(resolveEffectiveBsAccountId(saved), id);
  } finally {
    store2.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 BUG-P1-03: active queues while launching (524), 488 feed like bounds [160,1520], 488 poster timeline & compact gallery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w7-p103-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const k524 = 'Pie64_524_launch';
    const id524 = deterministicBluestacksId(k524);
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: k524,
        displayName: 'p524',
        adbPort: 5575,
        fbWidth: 900,
        fbHeight: 1600,
        online: false,
        fbLiteInstalled: true,
      },
    ]);
    let online = false;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((r) => {
      releaseLaunch = r;
    });
    const ranActive: string[] = [];
    const svc = new BluestacksService(
      store.bluestacks,
      {
        getOnlineKeys: () => new Set(online ? [k524] : []),
        discoverInstances: async () => ({
          instances: store.bluestacks.listInstances(online ? [k524] : []),
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
          await launchGate;
          online = true;
          return store.bluestacks.getInstance(id)!;
        },
        closeInstance: async () => {},
        inspectAccount: async (id) => store.bluestacks.getInstance(id)!,
      },
      { run: async () => {} },
      new FeatureExecutionRegistry(),
      {
        activeRunner: {
          run: async (id) => {
            ranActive.push(id);
            return {
              completedSteps: 1,
              skippedSteps: 0,
              likes: 1,
              acceptedFriends: 0,
              published: 0,
              notes: [],
            };
          },
        },
      },
    );
    svc.setWorkboard(new Workboard({ bluestacksConcurrency: 2 }));
    const ctx = (svc as unknown as { ctx: Parameters<typeof launchInstancesOp>[0] }).ctx;
    await launchInstancesOp(ctx, { instanceIds: [id524] });
    await svc.startActive({
      instanceIds: [id524],
      quickStep: { type: 'feed', durationMinutes: 0.2 },
    });
    // Queued while launching instead of silently skipped!
    assert.equal((await svc.state(false)).activeProfileCounts?.[id524]?.running, true);
    releaseLaunch();
    for (let i = 0; i < 60 && (await svc.state(false)).activeRunning; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(ranActive, [id524]);

    // 488 feed like bounds [160, 1520]
    const inst488 = mkInst('Pie64_488', {
      fbLiteVersion: '488.0.0.10.107',
      accountId: '',
      numericAccountId: '',
    });
    let likedY = 0;
    const feed488Xml = xmlDoc(
      `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,1455][900,1515]">` +
        nodeXml(0, '赞', '[10,1455][295,1515]', { click: true, long: true }) +
        nodeXml(1, '评论', '[305,1455][595,1515]', { click: true }) +
        nodeXml(2, '分享', '[605,1455][890,1515]', { click: true }) +
        `</node>`,
    );
    const activeRunner = new BluestacksActiveRunner(
      {
        ensureReadyAndLoggedIn: async () => inst488,
        openDeepLink: async () => {},
        detectAbnormalScreen: async () => null,
        dumpXml: async () => feed488Xml,
        screencap: async () =>
          mkPng((c) => {
            if (likedY > 0) {
              c.fillStyle = '#1877f2';
              c.fillRect(100, 1465, 60, 35);
            }
          }),
        tap900: async (_s: string, _x: number, y: number) => {
          likedY = y;
        },
        swipe900: async () => {},
        keyevent: async () => {},
      } as unknown as BluestacksDeviceManager,
      { recognizeBounds: async () => '', close: () => {} },
    );
    const realRand = Math.random;
    const realNow = Date.now;
    let tick = realNow();
    Math.random = () => 0;
    Date.now = () => (tick += 2000);
    try {
      const actOut = await activeRunner.run(
        inst488.id,
        [{ type: 'feed', durationMinutes: 0.5, maxLikes: 1, likeProbability: 100 }],
        new AbortController().signal,
        { status: () => {}, action: () => {} },
      );
      assert.equal(actOut.likes, 1);
    } finally {
      Math.random = realRand;
      Date.now = realNow;
    }

    // 488 Poster: timeline failure message + keyboard dismiss + compact gallery toolbar + bottom-anchored Next
    const mediaFile = path.join(dir, 'pic488.jpg');
    await writeFile(mediaFile, Buffer.from('jpg'));
    let stage: 'home' | 'composer_kb' | 'composer_nokb' | 'gallery' | 'gallery_next' | 'submitted' =
      'home';
    const logs: PosterLog[] = [];
    const failedNotes: string[] = [];
    const posterRunner = new BluestacksGroupPosterRunner(
      {
        ensureReadyAndLoggedIn: async () => inst488,
        openDeepLink: async () => {
          stage = 'home';
        },
        detectAbnormalScreen: async () => null,
        dumpXml: async () => {
          if (stage === 'home')
            return xmlDoc(nodeXml(0, '分享新鲜事', '[40,290][860,360]', { click: true }));
          if (stage === 'composer_kb')
            return xmlDoc(
              nodeXml(0, '', '[40,220][860,460]', {
                cls: 'com.facebook.primitive.textinput.TextInputView',
                click: true,
                long: true,
                focused: true,
              }) + nodeXml(1, '发布', '[720,60][880,120]', { click: true }),
            );
          if (stage === 'composer_nokb')
            return xmlDoc(
              nodeXml(0, '', '[40,220][860,460]', {
                cls: 'com.facebook.primitive.textinput.TextInputView',
                click: true,
                long: true,
                focused: true,
              }) +
                nodeXml(1, '发布', '[720,60][880,120]', { click: true }) +
                nodeXml(2, '', '[40,1450][180,1520]', {
                  click: true,
                  rid: 'gallery_btn',
                  desc: '相册',
                }),
            );
          if (stage === 'gallery')
            return xmlDoc(nodeXml(0, 'pic_1', '[20,180][280,440]', { click: true }));
          if (stage === 'gallery_next')
            return xmlDoc(nodeXml(0, '下一步', '[640,1460][870,1540]', { click: true }));
          return xmlDoc(nodeXml(0, 'Grace Helper 刚刚 Blessings 2026', '[20,260][860,360]'));
        },
        screencap: async () => mkPng(),
        tap900: async (_s: string, x: number, y: number) => {
          if (stage === 'home' && y >= 280) stage = 'composer_kb';
          else if (stage === 'composer_nokb' && x <= 200 && y >= 1440) stage = 'gallery';
          else if (stage === 'gallery') stage = 'gallery_next';
          else if (stage === 'gallery_next' && y >= 1440) stage = 'composer_nokb';
          else if (stage === 'composer_nokb' && x >= 700 && y <= 130) stage = 'submitted';
        },
        keyevent: async () => {
          if (stage === 'composer_kb') stage = 'composer_nokb';
        },
        swipe900: async () => {},
        pasteIntoFocused: async () => {},
        pushMediaToGallery: async () => '/sdcard/Pictures/Workbench/wb_488.jpg',
        cleanupPushedMedia: async () => {},
        copyLinkFromMoreMenu: async () => null,
      } as unknown as BluestacksDeviceManager,
      {
        recognizeBounds: async (_png, b) =>
          stage === 'submitted'
            ? '已发布 Blessings 2026'
            : stage === 'composer_nokb' && b.y1 <= 130 && b.x1 >= 680
              ? '发布'
              : '',
        close: () => {},
      },
      { recordPost: (l) => (logs.push(l), true) },
    );
    const postOut = await posterRunner.run(
      inst488.id,
      [mat('m488', { mediaSource: mediaFile, localFilePath: mediaFile, mediaKind: 'image' })],
      [],
      { maxGroupsPerInstance: 0, postToTimeline: true },
      new AbortController().signal,
      { status: () => {}, posted: () => {} },
    );
    assert.equal(postOut.posted, 1);
    assert.equal(logs[0]?.accountId, inst488.id);

    // Timeline failure message says 时间线发帖入口
    const failRunner = new BluestacksGroupPosterRunner(
      {
        ensureReadyAndLoggedIn: async () => inst488,
        openDeepLink: async () => {},
        detectAbnormalScreen: async () => null,
        dumpXml: async () => xmlDoc(''),
        screencap: async () => mkPng(),
        tap900: async () => {},
        swipe900: async () => {},
        keyevent: async () => {},
      } as unknown as BluestacksDeviceManager,
      { recognizeBounds: async () => '', close: () => {} },
    );
    const failOut = await failRunner.run(
      inst488.id,
      [mat('m_fail')],
      [],
      { maxGroupsPerInstance: 0, postToTimeline: true },
      new AbortController().signal,
      {
        status: () => {},
        posted: () => {},
        onTargetFailed: (i) => void failedNotes.push(i.reason),
      },
    );
    assert.equal(failOut.posted, 0);
    assert.match(failedNotes[0] ?? '', /未能打开时间线发帖入口/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 BUG-P1-04: cross-group attribution vs foreign skip, non-empty accountId, multiline Emoji comments & diagnostics', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w7-p104-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  const diagEvents: Array<{ code: string; reason?: string; data?: Record<string, unknown> }> = [];
  const origEmit = devDiag.emit.bind(devDiag);
  devDiag.emit = ((lvl, mod, code, payload) => {
    diagEvents.push({ code, reason: payload?.reason, data: payload?.data });
    return origEmit(lvl, mod, code, payload);
  }) as typeof devDiag.emit;
  try {
    // 1. Multiline Emoji comment: tall input send button + OCR readback + commentSkippedReason
    const tallCommentXml = xmlDoc(
      nodeXml(0, '', '[20,1200][760,1500]', {
        cls: 'com.facebook.primitive.textinput.TextInputView',
        click: true,
        long: true,
        focused: true,
      }) + nodeXml(1, '发送', '[780,1430][880,1500]', { click: true, rid: 'send_btn' }),
    );
    const sendNode = findCommentSendButtonNode(
      tallCommentXml,
      parseLiteXml(
        '<hierarchy><node bounds="[20,1200][760,1500]" class="TextInputView" clickable="true"/></hierarchy>',
        900,
        1600,
      )?.children[0] ?? null,
    );
    assert.ok(sendNode, 'Tall multiline input must still locate bottom-anchored send button');

    const emojiComment = '🙏✨\nGod bless your family!\nAmen ❤️';
    const afterXml488 = xmlDoc(
      nodeXml(0, '回复', '[30,240][120,290]') +
        nodeXml(1, '', '[20,1440][760,1520]', { cls: 'TextInputView', click: true }),
    );
    let phase: 'open' | 'typed' | 'after' = 'open';
    const emojiOps = {
      serial: '127.0.0.1:5565',
      sw: 900,
      sh: 1600,
      guard: () => {},
      wait: async () => {},
      xml: async () => (phase === 'after' ? afterXml488 : tallCommentXml),
      png: async () => mkPng(),
      capture: async () => ({
        xml: phase === 'after' ? afterXml488 : tallCommentXml,
        png: mkPng(),
      }),
      tap: async (_x: number, y: number) => {
        if (y >= 1400 && phase === 'typed') phase = 'after';
      },
      swipe: async () => {},
      back: async () => {},
      tapLike: async () => ({ ok: true, afterPng: mkPng() }),
      paste: async () => {
        phase = 'typed';
      },
      ocr: async () => (phase === 'after' ? 'God bless your family! Amen' : ''),
    } as unknown as ScreenOps;
    const emojiRes = await submitCommentWithReason(
      emojiOps,
      rect(305, 800, 595, 860),
      emojiComment,
    );
    assert.equal(emojiRes.ok, true);
    assert.equal(emojiRes.commentSkippedReason, null);

    // Failed comment returns reason via executeBarActions
    const noSendOps = {
      ...emojiOps,
      xml: async () =>
        xmlDoc(nodeXml(0, '', '[20,1440][760,1520]', { cls: 'TextInputView', click: true })),
      capture: async () => ({
        xml: xmlDoc(nodeXml(0, '', '[20,1440][760,1520]', { cls: 'TextInputView', click: true })),
        png: mkPng(),
      }),
    } as unknown as ScreenOps;
    const barFail = await executeBarActions(
      noSendOps,
      { likeBounds: rect(10, 800, 295, 860), commentBounds: rect(305, 800, 595, 860) },
      BumperSettings.parse({}),
      false,
      'Amen!',
    );
    assert.equal(barFail.didComment, null);
    assert.equal(barFail.commentSkippedReason, 'send_button_not_found');

    // 2. Cross-group attribution vs foreign group skip + non-empty accountId + comment skip event
    const k = 'Pie64_bumper_p104';
    const id = deterministicBluestacksId(k);
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: k,
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    store.bluestacks.saveInspectionResult({
      id,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '',
      accountName: 'Mawi Lee',
    });
    store.groupBumper.upsertTargets('groups', {
      items: [
        { id: '111000', name: 'Target G1', folderId: null },
        { id: '222000', name: 'Target G2', folderId: null },
      ],
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '888000', name: 'Page P1', folderId: null }],
    });
    store.groupBumper.saveComments({ texts: ['Amen comment!'] }, 'group');

    const cardXml = xmlDoc(
      `<node index="0" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="true" bounds="[0,120][900,1520]">` +
        `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,180][900,270]">` +
        nodeXml(0, '', '[20,190][76,246]', { click: true }) +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[90,190][740,256]">` +
        nodeXml(0, 'Page P1', '[90,190][360,220]', { click: true }) +
        nodeXml(1, '1 小时', '[90,224][210,254]') +
        `</node>` +
        nodeXml(2, '', '[820,190][885,250]', { click: true }) +
        `</node>` +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,520][900,590]">` +
        nodeXml(0, '', '[10,525][295,585]', { click: true, long: true }) +
        nodeXml(1, '', '[305,525][595,585]', { click: true }) +
        nodeXml(2, '', '[605,525][890,585]', { click: true }) +
        `</node></node>`,
    );
    let currentGroup = '111000';
    let swiped = 0;
    let liked = false;
    const runner = new BluestacksGroupBumperRunner(
      store.bluestacks,
      { applyResolvedTargetMetadata: () => {} },
      {
        ensureReadyAndLoggedIn: async () => store.bluestacks.getInstance(id)!,
        openDeepLink: async (_s: string, url: string) => {
          currentGroup = url.includes('222000') ? '222000' : '111000';
          swiped = 0;
          liked = false;
        },
        detectAbnormalScreen: async () => null,
        dumpXml: async () => (swiped > 0 ? null : cardXml),
        screencap: async () =>
          mkPng((c) => {
            if (liked) {
              c.fillStyle = '#1877f2';
              c.fillRect(120, 540, 50, 30);
            }
          }),
        swipe900: async () => {
          swiped++;
        },
        tap900: async (_s: string, x: number, y: number) => {
          if (x <= 295 && y >= 520) liked = true;
        },
        keyevent: async () => {},
        // When scanning G1 (111000), return foreign group 999999; when scanning G2 (222000), return cross-group G1 (111000)
        copyLinkFromMoreMenu: async () =>
          currentGroup === '111000'
            ? 'https://www.facebook.com/groups/999999/posts/777001/'
            : 'https://www.facebook.com/groups/111000/posts/777002/',
      } as unknown as BluestacksDeviceManager,
      {
        recognizeBounds: async (_png, b) => (b.y2 <= 265 ? 'Page P1 1 小时' : ''),
        close: () => {},
      },
    );
    await runner.run(
      id,
      [grp('111000', 'Target G1'), grp('222000', 'Target G2')],
      [grp('888000', 'Page P1')],
      BumperSettings.parse({
        searchMode: 'time_sort',
        likeProbability: 100,
        commentProbability: 100,
        maxPostsPerGroupPage: 1,
      }),
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'group',
    );
    const logs = store.groupBumper.logs('', 10, Date.now() + 1000, '\uffff', 'group');
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.postId, '777002');
    assert.equal(logs[0]?.groupId, '111000');
    assert.equal(logs[0]?.accountId, id);
    assert.ok(diagEvents.some((e) => e.code === 'BLUESTACKS_BUMPER_FOREIGN_GROUP_SKIPPED'));
    assert.ok(diagEvents.some((e) => e.code === 'BLUESTACKS_BUMPER_COMMENT_SKIPPED'));
  } finally {
    devDiag.emit = origEmit;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 v275: dumpsys 720x1280 calibration, transient 976x1280 boot override guard, vision false positives & EN_DAY_MONTH_RE', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-v275-vis-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    // 1. readLiveScreenSize prefers Physical 720x1280 over mismatched Override 976x1280 when conf matches 720x1280
    const ctx = createDeviceRuntimeContext(
      store.bluestacks,
      { recognizeBounds: async () => '', close: () => {} },
      {
        adbPath: 'HD-Adb.exe',
        runProc: async () => Buffer.from('Physical size: 720x1280\nOverride size: 976x1280\n'),
      },
    );
    const sz = await readLiveScreenSize(ctx, '127.0.0.1:5615', 720, 1280, true);
    assert.deepEqual(sz, { width: 720, height: 1280 });

    // 2. parseDumpsysTop auto-calibrates 720x1280 from LinearLayout 0,0-720,1280 even if caller passed 976x1280
    const dumpsys524 = [
      '  ACTIVITY com.facebook.lite/.MainActivity abc pid=100',
      '    mResumed=true mStopped=false',
      '    View Hierarchy:',
      '      DecorView@f196e47[MainActivity]',
      '        android.widget.LinearLayout{f57c674 V.E...... ........ 0,0-720,1280}',
      '          X.0kT{aaa VFED..C.. ........ 620,30-700,80}',
    ].join('\n');
    const calibrated = parseDumpsysTop(dumpsys524, 976, 1280);
    assert.ok(calibrated);
    const btnX2 = calibrated.children[0]?.children[0]?.bounds.x2 ?? 0;
    assert.equal(btnX2, 875); // 700 * 900 / 720 = 875 (not 645!)

    // 3. extractActionBars rejects [Anonymous post | Feeling | Poll] pills, accepts real [like | comment | share]
    const falseTriadXml = xmlDoc(
      `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,600][900,800]">` +
        nodeXml(0, '', '[23,680][394,740]', { click: true }) +
        nodeXml(1, '', '[416,680][658,740]', { click: true }) +
        nodeXml(2, '', '[680,680][878,740]', { click: true }) +
        `</node>` +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,1010][900,1085]">` +
        nodeXml(0, '', '[0,1010][300,1085]', { click: true }) +
        nodeXml(1, '', '[300,1010][600,1085]', { click: true }) +
        nodeXml(2, '', '[600,1010][900,1085]', { click: true }) +
        `</node>`,
    );
    const bars = extractActionBars(falseTriadXml);
    assert.equal(bars.length, 1);
    assert.equal(bars[0]?.y1, 1010);

    // 4. extractPostCards rejects Home composer bar right under Home tab bar & expands timestampBounds x2 <= 760
    const homeAndPostXml = xmlDoc(
      `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,97][900,169]">` +
        nodeXml(0, '', '[0,97][150,169]', { click: true }) +
        nodeXml(1, '', '[150,97][300,169]', { click: true }) +
        nodeXml(2, '', '[300,97][450,169]', { click: true }) +
        nodeXml(3, '', '[450,97][600,169]', { click: true }) +
        nodeXml(4, '', '[600,97][750,169]', { click: true }) +
        nodeXml(5, '', '[750,97][900,169]', { click: true }) +
        `</node>` +
        // Composer bar ([Avatar | 分享新鲜事 | Photo]) at y=179..256
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[9,179][889,256]">` +
        nodeXml(0, '', '[9,179][86,256]', { click: true }) +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[84,187][815,247]">` +
        nodeXml(0, '分享新鲜事', '[110,198][400,235]', { click: false }) +
        `</node>` +
        nodeXml(2, '', '[815,181][889,253]', { click: true }) +
        `</node>` +
        // Real post card with wide subtitle timestamp x2=620
        `<node index="2" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,746][900,841]">` +
        nodeXml(0, '', '[11,757][81,827]', { click: true }) +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[89,757][804,820]">` +
        nodeXml(0, 'Prayer Fellowship', '[91,765][431,797]', { click: true }) +
        nodeXml(1, 'Little Harbor of Grace · 1d', '[91,797][620,821]', { click: false }) +
        `</node>` +
        nodeXml(2, '', '[847,757][895,805]', { click: true }) +
        `</node>`,
    );
    const cards = extractPostCards(homeAndPostXml);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.header.bounds.y1, 746);
    assert.ok((cards[0]?.header.timestampBounds.x2 ?? 0) > 600);

    // 5. EN_DAY_MONTH_RE parses "5 November 2026"
    const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0);
    const age = relativePostAge('@ pastorsangpi 5 November 2026', nowMs);
    assert.ok(age !== null && age > 500 && age < 600);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 v275: Poster dismisses 检查分享对象 interstitial & submits bottom blue 发布, Active friends respects risk cap, Inviter handles 488/524 OCR', async () => {
  const inst488 = mkInst('Pie64_1', {
    fbLiteVersion: '488.0.0.10.107',
    numericAccountId: '61591261366732',
    accountId: '61591261366732',
  });
  // 1. Poster: taps timeline bar -> hits 2-step "检查分享对象" -> "谁能看到你今后的帖子" wizard -> taps 继续 then 完成 -> reaches composer -> taps bottom blue 发布 at y1=965
  let stage: 'home' | 'interstitial1' | 'interstitial2' | 'composer' | 'submitted' = 'home';
  const posterLogs: PosterLog[] = [];
  const poster = new BluestacksGroupPosterRunner(
    {
      ensureReadyAndLoggedIn: async () => inst488,
      openDeepLink: async () => {
        stage = 'home';
      },
      detectAbnormalScreen: async () => null,
      dumpXml: async () => {
        if (stage === 'home')
          return xmlDoc(nodeXml(0, '分享新鲜事', '[84,187][815,247]', { click: true }));
        if (stage === 'interstitial1')
          return xmlDoc(nodeXml(0, '继续', '[18,1525][882,1591]', { click: true }));
        if (stage === 'interstitial2')
          return xmlDoc(nodeXml(0, '完成', '[18,1525][882,1591]', { click: true }));
        if (stage === 'composer')
          return xmlDoc(
            nodeXml(0, '', '[18,262][882,342]', {
              cls: 'com.facebook.primitive.textinput.TextInputView',
              click: true,
              long: true,
              focused: true,
            }) + nodeXml(1, '发布', '[18,960][882,1035]', { click: true }),
          );
        return xmlDoc(nodeXml(0, 'Mawi Lee 刚刚 Peace 2026', '[20,260][860,360]'));
      },
      screencap: async () =>
        mkPng((c) => {
          if (stage === 'interstitial1' || stage === 'interstitial2') {
            c.fillStyle = '#1877f2';
            c.fillRect(18, 1525, 864, 66);
          } else if (stage === 'composer') {
            c.fillStyle = '#1877f2';
            c.fillRect(18, 960, 864, 75);
          }
        }),
      tap900: async (_s: string, _x: number, y: number) => {
        if (stage === 'home' && y >= 180 && y <= 260) stage = 'interstitial1';
        else if (stage === 'interstitial1' && y >= 1500) stage = 'interstitial2';
        else if (stage === 'interstitial2' && y >= 1500) stage = 'composer';
        else if (stage === 'composer' && y >= 940 && y <= 1050) stage = 'submitted';
      },
      keyevent: async () => {},
      swipe900: async () => {},
      pasteIntoFocused: async () => {},
      copyLinkFromMoreMenu: async () => null,
    } as unknown as BluestacksDeviceManager,
    {
      recognizeBounds: async (_p, b) => {
        if (stage === 'interstitial1')
          return b.y1 <= 200 || b.h > 800 ? '检查分享对象 所有视频帖现在都是 Reels 了' : '继续';
        if (stage === 'interstitial2')
          return b.y1 <= 200 || b.h > 800
            ? '谁能看到你今后的帖子和 Reels? 未来发布帖子和 Reels 时，你的分享对象都会沿用这一设置'
            : '完成';
        if (stage === 'composer') return b.y1 >= 940 ? '发布' : '';
        if (stage === 'submitted') return '已发布 Peace 2026';
        return '';
      },
      close: () => {},
    },
    { recordPost: (l) => (posterLogs.push(l), true) },
  );
  const pRes = await poster.run(
    inst488.id,
    [mat('m_v275', { caption: 'Peace 2026' })],
    [],
    { maxGroupsPerInstance: 0, postToTimeline: true },
    new AbortController().signal,
    { status: () => {}, posted: () => {} },
  );
  assert.equal(pRes.posted, 1);
  assert.equal(posterLogs[0]?.accountId, '61591261366732');

  // 2. Active runner friends step halts immediately without clicking when checkRiskLimit('action') blocks
  let friendTapped = false;
  const activeRunner = new BluestacksActiveRunner(
    {
      ensureReadyAndLoggedIn: async () => inst488,
      openDeepLink: async () => {},
      detectAbnormalScreen: async () => null,
      dumpXml: async () => xmlDoc(nodeXml(0, 'Confirm', '[100,300][340,360]', { click: true })),
      screencap: async () =>
        mkPng((c) => {
          c.fillStyle = '#1877f2';
          c.fillRect(100, 300, 240, 60);
        }),
      tap900: async () => {
        friendTapped = true;
      },
      swipe900: async () => {},
      keyevent: async () => {},
    } as unknown as BluestacksDeviceManager,
    { recognizeBounds: async () => 'Confirm', close: () => {} },
  );
  const fRes = await activeRunner.run(
    inst488.id,
    [{ type: 'friends', friendAction: 'accept', durationMinutes: 1, maxAccepts: 3 }],
    new AbortController().signal,
    {
      status: () => {},
      action: () => {},
      checkRiskLimit: async (kind) =>
        kind === 'action'
          ? { allowed: false, reason: '今日总动作上限' }
          : { allowed: true, reason: null },
    },
  );
  assert.equal(friendTapped, false);
  assert.equal(fRes.acceptedFriends, 0);
  assert.equal(fRes.skippedSteps, 1);

  // 3. Inviter accepts "+邀请" (68px wide) & "西+lnvite" header / "lnvite" row OCR, skips Invited, uses numericAccountId
  let invScreen: 'group' | 'list' = 'group';
  let invitedClicked = false;
  const inviteLogs: Array<{ accountId: string; friendName: string }> = [];
  const inviter = new BluestacksGroupInviterRunner(
    {
      ensureReadyAndLoggedIn: async () => inst488,
      openDeepLink: async () => {
        invScreen = 'group';
      },
      detectAbnormalScreen: async () => null,
      dumpXml: async () =>
        invScreen === 'group'
          ? xmlDoc(nodeXml(0, '', '[333,681][888,741]', { click: true }))
          : xmlDoc(nodeXml(0, '', '[805,573][873,633]', { click: true })), // width 68px!
      screencap: async () =>
        mkPng((c) => {
          c.fillStyle = '#1877f2';
          if (invScreen === 'group') c.fillRect(333, 681, 555, 60);
          else if (!invitedClicked) c.fillRect(805, 573, 68, 60);
        }),
      tap900: async () => {
        if (invScreen === 'group') invScreen = 'list';
        else invitedClicked = true;
      },
      swipe900: async () => {},
      keyevent: async () => {},
    } as unknown as BluestacksDeviceManager,
    {
      recognizeBounds: async (_p, b) => {
        if (invScreen === 'group') return '西 + lnvite';
        if (b.x1 >= 560) return '+ 邀请';
        return 'Tar Win';
      },
      close: () => {},
    },
    {
      recordInvites: (entries) => {
        for (const e of entries)
          inviteLogs.push({ accountId: e.accountId, friendName: e.friendName });
        return entries.length;
      },
    },
  );
  const invOut = await inviter.run(
    inst488.id,
    [grp('947494681288203', 'Myanmar Grace')],
    1,
    new AbortController().signal,
    { status: () => {}, invited: () => {} },
  );
  assert.equal(invOut.invited, 1);
  assert.equal(inviteLogs[0]?.accountId, '61591261366732');
});

test('W7 v275: BluestacksService.syncMaxConcurrency updates bumper/page settings AND startActive propagates checkRiskLimit mid-run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-v275-svc-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const inst = store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ])[0];
    assert.ok(inst);
    store.bluestacks.saveInspectionResult({
      id: inst.id,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '61591261366732',
      numericAccountId: '61591261366732',
      accountName: 'Mawi Lee',
    });
    await store.bluestacks.saveRiskLimitSettings({
      enabled: true,
      dailyMaxTotalActions: 10,
      dailyMaxBumps: 30,
      dailyMaxPosts: 10,
      dailyMaxInvites: 20,
      dailyMaxActiveLikes: 2,
      perInstanceOverrides: {},
    });
    store.bluestacks.recordDailyActiveAction(inst.id, 'like', 1);

    let initialAllowed: boolean | null = null;
    let afterCapAllowed: boolean | null = null;
    const svc = new BluestacksService(
      store.bluestacks,
      {
        discoverInstances: async () => ({
          instances: store.bluestacks.listInstances(['Pie64_1']),
          config: {
            installDir: null,
            confPath: null,
            detectedInstallDir: null,
            detectedConfPath: null,
            adbReady: true,
            playerReady: true,
            apkPath: null,
            detectedApkPath: null,
          },
        }),
        getOnlineKeys: () => new Set(['Pie64_1']),
      } as never,
      { run: async () => {}, ensureReady: async () => {} } as never,
      new FeatureExecutionRegistry(),
      {
        activeRunner: {
          run: async (_id, _steps, _sig, cb) => {
            initialAllowed = (await cb.checkRiskLimit?.('like'))?.allowed ?? null;
            cb.action('like'); // hits 2/2 dailyMaxActiveLikes
            await new Promise((r) => setTimeout(r, 30));
            afterCapAllowed = (await cb.checkRiskLimit?.('like'))?.allowed ?? null;
            return {
              completedSteps: 1,
              skippedSteps: 0,
              likes: 1,
              acceptedFriends: 0,
              published: 0,
              notes: [],
            };
          },
        },
      },
    );
    svc.setWorkboard(new Workboard());

    // 1. syncMaxConcurrency persists to BOTH bumperSettings and pageBumperSettings
    await svc.syncMaxConcurrency(7);
    const st7 = await svc.state(false);
    assert.equal(st7.bumperSettings.maxConcurrentProfiles, 7);
    assert.equal(st7.pageBumperSettings.maxConcurrentProfiles, 7);

    // 2. startActive propagates checkRiskLimit and detects mid-run cap transition
    await svc.startActive({
      instanceIds: [inst.id],
      quickStep: { type: 'feed', durationMinutes: 0.5, maxLikes: 2 },
      closeWindowOnFinish: false,
    });
    for (let i = 0; i < 40 && afterCapAllowed === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(initialAllowed, true);
    assert.equal(afterCapAllowed, false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 v275.1: 488 skeleton composer wait, isGalleryCameraTile, extractGalleryGridTiles & AlbumGalleryActivity 继续 picker', async () => {
  // 1. isGalleryCameraTile distinguishes light-gray + blue-circle camera tile from real photo tile
  const galPng = mkPng((c) => {
    // Tile 0: camera placeholder (#e9ebee bg + #1877f2 center circle)
    c.fillStyle = '#e9ebee';
    c.fillRect(0, 112, 175, 175);
    c.fillStyle = '#1877f2';
    c.beginPath();
    c.arc(87, 199, 55, 0, Math.PI * 2);
    c.fill();
    // Tile 1: natural photo (dark soil & sky)
    c.fillStyle = '#1d3a24';
    c.fillRect(181, 112, 175, 175);
    c.fillStyle = '#e8b96a';
    c.fillRect(181, 112, 175, 70);
  });
  assert.equal(await isGalleryCameraTile(galPng, rect(0, 112, 175, 287)), true);
  assert.equal(await isGalleryCameraTile(galPng, rect(181, 112, 356, 287)), false);

  // 2. extractGalleryGridTiles extracts clickable=false GalleryImageView tiles at y1=112 in visual order
  const galXml = xmlDoc(
    `<node index="0" text="图库" resource-id="com.facebook.lite:id/upload_photo_text" class="android.widget.TextView" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,36][900,108]" />` +
      nodeXml(0, '', '[0,112][175,287]', {
        cls: 'com.facebook.lite.widget.GalleryImageView',
        rid: 'com.facebook.lite:id/gallery_item_image',
        click: false,
      }) +
      nodeXml(1, '', '[181,112][356,287]', {
        cls: 'com.facebook.lite.widget.GalleryImageView',
        rid: 'com.facebook.lite:id/gallery_item_image',
        click: false,
      }) +
      nodeXml(2, '继续', '[12,1516][888,1588]', {
        cls: 'android.widget.TextView',
        rid: 'com.facebook.lite:id/multipicker_next',
        click: true,
      }),
  );
  const extractedTiles = extractGalleryGridTiles(galXml);
  assert.equal(extractedTiles.length, 2);
  assert.equal(extractedTiles[0]?.bounds.x1, 0);
  assert.equal(extractedTiles[1]?.bounds.x1, 181);

  // 3. End-to-end Poster: handles 2-tick skeleton composer, opens AlbumGalleryActivity, skips camera tile 0, taps tile 1 & bottom multipicker_next
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-v275-gal-'));
  try {
    const imgFile = path.join(dir, 'sunrise.png');
    await writeFile(
      imgFile,
      mkPng((c) => {
        c.fillStyle = '#336699';
        c.fillRect(0, 0, 900, 1600);
      }),
    );
    const inst488 = mkInst('Pie64_1', {
      fbLiteVersion: '488.0.0.10.107',
      numericAccountId: '61591261366732',
      accountId: '61591261366732',
    });
    let stg: 'home' | 'skeleton' | 'composer' | 'gallery' | 'submitted' = 'home';
    let skelReads = 0;
    const taps: Array<[number, number]> = [];
    const logs: PosterLog[] = [];
    const runner = new BluestacksGroupPosterRunner(
      {
        ensureReadyAndLoggedIn: async () => inst488,
        openDeepLink: async () => {
          stg = 'home';
        },
        detectAbnormalScreen: async () => null,
        pushMediaToGallery: async () => '/sdcard/Pictures/Workbench/wb_test.png',
        cleanupPushedMedia: async () => {},
        dumpXml: async () => {
          if (stg === 'home')
            return xmlDoc(nodeXml(0, '分享新鲜事', '[84,187][815,247]', { click: true }));
          if (stg === 'skeleton') {
            skelReads++;
            if (skelReads >= 3) stg = 'composer';
            else return xmlDoc(nodeXml(0, '', '[0,36][60,106]', { click: true }));
          }
          if (stg === 'composer')
            return xmlDoc(
              nodeXml(0, '', '[18,262][882,342]', {
                cls: 'com.facebook.primitive.textinput.TextInputView',
                click: true,
                long: true,
                focused: true,
              }) +
                nodeXml(1, '照片/视频', '[0,608][900,654]', { click: true }) +
                nodeXml(2, '发布', '[810,44][890,102]', { click: true }),
            );
          if (stg === 'gallery') return galXml;
          return xmlDoc(nodeXml(0, 'Mawi Lee 刚刚 Grace 488', '[20,260][860,360]'));
        },
        screencap: async () => {
          if (stg === 'gallery') return galPng;
          return mkPng((c) => {
            if (stg === 'composer') {
              c.fillStyle = '#1877f2';
              c.fillRect(810, 44, 80, 58);
            }
          });
        },
        tap900: async (_s: string, x: number, y: number) => {
          taps.push([x, y]);
          if (stg === 'home' && y >= 180 && y <= 260) {
            stg = 'skeleton';
            skelReads = 0;
          } else if (stg === 'composer' && y >= 590 && y <= 670) {
            stg = 'gallery';
          } else if (stg === 'gallery' && y >= 1500) {
            stg = 'composer';
          } else if (stg === 'composer' && y <= 140 && x >= 780) {
            stg = 'submitted';
          }
        },
        keyevent: async () => {},
        swipe900: async () => {},
        pasteIntoFocused: async () => {},
        copyLinkFromMoreMenu: async () => null,
      } as unknown as BluestacksDeviceManager,
      {
        recognizeBounds: async () => {
          if (stg === 'skeleton') return '创建帖子 发布';
          if (stg === 'gallery') return '';
          if (stg === 'composer') return '发布';
          if (stg === 'submitted') return '已发布 Grace 488';
          return '';
        },
        close: () => {},
      },
      { recordPost: (l) => (logs.push(l), true) },
    );
    const out = await runner.run(
      inst488.id,
      [
        mat('m_v275_gal', {
          caption: 'Grace 488',
          mediaSource: imgFile,
          localFilePath: imgFile,
          mediaKind: 'image',
        }),
      ],
      [],
      { maxGroupsPerInstance: 0, postToTimeline: true },
      new AbortController().signal,
      { status: () => {}, posted: () => {} },
    );
    assert.equal(out.posted, 1);
    assert.ok(
      taps.some(([x, y]) => x >= 181 && x <= 356 && y >= 112 && y <= 287),
      'must tap real tile 1 (not camera tile 0)',
    );
    assert.ok(
      taps.some(([, y]) => y >= 1516),
      'must tap bottom multipicker_next button',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('W7 v275.2: isLoginOrLoggedOutXml never false-triggers on single composer TextInputView, still catches 2-input or labeled login', () => {
  const mkNodes = (body: string) => xmlDoc(body);
  const filler = [0, 1, 2, 3, 4]
    .map((i) => nodeXml(i + 1, '', `[20,${80 + i * 20}][200,${95 + i * 20}]`))
    .join('');

  // Single composer/comment TextInputView without back button MUST NOT be flagged logged-out
  const composerModal = mkNodes(
    nodeXml(0, '', '[18,262][882,342]', {
      cls: 'com.facebook.primitive.textinput.TextInputView',
      click: true,
    }) + filler,
  );
  assert.equal(isLoginOrLoggedOutXml(composerModal), false);

  // Two login inputs (account + password) -> logged-out
  const twoInputs = mkNodes(
    nodeXml(0, '', '[40,320][860,390]', {
      cls: 'com.facebook.primitive.textinput.TextInputView',
      click: true,
    }) +
      nodeXml(1, '', '[40,420][860,490]', {
        cls: 'com.facebook.primitive.textinput.TextInputView',
        click: true,
      }) +
      filler,
  );
  assert.equal(isLoginOrLoggedOutXml(twoInputs), true);

  // Single input paired with explicit login button text -> logged-out
  const oneInputWithLogin = mkNodes(
    nodeXml(0, '', '[40,320][860,390]', {
      cls: 'com.facebook.primitive.textinput.TextInputView',
      click: true,
    }) +
      nodeXml(1, 'Log in', '[40,520][860,590]', { click: true }) +
      filler,
  );
  assert.equal(isLoginOrLoggedOutXml(oneInputWithLogin), true);
});
