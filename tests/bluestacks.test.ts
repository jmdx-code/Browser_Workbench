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
import type { CompatibleRepository } from '../src/domain/persistence.js';
import {
  compareAvatarToRegion,
  cropToDataUrl,
  extractActionBars,
  extractPostCards,
  isBottomSheetOpen,
  isDarkScreenOrReelMode,
  isLikeButtonBlue,
  makeCanonicalRect,
  parseDumpsysTop,
  parseLiteXml,
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
