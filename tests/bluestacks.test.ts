import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  SqliteBluestacksRepository,
  deterministicBluestacksId,
} from '../src/infrastructure/bluestacks-store.js';
import { parseBluestacksConfContent } from '../src/infrastructure/bluestacks-device-manager.js';
import { BluestacksGroupBumperRunner } from '../src/infrastructure/bluestacks-bumper-runner.js';
import { persistenceRoutes } from '../src/infrastructure/persistence-routes.js';
import type { CompatibleRepository } from '../src/domain/persistence.js';
import {
  classifyAbnormalScreenText,
  compareAvatarToRegion,
  cropToDataUrl,
  detectBottomSheetIdentityRows,
  detectHomeTabBar,
  detectVideoSpeakerState,
  extractActionBars,
  extractInlineVideoControls,
  extractPostCards,
  extractReactionPopupButtons,
  findAllTextInputNodes,
  isBottomSheetOpen,
  isDarkScreenOrReelMode,
  isLikeButtonBlue,
  isReactionButtonActive,
  isSolidBlueButton,
  makeCanonicalRect,
  parseDumpsysTop,
  parseLiteXml,
  resolveSharePostUrl,
  scalePointFrom900,
} from '../src/infrastructure/bluestacks-vision.js';
import {
  closeBlueStacksPids,
  generateTotpCode,
  isPrintableAscii,
  quoteForAndroidInputText,
} from '../src/infrastructure/bluestacks-win32.js';
import { SaveAutoScheduleInput } from '../src/shared/auto-scheduler.js';
import {
  isValidTotpSecret,
  maskLoginAccountLabel,
  normalizeTotpSecret,
  parseBatchLoginText,
} from '../src/shared/bluestacks.js';
import { PostRecordsSheetConfig } from '../src/shared/google-sheets.js';
import {
  BluestacksService,
  type BluestacksBumperRunnerPort,
  type BluestacksDeviceController,
  type BluestacksServiceRepository,
} from '../src/application/bluestacks-service.js';
import {
  hasUnsupportedOcrScript,
  isBluestacksPortraitResolution,
  nameSimilarity,
  relativePostAge,
  type BluestacksInstance,
  type BluestacksRuntimeConfig,
} from '../src/shared/bluestacks.js';
import { BumperSettings } from '../src/shared/group-bumper.js';

test('deterministicBluestacksId produces stable RFC 4122 v4 UUIDs', () => {
  const idA1 = deterministicBluestacksId('Pie64_1');
  const idA2 = deterministicBluestacksId('Pie64_1');
  const idB = deterministicBluestacksId('Tiramisu64');

  assert.equal(idA1, idA2);
  assert.notEqual(idA1, idB);
  assert.match(idA1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(idB, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('relativePostAge handles multilingual timestamps and WinRT radical-split Chinese', () => {
  assert.equal(relativePostAge('刚刚 · 公开'), 0.02);
  assert.equal(relativePostAge('30 分钟 · 公开'), 0.5);
  assert.equal(relativePostAge('2 小时'), 2);
  assert.equal(relativePostAge('3 刂 小时 · 群组成员'), 3);
  assert.equal(relativePostAge('5 小 、 时'), 5);
  assert.equal(relativePostAge('2 天'), 48);
  assert.equal(relativePostAge('昨天 14:20'), 24);
  assert.equal(
    nameSimilarity('Grace Chapel', 'Grace Chapel Official'),
    nameSimilarity('Grace Chapel Official', 'Grace Chapel'),
  );
  assert.equal(isBluestacksPortraitResolution(720, 1280), true);
  assert.equal(isBluestacksPortraitResolution(900, 1600), true);
  assert.equal(isBluestacksPortraitResolution(1920, 1080), false);
});

test('parseBluestacksConfContent parses real BlueStacks multi-instance config cleanly', () => {
  const conf = [
    'bst.instance.Pie64.display_name="不使用"',
    'bst.instance.Pie64.status.adb_port="5555"',
    'bst.instance.Pie64.fb_width="1920"',
    'bst.instance.Pie64.fb_height="1080"',
    'bst.instance.Pie64_1.display_name="p023"',
    'bst.instance.Pie64_1.status.adb_port="5565"',
    'bst.instance.Pie64_1.fb_width="900"',
    'bst.instance.Pie64_1.fb_height="1600"',
    'bst.instance.Tiramisu64.display_name="kf7"',
    'bst.instance.Tiramisu64.status.adb_port="5555"',
    'bst.instance.Tiramisu64.fb_width="900"',
    'bst.instance.Tiramisu64.fb_height="1600"',
  ].join('\n');

  const parsed = parseBluestacksConfContent(conf);
  assert.equal(parsed.length, 3);
  const p023 = parsed.find((x) => x.instanceKey === 'Pie64_1');
  assert.ok(p023);
  assert.equal(p023.displayName, 'p023');
  assert.equal(p023.statusPort, 5565);
  assert.equal(p023.fbWidth, 900);
  assert.equal(p023.fbHeight, 1600);
});

test('SqliteBluestacksRepository shares targets/comments/logs with GroupBumper and preserves user customizations', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bluestacks-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const bs = store.bluestacks;
    const bumper = store.groupBumper;

    // 1. Add shared groups, pages, and comments via Browser GroupBumper repository
    bumper.upsertTargets('groups', {
      items: [{ id: '123456789012345', name: '测试共享小组', folderId: null }],
    });
    bumper.upsertTargets('pages', {
      items: [{ id: '987654321098765', name: '测试共享专页', folderId: null }],
    });
    bumper.saveComments({
      texts: ['阿门！感谢分享', '愿主赐福！'],
      consumeCommentOnUse: true,
    });
    bs.saveBumperSettings(BumperSettings.parse({ consumeCommentOnUse: true }));

    // Verify BlueStacks sees the exact same shared groups, pages, and comments
    assert.equal(bs.targets('groups').length, 1);
    assert.equal(bs.targets('groups')[0]?.name, '测试共享小组');
    assert.equal(bs.targets('pages').length, 1);
    assert.equal(bs.targets('pages')[0]?.name, '测试共享专页');
    assert.equal(bs.comments().length, 2);

    // 2. Upsert discovered instances & customize alias + folder
    const folder = bs.createFolder({ name: '主力模拟器组' });
    bs.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    const instId = deterministicBluestacksId('Pie64_1');
    bs.renameInstance({ id: instId, alias: '主力023号' });
    bs.reorderInstances({ folderId: folder.id, ids: [instId] });
    bs.saveInspectionResult({
      id: instId,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '100099887766',
      accountName: 'John Grace',
      avatarUrl:
        'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoBAAEAAUAmJYgCdAEO/gHOAAD++P////////////////////8AAAA=',
    });

    // Re-discover with updated port/resolution: anti-regression must preserve alias, folderId, accountName, avatarUrl!
    const refreshed = bs.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5575,
        fbWidth: 720,
        fbHeight: 1280,
        online: false,
        fbLiteInstalled: null,
      },
    ]);
    const item = refreshed.find((inst: BluestacksInstance) => inst.id === instId);
    assert.ok(item);
    assert.equal(item.alias, '主力023号');
    assert.equal(item.folderId, folder.id);
    assert.equal(item.accountName, 'John Grace');
    assert.equal(item.adbPort, 5575);
    assert.equal(item.fbWidth, 720);

    // 3. Record a bump via BlueStacks and verify shared stats & comment consumption
    const chosenComment = bs.pickComment('112233445566', 0.1, []);
    assert.ok(chosenComment);
    const recorded = bs.recordBump(
      {
        id: randomUUID(),
        profileId: instId,
        accountId: '100099887766',
        groupId: '123456789012345',
        groupName: '测试共享小组',
        pageId: '987654321098765',
        pageName: '测试共享专页',
        postId: '112233445566',
        postUrl: 'https://www.facebook.com/groups/123456789012345/posts/112233445566/',
        liked: true,
        commentText: chosenComment.text,
        bumpedAt: Date.now(),
      },
      chosenComment.id,
    );
    assert.equal(recorded, true);
    assert.equal(bs.total(), 1);
    assert.equal(bs.comments().length, 1); // consumed 1 of 2!
    assert.equal(bumper.targets('groups')[0]?.totalBumpedCount, 1);
    assert.equal(bumper.targets('pages')[0]?.totalBumpedCount, 1);

    // Eligibility blocks duplicate bump by same account on same post
    const elig = bs.eligibility('100099887766', instId, '112233445566');
    assert.equal(elig.duplicate, true);
    assert.equal(elig.allowed, false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SqliteBluestacksRepository works standalone on raw :memory: database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const repo = new SqliteBluestacksRepository(db);
    assert.equal(repo.listInstances().length, 0);
    assert.equal(repo.total(), 0);
  } finally {
    db.close();
  }
});

test('bluestacks-vision normalizes 720x1280 XML/dumpsys to canonical 900x1600 and verifies pixels', async () => {
  const scaled = scalePointFrom900(450, 800, 720, 1280);
  assert.deepEqual(scaled, { x: 360, y: 640 });

  const xml720 = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][720,1280]">
    <node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,160][720,240]">
      <node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[16,168][76,228]" />
      <node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[84,168][640,232]">
        <node index="0" text="Grace Page" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[84,168][360,198]" />
        <node index="1" text="2 小时" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[84,202][220,230]" />
      </node>
      <node index="2" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[656,168][712,224]" />
    </node>
    <node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,560][720,624]">
      <node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="赞" clickable="true" long-clickable="true" focused="false" scrollable="false" bounds="[16,564][240,620]" />
      <node index="1" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="评论" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[248,564][472,620]" />
      <node index="2" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="分享" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[480,564][704,620]" />
    </node>
  </node>
