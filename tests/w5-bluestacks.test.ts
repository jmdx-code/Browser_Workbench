import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { BluestacksService } from '../src/application/bluestacks-service.js';
import { resolvePatrolCap } from '../src/application/bluestacks/bs-patrols.js';
import { FeatureExecutionRegistry } from '../src/application/feature-execution-registry.js';
import { Workboard } from '../src/application/workboard.js';
import {
  BluestacksGroupBumperRunner,
  applyLikeOrReaction,
  submitCommentOnActionBar,
} from '../src/infrastructure/bluestacks-bumper-runner.js';
import type {
  BluestacksDeviceManager,
  ScreenOps,
} from '../src/infrastructure/bluestacks-device-manager.js';
import { BluestacksGroupInviterRunner } from '../src/infrastructure/bluestacks-inviter-runner.js';
import { BluestacksGroupPosterRunner } from '../src/infrastructure/bluestacks-poster-runner.js';
import { deterministicBluestacksId } from '../src/infrastructure/bluestacks-store.js';
import {
  parseLiteXml,
  type LiteXmlNode,
  type RectBounds,
} from '../src/infrastructure/bluestacks-vision.js';
import { createBluestacksTools } from '../src/infrastructure/mcp/tools-bluestacks.js';
import type { WorkbenchMcpDependencies } from '../src/infrastructure/mcp/mcp-context.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { BluestacksInstance } from '../src/shared/bluestacks.js';
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
const mkInstance = (
  key: string,
  overrides: Partial<BluestacksInstance> = {},
): BluestacksInstance => ({
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
  ...overrides,
});
function mkPng(
  draw?: (ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void,
): Buffer {
  const c = createCanvas(900, 1600);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 1600);
  draw?.(ctx);
  return c.toBuffer('image/png');
}
const matText = (id: string, caption = 'Hello verified world'): PosterMaterial => ({
  id,
  caption,
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
});
const grpTarget = (id: string, name = 'Group A'): BumperTarget => ({
  id,
  name,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});
const nodeXml = (
  i: number,
  text: string,
  bounds: string,
  opts: { cls?: string; click?: boolean; long?: boolean; focused?: boolean; rid?: string } = {},
) =>
  `<node index="${i}" text="${text}" resource-id="${opts.rid ?? ''}" class="${opts.cls ?? 'android.view.View'}" package="com.facebook.lite" content-desc="${text}" clickable="${Boolean(opts.click)}" long-clickable="${Boolean(opts.long)}" focused="${Boolean(opts.focused)}" scrollable="false" bounds="${bounds}" />`;

