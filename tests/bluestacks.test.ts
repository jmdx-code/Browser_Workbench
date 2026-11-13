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
  compareAvatarToRegion,
  cropToDataUrl,
  detectVideoSpeakerState,
  extractActionBars,
  extractInlineVideoControls,
  extractPostCards,
  isBottomSheetOpen,
  isDarkScreenOrReelMode,
  isLikeButtonBlue,
  makeCanonicalRect,
  parseDumpsysTop,
  parseLiteXml,
  resolveSharePostUrl,
  scalePointFrom900,
} from '../src/infrastructure/bluestacks-vision.js';
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
    weeklyDailyCounts: async () => [],
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