</hierarchy>`;

  const root = parseLiteXml(xml720, 720, 1280);
  assert.ok(root);
  assert.equal(root.bounds.x2, 900);
  assert.equal(root.bounds.y2, 1600);

  const bars = extractActionBars(root);
  assert.equal(bars.length, 1);
  const cards = extractPostCards(root);
  assert.equal(cards.length, 1);
  assert.ok(cards[0]?.actionBar);
  assert.equal(cards[0].actionBar.likeBounds.x1, 20); // 16 * (900/720) = 20

  const dumpsysSample = [
    '  ACTIVITY com.facebook.lite/.MainActivity 1234abcd pid=999',
    '    mResumed=true mStopped=false',
    '    View Hierarchy:',
    '      com.android.internal.policy.DecorView{abc V.E...... ........ 0,0-720,1280}',
    '        android.view.ViewGroup{def V.E...C.. ........ 16,564-240,620}',
  ].join('\n');
  const dumpRoot = parseDumpsysTop(dumpsysSample, 720, 1280);
  assert.ok(dumpRoot);
  assert.equal(dumpRoot.bounds.x2, 900);
  assert.equal(dumpRoot.bounds.y2, 1600);

  // Canvas pixel tests: white screen with a Facebook-blue Like icon
  const canvas = createCanvas(900, 1600);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 1600);
  ctx.fillStyle = '#1877f2';
  ctx.fillRect(95, 715, 45, 35);
  const pngWhiteBlue = canvas.toBuffer('image/png');

  const likeRect = makeCanonicalRect(20, 705, 300, 775);
  assert.equal(await isLikeButtonBlue(pngWhiteBlue, likeRect), true);
  assert.equal(await isBottomSheetOpen(pngWhiteBlue), false);
  assert.equal(await isDarkScreenOrReelMode(pngWhiteBlue), false);

  const avatarRegion = makeCanonicalRect(80, 700, 160, 780);
  const avatarDataUrl = await cropToDataUrl(pngWhiteBlue, avatarRegion, 96);
  assert.ok(avatarDataUrl);
  assert.match(avatarDataUrl, /^data:image\/webp;base64,/);
  const sim = await compareAvatarToRegion(pngWhiteBlue, avatarRegion, avatarDataUrl);
  assert.ok(sim > 0.92, `expected high self-similarity, got ${sim}`);

  // Dark Reel mode screen
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, 900, 1600);
  const pngDark = canvas.toBuffer('image/png');
  assert.equal(await isDarkScreenOrReelMode(pngDark), true);
});

test('BluestacksService enforces portrait resolution, concurrency cap, and confirmed stopBumper', async () => {
  const portraitId = deterministicBluestacksId('Pie64_1');
  const portraitId2 = deterministicBluestacksId('Pie64_2');
  const landscapeId = deterministicBluestacksId('Pie64');

  const mockInstances: BluestacksInstance[] = [
    {
      id: portraitId,
      instanceKey: 'Pie64_1',
      displayName: 'p023',
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
      accountId: '10001',
      accountName: 'User1',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
    {
      id: portraitId2,
      instanceKey: 'Pie64_2',
      displayName: 'p024',
      alias: null,
      folderId: null,
      sortOrder: 1,
      adbPort: 5575,
      serial: '127.0.0.1:5575',
      fbWidth: 720,
      fbHeight: 1280,
      online: true,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '10002',
      accountName: 'User2',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
    {
      id: landscapeId,
      instanceKey: 'Pie64',
      displayName: '不使用',
      alias: null,
      folderId: null,
      sortOrder: 2,
      adbPort: 5555,
      serial: '127.0.0.1:5555',
      fbWidth: 1920,
      fbHeight: 1080,
      online: true,
      fbLiteInstalled: false,
      accountState: 'unknown',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
  ];

  const config: BluestacksRuntimeConfig = {
    installDir: null,
    confPath: null,
    detectedInstallDir: 'C:\\Program Files\\BlueStacks_nxt',
    detectedConfPath: 'D:\\BlueStacks_nxt\\bluestacks.conf',
    adbReady: true,
    playerReady: true,
  };

  let currentSettings = BumperSettings.parse({ maxConcurrentProfiles: 1 });
  const repo: CompatibleRepository<BluestacksServiceRepository> = {
    savedSettings: async () => ({
      installDir: null,
      confPath: null,
      bumperSettings: currentSettings,
    }),
    savePaths: async () => ({
      installDir: null,
      confPath: null,
      bumperSettings: currentSettings,
    }),
    saveBumperSettings: async (input: unknown) => {
      currentSettings = BumperSettings.parse(input);
      return currentSettings;
    },
    folders: async () => [],
    createFolder: async () => {
      throw new Error('unused');
    },
    renameFolder: async () => {
      throw new Error('unused');
    },
    deleteFolder: async () => {},
    reorderFolders: async () => {},
    listInstances: async () => mockInstances,
    getInstance: async (id: string) => mockInstances.find((i) => i.id === id) ?? null,
    renameInstance: async () =>
      mockInstances[0] ??
      (() => {
        throw new Error('empty');
      })(),
    reorderInstances: async () => {},
    deleteInstances: async () => 0,
    saveLastStatus: async () => {},
    targets: async (kind: 'groups' | 'pages') => [
      {
        id: kind === 'groups' ? '111222333444' : '555666777888',
        name: kind === 'groups' ? 'Group1' : 'Page1',
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalBumpedCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    todayCounts: async () => ({}),
    total: async () => 0,
  };

  const devices: BluestacksDeviceController = {
    getOnlineKeys: () => new Set(['Pie64_1', 'Pie64_2', 'Pie64']),
    discoverInstances: async () => ({ config, instances: mockInstances }),
    launchInstance: async () =>
      mockInstances[0] ??
      (() => {
        throw new Error('empty');
      })(),
    closeInstance: async () => {},
    inspectAccount: async () =>
      mockInstances[0] ??
      (() => {
        throw new Error('empty');
      })(),
  };

  let concurrentNow = 0;
  let maxObservedConcurrent = 0;
  const runner: BluestacksBumperRunnerPort = {
    run: async (_id, _groups, _pages, _settings, signal) => {
      concurrentNow++;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrentNow);
      try {
        await new Promise<void>((resolveRun, rejectRun) => {
          const timer = setTimeout(resolveRun, 5000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              rejectRun(new Error('TASK_STOPPED'));
            },
            { once: true },
          );
        });
      } finally {
        concurrentNow--;
      }
    },
  };

  const service = new BluestacksService(repo, devices, runner);

  // Starting ONLY the landscape instance should throw NO_ONLINE_PORTRAIT_INSTANCES
  await assert.rejects(
    () =>
      service.startBumper({
        profileIds: [landscapeId],
        groupIds: ['111222333444'],
        pageIds: ['555666777888'],
      }),
    /横屏/,
  );

  // Starting 2 portrait instances with maxConcurrentProfiles = 1 must cap concurrency at 1
  const startedState = await service.startBumper({
    profileIds: [portraitId, portraitId2],
    groupIds: ['111222333444'],
    pageIds: ['555666777888'],
  });
  assert.equal(startedState.running, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(maxObservedConcurrent, 1);

  // stopBumper awaits worker termination before returning running=false
  const stoppedState = await service.stopBumper();
  assert.equal(stoppedState.running, false);
  assert.equal(concurrentNow, 0);
});

test('real-world FB Lite regressions: inner carousel RecyclerView, sticky join footer, y1=94 header, circular avatar mask, and Myanmar script detection', async () => {
  assert.equal(hasUnsupportedOcrScript('Grace Chapel Official 2026'), false);
  assert.equal(hasUnsupportedOcrScript('恩典小组分享'), false);
  assert.equal(hasUnsupportedOcrScript('ကျမ်းစာဖတ်ခြင်းနှင့် အသက်တာ | Bangkok'), true);
  assert.equal(hasUnsupportedOcrScript('ငါယေရှုကိုချစ်တယ်'), true);

  const xmlWithInnerCarouselAndStickyFooter = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]">
    <node index="0" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="true" bounds="[0,104][900,1600]">
      <node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,94][900,188]">
        <node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[18,105][92,179]" />
        <node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[108,105][800,180]">
          <node index="0" text="ကျမ်းစာဖတ်ခြင်း" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[108,105][540,145]" />
          <node index="1" text="1天" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[108,148][210,176]" />
        </node>
        <node index="2" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[820,105][888,173]" />
      </node>
      <node index="1" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,710][900,784]">
        <node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="赞" clickable="true" long-clickable="true" focused="false" scrollable="false" bounds="[18,714][298,780]" />
        <node index="1" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="评论" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[308,714][588,780]" />
        <node index="2" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="分享" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[598,714][878,780]" />
      </node>
      <node index="2" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="true" bounds="[0,810][900,1430]" />
      <node index="3" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,1445][900,1520]">
        <node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="赞" clickable="true" long-clickable="true" focused="false" scrollable="false" bounds="[18,1450][298,1516]" />
        <node index="1" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="评论" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[308,1450][588,1516]" />
        <node index="2" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="分享" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[598,1450][878,1516]" />
      </node>
    </node>
    <node index="1" text="加入小组" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="加入小组" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[36,1456][864,1528]" />
  </node>
</hierarchy>`;

  const root = parseLiteXml(xmlWithInnerCarouselAndStickyFooter, 900, 1600);
  assert.ok(root);
  const bars = extractActionBars(root);
  // Only the visible actionBar at y=710..784 is returned; the one at y=1450..1516 covered by [加入小组] is excluded
  assert.equal(bars.length, 1);
  assert.equal(bars[0]?.y1, 714);

  const cards = extractPostCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.header.bounds.y1, 94);
  assert.ok(cards[0]?.actionBar);

  // Reference square avatar (with dark corners) vs FB Lite circular-masked avatar on white feed background
  const refCanvas = createCanvas(96, 96);
  const rctx = refCanvas.getContext('2d');
  rctx.fillStyle = '#1b2a4a';
  rctx.fillRect(0, 0, 96, 96);
  rctx.fillStyle = '#e59f28';
  rctx.beginPath();
  rctx.arc(48, 42, 24, 0, Math.PI * 2);
  rctx.fill();
  const refDataUrl = `data:image/png;base64,${refCanvas.toBuffer('image/png').toString('base64')}`;

  const screenCanvas = createCanvas(900, 1600);
  const sctx = screenCanvas.getContext('2d');
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, 900, 1600);
  sctx.save();
  sctx.beginPath();
  sctx.arc(55, 142, 37, 0, Math.PI * 2);
  sctx.clip();
  // Simulate FB Lite 84% center-zoomed avatar crop
  sctx.drawImage(refCanvas, 8, 8, 80, 80, 18, 105, 74, 74);
  sctx.restore();
  // Simulate FB Lite bottom-right green online status dot + white ring
  sctx.fillStyle = '#ffffff';
  sctx.beginPath();
  sctx.arc(82, 168, 13, 0, Math.PI * 2);
  sctx.fill();
  sctx.fillStyle = '#31a24c';
  sctx.beginPath();
  sctx.arc(82, 168, 10, 0, Math.PI * 2);
  sctx.fill();
  const screenPng = screenCanvas.toBuffer('image/png');

  const otherCanvas = createCanvas(96, 96);
  const octx = otherCanvas.getContext('2d');
  octx.fillStyle = '#c9efd8';
  octx.fillRect(0, 0, 96, 96);
  octx.fillStyle = '#1d8a4e';
  octx.fillRect(10, 56, 76, 30);
  const otherDataUrl = `data:image/png;base64,${otherCanvas.toBuffer('image/png').toString('base64')}`;

  const avatarBounds = makeCanonicalRect(18, 105, 92, 179);
  const matchSim = await compareAvatarToRegion(screenPng, avatarBounds, refDataUrl);
  const mismatchSim = await compareAvatarToRegion(screenPng, avatarBounds, otherDataUrl);
  assert.ok(
    matchSim >= 0.9,
    `expected zoomed + green-dot circular avatar match >= 0.90, got ${matchSim}`,
  );
  assert.ok(mismatchSim < 0.72, `expected non-matching avatar < 0.72, got ${mismatchSim}`);
});