test('W5 Poster: rejects null dumpXml and empty input-gone without readback, extracts real postUrl, cleans media in finally, and skips camera tile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w5-poster-'));
  try {
    const mediaFile = path.join(dir, 'sample.jpg');
    await writeFile(mediaFile, Buffer.from('fake-jpg'));
    const inst = mkInstance('Pie64_poster');
    const cleanedPaths: string[] = [];
    const tappedPoints: Array<{ x: number; y: number }> = [];
    const recordedLogs: PosterLog[] = [];
    let afterXmlMode: 'null' | 'no-evidence' | 'feed-with-url' | 'toast-no-url' = 'null';
    let stage: 'group' | 'composer' | 'gallery' | 'submitted' = 'group';

    const groupEntryXml = xmlDoc(nodeXml(0, '写点什么...', '[40,380][860,460]', { click: true }));
    const composerXml = xmlDoc(
      nodeXml(0, '', '[40,220][860,460]', {
        cls: 'com.facebook.primitive.textinput.TextInputView',
        click: true,
        long: true,
        focused: true,
      }) +
        nodeXml(1, '发布', '[720,60][880,120]', { click: true }) +
        nodeXml(2, '照片/视频', '[20,700][880,770]', { click: true }),
    );
    const galleryXml = xmlDoc(
      nodeXml(0, '相机', '[20,200][280,460]', { click: true }) +
        nodeXml(1, 'photo_1', '[300,200][560,460]', { click: true }) +
        nodeXml(2, '下一步', '[700,60][880,120]', { click: true }),
    );
    const feedCardXml = xmlDoc(
      `<node index="0" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="true" bounds="[0,120][900,1520]">` +
        `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,180][900,270]">` +
        nodeXml(0, '', '[20,190][76,246]', { click: true }) +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[90,190][740,256]">` +
        nodeXml(0, 'Grace Helper', '[90,190][360,220]', { click: true }) +
        nodeXml(1, '刚刚', '[90,224][210,254]') +
        `</node>` +
        nodeXml(2, '', '[820,190][885,250]', { click: true }) +
        `</node>` +
        nodeXml(1, 'Hello verified world', '[24,290][870,360]') +
        `</node>`,
    );
    const plainXmlNoInput = xmlDoc(nodeXml(0, 'Unrelated screen', '[40,200][500,260]'));
    const bluePng = mkPng((c) => {
      c.fillStyle = '#1877f2';
      c.fillRect(720, 60, 160, 60);
    });

    const fakeDevices = {
      ensureReadyAndLoggedIn: async () => inst,
      openDeepLink: async () => {
        stage = 'group';
      },
      detectAbnormalScreen: async () => null,
      dumpXml: async (): Promise<LiteXmlNode | null> => {
        if (stage === 'group') return groupEntryXml;
        if (stage === 'composer') return composerXml;
        if (stage === 'gallery') return galleryXml;
        if (afterXmlMode === 'null') return null;
        return afterXmlMode === 'feed-with-url' ? feedCardXml : plainXmlNoInput;
      },
      screencap: async () => bluePng,
      tap900: async (_s: string, x: number, y: number) => {
        tappedPoints.push({ x, y });
        if (stage === 'group' && y >= 370 && y <= 470) stage = 'composer';
        else if (stage === 'composer' && y >= 690 && y <= 780) stage = 'gallery';
        else if (stage === 'gallery' && x >= 690 && y <= 140) stage = 'composer';
        else if (stage === 'composer' && x >= 700 && y <= 140) stage = 'submitted';
      },
      swipe900: async () => {},
      keyevent: async () => {},
      pasteIntoFocused: async () => {},
      pushMediaToGallery: async () => '/sdcard/Pictures/Workbench/wb_test_1.jpg',
      cleanupPushedMedia: async (_s: string, paths: readonly string[]) => {
        cleanedPaths.push(...paths);
      },
      copyLinkFromMoreMenu: async () =>
        'https://www.facebook.com/groups/111222333/posts/998877665544/',
    } as unknown as BluestacksDeviceManager;

    let ocrMode: 'empty' | 'toast' | 'readback' = 'empty';
    const runner = new BluestacksGroupPosterRunner(
      fakeDevices,
      {
        recognizeBounds: async (_png, b) => {
          if (stage === 'group') return '写点什么...';
          if (stage === 'gallery') {
            if (b.y1 >= 180 && b.y2 <= 470 && b.x2 <= 290) return '相机';
            if (b.y1 <= 130 && b.x1 >= 680) return '下一步';
          }
          if (stage === 'composer') {
            if (b.y1 <= 130 && b.x1 >= 680) return '发布';
            if (b.y1 >= 680 && b.y2 <= 780) return '照片/视频';
          }
          if (stage === 'submitted') {
            if (ocrMode === 'toast') return '已发布';
            if (ocrMode === 'readback') return 'Grace Helper 刚刚 Hello verified world';
          }
          return '';
        },
        close: () => {},
      },
      { recordPost: (log) => (recordedLogs.push(log), true) },
    );

    const runFastClock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const realNow = Date.now;
      let tick = realNow();
      Date.now = () => (tick += 3500);
      try {
        return await fn();
      } finally {
        Date.now = realNow;
      }
    };

    afterXmlMode = 'null';
    ocrMode = 'empty';
    const nullXmlOut = await runFastClock(() =>
      runner.run(
        inst.id,
        [matText('m1')],
        [grpTarget('111222333')],
        { maxGroupsPerInstance: 1, postToTimeline: false },
        new AbortController().signal,
        { status: () => {}, posted: () => {} },
      ),
    );
    assert.equal(nullXmlOut.posted, 0);
    assert.match(nullXmlOut.notes[0] ?? '', /UNKNOWN/);

    afterXmlMode = 'no-evidence';
    const noEvidenceOut = await runFastClock(() =>
      runner.run(
        inst.id,
        [matText('m2')],
        [grpTarget('111222333')],
        { maxGroupsPerInstance: 1, postToTimeline: false },
        new AbortController().signal,
        { status: () => {}, posted: () => {} },
      ),
    );
    assert.equal(noEvidenceOut.posted, 0);
    assert.match(noEvidenceOut.notes[0] ?? '', /UNKNOWN/);

    afterXmlMode = 'feed-with-url';
    ocrMode = 'readback';
    const mediaMat: PosterMaterial = {
      ...matText('m3'),
      mediaSource: mediaFile,
      localFilePath: mediaFile,
      mediaKind: 'image',
    };
    const verifiedOut = await runner.run(
      inst.id,
      [mediaMat],
      [grpTarget('111222333')],
      { maxGroupsPerInstance: 1, postToTimeline: false },
      new AbortController().signal,
      { status: () => {}, posted: () => {} },
    );
    assert.equal(verifiedOut.posted, 1);
    assert.equal(recordedLogs[0]?.postId, '998877665544');
    assert.equal(
      recordedLogs[0]?.postUrl,
      'https://www.facebook.com/groups/111222333/posts/998877665544/',
    );
    assert.ok(tappedPoints.some((p) => p.x === 430 && p.y === 330));
    assert.deepEqual(cleanedPaths, ['/sdcard/Pictures/Workbench/wb_test_1.jpg']);

    afterXmlMode = 'toast-no-url';
    ocrMode = 'toast';
    const toastOut = await runner.run(
      inst.id,
      [matText('m4')],
      [grpTarget('111222333')],
      { maxGroupsPerInstance: 1, postToTimeline: false },
      new AbortController().signal,
      { status: () => {}, posted: () => {} },
    );
    assert.equal(toastOut.posted, 1);
    assert.equal(recordedLogs[1]?.postId, 'pending_approval');
    assert.equal(recordedLogs[1]?.postUrl, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('W5 Bumper: long-press reaction inspects likeBounds (no self-unlike), XML comment send+readback rejects occluded boxes, and fallback postId ignores scrollIdx/y1', async () => {
  const likeBounds = rect(10, 800, 295, 860);
  const popupXml = xmlDoc(
    ['like', 'love', 'care', 'haha', 'wow', 'sad', 'angry']
      .map((r, i) => nodeXml(i, r, `[${20 + i * 120},660][${120 + i * 120},760]`, { click: true }))
      .join(''),
  );
  const taps: Array<{ x: number; y: number }> = [];
  let reactionActive = false;
  const activeHeartPng = mkPng((ctx) => {
    ctx.fillStyle = '#e0245e';
    ctx.fillRect(likeBounds.cx - 15, likeBounds.cy - 15, 30, 30);
  });
  const idlePng = mkPng();
  const mockOps = {
    serial: '127.0.0.1:5565',
    sw: 900,
    sh: 1600,
    guard: () => {},
    wait: async () => {},
    xml: async () => popupXml,
    png: async () => (reactionActive ? activeHeartPng : idlePng),
    capture: async () => ({ xml: popupXml, png: reactionActive ? activeHeartPng : idlePng }),
    tap: async (x: number, y: number) => {
      taps.push({ x, y });
      if (y >= 660 && y <= 760) reactionActive = true;
    },
    swipe: async () => {},
    back: async () => {},
    tapLike: async (b: RectBounds) => {
      taps.push({ x: b.cx, y: b.cy });
      reactionActive = !reactionActive;
      return { ok: reactionActive, afterPng: reactionActive ? activeHeartPng : idlePng };
    },
    paste: async () => {},
    ocr: async () => '',
  } as unknown as ScreenOps;

  const likedOk = await applyLikeOrReaction(
    mockOps,
    likeBounds,
    BumperSettings.parse({ useLongPressReaction: true, reactionTypes: ['love'] }),
  );
  assert.equal(likedOk, true);
  assert.equal(reactionActive, true);
  assert.equal(
    taps.some((t) => t.x === likeBounds.cx && t.y === likeBounds.cy),
    false,
  );

  const commentBounds = rect(305, 800, 595, 860);
  const commentEditorXml = xmlDoc(
    nodeXml(0, 'Existing comment', '[30,300][700,360]') +
      nodeXml(1, '', '[20,1440][760,1520]', {
        cls: 'com.facebook.primitive.textinput.TextInputView',
        click: true,
        long: true,
        focused: true,
      }) +
      nodeXml(2, '发送', '[780,1440][880,1520]', { click: true, rid: 'comment_send_btn' }),
  );
  const afterCommentPostedXml = xmlDoc(
    nodeXml(0, 'Amen Grace!', '[30,380][700,440]') +
      nodeXml(1, '', '[20,1440][760,1520]', {
        cls: 'com.facebook.primitive.textinput.TextInputView',
        click: true,
        long: true,
        focused: true,
      }),
  );
  let commentPhase: 'open' | 'typed' | 'after' = 'open';
  let sendOk = false;
  const commentTaps: Array<{ x: number; y: number }> = [];
  const commentOps = {
    ...mockOps,
    xml: async () =>
      commentPhase === 'after' && sendOk ? afterCommentPostedXml : commentEditorXml,
    capture: async () => ({
      xml: commentPhase === 'after' && sendOk ? afterCommentPostedXml : commentEditorXml,
      png: idlePng,
    }),
    paste: async () => {
      commentPhase = 'typed';
    },
    tap: async (x: number, y: number) => {
      commentTaps.push({ x, y });
      if (x >= 780 && y >= 1440) commentPhase = 'after';
    },
  } as unknown as ScreenOps;

  assert.equal(await submitCommentOnActionBar(commentOps, commentBounds, 'Amen Grace!'), false);
  assert.ok(commentTaps.some((t) => t.x === 830 && t.y === 1480));
  commentPhase = 'open';
  sendOk = true;
  assert.equal(await submitCommentOnActionBar(commentOps, commentBounds, 'Amen Grace!'), true);

  const buildCardXml = (yOff: number) =>
    xmlDoc(
      `<node index="0" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="true" bounds="[0,120][900,1520]">` +
        `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,${180 + yOff}][900,${270 + yOff}]">` +
        nodeXml(0, '', `[20,${190 + yOff}][76,${246 + yOff}]`, { click: true }) +
        `<node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[90,${190 + yOff}][740,${256 + yOff}]">` +
        nodeXml(0, 'Target Page', `[90,${190 + yOff}][360,${220 + yOff}]`, { click: true }) +
        nodeXml(1, '1 小时', `[90,${224 + yOff}][210,${254 + yOff}]`) +
        `</node>` +
        nodeXml(2, '', `[820,${190 + yOff}][885,${250 + yOff}]`, { click: true }) +
        `</node>` +
        nodeXml(1, 'Stable Sermon Snippet 2026', `[24,${290 + yOff}][870,${360 + yOff}]`) +
        `<node index="2" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,${520 + yOff}][900,${590 + yOff}]">` +
        nodeXml(0, '', `[10,${525 + yOff}][295,${585 + yOff}]`, { click: true, long: true }) +
        nodeXml(1, '', `[305,${525 + yOff}][595,${585 + yOff}]`, { click: true }) +
        nodeXml(2, '', `[605,${525 + yOff}][890,${585 + yOff}]`, { click: true }) +
        `</node></node>`,
    );

  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w5-fp-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const inst = mkInstance('Pie64_fp');
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: inst.instanceKey,
        displayName: inst.displayName,
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    store.bluestacks.saveInspectionResult({
      id: inst.id,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '100011223344',
      accountName: 'Grace Helper',
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '61588000111222', name: 'Target Page', folderId: null }],
    });

    let runNo = 0;
    let swipeCount = 0;
    let isLiked = false;
    const mkFrame = (yOff: number, liked: boolean) =>
      mkPng((c) => {
        c.fillStyle = '#223344';
        c.fillRect(40, 310 + yOff, 200, 80);
        if (liked) {
          c.fillStyle = '#1877f2';
          c.fillRect(120, 540 + yOff, 50, 30);
        }
      });
    const bumperDevices = {
      ensureReadyAndLoggedIn: async () => store.bluestacks.getInstance(inst.id),
      openDeepLink: async () => {
        swipeCount = 0;
        isLiked = false;
      },
      detectAbnormalScreen: async () => null,
      dumpXml: async () => (swipeCount > 0 ? null : buildCardXml(runNo === 0 ? 0 : 200)),
      screencap: async () => mkFrame(runNo === 0 ? 0 : 200, isLiked),
      swipe900: async () => {
        swipeCount++;
      },
      tap900: async (_s: string, x: number, y: number) => {
        if (x <= 295 && y >= 520) isLiked = true;
      },
      keyevent: async () => {},
      copyLinkFromMoreMenu: async () => null,
    } as unknown as BluestacksDeviceManager;

    const bumperRunner = new BluestacksGroupBumperRunner(
      store.bluestacks,
      { applyResolvedTargetMetadata: () => {} },
      bumperDevices,
      {
        recognizeBounds: async (_png, b) =>
          b.y2 <= (runNo === 0 ? 250 : 450) ? 'Target Page' : '',
        close: () => {},
      },
    );
    const pages = store.bluestacks.targets('pages');
    await bumperRunner.run(
      inst.id,
      [],
      pages,
      BumperSettings.parse({ maxPostsPerPage: 1, likeProbability: 100, commentProbability: 0 }),
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'page',
    );
    runNo = 1;
    await bumperRunner.run(
      inst.id,
      [],
      pages,
      BumperSettings.parse({ maxPostsPerPage: 1, likeProbability: 100, commentProbability: 0 }),
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'page',
    );
    const logs = store.groupBumper.logs('', 10, Date.now() + 1000, '\uffff', 'page');
    assert.equal(logs.length, 1, 'Shifted same post must hash to identical fallback postId');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W5 Patrols, Workboard Permits, Risk Classification & closeWindowOnFinish across standalone BS modules', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w5-svc-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const k1 = 'Pie64_p1';
    const k2 = 'Pie64_p2';
    const id1 = deterministicBluestacksId(k1);
    const id2 = deterministicBluestacksId(k2);
    const matId = randomUUID();
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: k1,
        displayName: 'P1',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: false,
      },
      {
        instanceKey: k2,
        displayName: 'P2',
        adbPort: 5566,
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
      accountName: 'Active Pure Browse',
    });
    store.groupBumper.upsertTargets('groups', {
      items: [{ id: '991100', name: 'Grp1', folderId: null }],
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '881100', name: 'Pg1', folderId: null }],
    });
    store.groupPoster.saveMaterials({ items: [{ id: matId, caption: 'Hi', selected: true }] });

    store.bluestacks.saveRiskLimitSettings({
      enabled: true,
      dailyMaxTotalActions: 60,
      dailyMaxBumps: 30,
      dailyMaxPosts: 1,
      dailyMaxInvites: 20,
      dailyMaxActiveLikes: 25,
    });
    store.postBumpRecords.insert({
      recordType: 'post',
      carrier: 'bluestacks',
      status: 'success',
      profileId: id2,
      accountId: '10002',
      groupId: '991100',
      postId: '123456',
    });

    const closedIds: string[] = [];
    let inspectCalledForMissing = false;
    const activeRuns: string[] = [];
    let holdBumperResolve!: () => void;
    const holdBumper = new Promise<void>((r) => {
      holdBumperResolve = r;
    });

    const service = new BluestacksService(
      store.bluestacks,
      {
        getOnlineKeys: () => new Set([k1, k2]),
        discoverInstances: async () => ({
          instances: store.bluestacks.listInstances([k1, k2]),
          config: {
            installDir: null,
            confPath: null,
            detectedInstallDir: null,
            detectedConfPath: null,
            adbReady: true,
            playerReady: true,
          },
        }),
        launchInstance: async (id) => store.bluestacks.getInstance(id)!,
        closeInstance: async (id) => {
          closedIds.push(id);
        },
        inspectAccount: async (id) => {
          if (id === id1) inspectCalledForMissing = true;
          return store.bluestacks.getInstance(id)!;
        },
        probeFbLiteInstalled: async (serial) => (serial.endsWith('5565') ? false : true),
      },
      {
        run: async () => {
          await holdBumper;
        },
      },
      new FeatureExecutionRegistry(),
      {
        activeRunner: {
          run: async (id) => {
            activeRuns.push(id);
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
        posterRunner: { run: async () => ({ posted: 1, skipped: 0, notes: [] }) },
        inviterRunner: { run: async () => ({ invited: 1, skippedGroups: 0, notes: [] }) },
        listPosterMaterials: () => store.groupPoster.materials(),
      },
    );
    const wb = new Workboard({ bluestacksConcurrency: 2 });
    service.setWorkboard(wb);
    assert.equal(
      resolvePatrolCap({ workboard: wb } as Parameters<typeof resolvePatrolCap>[0], 10),
      2,
    );
    assert.equal(
      resolvePatrolCap({ workboard: wb } as Parameters<typeof resolvePatrolCap>[0], Number.NaN),
      1,
    );

    await service.startHealthCheck({
      instanceIds: [id1],
      maxConcurrency: 10,
      autoLaunch: false,
      autoInstallApk: false,
      closeOnFinish: false,
    });
    for (let i = 0; i < 40 && (await service.state(false)).healthCheck?.running; i++)
      await new Promise((r) => setTimeout(r, 15));
    const hc = (await service.state(false)).healthCheck;
    assert.equal(hc?.missingApp, 1);
    assert.equal(hc?.launchFailed, 0);
    assert.equal(hc?.items[0]?.category, 'missing-app');

    const schedHc = await service.runScheduledHealthCheckStep({
      instanceId: id1,
      autoInstallApk: false,
      onProgress: () => {},
    });
    assert.equal(schedHc.category, 'missing-app');
    assert.equal(schedHc.hardBlocked, true);
    assert.equal(inspectCalledForMissing, false);

    await service.startActive({
      instanceIds: [id2],
      quickStep: { type: 'marketplace', durationMinutes: 1 },
    });
    for (let i = 0; i < 40 && (await service.state(false)).activeRunning; i++)
      await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(activeRuns, [id2]);
    assert.equal(store.bluestacks.dailyInstanceUsage().perInstance[id2]?.postsToday, 1);

    await service.startBumper({
      profileIds: [id2],
      groupIds: ['991100'],
      pageIds: ['881100'],
      closeWindowOnFinish: true,
    });
    const busySched = await service.runScheduledActiveStep({
      instanceId: id2,
      quickStep: { type: 'feed', maxLikes: 0 },
      onProgress: () => {},
    });
    assert.match(busySched.status, /正忙|正在执行/);
    holdBumperResolve();
    for (let i = 0; i < 50 && (await service.state(false)).running; i++)
      await new Promise((r) => setTimeout(r, 15));
    assert.ok(closedIds.includes(id2));
    assert.equal(wb.bluestacksPermits.used, 0);

    // 5. Standalone startPoster & startInviter with closeWindowOnFinish
    store.bluestacks.saveRiskLimitSettings({
      enabled: true,
      dailyMaxTotalActions: 60,
      dailyMaxBumps: 30,
      dailyMaxPosts: 10,
      dailyMaxInvites: 20,
      dailyMaxActiveLikes: 25,
    });
    closedIds.length = 0;
    await service.startPoster({
      instanceIds: [id2],
      materialIds: [matId],
      groupIds: ['991100'],
      closeWindowOnFinish: true,
    });
    for (let i = 0; i < 50 && (await service.state(false)).posterRunning; i++)
      await new Promise((r) => setTimeout(r, 15));
    assert.ok(closedIds.includes(id2));

    // 5. Standalone startPoster & startInviter with closeWindowOnFinish
    store.bluestacks.saveRiskLimitSettings({
      enabled: true,
      dailyMaxTotalActions: 60,
      dailyMaxBumps: 30,
      dailyMaxPosts: 10,
      dailyMaxInvites: 20,
      dailyMaxActiveLikes: 25,
    });
    closedIds.length = 0;
    await service.startInviter({
      instanceIds: [id2],
      groupIds: ['991100'],
      invitesPerGroup: 2,
      closeWindowOnFinish: true,
    });
    for (let i = 0; i < 50 && (await service.state(false)).inviterRunning; i++)
      await new Promise((r) => setTimeout(r, 15));
    assert.ok(closedIds.includes(id2));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('W5 Inviter (MM/VI/TH + SQLite dedup), Instance Ops Abort + External Busy, Store clear unknown + batched usage, and MCP stop_bumper/columns/resolveIds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-w5-misc-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const inst = mkInstance('Pie64_inv');
    const groupId = '777888999';
    store.groupInviter.upsertGroups({ items: [{ groupId, groupName: 'SEA Group' }] });
    const preInvitedFriendId =
      'bs_' +
      createHash('sha256')
        .update(`${inst.numericAccountId}:alice myanmar`)
        .digest('hex')
        .slice(0, 16);
    store.groupInviter.recordInvites([
      {
        profileId: inst.id,
        accountId: inst.numericAccountId ?? '100011223344',
        friendId: preInvitedFriendId,
        friendName: 'Alice Myanmar',
        groupId,
      },
    ]);

    const invGroupXml = xmlDoc(nodeXml(0, 'ဖိတ်ခေါ်', '[40,520][260,590]', { click: true }));
    const invListXml = xmlDoc(
      nodeXml(0, 'ဖိတ်', '[620,260][840,320]', { click: true }) +
        nodeXml(1, 'Mời', '[620,380][840,440]', { click: true }) +
        nodeXml(2, 'เชิญ', '[620,500][840,560]', { click: true }) +
        nodeXml(3, 'ဖိတ်ပြီး', '[620,620][840,680]', { click: true }),
    );
    const tappedYs = new Set<number>();
    let inInviteList = false;
    let swipes = 0;
    const mkInvPng = () =>
      mkPng((c) => {
        c.fillStyle = '#1877f2';
        if (!inInviteList) c.fillRect(40, 520, 220, 70);
        else
          for (const y of [260, 380, 500, 620])
            if (!tappedYs.has(y + 30)) c.fillRect(620, y, 220, 60);
      });
    const invRunner = new BluestacksGroupInviterRunner(
      {
        ensureReadyAndLoggedIn: async () => inst,
        openDeepLink: async () => {
          inInviteList = false;
          swipes = 0;
        },
        detectAbnormalScreen: async () => null,
        dumpXml: async () => (inInviteList ? (swipes > 0 ? null : invListXml) : invGroupXml),
        screencap: async () => mkInvPng(),
        tap900: async (_s: string, _x: number, y: number) => {
          if (!inInviteList && y >= 500) inInviteList = true;
          else tappedYs.add(y);
        },
        swipe900: async () => {
          swipes++;
        },
        keyevent: async () => {},
      } as unknown as BluestacksDeviceManager,
      {
        recognizeBounds: async (_png, b) => {
          if (!inInviteList) return 'ဖိတ်ခေါ်';
          if (b.x1 >= 600)
            return b.y1 < 340 ? 'ဖိတ်' : b.y1 < 460 ? 'Mời' : b.y1 < 580 ? 'เชิญ' : 'ဖိတ်ပြီး';
          return b.y1 < 340
            ? 'Alice Myanmar'
            : b.y1 < 460
              ? 'Minh Vietnam'
              : b.y1 < 580
                ? 'Somchai Thai'
                : 'Done User';
        },
        close: () => {},
      },
      store.groupInviter,
    );
    const invOutcome = await invRunner.run(
      inst.id,
      [grpTarget(groupId, 'SEA Group')],
      5,
      new AbortController().signal,
      { status: () => {}, invited: () => {} },
    );
    assert.equal(invOutcome.invited, 2);

    const bsKey = 'Pie64_reset_test';
    const bsId = deterministicBluestacksId(bsKey);
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: bsKey,
        displayName: 'ResetTest',
        adbPort: 5577,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    store.bluestacks.saveInspectionResult({
      id: bsId,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '615000111222',
      numericAccountId: '615000111222',
      accountName: 'Reset Me',
      identityType: 'page',
      avatarUrl:
        'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoBAAEAAUAmJYgCdAEO/gHOAAD++P////////////////////8AAAA=',
    });
    const resetInst = store.bluestacks.saveInspectionResult({
      id: bsId,
      fbLiteInstalled: true,
      accountState: 'unknown',
    });
    assert.equal(resetInst.numericAccountId, '');
    assert.equal(resetInst.avatarUrl, null);
    assert.equal(resetInst.identityType, 'unknown');

    const registry = new FeatureExecutionRegistry();
    let externalBusy = true;
    registry.register({
      id: 'browser-external-mock',
      label: 'External Mock',
      isProfileRunning: (id) => externalBusy && id === bsId,
      hasActiveExecution: () => externalBusy,
      stopProfiles: async () => {},
    });
    let apkAborted = false;
    const svc = new BluestacksService(
      store.bluestacks,
      {
        getOnlineKeys: () => new Set([bsKey]),
        discoverInstances: async () => ({
          instances: store.bluestacks.listInstances([bsKey]),
          config: {
            installDir: null,
            confPath: null,
            detectedInstallDir: null,
            detectedConfPath: null,
            adbReady: true,
            playerReady: true,
          },
        }),
        launchInstance: async () => store.bluestacks.getInstance(bsId)!,
        closeInstance: async () => {},
        inspectAccount: async () => store.bluestacks.getInstance(bsId)!,
        installFbLiteApk: async (_id, _apk, sig) =>
          await new Promise<BluestacksInstance>((_r, reject) => {
            sig?.addEventListener('abort', () => {
              apkAborted = true;
              reject(new Error('TASK_STOPPED'));
            });
          }),
      },
      { run: async () => {} },
      registry,
    );
    await assert.rejects(() => svc.installApk({ instanceIds: [bsId] }), /正忙/);
    externalBusy = false;
    await svc.installApk({ instanceIds: [bsId] });
    await new Promise((r) => setTimeout(r, 20));
    await svc.stopBatchOp([bsId]);
    assert.equal(apkAborted, true);

    const stopCalls: Array<{ ids?: readonly string[]; mode?: string }> = [];
    let stateCalls = 0;
    const fakeBs = {
      state: async () => {
        stateCalls++;
        return {
          instances: [inst],
          folders: [],
          config: {
            installDir: null,
            confPath: null,
            detectedInstallDir: null,
            detectedConfPath: null,
            adbReady: true,
            playerReady: true,
          },
          bumperSettings: BumperSettings.parse({}),
          pageBumperSettings: BumperSettings.parse({}),
          running: true,
          pageBumperRunning: true,
          launchingIds: [],
          closingIds: [],
          inspectingIds: [],
          statusText: '',
          pageBumperStatusText: '',
          profileCounts: {},
          pageBumperProfileCounts: {},
          total: 0,
          pageTotal: 0,
        };
      },
      stopBumper: async (ids?: readonly string[], mode?: string) => (
        stopCalls.push({ ids, mode }),
        fakeBs.state()
      ),
    };
    const [bsTool] = createBluestacksTools({
      bluestacksService: fakeBs as unknown as WorkbenchMcpDependencies['bluestacksService'],
      getGroupBumperService: () => undefined,
    } as unknown as WorkbenchMcpDependencies);
    assert.equal(bsTool?.inputSchema.properties.columns?.maximum, 10);
    await bsTool?.handler({ action: 'stop_bumper', instanceIds: [inst.instanceKey] });
    assert.deepEqual(stopCalls, [{ ids: [inst.id], mode: 'group' }]);
    assert.equal(stateCalls, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
