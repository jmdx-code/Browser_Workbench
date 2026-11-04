import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { parseTargetMetadataFromHtml } from '../src/infrastructure/group-bumper-avatar.js';
import { GroupBumperService, type BumperRunner } from '../src/application/group-bumper-service.js';
import { GroupBumperBrowserAdapter } from '../src/infrastructure/group-bumper-runner.js';
import type { Core } from '../src/bridge/core.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import {
  isLocalAvatar,
  isTargetIncomplete,
  MAX_LOCAL_AVATAR_BYTES,
} from '../src/shared/group-bumper.js';
import {
  localizeAvatarBytesToDataUrl,
  verifyTargetAvatar,
} from '../src/infrastructure/group-bumper-avatar.js';
import { createCanvas } from '@napi-rs/canvas';
async function fixture(run: (store: WorkspaceStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wo54-'));
  const s = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  try {
    await run(s);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const idleRunner: BumperRunner = {
  ready: () => false,
  busy: async () => false,
  run: async () => {},
  stop: async () => {},
};
test('WO54 scoped inline metadata resolves aliases and referenced pictures without another actor image', () => {
  const html =
    '<script type="application/json">' +
    JSON.stringify({
      records: {
        wrong: {
          __typename: 'User',
          id: '99999',
          name: 'Wrong',
          profile_picture: { uri: 'https://example.com/wrong.jpg' },
        },
        target: {
          __typename: 'Page',
          id: '12345',
          username: 'my.page',
          name: 'Target',
          'profile_picture(scale:1)': { __ref: 'picture' },
        },
        picture: { __id: 'picture', uri: 'https://example.com/photo%25.jpg' },
      },
    }) +
    '</script>';
  assert.deepEqual(parseTargetMetadataFromHtml(html, 'pages', 'my.page'), {
    canonicalId: '12345',
    name: 'Target',
    avatarUrl: 'https://example.com/photo%25.jpg',
  });
  assert.equal(parseTargetMetadataFromHtml(html, 'pages', '77777').avatarUrl, null);
  assert.equal(
    isTargetIncomplete({ id: 'my.page', name: 'Target', avatarUrl: 'https://example.com/a.jpg' }),
    true,
  );
  assert.equal(
    parseTargetMetadataFromHtml(
      '<script type="application/json">' +
        JSON.stringify({
          __typename: 'Group',
          id: '54321',
          name: 'Group',
          cover_photo: { image: { uri: 'https://example.com/cover.jpg' } },
        }) +
        '</script>',
      'groups',
      '54321',
    ).avatarUrl,
    'https://example.com/cover.jpg',
  );
});
test('WO54 canonical group and page merges prefer fresh metadata and preserve successful logs', async () =>
  fixture(async (s) => {
    for (const kind of ['groups', 'pages'] as const) {
      const r = s.groupBumper;
      r.upsertTargets(kind, {
        items: [
          { id: 'old.slug', name: 'Old' },
          { id: '12345', name: 'Existing' },
        ],
      });
      r.updateAvatar(kind, '12345', 'https://example.com/old.jpg');
      r.applyResolvedTargetMetadata(kind, 'old.slug', {
        canonicalId: '12345',
        name: 'New',
        avatarUrl: 'https://example.com/new.jpg',
      });
      assert.equal(r.targets(kind).length, 1);
      assert.equal(r.targets(kind)[0]?.name, 'New');
      assert.equal(r.targets(kind)[0]?.avatarUrl, 'https://example.com/new.jpg');
    }
  }));
test('WO54 manual selected refresh forces complete rows; default refresh only reads incomplete rows; no-browser result is visible', async () =>
  fixture(async (s) => {
    const r = s.groupBumper;
    const c = createCanvas(16, 16);
    const localDataUrl = await localizeAvatarBytesToDataUrl(await c.encode('png'));
    assert.ok(localDataUrl && isLocalAvatar(localDataUrl));
    r.upsertTargets('pages', {
      items: [
        { id: '12345', name: 'Complete' },
        { id: 'alias.page', name: 'Alias' },
      ],
    });
    for (const row of r.targets('pages')) r.updateAvatar('pages', row.id, localDataUrl);
    const calls: string[][] = [];
    const svc = new GroupBumperService(
      r,
      idleRunner,
      async () => ({ comments: [], total: 0 }),
      () => {},
      async (_kind, rows) => {
        calls.push(rows.map((x) => x.id));
        return { updated: 0, needsBrowser: rows.length, failed: 0 };
      },
    );
    await svc.manage('pages/refresh', {});
    assert.deepEqual(calls[0], ['alias.page']);
    assert.match((await svc.state()).statusText, /无可用闲置浏览器/);
    await svc.manage('pages/refresh', { ids: ['12345'] });
    assert.deepEqual(calls[1], ['12345']);
  }));
test('WO54 pending refresh prevents a competing bumper run until the refresh settles', async () =>
  fixture(async (s) => {
    s.groupBumper.upsertTargets('pages', { items: [{ id: '12345' }] });
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    const svc = new GroupBumperService(
      s.groupBumper,
      idleRunner,
      async () => ({ comments: [], total: 0 }),
      () => {},
      async () => {
        await done;
        return { updated: 1, needsBrowser: 0, failed: 0 };
      },
    );
    const work = svc.manage('pages/refresh', {});
    await new Promise((r) => setImmediate(r));
    await assert.rejects(
      svc.start({ profileIds: [randomUUID()], groupIds: ['12345'], pageIds: ['12345'] }),
      /正在读取资料/,
    );
    finish();
    await work;
  }));
test('WO54 browser resolver skips a busy first peer and reads once from the next idle peer with no workspace cleanup', async () => {
  const a = { profileId: randomUUID(), online: true, synced: true, phase: 'PAUSED', epoch: 'a' },
    b = { ...a, profileId: randomUUID(), epoch: 'b' };
  let reads = 0;
  const pngBytes = await createCanvas(16, 16).encode('png');
  const kernel = {
    withSummary: async (_peer: unknown, read: (port: unknown) => Promise<unknown>) =>
      read({ inventory: async () => ({ tabs: [], operations: [] }) }),
    inspectIdleFacebookPage: async () => null,
    readFacebookMetadataPage: async (
      peer: typeof b,
      _guard: unknown,
      read: (p: unknown) => Promise<unknown>,
    ) => {
      assert.equal(peer, b);
      reads++;
      return {
        stop: { state: 'stopped' },
        closedRecord: { state: 'CLOSED' },
        reading: await read({
          evaluate: async () =>
            '<meta property="og:title" content="Target"><meta property="og:image" content="https://example.com/a.jpg">',
        }),
      };
    },
  };
  const adapter = new GroupBumperBrowserAdapter(
    {} as never,
    () => kernel as unknown as KernelBridge,
    () =>
      ({
        peers: new Map([
          [a.profileId, a],
          [b.profileId, b],
        ]),
      }) as unknown as Core,
    async (id) => id === a.profileId,
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(pngBytes), { headers: { 'content-type': 'image/png' } });
  let result;
  try {
    result = await adapter.resolveTargetMetadata('pages', '12345');
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(result.name, 'Target');
  assert.ok(isLocalAvatar(result.avatarUrl));
  assert.equal(reads, 1);
  assert.equal(adapter.hasMetadataReads(), false);
});

test('WO55 readFacebookMetadataPage always opens a background temporary tab without adopting READY tab and closes only temporary tab', async () => {
  const { KernelBridge: Bridge } = await import('../src/infrastructure/kernel-bridge.js');
  const profileId = randomUUID(),
    proof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: 'target',
    },
    tempProof = {
      profileId,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 99,
      targetId: 'temp-target',
    };
  for (const retained of [false, true]) {
    const peer = {
      profileId,
      capabilities: ['facebook-task-kernel-v1', 'facebook-task-main-frame-v1'],
    };
    let closed = 0;
    let connection: Record<string, unknown> = {};
    const kernel: KernelBridge = Object.assign(Object.create(Bridge.prototype) as object, {
      idlePages: new Map(),
      withSummary: async (_peer: unknown, read: (port: unknown) => Promise<unknown>) =>
        read({
          inventory: async () => ({
            tabs: retained ? [{ state: 'READY', proof }] : [],
            operations: [],
          }),
        }),
      connectOwned: async (
        _p: unknown,
        _files: unknown,
        existing: unknown,
        options: {
          preservePage: () => boolean;
          foreground: boolean;
          readonlyIdentity: boolean;
          forceNewTemporaryTab?: boolean;
          backgroundMetadataRead?: boolean;
        },
      ) => {
        assert.equal(existing, undefined);
        assert.equal(options.preservePage(), false);
        assert.equal(options.foreground, false);
        assert.equal(options.readonlyIdentity, true);
        assert.equal(options.forceNewTemporaryTab, true);
        assert.equal(options.backgroundMetadataRead, true);
        connection = {
          proof: tempProof,
          browser: {
            contexts: () => [
              {
                pages: () => [
                  {
                    evaluate: async () => ({ url: 'https://www.facebook.com/' }),
                  },
                ],
              },
            ],
          },
          close: async () => {
            closed++;
            connection.closedInventory = {
              tabs: [
                ...(retained ? [{ state: 'READY', proof }] : []),
                { state: 'CLOSED', proof: tempProof },
              ],
            };
            return { state: 'stopped' };
          },
          stopOnCloseFailure: async () => {
            throw Error('unexpected fallback');
          },
        };
        return connection;
      },
    }) as unknown as KernelBridge;
    const result = await kernel.readFacebookMetadataPage(
      peer as never,
      () => {},
      async () => ({ name: 'Read only' }),
    );
    assert.equal(result.reading.name, 'Read only');
    assert.equal(result.closedRecord?.state, 'CLOSED');
    assert.equal(closed, 1);
  }
});

test('WO54 HTML avatar URLs are rejected and actual image responses are localized to data:image/... <= 128KB', async () => {
  const pngBytes = await createCanvas(320, 320).encode('png');
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      new Response(
        String(url).includes('html') ? '<html>redirect</html>' : new Uint8Array(pngBytes),
        { headers: { 'content-type': String(url).includes('html') ? 'text/html' : 'image/png' } },
      );
    assert.equal(await verifyTargetAvatar('https://example.com/html', 1000), null);
    const localized = await verifyTargetAvatar('https://example.com/image', 1000);
    assert.ok(localized && isLocalAvatar(localized));
    assert.ok(localized.length <= MAX_LOCAL_AVATAR_BYTES);
  } finally {
    globalThis.fetch = previous;
  }
});

test('WO55 a parked idle connection is released before opening a temporary metadata tab so user READY tab is untouched', async () => {
  const { KernelBridge: Bridge } = await import('../src/infrastructure/kernel-bridge.js');
  const id = randomUUID(),
    proof = {
      profileId: id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 7,
      targetId: 't',
    },
    tempProof = {
      profileId: id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 88,
      targetId: 'temp',
    };
  const peer = {
    profileId: id,
    capabilities: [
      'facebook-task-kernel-v1',
      'facebook-task-main-frame-v1',
      'kernel-page-quiesce-v1',
    ],
  };
  const parked = new Map();
  let idleReleases = 0;
  let tempCloses = 0;
  const conn = {
    proof,
    inventory: async () => ({ tabs: [{ state: 'READY', proof }], operations: [] }),
    close: async () => {
      idleReleases++;
      parked.delete(id);
      return { state: 'stopped' };
    },
  };
  parked.set(id, { peer, connection: conn });
  const kernel = Object.assign(Object.create(Bridge.prototype) as object, {
    idlePages: parked,
    withSummary: async (_p: unknown, read: (port: unknown) => Promise<unknown>) =>
      read({ inventory: async () => ({ tabs: [{ state: 'READY', proof }], operations: [] }) }),
    releaseIdleForExtension: async () => {
      await conn.close();
    },
    connectOwned: async (
      _p: unknown,
      _files: unknown,
      existing: unknown,
      options: { preservePage: () => boolean },
    ) => {
      assert.equal(existing, undefined);
      assert.equal(options.preservePage(), false);
      const tempConn: Record<string, unknown> = {
        proof: tempProof,
        browser: {
          contexts: () => [{ pages: () => [{ evaluate: async () => ({}) }] }],
        },
        close: async () => {
          tempCloses++;
          tempConn.closedInventory = {
            tabs: [
              { proof, state: 'READY' },
              { proof: tempProof, state: 'CLOSED' },
            ],
          };
          return { state: 'stopped' };
        },
      };
      return tempConn;
    },
  }) as unknown as KernelBridge;
  const result = await kernel.readFacebookMetadataPage(
    peer as never,
    () => {},
    async () => ({ name: 'Read' }),
  );
  assert.equal(result.reading.name, 'Read');
  assert.equal(idleReleases, 1);
  assert.equal(tempCloses, 1);
  assert.equal(result.closedRecord?.state, 'CLOSED');
  assert.equal(parked.size, 0);
});

test('WO54 a Page avatar never uses its cover photo or a Facebook photo document URL', () => {
  const html =
    '<script type="application/json">' +
    JSON.stringify({
      __typename: 'User',
      id: '12345',
      name: 'Page',
      cover_photo: {
        url: 'https://www.facebook.com/photo/?fbid=777',
        image: { uri: 'https://example.com/cover.jpg' },
      },
      profilePicLarge: { uri: 'https://example.com/avatar.jpg' },
    }) +
    '</script>';
  assert.equal(
    parseTargetMetadataFromHtml(html, 'pages', '12345').avatarUrl,
    'https://example.com/avatar.jpg',
  );
});

test('WO54 alias merging updates matching log IDs and names without losing counts', async () =>
  fixture(async (s) => {
    const r = s.groupBumper;
    for (const kind of ['groups', 'pages'] as const)
      r.upsertTargets(kind, {
        items: [
          { id: 'alias', name: 'Old' },
          { id: '12345', name: 'Existing' },
        ],
      });
    r.record({
      id: randomUUID(),
      profileId: randomUUID(),
      accountId: '12345',
      groupId: 'alias',
      groupName: 'Old',
      pageId: 'alias',
      pageName: 'Old',
      postId: '99999',
      postUrl: 'https://www.facebook.com/groups/alias/posts/99999/',
      liked: true,
      commentText: null,
      bumpedAt: Date.now(),
    });
    for (const kind of ['groups', 'pages'] as const) {
      r.applyResolvedTargetMetadata(kind, 'alias', {
        canonicalId: '12345',
        name: 'Resolved',
        avatarUrl: 'https://example.com/new.jpg',
      });
      assert.equal(r.targets(kind)[0]?.totalBumpedCount, 1);
    }
    assert.equal(r.logs()[0]?.groupId, '12345');
    assert.equal(r.logs()[0]?.pageId, '12345');
    assert.equal(r.logs()[0]?.groupName, 'Resolved');
    assert.equal(r.logs()[0]?.pageName, 'Resolved');
    assert.equal(r.total(), 1);
  }));

test('WO55 isLocalAvatar and isTargetIncomplete enforce local data:image/... <= 128KB and non-placeholder name', async () => {
  const smallCanvas = createCanvas(64, 64);
  const validLocal = await localizeAvatarBytesToDataUrl(await smallCanvas.encode('png'));
  assert.ok(validLocal && isLocalAvatar(validLocal));
  assert.equal(isLocalAvatar(null), false);
  assert.equal(isLocalAvatar('https://scontent.xx.fbcdn.net/v/t39.30808-1/a.jpg'), false);
  assert.equal(
    isLocalAvatar('data:image/webp;base64,' + 'A'.repeat(MAX_LOCAL_AVATAR_BYTES)),
    false,
  );

  assert.equal(
    isTargetIncomplete({ id: '123456', name: 'Valid Name', avatarUrl: validLocal }),
    false,
  );
  assert.equal(
    isTargetIncomplete({
      id: '123456',
      name: 'Valid Name',
      avatarUrl: 'https://scontent.xx.fbcdn.net/a.jpg',
    }),
    true,
  );
  assert.equal(isTargetIncomplete({ id: '123456', name: '123456', avatarUrl: validLocal }), true);
  assert.equal(
    isTargetIncomplete({ id: 'alias.slug', name: 'Valid Name', avatarUrl: validLocal }),
    true,
  );
});

test('WO55 anti-regression prevents external URL or null from overwriting localized data:image/... avatar across store methods', async () =>
  fixture(async (s) => {
    const r = s.groupBumper;
    const localAvatar = await localizeAvatarBytesToDataUrl(
      await createCanvas(32, 32).encode('png'),
    );
    assert.ok(localAvatar && isLocalAvatar(localAvatar));

    for (const kind of ['groups', 'pages'] as const) {
      r.upsertTargets(kind, { items: [{ id: '12345', name: 'Real Target Name' }] });
      r.updateAvatar(kind, '12345', localAvatar);
      assert.equal(r.targets(kind)[0]?.avatarUrl, localAvatar);

      r.updateAvatar(kind, '12345', 'https://scontent.xx.fbcdn.net/expired.jpg');
      assert.equal(r.targets(kind)[0]?.avatarUrl, localAvatar);

      r.applyResolvedTargetMetadata(kind, '12345', {
        canonicalId: '12345',
        name: '12345',
        avatarUrl: 'https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=12345',
      });
      assert.equal(r.targets(kind)[0]?.avatarUrl, localAvatar);
      assert.equal(r.targets(kind)[0]?.name, 'Real Target Name');

      r.applyResolvedTargetMetadata(kind, '12345', {
        canonicalId: '12345',
        name: null,
        avatarUrl: null,
      });
      assert.equal(r.targets(kind)[0]?.avatarUrl, localAvatar);
    }

    s.groupInviter.upsertGroups({
      items: [{ groupId: '12345', groupName: 'Imported Name' }],
    });
    s.groupInviter.updateGroupAvatar('12345', 'https://scontent.xx.fbcdn.net/external.jpg');
    assert.equal(r.targets('groups')[0]?.avatarUrl, localAvatar);
  }));

test('WO55 pages/add and groups/add both use isTargetIncomplete to trigger refresh', async () =>
  fixture(async (s) => {
    const r = s.groupBumper;
    const refreshed: Array<{ kind: string; ids: string[] }> = [];
    const svc = new GroupBumperService(
      r,
      idleRunner,
      async () => ({ comments: [], total: 0 }),
      () => {},
      async (kind, items) => {
        refreshed.push({ kind, ids: items.map((i) => i.id) });
        return { updated: items.length, needsBrowser: 0, failed: 0 };
      },
    );
    await svc.manage('pages/add', { items: [{ id: 'my.page.alias', name: 'My Page' }] });
    await svc.manage('groups/add', { items: [{ id: 'my.group.alias', name: 'My Group' }] });
    assert.deepEqual(refreshed, [
      { kind: 'pages', ids: ['my.page.alias'] },
      { kind: 'groups', ids: ['my.group.alias'] },
    ]);
  }));

test('WO55 per-item independent timeout and itemToken prevent stale async writes while allowing subsequent items to succeed', async () => {
  const peer = {
    profileId: randomUUID(),
    online: true,
    synced: true,
    phase: 'PAUSED',
    epoch: 'e1',
  };
  const pngBytes = await createCanvas(24, 24).encode('png');
  const resolvedItems: Array<{ id: string; meta: unknown }> = [];
  const navUrls: string[] = [];

  const kernel = {
    withSummary: async (_peer: unknown, read: (port: unknown) => Promise<unknown>) =>
      read({ inventory: async () => ({ tabs: [], operations: [] }) }),
    readFacebookMetadataPage: async (
      _peer: unknown,
      _guard: unknown,
      read: (page: unknown) => Promise<unknown>,
    ) => {
      let currentUrl = 'https://www.facebook.com/groups/111111/';
      const fakePage = {
        evaluate: async (fn: unknown, arg?: unknown) => {
          if (typeof arg === 'string' && arg.startsWith('https://')) {
            navUrls.push(arg);
            currentUrl = arg;
            return;
          }
          const fnStr = String(fn);
          if (fnStr.includes('location.href') && arg === undefined) {
            return currentUrl;
          }
          if (currentUrl.includes('111111')) {
            await new Promise((r) => setTimeout(r, 120));
            return {
              href: currentUrl,
              readyState: 'loading',
              navigated: true,
              abnormal: null,
              unavailableTarget: false,
              canonicalId: null,
              domName: null,
              domAvatarUrl: null,
              scopedHtml: '',
              summary: null,
            };
          }
          return {
            href: currentUrl,
            readyState: 'complete',
            navigated: true,
            abnormal: null,
            unavailableTarget: false,
            canonicalId: '222222',
            domName: 'Second Group',
            domAvatarUrl: 'https://scontent.xx.fbcdn.net/second.jpg',
            scopedHtml:
              '<meta property="og:title" content="Second Group"><meta property="og:image" content="https://scontent.xx.fbcdn.net/second.jpg">',
            summary: null,
          };
        },
      };
      return {
        stop: { state: 'stopped' },
        closedRecord: { state: 'CLOSED' },
        reading: await read(fakePage),
      };
    },
  };

  const adapter = new GroupBumperBrowserAdapter(
    {} as never,
    () => kernel as unknown as KernelBridge,
    () => ({ peers: new Map([[peer.profileId, peer]]) }) as unknown as Core,
    async () => false,
  );

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(pngBytes), { headers: { 'content-type': 'image/png' } });
  try {
    const out = await adapter.refreshTargets(
      'groups',
      [
        {
          id: '111111',
          name: '111111',
          avatarUrl: null,
        },
        {
          id: '222222',
          name: '222222',
          avatarUrl: null,
        },
      ],
      {
        itemTimeoutMs: 60,
        onItemResolved: async (rawId, meta) => {
          resolvedItems.push({ id: rawId, meta });
        },
      },
    );
    assert.equal(out.updated, 1);
    assert.equal(out.failed, 1);
    assert.equal(resolvedItems.length, 1);
    assert.equal(resolvedItems[0]?.id, '222222');
    assert.deepEqual(navUrls, ['https://www.facebook.com/groups/222222/']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('WO55 account-level login failure immediately fuses remaining batch while preserving already-saved items', async () => {
  const peer = {
    profileId: randomUUID(),
    online: true,
    synced: true,
    phase: 'PAUSED',
    epoch: 'e1',
  };
  const pngBytes = await createCanvas(24, 24).encode('png');
  const resolvedItems: string[] = [];
  const navUrls: string[] = [];

  const kernel = {
    withSummary: async (_peer: unknown, read: (port: unknown) => Promise<unknown>) =>
      read({ inventory: async () => ({ tabs: [], operations: [] }) }),
    readFacebookMetadataPage: async (
      _peer: unknown,
      _guard: unknown,
      read: (page: unknown) => Promise<unknown>,
    ) => {
      let currentUrl = 'https://www.facebook.com/groups/111111/';
      const fakePage = {
        evaluate: async (_fn: unknown, arg?: unknown) => {
          if (typeof arg === 'string' && arg.startsWith('https://')) {
            navUrls.push(arg);
            currentUrl = arg;
            return;
          }
          if (currentUrl.includes('111111')) {
            return {
              href: currentUrl,
              readyState: 'complete',
              navigated: true,
              abnormal: null,
              unavailableTarget: false,
              canonicalId: '111111',
              domName: 'First Group',
              domAvatarUrl: 'https://scontent.xx.fbcdn.net/first.jpg',
              scopedHtml:
                '<meta property="og:title" content="First Group"><meta property="og:image" content="https://scontent.xx.fbcdn.net/first.jpg">',
              summary: null,
            };
          }
          return {
            href: 'https://www.facebook.com/login/?next=222222',
            readyState: 'complete',
            navigated: true,
            abnormal: 'FACEBOOK_ACCOUNT_LOGGED_OUT',
            unavailableTarget: false,
            canonicalId: null,
            domName: null,
            domAvatarUrl: null,
            scopedHtml: '',
            summary: null,
          };
        },
      };
      return {
        stop: { state: 'stopped' },
        closedRecord: { state: 'CLOSED' },
        reading: await read(fakePage),
      };
    },
  };

  const adapter = new GroupBumperBrowserAdapter(
    {} as never,
    () => kernel as unknown as KernelBridge,
    () => ({ peers: new Map([[peer.profileId, peer]]) }) as unknown as Core,
    async () => false,
  );

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(pngBytes), { headers: { 'content-type': 'image/png' } });
  try {
    const out = await adapter.refreshTargets(
      'groups',
      [
        {
          id: '111111',
          name: '111111',
          avatarUrl: null,
        },
        {
          id: '222222',
          name: '222222',
          avatarUrl: null,
        },
        {
          id: '333333',
          name: '333333',
          avatarUrl: null,
        },
      ],
      {
        onItemResolved: async (rawId) => {
          resolvedItems.push(rawId);
        },
      },
    );
    assert.deepEqual(resolvedItems, ['111111']);
    assert.equal(out.updated, 1);
    assert.equal(out.failed, 2);
    assert.match(out.error ?? '', /登录态失效或受限/);
    assert.deepEqual(navUrls, ['https://www.facebook.com/groups/222222/']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