test('BlueStacks Page Bumper: isolated page_bumper_settings, source_mode=page accounting, resolveSharePostUrl(page), and mode-isolated BluestacksService', async () => {
  // 1. resolveSharePostUrl in 'page' mode produces clean Page/Reel URLs without /groups/
  const reelUrl = await resolveSharePostUrl(
    'https://www.facebook.com/reel/2320501665162878/?app=fbl&mibextid=abc',
    '442296708973923',
    'page',
  );
  assert.equal(reelUrl.postId, '2320501665162878');
  assert.equal(reelUrl.postUrl, 'https://www.facebook.com/reel/2320501665162878/');

  const storyUrl = await resolveSharePostUrl(
    'https://www.facebook.com/permalink.php?story_fbid=9988776655443322&id=61588452821652&app=fbl',
    '61588452821652',
    'page',
  );
  assert.equal(storyUrl.postId, '9988776655443322');
  assert.equal(
    storyUrl.postUrl,
    'https://www.facebook.com/permalink.php?story_fbid=9988776655443322&id=61588452821652',
  );

  const pfbidUrl = await resolveSharePostUrl(
    'https://www.facebook.com/61588452821652/posts/pfbid02xyzAbc12345/?app=fbl',
    '61588452821652',
    'page',
  );
  assert.match(pfbidUrl.postId, /^\d+$/);
  assert.equal(
    pfbidUrl.postUrl,
    'https://www.facebook.com/61588452821652/posts/pfbid02xyzAbc12345/',
  );
  assert.equal(pfbidUrl.postUrl.includes('/groups/'), false);

  // 2. SqliteBluestacksRepository isolates page_bumper_settings, page comments, and source_mode='page' stats
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bs-page-bumper-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  let activeService: BluestacksService | null = null;
  try {
    const bs = store.bluestacks;
    const bumper = store.groupBumper;
    const instId = deterministicBluestacksId('Pie64_1');

    bs.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    bumper.upsertTargets('pages', {
      items: [{ id: '61588452821652', name: 'Grace Myanmar Page', folderId: null }],
    });
    bumper.saveComments(
      { texts: ['专页专属留言1', '专页专属留言2'], consumeCommentOnUse: true },
      'page',
    );
    bumper.saveComments({ texts: ['小组留言A'], consumeCommentOnUse: false }, 'group');

    bs.saveBumperSettings(
      BumperSettings.parse({ maxPostsPerPage: 3, dailyMaxLikesPerAccount: 10 }),
    );
    bs.savePageBumperSettings(
      BumperSettings.parse({
        maxPostsPerPage: 7,
        dailyMaxLikesPerAccount: 25,
        consumeCommentOnUse: true,
      }),
    );

    const saved = bs.savedSettings();
    assert.equal(saved.bumperSettings.maxPostsPerPage, 3);
    assert.equal(saved.pageBumperSettings.maxPostsPerPage, 7);
    assert.equal(saved.pageBumperSettings.dailyMaxLikesPerAccount, 25);

    assert.equal(bs.comments('page').length, 2);
    assert.equal(bs.comments('group').length, 1);

    const pickedPageComment = bs.pickComment('2320501665162878', 0.2, [], 'page');
    assert.ok(pickedPageComment);
    assert.match(pickedPageComment.text, /^专页专属留言/);

    const ok = bs.recordBump(
      {
        id: randomUUID(),
        profileId: instId,
        accountId: '1000556677',
        groupId: '-',
        groupName: '专页主页',
        pageId: '61588452821652',
        pageName: 'Grace Myanmar Page',
        postId: '2320501665162878',
        postUrl: 'https://www.facebook.com/reel/2320501665162878/',
        liked: true,
        commentText: pickedPageComment.text,
        bumpedAt: Date.now(),
        sourceMode: 'page',
      },
      pickedPageComment.id,
    );
    assert.equal(ok, true);
    assert.equal(bs.total('page'), 1);
    assert.equal(bs.total('group'), 0);
    assert.equal(bs.todayCounts(Date.now(), 'page')[instId], 1);
    assert.equal(bs.todayCounts(Date.now(), 'group')[instId] ?? 0, 0);
    assert.equal(bs.comments('page').length, 1); // consumed from page scope only
    assert.equal(bs.comments('group').length, 1); // group comment untouched
    assert.equal(bumper.targets('pages')[0]?.totalBumpedCount, 1);

    // 3. BluestacksService isolates group vs page modes while blocking same-instance collision
    const instId2 = deterministicBluestacksId('Pie64_2');
    bs.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
      {
        instanceKey: 'Pie64_2',
        displayName: 'p024',
        adbPort: 5575,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    bumper.upsertTargets('groups', {
      items: [{ id: '123456789012', name: 'Test Group', folderId: null }],
    });

    const observedModes: Array<{ id: string; mode: string }> = [];
    const devices: BluestacksDeviceController = {
      getOnlineKeys: () => new Set(['Pie64_1', 'Pie64_2']),
      discoverInstances: async () => ({
        config: {
          installDir: null,
          confPath: null,
          detectedInstallDir: 'C:\\Program Files\\BlueStacks_nxt',
          detectedConfPath: 'D:\\BlueStacks_nxt\\bluestacks.conf',
          adbReady: true,
          playerReady: true,
        },
        instances: bs.listInstances(['Pie64_1', 'Pie64_2']),
      }),
      launchInstance: async (id) => bs.getInstance(id)!,
      closeInstance: async () => {},
      inspectAccount: async (id) => bs.getInstance(id)!,
    };
    const runner: BluestacksBumperRunnerPort = {
      run: async (id, _groups, _pages, _settings, signal, _cb, mode = 'group') => {
        observedModes.push({ id, mode });
        await new Promise<void>((resolveRun, rejectRun) => {
          const timer = setTimeout(resolveRun, 5000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              rejectRun(new Error('TASK_STOPPED'));
            },
            { once: true },
          );
        });
      },
    };

    const service = new BluestacksService(bs, devices, runner);
    activeService = service;
    const pageStarted = await service.startPageBumper({
      profileIds: [instId],
      pageIds: ['61588452821652'],
    });
    assert.equal(pageStarted.pageBumperRunning, true);
    assert.equal(pageStarted.running, false);

    // Attempting to start group bumper on the SAME running instance must skip it and reject with ALL_INSTANCES_BUSY
    await assert.rejects(
      () =>
        service.startBumper({
          profileIds: [instId],
          groupIds: ['123456789012'],
          pageIds: ['61588452821652'],
        }),
      /所选模拟器已在运行队列中/,
    );

    // Starting group bumper on a DIFFERENT instance runs concurrently in isolated mode
    const bothRunning = await service.startBumper({
      profileIds: [instId2],
      groupIds: ['123456789012'],
      pageIds: ['61588452821652'],
    });
    assert.equal(bothRunning.pageBumperRunning, true);
    assert.equal(bothRunning.running, true);
    await new Promise((r) => setTimeout(r, 720));
    assert.deepEqual(observedModes, [
      { id: instId, mode: 'page' },
      { id: instId2, mode: 'group' },
    ]);

    // Stopping ONLY page bumper leaves group bumper running!
    const afterPageStop = await service.stopBumper(undefined, 'page');
    assert.equal(afterPageStop.pageBumperRunning, false);
    assert.equal(afterPageStop.running, true);

    const afterGroupStop = await service.stopBumper(undefined, 'group');
    assert.equal(afterGroupStop.running, false);
  } finally {
    if (activeService) {
      await activeService.stopBumper().catch(() => {});
    }
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistenceRoutes registers every SqliteBluestacksRepository method including savePageBumperSettings', () => {
  const protoMethods = Object.getOwnPropertyNames(SqliteBluestacksRepository.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      !name.startsWith('map') &&
      typeof (SqliteBluestacksRepository.prototype as unknown as Record<string, unknown>)[name] ===
        'function',
  );
  for (const method of protoMethods) {
    assert.equal(
      persistenceRoutes.has(`workspace.bluestacks.${method}`),
      true,
      `missing persistence worker route: workspace.bluestacks.${method}`,
    );
  }
});

test('extractPostCards detects dumpsys Page headers with trailing avatar child and runner does not skip consecutive tall posts', async () => {
  // Real FB Lite Page dumpsys structure (non-Story Page 100085926219692):
  // children[0] = author/timestamp (91..853), children[1] = more menu (853..895), children[2] = avatar (19..74)
  const dumpsysPageFeed = [
    '  ACTIVITY com.facebook.lite/.deeplinking.activities.PermalinkPossiblePatternsActivityAlias cd0d6b3 pid=4164',
    '    mResumed=true mStopped=false',
    '    View Hierarchy:',
    '      DecorView@30a68f9[PermalinkPossiblePatternsActivityAlias]',
    '        android.widget.FrameLayout{40c3bec V.E...... ........ 0,36-900,1600}',
    '          com.facebook.lite.ui.LiteSwipeRefreshLayout{717cadb V.ED..... ........ 0,70-900,1492}',
    '            X.10N{5524978 VFED..... ........ 0,0-900,1422 #44}',
    '              X.0hs{5ccfa20 V.ED..... ........ 0,785-900,879}',
    '                X.0hp{c8b09e2 VFED..C.. ........ 0,1-900,94}',
    '                  X.0hp{1d91830 VFED..C.. ........ 91,11-853,74}',
    '                    X.0hp{13c6fd9 VFED..C.. ........ 2,8-251,40}',
    '                  X.0hp{b024173 VFED..C.. ........ 853,11-895,59}',
    '                  X.0hp{1b702ad VFED..C.. ........ 19,19-74,74}',
    '              X.0hs{a40807f V.ED..... ........ 0,879-900,2102}',
    '                X.0hp{cd3e22e VFED..C.. ........ 0,98-900,1223}',
  ].join('\n');
  const parsedFeed = parseDumpsysTop(dumpsysPageFeed, 900, 1600);
  const extracted = extractPostCards(parsedFeed);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0]?.header.avatarBounds.x1, 19);
  assert.equal(extracted[0]?.header.avatarBounds.x2, 74);
  assert.equal(extracted[0]?.header.moreMenuBounds?.x1, 853);
  assert.equal(extracted[0]?.actionBar, null);

  // Simulate 3 consecutive tall posts on a Page timeline where each alignStep swipe exposes BOTH
  // the current post's actionBar (y=201..261) AND the NEXT post's header right below it (y=269..363)!
  const makeFramePng = (likedBlue: boolean, bandSeed: number) => {
    const c = createCanvas(900, 1600);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 1600);
    // Distinct post body texture so seenCardSigs distinguishes posts #1, #2, #3
    ctx.fillStyle = `rgb(${(bandSeed * 67) % 200}, ${(bandSeed * 113) % 200}, ${(bandSeed * 179) % 200})`;
    ctx.fillRect(30 + bandSeed * 80, 360, 220, 120);
    ctx.fillRect(40 + bandSeed * 70, 990, 240, 120);
    if (likedBlue) {
      ctx.fillStyle = '#1877f2';
      ctx.fillRect(90, 212, 60, 34);
    }
    return c.toBuffer('image/png');
  };

  // Screen states across the run:
  // 0: enterAndVerifyPage initial hero (0 cards -> triggers 1 downward swipe)
  // 1: scrollIdx=0 recoverToFeed -> Post #1 header at relY=785 (actionBar offscreen)
  // 2: Post #1 alignStep=0 -> Post #1 actionBar at abs y=201..261 AND Post #2 header at abs y=269..363
  // 3: scrollIdx=1 recoverToFeed (NO extra blind swipe!) -> sees Post #2 header at abs y=269..363
  // 4: Post #2 alignStep=0 -> Post #2 actionBar at abs y=201..261 AND Post #3 header at abs y=269..363
  // 5: scrollIdx=2 recoverToFeed (NO extra blind swipe!) -> sees Post #3 header at abs y=269..363
  // 6: Post #3 alignStep=0 -> Post #3 actionBar at abs y=201..261
  const heroXml = parseDumpsysTop(
    [
      '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
      '    mResumed=true',
      '    View Hierarchy:',
      '      DecorView@1[MainActivity]',
      '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
      '          X.0hp{2 VFED..C.. ........ 311,197-608,494}',
    ].join('\n'),
    900,
    1600,
  );
  const barPlusNextHeaderXml = parseDumpsysTop(
    [
      '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
      '    mResumed=true',
      '    View Hierarchy:',
      '      DecorView@1[MainActivity]',
      '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
      '          X.0hs{10 V.ED..... ........ 0,57-900,160}',
      '            X.0hp{11 VFED..CL. ........ 0,38-300,98}',
      '            X.0hp{12 VFED..C.. ........ 300,38-600,98}',
      '            X.0hp{13 VFED..C.. ........ 600,38-900,98}',
      '          X.0hs{20 V.ED..... ........ 0,163-900,257}',
      '            X.0hp{21 VFED..C.. ........ 0,1-900,94}',
      '              X.0hp{22 VFED..C.. ........ 91,11-853,74}',
      '                X.0hp{23 VFED..C.. ........ 2,8-251,40}',
      '              X.0hp{24 VFED..C.. ........ 853,11-895,59}',
      '              X.0hp{25 VFED..C.. ........ 19,19-74,74}',
      '          X.0hs{30 V.ED..... ........ 0,257-900,1480}',
      '            X.0hp{31 VFED..C.. ........ 0,98-900,1223}',
    ].join('\n'),
    900,
    1600,
  );
  const finalBarOnlyXml = parseDumpsysTop(
    [
      '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
      '    mResumed=true',
      '    View Hierarchy:',
      '      DecorView@1[MainActivity]',
      '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
      '          X.0hs{10 V.ED..... ........ 0,57-900,160}',
      '            X.0hp{11 VFED..CL. ........ 0,38-300,98}',
      '            X.0hp{12 VFED..C.. ........ 300,38-600,98}',
      '            X.0hp{13 VFED..C.. ........ 600,38-900,98}',
    ].join('\n'),
    900,
    1600,
  );

  let stage = 0;
  let lastTappedLike = false;
  let copyIdx = 0;
  const copiedPostIds = ['1121088760765321', '1120647960809401', '1116788727861991'];

  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bs-tall-posts-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const instId = deterministicBluestacksId('Pie64_1');
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    store.bluestacks.saveInspectionResult({
      id: instId,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: 'p023 (Mawi Lee)',
      accountName: 'Mawi Lee',
      fbWidth: 900,
      fbHeight: 1600,
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '100085926219692', name: 'မြန်မာခရစ်ယာန်များ၏အိမ်တော်', folderId: null }],
    });

    const fakeDevices = {
      ensureReadyAndLoggedIn: async () => store.bluestacks.getInstance(instId)!,
      openDeepLink: async () => {
        stage = 0;
      },
      isLoginOrLoggedOutXml: () => false,
      dumpXml: async () => {
        if (stage === 0) return heroXml;
        if (stage === 1) return parsedFeed;
        if (stage >= 2 && stage <= 5) return barPlusNextHeaderXml;
        return finalBarOnlyXml;
      },
      screencap: async () => {
        if (lastTappedLike) {
          lastTappedLike = false;
          return makeFramePng(true, stage);
        }
        return makeFramePng(false, stage);
      },
      swipe900: async () => {
        stage++;
      },
      tap900: async (_serial: string, x: number, y: number) => {
        if (x <= 300 && y >= 195 && y <= 270) {
          lastTappedLike = true;
        }
      },
      keyevent: async () => {},
      copyLinkFromMoreMenu: async () => {
        const pid = copiedPostIds[copyIdx++] ?? '999999';
        return `https://www.facebook.com/100085926219692/posts/${pid}/`;
      },
      pasteIntoFocused: async () => {},
    };

    const runner = new BluestacksGroupBumperRunner(
      store.bluestacks,
      { applyResolvedTargetMetadata: async () => null },
      fakeDevices as unknown as ConstructorParameters<typeof BluestacksGroupBumperRunner>[2],
      { recognizeBounds: async () => '', close: async () => {} },
    );

    const pages = store.bluestacks.targets('pages');
    await runner.run(
      instId,
      [],
      pages,
      BumperSettings.parse({
        maxPostsPerPage: 3,
        likeProbability: 100,
        commentProbability: 0,
        dailyMaxLikesPerAccount: 20,
      }),
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'page',
    );

    assert.equal(store.bluestacks.total('page'), 3);
    const logs = store.groupBumper.logs('', 10, Date.now() + 1000, '\uffff', 'page');
    assert.deepEqual(logs.map((l) => l.postId).sort(), [...copiedPostIds].sort());

    // Verify transient clipboard contention in copyLinkFromMoreMenu falls back to deterministic postId without aborting run
    stage = 0;
    lastTappedLike = false;
    fakeDevices.copyLinkFromMoreMenu = async () => {
      throw new Error('EXIT_1: Set-Clipboard : 请求的剪贴板操作失败');
    };
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '61588452821652', name: 'Fallback Page', folderId: null }],
    });
    const fallbackPages = store.bluestacks
      .targets('pages')
      .filter((p) => p.id === '61588452821652');
    await runner.run(
      instId,
      [],
      fallbackPages,
      BumperSettings.parse({
        maxPostsPerPage: 2,
        likeProbability: 100,
        commentProbability: 0,
        dailyMaxLikesPerAccount: 20,
      }),
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'page',
    );
    assert.equal(store.bluestacks.total('page'), 5);

    // Verify bottom-of-screen header (y1=1295) below an earlier post's actionBar (y1=382) + Story card
    // never clicks the earlier post's actionBar during alignStep=0, advancing to alignStep=1 for its own bar!
    const bottomHeaderWithPrevBarXml = parseDumpsysTop(
      [
        '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
        '    mResumed=true',
        '    View Hierarchy:',
        '      DecorView@1[MainActivity]',
        '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
        '          X.0hs{10 V.ED..... ........ 0,276-900,379}',
        '            X.0hp{11 VFED..CL. ........ 0,38-300,98}',
        '            X.0hp{12 VFED..C.. ........ 300,38-600,98}',
        '            X.0hp{13 VFED..C.. ........ 600,38-900,98}',
        '          X.0hs{20 V.ED..... ........ 0,1189-900,1283}',
        '            X.0hp{21 VFED..C.. ........ 0,1-900,94}',
        '              X.0hp{22 VFED..C.. ........ 19,19-74,74}',
        '              X.0hp{23 VFED..C.. ........ 91,11-853,74}',
        '                X.0hp{24 VFED..C.. ........ 2,8-251,40}',
        '              X.0hp{25 VFED..C.. ........ 853,11-895,59}',
      ].join('\n'),
      900,
      1600,
    );
    // After alignStep=0 (~700px drag): earlier post's bar is STILL visible at relY=80 (abs y=224),
    // while our post's header shifted from abs y=1295 -> abs y=595 (relY=489), actionBar still off-screen!
    const midShiftStillHasPrevBarXml = parseDumpsysTop(
      [
        '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
        '    mResumed=true',
        '    View Hierarchy:',
        '      DecorView@1[MainActivity]',
        '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
        '          X.0hs{10 V.ED..... ........ 0,80-900,183}',
        '            X.0hp{11 VFED..CL. ........ 0,38-300,98}',
        '            X.0hp{12 VFED..C.. ........ 300,38-600,98}',
        '            X.0hp{13 VFED..C.. ........ 600,38-900,98}',
        '          X.0hs{20 V.ED..... ........ 0,489-900,583}',
        '            X.0hp{21 VFED..C.. ........ 0,1-900,94}',
        '              X.0hp{22 VFED..C.. ........ 19,19-74,74}',
        '              X.0hp{23 VFED..C.. ........ 91,11-853,74}',
        '                X.0hp{24 VFED..C.. ........ 2,8-251,40}',
        '              X.0hp{25 VFED..C.. ........ 853,11-895,59}',
      ].join('\n'),
      900,
      1600,
    );
    // After alignStep=1 (~700px drag): both earlier bar and our header exited top; our own actionBar is at relY=980 (abs y=1124)!
    const ownBarExposedXml = parseDumpsysTop(
      [
        '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
        '    mResumed=true',
        '    View Hierarchy:',
        '      DecorView@1[MainActivity]',
        '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
        '          X.0hs{30 V.ED..... ........ 0,980-900,1083}',
        '            X.0hp{31 VFED..CL. ........ 0,38-300,98}',
        '            X.0hp{32 VFED..C.. ........ 300,38-600,98}',
        '            X.0hp{33 VFED..C.. ........ 600,38-900,98}',
      ].join('\n'),
      900,
      1600,
    );
    let subStage = 0;
    const tappedYs: number[] = [];
    fakeDevices.openDeepLink = async () => {
      subStage = 0;
    };
    fakeDevices.dumpXml = async () => {
      if (subStage === 0) return bottomHeaderWithPrevBarXml;
      if (subStage === 1) return midShiftStillHasPrevBarXml;
      return ownBarExposedXml;
    };
    fakeDevices.swipe900 = async () => {
      subStage++;
    };
    fakeDevices.tap900 = async (_serial: string, x: number, y: number) => {
      tappedYs.push(y);
      if (x <= 300 && y >= 1100 && y <= 1200) {
        lastTappedLike = true;
      }
    };
    fakeDevices.screencap = async () => {
      const c = createCanvas(900, 1600);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 900, 1600);
      ctx.fillStyle = '#336699';
      ctx.fillRect(40, 1360, 300, 120);
      if (lastTappedLike) {
        lastTappedLike = false;
        ctx.fillStyle = '#1877f2';
        ctx.fillRect(90, 1130, 60, 34);
      }
      return c.toBuffer('image/png');
    };
    fakeDevices.copyLinkFromMoreMenu = async () =>
      'https://www.facebook.com/61578473189457/posts/888888888888/';
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '61578473189457', name: 'Story Guard Page', folderId: null }],
    });
    const storyGuardPages = store.bluestacks
      .targets('pages')
      .filter((p) => p.id === '61578473189457');
    await runner.run(
      instId,
      [],
      storyGuardPages,
      BumperSettings.parse({
        maxPostsPerPage: 1,
        likeProbability: 100,
        commentProbability: 0,
        dailyMaxLikesPerAccount: 20,
      }),
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'page',
    );
    // Must NEVER tap the earlier post's actionBar (y=224..284); must tap ONLY our own actionBar (y ~ 1154)!
    assert.equal(
      tappedYs.some((y) => y < 400),
      false,
      `unexpectedly tapped earlier post actionBar: ${tappedYs.join(',')}`,
    );
    assert.equal(store.bluestacks.total('page'), 6);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('BlueStacks enableSound controls Android STREAM_MUSIC and FB Lite inline speaker icon without double-tapping subsequent unmuted Reels', async () => {
  const drawReelFrame = (opts: {
    speakerMuted: boolean;
    likedBlue: boolean;
    seed: number;
    soundX1?: number;
    soundY1?: number;
    likeY1?: number;
  }) => {
    const sx = opts.soundX1 ?? 840;
    const sy = opts.soundY1 ?? 1160;
    const ly = opts.likeY1 ?? 1244;
    const c = createCanvas(900, 1600);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 1600);
    // Distinct video body texture per post so seenCardSigs treats Reel #1 and Reel #2 as distinct
    ctx.fillStyle = `rgb(${40 + opts.seed * 55}, ${80 + opts.seed * 35}, ${130 + opts.seed * 25})`;
    ctx.fillRect(0, 290, 900, 930);
    ctx.fillStyle = '#f5d142';
    ctx.fillRect(60 + opts.seed * 140, 340, 180, 90);

    // 60x60 dark circular FB Lite speaker badge at [sx, sy, sx+60, sy+60]
    ctx.fillStyle = '#1c1e21';
    ctx.beginPath();
    ctx.arc(sx + 30, sy + 30, 26, 0, Math.PI * 2);
    ctx.fill();
    // White speaker cone (local x=16..27, y=23..36)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(sx + 16, sy + 23, 12, 14);
    if (opts.speakerMuted) {
      // Compact mute 'x' (local x=32..39, y=26..33 -> zero pixels in wave bands)
      ctx.fillRect(sx + 33, sy + 27, 6, 6);
    } else {
      // Curved sound waves reaching top/bottom/outer wave bands
      ctx.fillRect(sx + 34, sy + 18, 10, 5);
      ctx.fillRect(sx + 34, sy + 37, 10, 4);
      ctx.fillRect(sx + 42, sy + 21, 5, 18);
    }

    if (opts.likedBlue) {
      ctx.fillStyle = '#1877f2';
      ctx.fillRect(90, ly + 12, 60, 34);
    }
    return c.toBuffer('image/png');
  };

  const soundRect = makeCanonicalRect(840, 1160, 900, 1220);
  assert.equal(
    await detectVideoSpeakerState(
      drawReelFrame({ speakerMuted: true, likedBlue: false, seed: 1 }),
      soundRect,
    ),
    'muted',
  );
  assert.equal(
    await detectVideoSpeakerState(
      drawReelFrame({ speakerMuted: false, likedBlue: false, seed: 1 }),
      soundRect,
    ),
    'unmuted',
  );

  const buildVideoFeedDumpsys = (endedVisible: boolean) =>
    parseDumpsysTop(
      [
        '  ACTIVITY com.facebook.lite/.MainActivity 1 pid=1',
        '    mResumed=true',
        '    View Hierarchy:',
        '      DecorView@1[MainActivity]',
        '        X.10N{1 VFED..... ........ 0,106-900,1528 #1}',
        '          X.0hs{10 V.ED..... ........ 0,90-900,184}',
        '            X.0hp{11 VFED..C.. ........ 0,1-900,94}',
        '              X.0hp{12 VFED..C.. ........ 19,19-74,74}',
        '              X.0hp{13 VFED..C.. ........ 91,11-853,74}',
        '                X.0hp{14 VFED..C.. ........ 2,8-251,40}',
        '              X.0hp{15 VFED..C.. ........ 853,11-895,59}',
        '          X.0hs{20 V.ED..... ........ 0,184-900,1114 #7f0801 app:id/video_view}',
        `            X.0hp{21 ${endedVisible ? 'V.E......' : 'I.E......'} ........ 0,0-900,930 #7f0802 app:id/end_of_video_cta}`,
        '            X.0hp{22 VFED..C.. ........ 840,870-900,930 #7f0803 app:id/sound_image_view}',
        '          X.0hs{30 V.ED..... ........ 0,1120-900,1220}',
        '            X.0hp{31 VFED..CL. ........ 0,18-300,78}',
        '            X.0hp{32 VFED..C.. ........ 300,18-600,78}',
        '            X.0hp{33 VFED..C.. ........ 600,18-900,78}',
      ].join('\n'),
      900,
      1600,
    );

  const playingXml = buildVideoFeedDumpsys(false);
  const endedXml = buildVideoFeedDumpsys(true);
  const playingControls = extractInlineVideoControls(playingXml, 290, 1242, true);
  assert.ok(playingControls.videoBounds);
  assert.ok(playingControls.soundBounds);
  assert.equal(playingControls.soundBounds.cx, 870);
  assert.equal(playingControls.soundBounds.cy, 1190);
  assert.equal(playingControls.ended, false);
  assert.equal(extractInlineVideoControls(endedXml, 290, 1242, true).ended, true);

  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bs-sound-'));
  const store = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    const instId = deterministicBluestacksId('Pie64_1');
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_1',
        displayName: 'p023',
        adbPort: 5565,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);
    store.bluestacks.saveInspectionResult({
      id: instId,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: 'p023 (Mawi Lee)',
      accountName: 'Mawi Lee',
      fbWidth: 900,
      fbHeight: 1600,
    });
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '100085621666905', name: 'Reel Video Page', folderId: null }],
    });

    let reelIndex = 0;
    let speakerMuted = true;
    let lastTappedLike = false;
    let speakerTapCount = 0;
    const mediaSoundCalls: boolean[] = [];
    const observedStatuses: string[] = [];

    const fakeDevices = {
      ensureReadyAndLoggedIn: async () => store.bluestacks.getInstance(instId)!,
      openDeepLink: async () => {
        reelIndex = 0;
      },
      isLoginOrLoggedOutXml: () => false,
      dumpXml: async () => playingXml,
      screencap: async () => {
        const liked = lastTappedLike;
        lastTappedLike = false;
        return drawReelFrame({
          speakerMuted,
          likedBlue: liked,
          seed: reelIndex + 1,
          soundX1: 840,
          soundY1: 1160,
          likeY1: 1244,
        });
      },
      swipe900: async () => {
        reelIndex++;
      },
      tap900: async (_serial: string, x: number, y: number) => {
        if (x >= 835 && x <= 900 && y >= 1155 && y <= 1225) {
          speakerTapCount++;
          speakerMuted = !speakerMuted;
          return;
        }
        if (x <= 300 && y >= 1235 && y <= 1315) {
          lastTappedLike = true;
        }
      },
      setMediaSoundEnabled: async (_serial: string, enabled: boolean) => {
        mediaSoundCalls.push(enabled);
      },
      keyevent: async () => {},
      copyLinkFromMoreMenu: async () =>
        `https://www.facebook.com/reel/${900100 + reelIndex}/?app=fbl`,
      pasteIntoFocused: async () => {},
    };

    const runner = new BluestacksGroupBumperRunner(
      store.bluestacks,
      { applyResolvedTargetMetadata: async () => null },
      fakeDevices as unknown as ConstructorParameters<typeof BluestacksGroupBumperRunner>[2],
      { recognizeBounds: async () => '', close: async () => {} },
    );

    // 1. Run with enableSound = true across 2 consecutive Reels:
    //    Reel #1 starts muted -> taps speaker ONCE -> speakerMuted becomes false.
    //    Reel #2 inherits speakerMuted=false -> must NOT tap speaker again!
    store.bluestacks.savePageBumperSettings(
      BumperSettings.parse({
        maxPostsPerPage: 2,
        likeProbability: 100,
        commentProbability: 0,
        dailyMaxLikesPerAccount: 20,
        enableSound: true,
      }),
    );
    await runner.run(
      instId,
      [],
      store.bluestacks.targets('pages'),
      store.bluestacks.savedSettings().pageBumperSettings,
      new AbortController().signal,
      {
        status: (txt) => observedStatuses.push(txt),
        added: () => {},
      },
      'page',
    );

    assert.deepEqual(mediaSoundCalls, [true]);
    assert.equal(speakerTapCount, 1);
    assert.equal(speakerMuted, false);
    assert.equal(
      observedStatuses.some((s) => s.startsWith('正在观看视频 · ')),
      true,
    );
    assert.equal(store.bluestacks.total('page'), 2);

    // 2. Run with enableSound = false when FB Lite speaker was left unmuted:
    //    Must call setMediaSoundEnabled(false) AND tap speaker once to mute back to true!
    store.groupBumper.upsertTargets('pages', {
      items: [{ id: '61578473189457', name: 'Mute Check Page', folderId: null }],
    });
    store.bluestacks.savePageBumperSettings(
      BumperSettings.parse({
        maxPostsPerPage: 1,
        likeProbability: 100,
        commentProbability: 0,
        dailyMaxLikesPerAccount: 20,
        enableSound: false,
      }),
    );
    fakeDevices.copyLinkFromMoreMenu = async () =>
      `https://www.facebook.com/reel/${900500 + reelIndex}/?app=fbl`;
    await runner.run(
      instId,
      [],
      store.bluestacks.targets('pages').filter((p) => p.id === '61578473189457'),
      store.bluestacks.savedSettings().pageBumperSettings,
      new AbortController().signal,
      { status: () => {}, added: () => {} },
      'page',
    );

    assert.deepEqual(mediaSoundCalls, [true, false]);
    assert.equal(speakerTapCount, 2);
    assert.equal(speakerMuted, true);
    assert.equal(store.bluestacks.total('page'), 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Android 13 aid= parsing, v524 TextInputView, Home tab dual-identity, 2-row 7-reaction popup, solid-blue CTA vs checkbox, reaction colors, and checkpoint classifier', async () => {
  // 1. Android 13 dumpsys with aid=... + FB Lite v524 TextInputView
  const android13Dump = [
    '  ACTIVITY com.facebook.lite/.MainActivity abcd1234 pid=2222',
    '    mResumed=true mStopped=false',
    '    View Hierarchy:',
    '      com.android.internal.policy.DecorView{111 V.E...... ........ 0,0-900,1600 aid=1073741824}',
    '        com.facebook.primitive.textinput.TextInputView{222 VFED..CL. F....... 40,500-860,590 #1 aid=1073741825}',
    '        com.facebook.primitive.textinput.TextInputView{333 VFED..CL. ........ 40,620-860,710 #2 aid=1073741826}',
  ].join('\n');
  const root13 = parseDumpsysTop(android13Dump, 900, 1600);
  assert.ok(root13);
  const inputs = findAllTextInputNodes(root13);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.bounds.y1, 500);
  assert.equal(inputs[1]?.bounds.y1, 620);

  // 2. Dual-identity Home Tab Bar detection: 6 tabs = Personal, 4 tabs = Page
  const buildTabBarXml = (count: number) => {
    const w = Math.floor(900 / count);
    const tabs = Array.from(
      { length: count },
      (_, i) =>
        `<node index="${i}" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[${i * w},128][${(i + 1) * w},214]" />`,
    ).join('\n');
    return `<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]"><node index="0" text="" resource-id="" class="android.view.ViewGroup" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,128][900,214]">${tabs}</node></node></hierarchy>`;
  };
  const personalRoot = parseLiteXml(buildTabBarXml(6), 900, 1600);
  const pageRoot = parseLiteXml(buildTabBarXml(4), 900, 1600);
  assert.ok(personalRoot && pageRoot);
  const personalBar = detectHomeTabBar(personalRoot);
  const pageBar = detectHomeTabBar(pageRoot);
  assert.equal(personalBar?.identityHint, 'personal');
  assert.equal(personalBar?.tabs.length, 6);
  assert.equal(pageBar?.identityHint, 'page');
  assert.equal(pageBar?.tabs.length, 4);

  // 3. 2-row 7-Reaction popup (3 top: like/love/care + 4 bottom: haha/wow/sad/angry)
  const popupXml = `<hierarchy rotation="0">
    <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.facebook.lite" content-desc="" clickable="false" long-clickable="false" focused="false" scrollable="false" bounds="[0,0][900,1600]">
      <node index="0" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[80,480][210,590]" />
      <node index="1" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[220,480][350,590]" />
      <node index="2" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[360,480][490,590]" />
      <node index="3" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[40,600][170,710]" />
      <node index="4" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[180,600][310,710]" />
      <node index="5" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[320,600][450,710]" />
      <node index="6" text="" resource-id="" class="android.view.View" package="com.facebook.lite" content-desc="" clickable="true" long-clickable="false" focused="false" scrollable="false" bounds="[460,600][590,710]" />
    </node>
  </hierarchy>`;
  const popupRoot = parseLiteXml(popupXml, 900, 1600);
  assert.ok(popupRoot);
  const reactions = extractReactionPopupButtons(popupRoot, makeCanonicalRect(20, 740, 290, 810));
  assert.equal(Object.keys(reactions).length, 7);
  assert.equal(reactions.like?.x1, 80);
  assert.equal(reactions.love?.x1, 220);
  assert.equal(reactions.care?.x1, 360);
  assert.equal(reactions.haha?.x1, 40);
  assert.equal(reactions.angry?.x1, 460);

  // 4. Solid blue CTA button vs small blue checkbox on white background, plus multi-color active reaction check
  const canvas = createCanvas(900, 1600);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 900, 1600);
  // Solid blue primary button [40, 200, 860, 280]
  ctx.fillStyle = '#1877f2';
  ctx.fillRect(40, 200, 820, 80);
  // Small blue checkbox inside a wide row [40, 320, 860, 400]
  ctx.fillStyle = '#1877f2';
  ctx.fillRect(50, 345, 26, 26);
  // Red heart reaction [20, 700, 280, 770]
  ctx.fillStyle = '#f33e58';
  ctx.fillRect(100, 715, 36, 36);
  // Amber Haha reaction [300, 700, 560, 770]
  ctx.fillStyle = '#f7b125';
  ctx.fillRect(380, 715, 36, 36);
  // Gray unreacted button [600, 700, 860, 770]
  ctx.fillStyle = '#65676b';
  ctx.fillRect(680, 715, 36, 36);
  const png = canvas.toBuffer('image/png');

  assert.equal(await isSolidBlueButton(png, makeCanonicalRect(40, 200, 860, 280)), true);
  assert.equal(await isSolidBlueButton(png, makeCanonicalRect(40, 320, 860, 400)), false);
  assert.equal(await isReactionButtonActive(png, makeCanonicalRect(20, 700, 280, 770)), true);
  assert.equal(await isReactionButtonActive(png, makeCanonicalRect(300, 700, 560, 770)), true);
  assert.equal(await isReactionButtonActive(png, makeCanonicalRect(600, 700, 860, 770)), false);

  // 5. Abnormal screen text classification
  assert.equal(
    classifyAbnormalScreenText(
      'We need to secure your account to keep using Facebook. Pass a security check',
    ),
    'verification',
  );
  assert.equal(
    classifyAbnormalScreenText('Meta detected suspicious activity on your account'),
    'verification',
  );
  assert.equal(
    classifyAbnormalScreenText('Your account has been disabled for violating Community Standards'),
    'restricted',
  );
  assert.equal(classifyAbnormalScreenText('手机号或邮箱 密码 登录 忘记密码'), 'logged-out');
  assert.equal(classifyAbnormalScreenText('在想些什么？ 照片 直播'), null);
});

test('RFC 6238 TOTP generator and Android ASCII input quoting handle complex secrets and passwords', () => {
  // Official RFC 6238 SHA-1 test secret "12345678901234567890" = Base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  assert.equal(generateTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
  assert.equal(
    generateTotpCode('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', 1_111_111_109_000),
    '081804',
  );

  assert.equal(isPrintableAscii('Pass^+:?<>!},123'), true);
  assert.equal(isPrintableAscii('你好世界'), false);
  assert.equal(isPrintableAscii('hello 😊'), false);

  assert.equal(quoteForAndroidInputText('a b'), "'a%sb'");
  assert.equal(quoteForAndroidInputText("it's^<>!"), "'it'\\''s^<>!'");
});

test('SqliteBluestacksRepository migrates legacy 4-state CHECK table to 6-state without data loss and preserves metadata on verification/restricted', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Seed legacy 4-state bluestacks_instances table
    db.exec(`
      CREATE TABLE bluestacks_instances (
        id TEXT PRIMARY KEY,
        instance_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        alias TEXT,
        folder_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        adb_port INTEGER NOT NULL DEFAULT 5555,
        fb_width INTEGER NOT NULL DEFAULT 0,
        fb_height INTEGER NOT NULL DEFAULT 0,
        fb_lite_installed INTEGER NOT NULL DEFAULT 0,
        account_state TEXT NOT NULL DEFAULT 'unknown'
          CHECK (account_state IN ('unknown','logged-in','logged-out','missing-app')),
        account_id TEXT NOT NULL DEFAULT '',
        account_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        last_status TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    const instId = deterministicBluestacksId('Pie64_1');
    db.prepare(
      `INSERT INTO bluestacks_instances (id, instance_key, display_name, alias, adb_port, fb_width, fb_height, fb_lite_installed, account_state, account_id, account_name, avatar_url, updated_at)
       VALUES (?, 'Pie64_1', 'p023', '主力号', 5565, 900, 1600, 1, 'logged-in', '10001234', 'Mawi Lee', 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADQAQCdASoBAAEAAUAmJYgCdAEO/gHOAAD++P////////////////////8AAAA=', 1000)`,
    ).run(instId);

    // Open repository -> runs non-destructive migration!
    const repo = new SqliteBluestacksRepository(db);
    const before = repo.getInstance(instId);
    assert.ok(before);
    assert.equal(before.alias, '主力号');
    assert.equal(before.accountName, 'Mawi Lee');

    // Save 'verification' state -> MUST NOT throw CHECK constraint error AND MUST preserve accountName & avatarUrl!
    const updated = repo.saveInspectionResult({
      id: instId,
      fbLiteInstalled: true,
      accountState: 'verification',
      identityType: 'personal',
      numericAccountId: '10001234',
      managedIdentities: [
        { name: 'Mawi Lee', identityType: 'personal', active: true },
        { name: 'Thu', identityType: 'page', active: false },
      ],
      androidSdk: 33,
      fbLiteVersion: '524.0.0.7.106',
    });
    assert.ok(updated);
    assert.equal(updated.accountState, 'verification');
    assert.equal(updated.accountName, 'Mawi Lee');
    assert.ok(updated.avatarUrl?.startsWith('data:image/webp;base64,'));
    assert.equal(updated.numericAccountId, '10001234');
    assert.equal(updated.managedIdentities?.length, 2);
    assert.equal(updated.androidSdk, 33);
    assert.equal(updated.fbLiteVersion, '524.0.0.7.106');

    // Save apkPath setting
    const paths = repo.savePaths({ apkPath: 'D:\\apks\\fb-lite.apk' });
    assert.equal(paths.apkPath, 'D:\\apks\\fb-lite.apk');
  } finally {
    db.close();
  }
});

test('Auto-Scheduler 6-step BlueStacks schema & Cloud Sheets BlueStacks binding validate cleanly', () => {
  const comboId = randomUUID();
  const matId = randomUUID();
  const sched = SaveAutoScheduleInput.parse({
    name: '蓝蝶全链路自动化',
    carrier: 'bluestacks',
    enabled: true,
    targetSelector: {
      mode: 'explicit',
      targetIds: [deterministicBluestacksId('Pie64_1')],
      skipAbnormalAccounts: true,
    },
    trigger: {
      weekdays: [1, 2, 3, 4, 5],
      times: ['08:00'],
      timeZone: 'Asia/Shanghai',
    },
    steps: [
      { id: randomUUID(), type: 'bluestacks-active-combination', combinationId: comboId },
      {
        id: randomUUID(),
        type: 'bluestacks-group-poster',
        materialIds: [matId],
        groupIds: ['123456789'],
        maxGroupsPerProfile: 2,
        postToTimeline: true,
      },
      {
        id: randomUUID(),
        type: 'bluestacks-group-bumper',
        groupIds: ['123456789'],
        pageIds: ['987654321'],
      },
      { id: randomUUID(), type: 'bluestacks-page-bumper', pageIds: ['987654321'] },
      {
        id: randomUUID(),
        type: 'bluestacks-group-inviter',
        groupIds: ['123456789'],
        invitesPerGroup: 5,
      },
    ],
  });
  assert.equal(sched.steps.length, 5);

  const defaultRecordsCfg = PostRecordsSheetConfig.parse({});
  assert.deepEqual(defaultRecordsCfg.bumperBluestacksFolderIds, []);
  assert.deepEqual(defaultRecordsCfg.bumperBluestacksIds, []);

  const boundRecordsCfg = PostRecordsSheetConfig.parse({
    bumperBluestacksFolderIds: [randomUUID()],
    bumperBluestacksIds: [deterministicBluestacksId('Pie64_1')],
  });
  assert.equal(boundRecordsCfg.bumperBluestacksFolderIds.length, 1);
  assert.equal(boundRecordsCfg.bumperBluestacksIds.length, 1);
});

test('detectBottomSheetIdentityRows locates 3 identity rows and active blue checkmark from overlay PNG', async () => {
  const c = createCanvas(900, 1600);
  const ctx = c.getContext('2d');
  // Dimmed backdrop above bottom sheet
  ctx.fillStyle = '#555555';
  ctx.fillRect(0, 0, 900, 1020);
  // White bottom sheet starting at y=1020
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 1020, 900, 580);
  // 3 circular avatars at x=84, y=1090, 1200, 1310 (r=30 -> 60x60)
  const ys = [1090, 1200, 1310];
  for (let i = 0; i < ys.length; i++) {
    const cy = ys[i] ?? 1090;
    ctx.fillStyle = i === 0 ? '#3b5998' : i === 1 ? '#2e7d32' : '#c62828';
    ctx.beginPath();
    ctx.arc(84, cy, 30, 0, Math.PI * 2);
    ctx.fill();
  }
  // Blue active checkmark circle on row 0 at x=832, y=1090
  ctx.fillStyle = '#1877f2';
  ctx.beginPath();
  ctx.arc(832, 1090, 18, 0, Math.PI * 2);
  ctx.fill();

  const rows = await detectBottomSheetIdentityRows(c.toBuffer('image/png'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.isActiveBlueCheck, true);
  assert.equal(rows[1]?.isActiveBlueCheck, false);
  assert.equal(rows[2]?.isActiveBlueCheck, false);
  assert.ok((rows[0]?.fullTextBounds.x1 ?? 0) >= 120);
});

test('parseBatchLoginText handles multi-line labeled blocks with special-char passwords, delimited rows, and validation', () => {
  const mixedInput = [
    '# comment line',
    '账号: alice@example.com',
    '密码: Pa:ss,Word!#123',
    'totp: jbsw y3dp ehpk 3pxp',
    '',
    '账号：bob_user',
    '密码：SimplePass99',
    '',
    '账号,密码,2FA',
    'carol@test.io|PipePass!|MFRGGZDFMZTWQ2LK',
    'dave@test.io\tTabPass:88\tNOTE_COL\tGEZDGNBVGY3TQOJQ',
    'eve@test.io----DashPass123----ORSXG5A2',
    '"frank@test.io","Csv,Pass,1","JBSWY3DPEHPK3PXP"',
    'bad@test.io|Pass1|NOT_BASE32_!!!',
    'broken_single_token',
  ].join('\n');

  const parsed = parseBatchLoginText(mixedInput);
  assert.equal(parsed.entries.length, 6);
  assert.equal(parsed.errors.length, 2);

  // Multi-line block preserves literal ':' and ',' inside password!
  assert.equal(parsed.entries[0]?.account, 'alice@example.com');
  assert.equal(parsed.entries[0]?.password, 'Pa:ss,Word!#123');
  assert.equal(parsed.entries[0]?.totpSecret, 'JBSWY3DPEHPK3PXP');

  // 2-line block without 2FA
  assert.equal(parsed.entries[1]?.account, 'bob_user');
  assert.equal(parsed.entries[1]?.password, 'SimplePass99');
  assert.equal(parsed.entries[1]?.totpSecret, '');

  // Pipe, Tab (picking valid Base32 from trailing col), ----, and quoted CSV
  assert.equal(parsed.entries[2]?.account, 'carol@test.io');
  assert.equal(parsed.entries[2]?.totpSecret, 'MFRGGZDFMZTWQ2LK');
  assert.equal(parsed.entries[3]?.account, 'dave@test.io');
  assert.equal(parsed.entries[3]?.password, 'TabPass:88');
  assert.equal(parsed.entries[3]?.totpSecret, 'GEZDGNBVGY3TQOJQ');
  assert.equal(parsed.entries[4]?.account, 'eve@test.io');
  assert.equal(parsed.entries[4]?.totpSecret, 'ORSXG5A2');
  assert.equal(parsed.entries[5]?.account, 'frank@test.io');
  assert.equal(parsed.entries[5]?.password, 'Csv,Pass,1');

  assert.equal(normalizeTotpSecret('jbsw y3dp-ehpk'), 'JBSWY3DPEHPK');
  assert.equal(isValidTotpSecret('JBSW Y3DP EHPK 3PXP'), true);
  assert.equal(isValidTotpSecret('12345'), false);

  assert.equal(maskLoginAccountLabel('alice@example.com'), 'al***e@example.com');
  assert.equal(maskLoginAccountLabel('10001234567890'), '1000***90');
});

test('BluestacksService.startBatchLogin orchestrates auto-launch, auto-APK, skip-logged-in, checkpoint classification, auto-close, and zero secret leakage', async () => {
  const { BluestacksService } = await import('../src/application/bluestacks-service.js');
  const { ProductError } = await import('../src/domain/workspace.js');

  const idOk = deterministicBluestacksId('Pie64_5');
  const idAlready = deterministicBluestacksId('Pie64_1');
  const idCheck = deterministicBluestacksId('Pie64_4');

  const liveInstances: BluestacksInstance[] = [
    {
      id: idOk,
      instanceKey: 'Pie64_5',
      displayName: 'App Player 5',
      alias: null,
      folderId: null,
      sortOrder: 0,
      adbPort: 5605,
      serial: '127.0.0.1:5605',
      fbWidth: 900,
      fbHeight: 1600,
      online: false,
      fbLiteInstalled: false,
      accountState: 'missing-app',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: 1,
    },
    {
      id: idAlready,
      instanceKey: 'Pie64_1',
      displayName: 'p023',
      alias: null,
      folderId: null,
      sortOrder: 1,
      adbPort: 5565,
      serial: '127.0.0.1:5565',
      fbWidth: 900,
      fbHeight: 1600,
      online: true,
      fbLiteInstalled: true,
      accountState: 'logged-in',
      accountId: '61591261366732',
      accountName: 'Mawi Lee',
      numericAccountId: '61591261366732',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: 1,
    },
    {
      id: idCheck,
      instanceKey: 'Pie64_4',
      displayName: 'App Player 4',
      alias: null,
      folderId: null,
      sortOrder: 2,
      adbPort: 5595,
      serial: '127.0.0.1:5595',
      fbWidth: 900,
      fbHeight: 1600,
      online: false,
      fbLiteInstalled: true,
      accountState: 'unknown',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: 1,
    },
  ];

  const config: BluestacksRuntimeConfig = {
    installDir: 'C:\\Program Files\\BlueStacks_nxt',
    confPath: 'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf',
    apkPath: 'D:\\fb-lite.apk',
    detectedInstallDir: 'C:\\Program Files\\BlueStacks_nxt',
    detectedConfPath: 'C:\\ProgramData\\BlueStacks_nxt\\bluestacks.conf',
    detectedApkPath: 'D:\\fb-lite.apk',
    adbReady: true,
    playerReady: true,
  };

  const launched: string[] = [];
  const installed: string[] = [];
  const closed: string[] = [];

  const defaultBumperSettings = {
    searchMode: 'time_sort' as const,
    maxPostAgeHours: 24,
    maxPostsPerGroupPage: 5,
    maxPostsPerPage: 3,
    maxConcurrentProfiles: 4,
    dailyMaxLikesPerAccount: 20,
    maxLikesPerPost: 50,
    likeProbability: 100,
    commentProbability: 30,
    consumeCommentOnUse: false,
    enableSound: false,
    useLongPressReaction: false,
    reactionTypes: ['like' as const],
  };

  const repo: BluestacksServiceRepository = {
    savePaths: () => ({
      installDir: null,
      confPath: null,
      apkPath: 'D:\\fb-lite.apk',
      bumperSettings: defaultBumperSettings,
    }),
    savedSettings: () => ({
      installDir: null,
      confPath: null,
      apkPath: 'D:\\fb-lite.apk',
      bumperSettings: defaultBumperSettings,
    }),
    saveBumperSettings: () => {
      throw new Error('unused');
    },
    folders: () => [],
    createFolder: () => {
      throw new Error('unused');
    },
    renameFolder: () => {
      throw new Error('unused');
    },
    deleteFolder: () => {},
    reorderFolders: () => {},
    listInstances: () => liveInstances,
    getInstance: (id) => liveInstances.find((x) => x.id === id) ?? null,
    saveLastStatus: () => {},
    renameInstance: () => {
      throw new Error('unused');
    },
    reorderInstances: () => {},
    deleteInstances: () => 0,
    targets: () => [],
    todayCounts: () => ({}),
    total: () => 0,
  };

  const devices: BluestacksDeviceController = {
    getOnlineKeys: () => new Set(liveInstances.filter((x) => x.online).map((x) => x.instanceKey)),
    discoverInstances: async () => ({ config, instances: liveInstances }),
    launchInstance: async (id) => {
      launched.push(id);
      const item = liveInstances.find((x) => x.id === id);
      if (!item) throw new Error('missing');
      item.online = true;
      return item;
    },
    closeInstance: async (id) => {
      closed.push(id);
      const item = liveInstances.find((x) => x.id === id);
      if (item) item.online = false;
    },
    inspectAccount: async (id) => {
      const item = liveInstances.find((x) => x.id === id);
      if (!item) throw new Error('missing');
      return item;
    },
    probeFbLiteInstalled: async (serial) => {
      const item = liveInstances.find((x) => x.serial === serial);
      return item?.fbLiteInstalled ?? false;
    },
    installFbLiteApk: async (id) => {
      installed.push(id);
      const item = liveInstances.find((x) => x.id === id);
      if (!item) throw new Error('missing');
      item.fbLiteInstalled = true;
      item.accountState = 'logged-out';
      return item;
    },
    loginAccountDetailed: async (id) => {
      const item = liveInstances.find((x) => x.id === id);
      if (!item) throw new Error('missing');
      if (id === idCheck) {
        item.accountState = 'verification';
        throw new ProductError('BLUESTACKS_ACCOUNT_CHECKPOINT', '账号触发 Checkpoint 验证', 409);
      }
      item.accountState = 'logged-in';
      item.accountName = 'Fresh Account';
      item.numericAccountId = '61599988877766';
      return { instance: item, skippedAlreadyLoggedIn: false };
    },
  };

  const service = new BluestacksService(repo, devices, { run: async () => {} });
  const secretPass = 'UltraSecret:Pass,999!';
  const secretTotp = 'JBSWY3DPEHPK3PXP';

  await service.startBatchLogin({
    items: [
      {
        instanceId: idOk,
        account: 'fresh@example.com',
        password: secretPass,
        totpSecret: secretTotp,
      },
      { instanceId: idAlready, account: 'other@example.com', password: secretPass },
      { instanceId: idCheck, account: 'check@example.com', password: secretPass },
    ],
    maxConcurrency: 2,
    autoLaunch: true,
    autoInstallApk: true,
    ifAlreadyLoggedIn: 'skip',
    saveLoginInfo: true,
    closeOnFinish: true,
  });

  // Wait for batch login to settle
  for (let i = 0; i < 40; i++) {
    const st = await service.state(false);
    if (st.batchLogin && !st.batchLogin.running) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  const finalState = await service.state(false);
  const bl = finalState.batchLogin;
  assert.ok(bl);
  assert.equal(bl.running, false);
  assert.equal(bl.total, 3);
  assert.equal(bl.completed, 3);
  assert.equal(bl.succeeded, 1);
  assert.equal(bl.skipped, 1);
  assert.equal(bl.verification, 1);
  assert.equal(bl.failed, 0);

  // Verify auto-launch, auto-APK, and auto-close did NOT touch already-online skipped idAlready
  assert.ok(launched.includes(idOk));
  assert.ok(launched.includes(idCheck));
  assert.ok(!launched.includes(idAlready));
  assert.deepEqual(installed, [idOk]);
  assert.ok(closed.includes(idOk));
  assert.ok(closed.includes(idCheck));
  assert.ok(!closed.includes(idAlready));

  // Hard security invariant: ZERO plaintext passwords, TOTP secrets, or raw emails in state JSON!
  const serialized = JSON.stringify(finalState);
  assert.equal(serialized.includes(secretPass), false);
  assert.equal(serialized.includes(secretTotp), false);
  assert.equal(serialized.includes('fresh@example.com'), false);
});

test('BluestacksService.startHealthCheck classifies healthy, landscape, missing-app auto-repair, verification & restricted cleanly', async () => {
  const idHealthy = deterministicBluestacksId('Pie64_hc_ok');
  const idLand = deterministicBluestacksId('Pie64_hc_land');
  const idMissing = deterministicBluestacksId('Pie64_hc_miss');
  const idVerify = deterministicBluestacksId('Pie64_hc_ver');
  const idRestrict = deterministicBluestacksId('Pie64_hc_ban');

  const liveInstances: BluestacksInstance[] = [
    {
      id: idHealthy,
      instanceKey: 'Pie64_hc_ok',
      displayName: 'OK-1',
      alias: null,
      folderId: null,
      sortOrder: 0,
      adbPort: 5601,
      serial: '127.0.0.1:5601',
      fbWidth: 900,
      fbHeight: 1600,
      online: false,
      fbLiteInstalled: true,
      accountState: 'unknown',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
    {
      id: idLand,
      instanceKey: 'Pie64_hc_land',
      displayName: 'Land-1',
      alias: null,
      folderId: null,
      sortOrder: 1,
      adbPort: 5602,
      serial: '127.0.0.1:5602',
      fbWidth: 1920,
      fbHeight: 1080,
      online: false,
      fbLiteInstalled: null,
      accountState: 'unknown',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
    {
      id: idMissing,
      instanceKey: 'Pie64_hc_miss',
      displayName: 'Miss-1',
      alias: null,
      folderId: null,
      sortOrder: 2,
      adbPort: 5603,
      serial: '127.0.0.1:5603',
      fbWidth: 720,
      fbHeight: 1280,
      online: false,
      fbLiteInstalled: false,
      accountState: 'missing-app',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
    {
      id: idVerify,
      instanceKey: 'Pie64_hc_ver',
      displayName: 'Ver-1',
      alias: null,
      folderId: null,
      sortOrder: 3,
      adbPort: 5604,
      serial: '127.0.0.1:5604',
      fbWidth: 900,
      fbHeight: 1600,
      online: false,
      fbLiteInstalled: true,
      accountState: 'unknown',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
    {
      id: idRestrict,
      instanceKey: 'Pie64_hc_ban',
      displayName: 'Ban-1',
      alias: null,
      folderId: null,
      sortOrder: 4,
      adbPort: 5605,
      serial: '127.0.0.1:5605',
      fbWidth: 900,
      fbHeight: 1600,
      online: false,
      fbLiteInstalled: true,
      accountState: 'unknown',
      accountId: '',
      accountName: '',
      avatarUrl: null,
      lastStatus: null,
      updatedAt: Date.now(),
    },
  ];

  const launched: string[] = [];
  const closed: string[] = [];
  const installed: string[] = [];

  const repo: BluestacksServiceRepository = {
    savedSettings: () => ({
      installDir: null,
      confPath: null,
      bumperSettings: BumperSettings.parse({ maxConcurrentProfiles: 4 }),
      pageBumperSettings: BumperSettings.parse({ maxConcurrentProfiles: 4 }),
    }),
    savePaths: () => ({
      installDir: null,
      confPath: null,
      bumperSettings: BumperSettings.parse({ maxConcurrentProfiles: 4 }),
    }),
    saveBumperSettings: (v) => BumperSettings.parse(v),
    folders: () => [],
    createFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
    renameFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
    deleteFolder: () => {},
    reorderFolders: () => {},
    listInstances: () => liveInstances.map((x) => ({ ...x })),
    getInstance: (id) => {
      const f = liveInstances.find((x) => x.id === id);
      return f ? { ...f } : null;
    },
    saveLastStatus: (id, status) => {
      const f = liveInstances.find((x) => x.id === id);
      if (f) f.lastStatus = status;
    },
    renameInstance: () => liveInstances[0]!,
    reorderInstances: () => {},
    deleteInstances: () => 0,
    targets: () => [],
    todayCounts: () => ({}),
    total: () => 0,
  };

  const devices: BluestacksDeviceController = {
    getOnlineKeys: () => new Set(liveInstances.filter((x) => x.online).map((x) => x.instanceKey)),
    discoverInstances: async () => ({
      instances: liveInstances.map((x) => ({ ...x })),
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
      launched.push(id);
      const item = liveInstances.find((x) => x.id === id)!;
      item.online = true;
      item.androidSdk = 28;
      return { ...item };
    },
    closeInstance: async (id) => {
      closed.push(id);
      const item = liveInstances.find((x) => x.id === id);
      if (item) item.online = false;
    },
    probeFbLiteInstalled: async (serial) => {
      const item = liveInstances.find((x) => x.serial === serial);
      return item?.fbLiteInstalled ?? false;
    },
    installFbLiteApk: async (id) => {
      installed.push(id);
      const item = liveInstances.find((x) => x.id === id)!;
      item.fbLiteInstalled = true;
      item.fbLiteVersion = '524.0.0.7.106';
      item.accountState = 'logged-out';
      return { ...item };
    },
    inspectAccount: async (id) => {
      const item = liveInstances.find((x) => x.id === id)!;
      if (id === idHealthy) {
        item.accountState = 'logged-in';
        item.accountName = 'Healthy User';
        item.numericAccountId = '61588877766655';
        item.identityType = 'personal';
        item.fbLiteVersion = '524.0.0.7.106';
        item.managedIdentities = [
          { name: 'Healthy User', identityType: 'personal', active: true },
          { name: 'My Page', identityType: 'page', active: false },
        ];
        return { ...item };
      }
      if (id === idMissing) {
        item.accountState = 'logged-out';
        throw new Error('FB Lite 未登录账号');
      }
      if (id === idVerify) {
        item.accountState = 'verification';
        item.fbLiteVersion = '488.0.0.15.106';
        return { ...item };
      }
      if (id === idRestrict) {
        item.accountState = 'restricted';
        item.fbLiteVersion = '488.0.0.15.106';
        return { ...item };
      }
      return { ...item };
    },
  };

  const service = new BluestacksService(repo, devices, { run: async () => {} });
  await service.startHealthCheck({
    instanceIds: [idHealthy, idLand, idMissing, idVerify, idRestrict],
    maxConcurrency: 3,
    autoLaunch: true,
    autoInstallApk: true,
    closeOnFinish: true,
  });

  for (let i = 0; i < 40; i++) {
    const st = await service.state(false);
    if (st.healthCheck && !st.healthCheck.running) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  const finalState = await service.state(false);
  const hc = finalState.healthCheck;
  assert.ok(hc);
  assert.equal(hc.running, false);
  assert.equal(hc.total, 5);
  assert.equal(hc.completed, 5);
  assert.equal(hc.healthy, 1);
  assert.equal(hc.landscape, 1);
  assert.equal(hc.loggedOut, 1);
  assert.equal(hc.verification, 1);
  assert.equal(hc.restricted, 1);
  assert.equal(hc.autoRepaired, 1);

  // Landscape instance must NEVER be launched or closed!
  assert.equal(launched.includes(idLand), false);
  assert.equal(closed.includes(idLand), false);
  assert.deepEqual(installed, [idMissing]);
  assert.equal(closed.length, 4);

  const healthyRow = hc.items.find((x) => x.instanceId === idHealthy);
  assert.equal(healthyRow?.numericAccountId, '61588877766655');
  assert.equal(healthyRow?.managedPageCount, 1);
  const repairedRow = hc.items.find((x) => x.instanceId === idMissing);
  assert.equal(repairedRow?.autoRepaired, true);
  assert.equal(repairedRow?.category, 'logged-out');
});

test('BlueStacks daily risk limits persist across restarts, aggregate all 4 action types, and enforce pre-flight & mid-run protective sleep', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bs-risk-'));
  const dbPath = path.join(dir, 'workspace.sqlite');
  let store = await WorkspaceStore.open(dbPath);
  try {
    const idA = deterministicBluestacksId('Pie64_risk_a');
    const idB = deterministicBluestacksId('Pie64_risk_b');
    store.bluestacks.upsertDiscoveredInstances([
      {
        instanceKey: 'Pie64_risk_a',
        displayName: 'Risk-A',
        adbPort: 5611,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
      {
        instanceKey: 'Pie64_risk_b',
        displayName: 'Risk-B',
        adbPort: 5612,
        fbWidth: 900,
        fbHeight: 1600,
        online: true,
        fbLiteInstalled: true,
      },
    ]);

    const now = Date.now();
    // Global cap: 5 total actions, 3 bumps, 2 active likes; override idB to tighter cap (1 total)
    store.bluestacks.saveRiskLimitSettings({
      enabled: true,
      dailyMaxTotalActions: 5,
      dailyMaxBumps: 3,
      dailyMaxPosts: 2,
      dailyMaxInvites: 4,
      dailyMaxActiveLikes: 2,
      perInstanceOverrides: {
        [idB]: { dailyMaxTotalActions: 1, dailyMaxBumps: 1 },
      },
    });

    // Record 1 group bump + 1 page bump + 1 post + 1 invite + 1 active like on idA => total = 5 (reached!)
    store.bluestacks.recordBump({
      id: randomUUID(),
      profileId: idA,
      accountId: 'accA',
      groupId: '1001',
      groupName: 'G1',
      pageId: '2001',
      pageName: 'P1',
      postId: '30001',
      postUrl: 'https://www.facebook.com/groups/1001/posts/30001/',
      liked: true,
      commentText: null,
      bumpedAt: now,
      sourceMode: 'group',
    });
    store.bluestacks.recordBump({
      id: randomUUID(),
      profileId: idA,
      accountId: 'accA',
      groupId: '-',
      groupName: '',
      pageId: '2001',
      pageName: 'P1',
      postId: '30002',
      postUrl: 'https://www.facebook.com/2001/posts/30002/',
      liked: true,
      commentText: null,
      bumpedAt: now,
      sourceMode: 'page',
    });
    store.groupPoster.recordPost({
      id: randomUUID(),
      profileId: idA,
      accountId: 'accA',
      accountName: 'Acc A',
      accountAvatar: null,
      identityType: 'personal',
      groupId: '1001',
      groupName: 'G1',
      groupAvatar: null,
      materialId: 'mat-1',
      captionPreview: 'hello',
      postId: '40001',
      postUrl: 'https://www.facebook.com/groups/1001/posts/40001/',
      postedAt: now,
    });
    store.groupInviter.recordInvites([
      {
        profileId: idA,
        accountId: 'accA',
        friendId: 'f-1',
        friendName: 'Friend 1',
        groupId: '1001',
        invitedAt: now,
      },
    ]);
    store.bluestacks.recordDailyActiveAction(idA, 'like', 1, now);

    // Reopen SQLite to prove cross-restart persistence
    store.close();
    store = await WorkspaceStore.open(dbPath);

    const usageToday = store.bluestacks.dailyInstanceUsage(now);
    assert.equal(usageToday.totalGroupBumps, 1);
    assert.equal(usageToday.totalPageBumps, 1);
    assert.equal(usageToday.totalPosts, 1);
    assert.equal(usageToday.totalInvites, 1);
    assert.equal(usageToday.totalActiveLikes, 1);
    assert.equal(usageToday.totalActions, 5);
    assert.equal(usageToday.reachedLimitInstances, 1);
    assert.equal(usageToday.perInstance[idA]?.limitReached, true);
    assert.equal(usageToday.perInstance[idB]?.limitReached, false);
    assert.equal(usageToday.perInstance[idB]?.hasOverride, true);
    assert.equal(usageToday.perInstance[idB]?.effectiveLimits.dailyMaxTotalActions, 1);

    // Eligibility blocks idA (at total 5/5) while allowing idB (0/1)
    assert.equal(store.bluestacks.eligibility('accA', idA, '99999', now, 'group').allowed, false);
    assert.equal(store.bluestacks.eligibility('accB', idB, '99999', now, 'group').allowed, true);

    // Next calendar day resets cleanly!
    const tomorrow = now + 26 * 3600_000;
    const usageTomorrow = store.bluestacks.dailyInstanceUsage(tomorrow);
    assert.equal(usageTomorrow.totalActions, 0);
    assert.equal(usageTomorrow.perInstance[idA]?.limitReached, false);

    // Service-level enforcement: startActive on [idA, idB] skips idA (already 5/5) and runs idB,
    // then mid-run aborts idB with soft protective sleep as soon as idB hits its 1/1 override!
    const ranIds: string[] = [];
    let idBAbortedByRisk = false;
    const fakeDevices: BluestacksDeviceController = {
      getOnlineKeys: () => new Set(['Pie64_risk_a', 'Pie64_risk_b']),
      discoverInstances: async () => ({
        instances: store.bluestacks.listInstances(['Pie64_risk_a', 'Pie64_risk_b']),
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
      closeInstance: async () => {},
      inspectAccount: async (id) => store.bluestacks.getInstance(id)!,
    };
    const service = new BluestacksService(
      store.bluestacks,
      fakeDevices,
      { run: async () => {} },
      undefined,
      {
        activeRunner: {
          run: async (instanceId, _steps, signal, cb) => {
            ranIds.push(instanceId);
            cb.action(); // pushes idB to 1/1 -> triggers RISK_LIMIT_REACHED abort!
            await new Promise((r) => setTimeout(r, 40));
            if (signal.aborted) {
              idBAbortedByRisk = true;
              throw new Error('TASK_STOPPED');
            }
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

    await service.startActive({
      instanceIds: [idA, idB],
      quickStep: { type: 'feed', durationMinutes: 1, maxLikes: 5 },
    });
    for (let i = 0; i < 30; i++) {
      const st = await service.state(false);
      if (!st.activeRunning) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.deepEqual(ranIds, [idB]);
    assert.equal(idBAbortedByRisk, true);
    const stAfter = await service.state(false);
    assert.match(stAfter.activeProfileCounts?.[idA]?.status ?? '', /自动休眠保护/);
    assert.match(stAfter.activeProfileCounts?.[idB]?.status ?? '', /自动休眠保护/);

    // Scheduled step on limited idA must return softIssue=false & hardBlocked=false (never banned!)
    const schedRes = await service.runScheduledActiveStep({
      instanceId: idA,
      quickStep: { type: 'feed', durationMinutes: 1 },
      onProgress: () => {},
    });
    assert.equal(schedRes.hardBlocked, false);
    assert.equal(schedRes.softIssue, false);
    assert.match(schedRes.status, /自动休眠保护/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('BluestacksService.runDirectPosterForSheet auto-launches, switches to managed Page identity, invokes onPosted, and auto-closes', async () => {
  const instId = deterministicBluestacksId('Pie64_sheet_post');
  const inst: BluestacksInstance = {
    id: instId,
    instanceKey: 'Pie64_sheet_post',
    displayName: 'Sheet-BS',
    alias: null,
    folderId: null,
    sortOrder: 0,
    adbPort: 5620,
    serial: '127.0.0.1:5620',
    fbWidth: 900,
    fbHeight: 1600,
    online: false,
    fbLiteInstalled: true,
    accountState: 'logged-in',
    accountId: 'p023',
    accountName: 'Mawi Lee',
    numericAccountId: '61591261366732',
    identityType: 'personal',
    managedIdentities: [
      { name: 'Mawi Lee', identityType: 'personal', active: true },
      { name: 'Thu', identityType: 'page', active: false },
    ],
    avatarUrl: null,
    lastStatus: null,
    updatedAt: Date.now(),
  };

  const events: string[] = [];
  const repo: BluestacksServiceRepository = {
    savedSettings: () => ({
      installDir: null,
      confPath: null,
      bumperSettings: BumperSettings.parse({ maxConcurrentProfiles: 4 }),
    }),
    savePaths: () => ({
      installDir: null,
      confPath: null,
      bumperSettings: BumperSettings.parse({ maxConcurrentProfiles: 4 }),
    }),
    saveBumperSettings: (v) => BumperSettings.parse(v),
    folders: () => [],
    createFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
    renameFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
    deleteFolder: () => {},
    reorderFolders: () => {},
    listInstances: () => [{ ...inst }],
    getInstance: () => ({ ...inst }),
    saveLastStatus: () => {},
    renameInstance: () => ({ ...inst }),
    reorderInstances: () => {},
    deleteInstances: () => 0,
    targets: () => [],
    todayCounts: () => ({}),
    total: () => 0,
  };
  const devices: BluestacksDeviceController = {
    getOnlineKeys: () => new Set(inst.online ? [inst.instanceKey] : []),
    discoverInstances: async () => ({
      instances: [{ ...inst }],
      config: {
        installDir: null,
        confPath: null,
        detectedInstallDir: null,
        detectedConfPath: null,
        adbReady: true,
        playerReady: true,
      },
    }),
    launchInstance: async () => {
      events.push('launch');
      inst.online = true;
      return { ...inst };
    },
    switchIdentity: async (_id, target) => {
      events.push(`switch:${target.targetName}:${target.targetType}`);
      inst.accountName = target.targetName ?? 'Thu';
      inst.identityType = 'page';
      return { ...inst };
    },
    closeInstance: async () => {
      events.push('close');
      inst.online = false;
    },
    inspectAccount: async () => ({ ...inst }),
  };

  const service = new BluestacksService(repo, devices, { run: async () => {} }, undefined, {
    posterRunner: {
      run: async (_id, _mats, grps, opts, _sig, cb) => {
        events.push(`post:tl=${opts.postToTimeline}:grps=${grps.length}`);
        await cb.onPostLog?.(
          {
            id: randomUUID(),
            profileId: instId,
            accountId: '61580000111222',
            accountName: 'Thu',
            accountAvatar: null,
            identityType: 'page',
            groupId: '__page_timeline__',
            groupName: 'Thu',
            groupAvatar: null,
            materialId: 'm1',
            captionPreview: 'test',
            postId: '12345',
            postUrl: 'https://www.facebook.com/61580000111222',
            postedAt: Date.now(),
          },
          true,
        );
        return { posted: 1, skipped: 0, notes: [] };
      },
    },
  });

  const receivedPosts: Array<{ isTimeline: boolean; postId: string }> = [];
  const res = await service.runDirectPosterForSheet({
    instanceId: instId,
    targetPageId: '61580000111222',
    targetPageName: 'Thu',
    material: {
      id: 'm1',
      caption: 'Hello from Sheet',
      mediaSource: '',
      mediaKind: 'none',
      background: 'plain',
      aiLabel: 'default',
      localFilePath: null,
      hasThumbnail: false,
      cacheStatus: 'ready',
      cacheError: null,
      selected: true,
      sortOrder: 0,
      usedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    targets: [
      {
        id: '__page_timeline__',
        name: 'Thu（专页时间线）',
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalBumpedCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    closeOnFinish: true,
    onPosted: (log, isTimeline) => {
      receivedPosts.push({ isTimeline, postId: log.postId });
    },
  });

  assert.equal(res.timelinePosted, true);
  assert.equal(res.postedCount, 0);
  assert.equal(res.error, undefined);
  assert.deepEqual(events, ['launch', 'switch:Thu:page', 'post:tl=true:grps=0', 'close']);
  assert.deepEqual(receivedPosts, [{ isTimeline: true, postId: '12345' }]);
});

test('closeBlueStacksPids sends WM_CLOSE + UIA confirmation with 6s graceful wait instead of premature kill', async () => {
  if (process.platform !== 'win32') return;
  const calls: Array<{ exe: string; args: string[]; timeoutMs?: number }> = [];
  await closeBlueStacksPids(
    async (exe, args, opts) => {
      calls.push({
        exe,
        args,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return Buffer.alloc(0);
    },
    [{ pid: 12345, hwnd: '987654' }, { pid: 12345, hwnd: '' }, { pid: 22222 }],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.exe, 'powershell.exe');
  assert.ok((calls[0]?.timeoutMs ?? 0) >= 30_000);
  const script = calls[0]?.args[calls[0].args.length - 1] ?? '';
  assert.match(script, /Pid = 12345; Hwnd = \[Int64\]987654/);
  assert.match(script, /Pid = 22222; Hwnd = \[Int64\]0/);
  assert.match(script, /0x0010/); // WM_CLOSE
  assert.match(script, /InvokePattern/); // UIA confirmation dialog handler
  assert.match(script, /AddSeconds\(3\.5\)/);
  assert.match(script, /AddSeconds\(6\)/); // bounded graceful wait
  assert.doesNotMatch(script, /reboot\s+-p/);
});

test('BluestacksService manual tasks auto-launch closed portrait instances while still blocking landscape', async () => {
  const portraitId = deterministicBluestacksId('Pie64_closed_ok');
  const landscapeId = deterministicBluestacksId('Pie64_closed_land');
  const liveInstances: BluestacksInstance[] = [
    {
      id: portraitId,
      instanceKey: 'Pie64_closed_ok',
      displayName: 'Closed Portrait',
      alias: 'p023',
      adbPort: 5565,
      serial: '127.0.0.1:5565',
      fbWidth: 720,
      fbHeight: 1280,
      folderId: null,
      sortOrder: 0,
      online: false,
      fbLiteInstalled: true,
      accountName: 'Mawi Lee',
      accountId: '1000111',
      numericAccountId: '1000111',
      identityType: 'personal',
      managedIdentities: [],
      avatarUrl: null,
      accountState: 'logged-in',
      lastStatus: '未启动',
      updatedAt: Date.now(),
    },
    {
      id: landscapeId,
      instanceKey: 'Pie64_closed_land',
      displayName: '不使用',
      alias: null,
      adbPort: 5555,
      serial: '127.0.0.1:5555',
      fbWidth: 1920,
      fbHeight: 1080,
      folderId: null,
      sortOrder: 1,
      online: false,
      fbLiteInstalled: false,
      accountName: '',
      accountId: '',
      numericAccountId: '',
      identityType: 'unknown',
      managedIdentities: [],
      avatarUrl: null,
      accountState: 'unknown',
      lastStatus: '未启动',
      updatedAt: Date.now(),
    },
  ];

  const events: string[] = [];
  const defaultSettings = BumperSettings.parse({ maxConcurrentProfiles: 2 });
  const repo: BluestacksServiceRepository = {
    listInstances: () => liveInstances.map((x) => ({ ...x })),
    getInstance: (id) => liveInstances.find((x) => x.id === id) ?? null,
    folders: () => [],
    savedSettings: () => ({
      installDir: null,
      confPath: null,
      bumperSettings: defaultSettings,
      pageBumperSettings: defaultSettings,
    }),
    saveBumperSettings: (v) => BumperSettings.parse(v),
    savePageBumperSettings: (v) => BumperSettings.parse(v),
    savePaths: () => ({
      installDir: null,
      confPath: null,
      bumperSettings: defaultSettings,
    }),
    createFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
    renameFolder: () => ({ id: randomUUID(), name: 'f', sortOrder: 0 }),
    deleteFolder: () => {},
    reorderFolders: () => {},
    renameInstance: () => ({ ...liveInstances[0]! }),
    reorderInstances: () => {},
    deleteInstances: () => 0,
    saveLastStatus: (id, status) => {
      const target = liveInstances.find((x) => x.id === id);
      if (target) target.lastStatus = status;
    },
    targets: (kind) =>
      kind === 'groups'
        ? [
            {
              id: '1072811415396195',
              name: 'Test Group',
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalBumpedCount: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ]
        : [
            {
              id: '61588452821652',
              name: 'Test Page',
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalBumpedCount: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
    todayCounts: () => ({}),
    total: () => 0,
  };

  const devices: BluestacksDeviceController = {
    discoverInstances: async () => ({
      instances: liveInstances.map((x) => ({ ...x })),
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
    getOnlineKeys: () => new Set(liveInstances.filter((x) => x.online).map((x) => x.instanceKey)),
    launchInstance: async (id) => {
      events.push(`launch:${id}`);
      const target = liveInstances.find((x) => x.id === id)!;
      target.online = true;
      return { ...target };
    },
    closeInstance: async (id) => {
      const target = liveInstances.find((x) => x.id === id);
      if (target) target.online = false;
    },
    inspectAccount: async (id) => {
      events.push(`inspect:${id}`);
      const target = liveInstances.find((x) => x.id === id)!;
      return { ...target };
    },
  };

  const runner: BluestacksBumperRunnerPort = {
    run: async (id, _g, _p, _s, _sig, _cb, mode) => {
      events.push(`bumper:${mode ?? 'group'}:${id}`);
    },
  };

  const service = new BluestacksService(repo, devices, runner, undefined, {
    activeRunner: {
      run: async (id) => {
        events.push(`active:${id}`);
        return {
          completedSteps: 1,
          likes: 0,
          acceptedFriends: 0,
          published: 0,
          skippedSteps: 0,
          notes: [],
        };
      },
    },
    inviterRunner: {
      run: async (id) => {
        events.push(`inviter:${id}`);
        return { invited: 2, skippedGroups: 0, notes: [] };
      },
    },
  });

  // 1. Landscape closed instance MUST still be rejected (never boot landscape!)
  await assert.rejects(
    () =>
      service.startActive({
        instanceIds: [landscapeId],
        quickStep: { type: 'feed', durationMinutes: 1, maxLikes: 0 },
      }),
    /横屏/,
  );
  assert.equal(events.length, 0);

  // 2. Closed portrait instance auto-launches & runs Active Feed seamlessly!
  await service.startActive({
    instanceIds: [portraitId],
    quickStep: { type: 'feed', durationMinutes: 1, maxLikes: 0 },
  });
  for (let i = 0; i < 40 && !events.includes(`active:${portraitId}`); i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.deepEqual(events, [`launch:${portraitId}`, `active:${portraitId}`]);

  // 3. Close again and verify startInviter also auto-launches!
  liveInstances[0]!.online = false;
  events.length = 0;
  await service.startInviter({
    instanceIds: [portraitId],
    groupIds: ['1072811415396195'],
    invitesPerGroup: 5,
  });
  for (let i = 0; i < 40 && !events.includes(`inviter:${portraitId}`); i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.deepEqual(events, [`launch:${portraitId}`, `inviter:${portraitId}`]);

  // 4. Close again and verify startBumper also auto-launches!
  liveInstances[0]!.online = false;
  events.length = 0;
  await service.startBumper({
    profileIds: [portraitId],
    groupIds: ['1072811415396195'],
    pageIds: ['61588452821652'],
  });
  for (let i = 0; i < 40 && !events.includes(`bumper:group:${portraitId}`); i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.deepEqual(events, [`launch:${portraitId}`, `bumper:group:${portraitId}`]);
});
