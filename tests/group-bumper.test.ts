import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, workspaceSchemaVersion } from '../src/infrastructure/workspace-store.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import {
  BumperSettings,
  extractBumperPageId,
  type BumperLog,
  type BumperTarget,
} from '../src/shared/group-bumper.js';
import { applyGroupGridPaste } from '../src/renderer/group-inviter-grid.js';
import {
  extractBumperPost,
  relativePostAge,
  bumperAuthorMatch,
} from '../src/infrastructure/group-bumper-effects.js';
import {
  bumperSetupLabels,
  bumperSetupKinds,
  bumperDigest,
} from '../src/infrastructure/group-bumper-recovery.js';
import {
  decodeHtmlEntities,
  parseTargetMetadataFromHtml,
} from '../src/infrastructure/group-bumper-avatar.js';
import {
  claimBumperComment,
  confirmedBumperGraphQL,
} from '../src/infrastructure/group-bumper-runner.js';
import {
  GroupBumperService,
  buildStaggeredBumperQueues,
} from '../src/application/group-bumper-service.js';
import { profileTaskResultLabel } from '../src/shared/profile-task-result.js';
import { PersistenceClient } from '../src/infrastructure/persistence-client.js';

async function fixture(work: (store: WorkspaceStore, file: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bumper-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    await work(store, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const target = (id: string, name = id): BumperTarget => ({
  id,
  name,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});
const profileId = randomUUID();
function log(postId: string, accountId = '10001', overrides: Partial<BumperLog> = {}): BumperLog {
  return {
    id: randomUUID(),
    profileId,
    accountId,
    groupId: '12345',
    groupName: 'group',
    pageId: '20001',
    pageName: 'page',
    postId,
    postUrl: `https://www.facebook.com/groups/12345/posts/${postId}/`,
    liked: true,
    commentText: null,
    bumpedAt: Date.now(),
    ...overrides,
  };
}
test('schema 43 adds only bumper data, target CRUD and inviter import preserve existing data', async () =>
  fixture(async (store, file) => {
    assert.ok(workspaceSchemaVersion >= 43);
    const r = store.groupBumper;
    store.groupInviter.upsertGroups({ items: [{ groupId: '12345', groupName: 'original' }] });
    store.groupInviter.updateGroupAvatar('12345', 'https://example.com/avatar.jpg');
    assert.equal(r.targets('groups')[0]?.avatarUrl, 'https://example.com/avatar.jpg');
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'updated' }] });
    assert.equal(r.targets('groups')[0]?.name, 'updated');
    assert.equal(r.targets('groups')[0]?.avatarUrl, 'https://example.com/avatar.jpg');
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'page' }] });
    r.updateAvatar('pages', '20001', 'https://example.com/page.jpg');
    assert.equal(r.targets('pages')[0]?.avatarUrl, 'https://example.com/page.jpg');
    assert.equal(r.deleteTargets('pages', { ids: ['20001'] }), 1);
    // WO60-B：共用小组库两侧都是真实名称时，较新一侧的改名同步给另一侧
    assert.equal(store.groupInviter.listGroups()[0]?.groupName, 'updated');
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, workspaceSchemaVersion);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  }));
for (const scope of ['group', 'page'] as const) {
  test(`comment editor merges ${scope} edits without resurrecting consumed rows or deleting concurrent additions`, async () =>
    fixture((store) => {
      const r = store.groupBumper;
      const original = r.saveComments(
        { texts: ['consumed', 'kept', 'deleted'], consumeCommentOnUse: true },
        scope,
      );
      const consumed = original.find((c) => c.text === 'consumed')!;
      r.record(
        log('70001', '10001', { liked: false, commentText: consumed.text, sourceMode: scope }),
        consumed.id,
      );
      const current = r.comments(scope);
      r.saveComments(
        {
          texts: [...current.map((c) => c.text), 'concurrent addition'],
          consumeCommentOnUse: true,
        },
        scope,
      );
      const keptId = r.comments(scope).find((c) => c.text === 'kept')!.id;
      const after = r.saveComments(
        {
          texts: ['consumed', 'kept', 'new edit'],
          consumeCommentOnUse: true,
          baseComments: original.map(({ id, text }) => ({ id, text })),
        },
        scope,
      );
      assert.deepEqual(after.map((c) => c.text).sort(), [
        'concurrent addition',
        'kept',
        'new edit',
      ]);
      assert.equal(after.find((c) => c.text === 'kept')!.id, keptId);
      const unchanged = r.saveComments(
        {
          texts: original.map((c) => c.text),
          consumeCommentOnUse: true,
          baseComments: original.map(({ id, text }) => ({ id, text })),
        },
        scope,
      );
      assert.equal(
        unchanged.some((c) => c.text === 'consumed'),
        false,
      );
      assert.equal(
        unchanged.some((c) => c.text === 'deleted'),
        false,
      );
      const reopened = r.comments(scope);
      const readded = r.saveComments(
        {
          texts: [...reopened.map((c) => c.text), 'consumed'],
          consumeCommentOnUse: true,
          baseComments: reopened.map(({ id, text }) => ({ id, text })),
        },
        scope,
      );
      assert.ok(readded.some((c) => c.text === 'consumed'));
      const otherScope = scope === 'group' ? 'page' : 'group';
      assert.equal(r.comments(otherScope).length, 0);
    }));
}

test('parallel comment selection rechecks claims after real persistence reads, reselects, and releases for retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-comment-claims-'));
  const client = await PersistenceClient.open(dir);
  try {
    const r = client.workspace.groupBumper;
    const claims = new Set<string>();
    const choose = (postId: string) =>
      claimBumperComment(
        claims,
        (ids) => r.pickComment(postId, 0, ids, 'group'),
        () => {},
      );
    await r.saveComments({ texts: ['one use'], consumeCommentOnUse: true });
    const single = await Promise.all([choose('80001'), choose('80002')]);
    assert.equal(single.filter(Boolean).length, 1);
    claims.clear();
    await r.saveComments({ texts: ['one', 'two'], consumeCommentOnUse: true });
    const pair = await Promise.all([choose('80003'), choose('80004')]);
    assert.equal(pair.filter(Boolean).length, 2);
    assert.notEqual(pair[0]!.id, pair[1]!.id);
    claims.delete(pair[0]!.id);
    assert.equal((await choose('80005'))?.id, pair[0]!.id);
    const cancelClaims = new Set<string>();
    let cancelled = false;
    await assert.rejects(
      claimBumperComment(
        cancelClaims,
        async () => {
          cancelled = true;
          return pair[0]!;
        },
        () => {
          if (cancelled) throw Error('stopped');
        },
      ),
      /stopped/,
    );
    assert.equal(cancelClaims.size, 0);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('same account OR profile cannot repeat a post; per-post and local-day limits are distinct', async () =>
  fixture((store) => {
    const r = store.groupBumper;
    r.saveSettings({ ...r.settings(), dailyMaxLikesPerAccount: 2, maxLikesPerPost: 2 });
    assert.equal(r.record(log('30001')), true);
    assert.equal(r.record(log('30001')), false);
    assert.equal(r.eligibility('10001', randomUUID(), '30001').duplicate, true);
    assert.equal(r.eligibility('different', profileId, '30001').duplicate, true);
    r.record(log('30001', '10002', { profileId: randomUUID() }));
    assert.equal(r.eligibility('10003', randomUUID(), '30001').allowed, false);
    r.record(log('30002'));
    assert.equal(r.eligibility('10001', profileId, '30003').allowed, false);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(1, 0, 0, 0);
    assert.equal(r.eligibility('10001', profileId, '30003', tomorrow.getTime()).today, 0);
  }));
test('confirmed like persists before comment; successful comment merges once, increments usage or consumes text', async () =>
  fixture((store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    r.saveComments({ texts: ['one', 'two'], consumeCommentOnUse: false });
    const row = log('30001');
    assert.equal(r.record(row), true);
    const comment = r.pickComment('30001', 0)!;
    row.commentText = comment.text;
    assert.equal(r.record(row, comment.id), false);
    r.record(row, comment.id);
    assert.equal(r.total(), 1);
    assert.equal(r.comments().find((c) => c.id === comment.id)?.usedCount, 1);
    assert.equal(r.targets('groups')[0]?.totalBumpedCount, 1);
    assert.equal(r.targets('pages')[0]?.totalBumpedCount, 1);
    const other = comment.text === 'one' ? 'two' : 'one';
    assert.equal(r.pickComment('30001', 0)?.text, other);
    r.saveComments({ texts: ['one', 'two'], consumeCommentOnUse: true });
    const second = r.pickComment('30001', 0)!;
    r.record(
      log('30001', '10002', { profileId: randomUUID(), commentText: second.text }),
      second.id,
    );
    assert.deepEqual(
      r.comments().map((c) => c.text),
      [comment.text],
    );
    assert.equal(r.logs(other).length, 1);
    assert.equal(r.deleteLogs({ ids: [row.id] }), 1);
    assert.equal(r.deleteLogs({ all: true }), 1);
    assert.equal(r.total(), 0);
  }));
test('random comments avoid reused text until exhausted and zero effect never counts', async () =>
  fixture((store) => {
    const r = store.groupBumper;
    r.saveComments({ texts: ['x', 'y'], consumeCommentOnUse: false });
    assert.equal(r.record(log('30001', '10001', { liked: false })), false);
    r.record(log('30001', '10001', { commentText: 'x' }));
    r.record(log('30001', '10002', { profileId: randomUUID(), commentText: 'y' }));
    assert.ok(r.pickComment('30001', 0));
    r.saveSettings({ ...r.settings(), consumeCommentOnUse: true });
    assert.equal(r.pickComment('30001', 0), null);
    assert.equal(r.total(), 2);
  }));
test('page URLs and shared quoted multiline matrix preserve aligned ID/name pairs', () => {
  for (const [raw, id] of [
    ['61595532432687', '61595532432687'],
    ['https://www.facebook.com/profile.php?id=61595532432687', '61595532432687'],
    ['https://facebook.com/61595532432687', '61595532432687'],
    ['https://www.facebook.com/groups/123/user/61595532432687/', '61595532432687'],
    ['facebook.com/my_page?ref=share', 'my_page'],
    ['https://facebook.com/pages/My-Page/12345/', '12345'],
  ])
    assert.equal(extractBumperPageId(raw!), id);
  const create = (groupId = '', groupName = '') => ({ key: randomUUID(), groupId, groupName });
  const rows = applyGroupGridPaste(
    [create()],
    0,
    1,
    'https://facebook.com/profile.php?id=12345\t"Name\nnext"\nhttps://facebook.com/my_page\tSecond',
    create,
    0,
    1,
    extractBumperPageId,
  );
  assert.deepEqual(
    rows.map((r) => [r.groupId, r.groupName]),
    [
      ['12345', 'Name next'],
      ['my_page', 'Second'],
    ],
  );
});
test('post link normalization, author identity and relative ages reject wrong-group or contrary IDs', () => {
  for (const url of [
    '/groups/123/posts/345/',
    '/groups/123/permalink/345/',
    '/story.php?story_fbid=345',
    '/photo/?set=pcb.345',
  ])
    assert.equal(extractBumperPost(url, '123')?.postId, '345');
  assert.equal(extractBumperPost('/groups/999/posts/345/', '123'), null);
  assert.equal(extractBumperPost('https://evil.example/groups/123/posts/345/', '123'), null);
  for (const [value, expected] of [
    ['just now', 0],
    ['1m', 1 / 60],
    ['30 分钟', 0.5],
    ['2h', 2],
    ['3 小時', 3],
    ['1d', 24],
    ['昨天', 24],
    ['3 天', 72],
  ])
    assert.equal(relativePostAge(String(value)), expected);
  assert.equal(relativePostAge('unrecognized time'), null);
  assert.equal(
    bumperAuthorMatch({ authorId: '20001', authorName: 'changed' }, target('20001', 'page')),
    true,
  );
  assert.equal(
    bumperAuthorMatch({ authorId: '99999', authorName: 'page' }, target('20001', 'page')),
    false,
  );
});
test('native interaction response needs same actor/feedback, actual business state and no GraphQL errors', () => {
  const input = {
    actorId: '10001',
    feedbackId: 'feedback123',
    kind: 'like' as const,
    variables: { input: { actor_id: '10001', feedback_id: 'feedback123' } },
    status: 200,
    body:
      'for (;;);\n' +
      JSON.stringify({
        data: {
          feedback_react: {
            feedback: { id: 'feedback123', viewer_feedback_reaction_info: { reaction_type: 1 } },
          },
        },
      }),
  };
  assert.equal(confirmedBumperGraphQL(input), true);
  for (const change of [
    { actorId: '10002' },
    { feedbackId: 'other' },
    { status: 500 },
    { body: JSON.stringify({ errors: [{ message: 'denied' }], data: {} }) },
    { body: '{"data":{}}' },
  ])
    assert.equal(confirmedBumperGraphQL({ ...input, ...change }), false);
  assert.equal(
    confirmedBumperGraphQL({
      ...input,
      kind: 'comment',
      variables: {
        input: { actor_id: '10001', feedback_id: 'feedback123', message: { text: 'hello' } },
      },
      comment: 'hello',
      body: JSON.stringify({
        data: {
          comment_create: {
            comment: {
              id: 'comment1',
              body: { text: 'hello' },
              author: { id: '10001' },
              feedback: { id: 'feedback123' },
            },
          },
        },
      }),
    }),
    true,
  );
});
test('service skips busy/offline browsers and can cancel staggered worker before its first browser action', async () =>
  fixture(async (store) => {
    store.groupBumper.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    store.groupBumper.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const a = randomUUID(),
      b = randomUUID(),
      c = randomUUID();
    let calls = 0;
    const service = new GroupBumperService(
      store.groupBumper,
      {
        ready: (id) => id !== c,
        busy: async (id) => id === b,
        stop: async () => {},
        run: async (_id, _g, _p, _s, cb) => {
          calls++;
          while (!cb.cancelled()) await new Promise((r) => setTimeout(r, 5));
        },
      },
      async () => ({ comments: [], total: 0 }),
    );
    const state = await service.start({
      profileIds: [a, b, c],
      groupIds: ['12345'],
      pageIds: ['20001'],
    });
    assert.equal(service.isProfileRunning(a), true);
    assert.equal(state.profileCounts[b]?.status, '跳过：正在执行其他任务');
    assert.equal(state.profileCounts[c]?.status, '跳过：浏览器未连接');
    await service.stop([a]);
    for (let i = 0; i < 100 && service.hasActiveExecution(); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(service.hasActiveExecution(), false);
    assert.ok(calls <= 1);
  }));
test('bumper repository commands run through the production persistence worker', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-bumper-worker-'));
  const persistence = await PersistenceClient.open(dir);
  try {
    const r = persistence.workspace.groupBumper;
    await r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    assert.equal((await r.targets('pages'))[0]?.id, '20001');
    assert.deepEqual(await r.settings(), BumperSettings.parse({}));
  } finally {
    await persistence.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('history cursor includes the ID so equal timestamps are not lost across pages', async () =>
  fixture((store) => {
    const r = store.groupBumper,
      time = Date.now() - 1000;
    for (let i = 0; i < 7; i++) r.record(log(String(40000 + i), '10001', { bumpedAt: time }));
    const first = r.logs('', 3),
      last = first.at(-1)!;
    const second = r.logs('', 3, last.bumpedAt, last.id),
      last2 = second.at(-1)!;
    const third = r.logs('', 3, last2.bumpedAt, last2.id);
    assert.equal(new Set([...first, ...second, ...third].map((r) => r.id)).size, 7);
  }));

test('stopping an unconfirmed native owner keeps its profile busy until a successful retry', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const id = randomUUID();
    let held = true;
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        hasControl: () => held,
        run: async () => {
          throw Error('close failed');
        },
        stop: async () => {
          held = false;
        },
      },
      async () => ({ comments: [], total: 0 }),
    );
    await service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.isProfileRunning(id), true);
    await service.stop([id]);
    assert.equal(service.hasActiveExecution(), false);
  }));

test('buildStaggeredBumperQueues rotates start offsets across profiles while keeping all targets', () => {
  const targets = ['101', '102', '103', '104'].map((id) => target(id));
  const queues = buildStaggeredBumperQueues(['p1', 'p2', 'p3', 'p4'], targets);
  const firstIds = ['p1', 'p2', 'p3', 'p4'].map((pid) => queues.get(pid)?.[0]?.id);
  assert.equal(new Set(firstIds).size, 4);
  for (const pid of ['p1', 'p2', 'p3', 'p4']) {
    const q = queues.get(pid) ?? [];
    assert.equal(q.length, 4);
    assert.equal(new Set(q.map((item) => item.id)).size, 4);
  }
});

test('start rejects 0% like+comment probabilities and comment-only mode with empty comments, and persists profile_task_results', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const id = randomUUID();
    r.saveSettings({
      ...r.settings(),
      likeProbability: 0,
      commentProbability: 0,
    });
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        run: async (_id, _g, _p, _s, cb) => {
          cb.added(1);
        },
        stop: async () => {},
      },
      async () => ({ comments: r.comments(), total: r.total() }),
      () => {},
      undefined,
      0,
    );
    await assert.rejects(
      () => service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] }),
      /点赞概率和留言概率不能同时为 0%/,
    );

    r.saveSettings({
      ...r.settings(),
      likeProbability: 0,
      commentProbability: 100,
    });
    await assert.rejects(
      () => service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] }),
      /留言列表为空/,
    );

    const saved = r.saveComments({
      texts: ['Nice post!', 'Great share!'],
      consumeCommentOnUse: true,
    });
    assert.equal(saved.length, 2);
    const firstPick = r.pickComment('90001', 0, [saved[0]!.id]);
    assert.equal(firstPick?.id, saved[1]?.id);

    await service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] });
    for (let i = 0; i < 40 && service.hasActiveExecution(); i++)
      await new Promise((res) => setTimeout(res, 10));
    const overview = store.tasks.runtimeSnapshot();
    const resultRow = overview.profileResults?.find((row) => row.profileId === id);
    assert.equal(resultRow?.source, 'group-bumper');
    assert.equal(resultRow?.state, 'COMPLETED');
    assert.equal(profileTaskResultLabel(resultRow!)?.text, '上次成功 · 小组顶贴');
  }));

test('service preserves detailed 0-bump status reasons and marks all-groups-failed as FAILED', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const idZero = randomUUID();
    const idFail = randomUUID();
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        run: async (id, _g, _p, _s, cb) => {
          if (id === idZero) {
            cb.status('已完成 · 0 次（小组内未扫到目标主页帖子）');
            return;
          }
          throw new Error('全部小组执行异常：小组帖子未加载');
        },
        stop: async () => {},
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    await service.start({
      profileIds: [idZero, idFail],
      groupIds: ['12345'],
      pageIds: ['20001'],
    });
    for (let i = 0; i < 40 && service.hasActiveExecution(); i++)
      await new Promise((res) => setTimeout(res, 10));
    const state = await service.state();
    assert.equal(state.profileCounts[idZero]?.status, '已完成 · 0 次（小组内未扫到目标主页帖子）');
    assert.equal(state.profileCounts[idFail]?.status, '全部小组执行异常：小组帖子未加载');
    const overview = store.tasks.runtimeSnapshot();
    const failRow = overview.profileResults?.find((row) => row.profileId === idFail);
    assert.equal(failRow?.state, 'FAILED');
    assert.equal(profileTaskResultLabel(failRow!)?.text, '上次失败 · 小组顶贴');
  }));

test('ID-only target upsert, HTML metadata parser, and classic Page ID upgrade to canonical Profile ID', async () =>
  fixture((store) => {
    const r = store.groupBumper;
    // 1. Upsert with empty name uses ID as placeholder and does not overwrite existing real name
    r.upsertTargets('pages', { items: [{ id: '1114172675105164', name: '' }] });
    assert.equal(r.targets('pages')[0]?.name, '1114172675105164');
    r.upsertTargets('pages', { items: [{ id: '1114172675105164', name: '台湾小微' }] });
    assert.equal(r.targets('pages')[0]?.name, '台湾小微');
    r.upsertTargets('pages', { items: [{ id: '1114172675105164', name: '' }] });
    assert.equal(r.targets('pages')[0]?.name, '台湾小微');

    // 2. HTML metadata parser decodes hex entities and extracts canonical fb://profile/ ID
    assert.equal(
      decodeHtmlEntities('&#x53f0;&#x6e7e;&#x5c0f;&#x5fae; &amp; Friends'),
      '台湾小微 & Friends',
    );
    const html = `
      <html>
        <head>
          <meta property="al:android:url" content="fb://profile/61578473189457" />
          <meta property="og:title" content="&#x53f0;&#x6e7e;&#x5c0f;&#x5fae; | Facebook" />
          <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t39.30808-1/avatar.jpg?stp=dst-jpg&amp;oe=123" />
        </head>
      </html>
    `;
    const parsed = parseTargetMetadataFromHtml(html, 'pages');
    assert.equal(parsed.canonicalId, '61578473189457');
    assert.equal(parsed.name, '台湾小微');
    assert.equal(
      parsed.avatarUrl,
      'https://scontent.xx.fbcdn.net/v/t39.30808-1/avatar.jpg?stp=dst-jpg&oe=123',
    );

    // 3. applyResolvedTargetMetadata upgrades classic Page ID to canonical ID and updates logs
    r.record(
      log('555001', '10001', {
        pageId: '1114172675105164',
        pageName: '1114172675105164',
      }),
    );
    r.applyResolvedTargetMetadata('pages', '1114172675105164', parsed);
    const updatedPages = r.targets('pages');
    assert.equal(updatedPages.length, 1);
    assert.equal(updatedPages[0]?.id, '61578473189457');
    assert.equal(updatedPages[0]?.name, '台湾小微');
    assert.equal(
      updatedPages[0]?.avatarUrl,
      'https://scontent.xx.fbcdn.net/v/t39.30808-1/avatar.jpg?stp=dst-jpg&oe=123',
    );
    const logs = r.logs();
    assert.equal(logs[0]?.pageId, '61578473189457');
    assert.equal(logs[0]?.pageName, '台湾小微');
  }));

test('WO56: maxLikesPerPost defaults to 50, idempotent migration upgrades legacy 10 once, and weeklyDailyCounts buckets 7 local days', async () =>
  fixture((store, file) => {
    assert.equal(BumperSettings.parse({}).maxLikesPerPost, 50);

    const rawDb = new DatabaseSync(file);
    try {
      // 1. Simulate legacy pre-WO56 settings row (maxLikesPerPost=10, default_max_likes_50_applied=0)
      const legacySettings = { ...BumperSettings.parse({}), maxLikesPerPost: 10 };
      rawDb
        .prepare(
          'UPDATE group_bumper_settings SET body=?, default_max_likes_50_applied=0 WHERE id=1',
        )
        .run(JSON.stringify(legacySettings));

      // 2. Constructing SqliteGroupBumperRepository upgrades 10 to 50 and marks default_max_likes_50_applied=1
      const repo1 = new SqliteGroupBumperRepository(rawDb);
      assert.equal(repo1.settings().maxLikesPerPost, 50);

      // User explicitly sets maxLikesPerPost back to 10
      repo1.saveSettings({ ...repo1.settings(), maxLikesPerPost: 10 });
      assert.equal(repo1.settings().maxLikesPerPost, 10);

      // 3. Re-constructing SqliteGroupBumperRepository does NOT overwrite user's explicit 10
      const repo2 = new SqliteGroupBumperRepository(rawDb);
      assert.equal(repo2.settings().maxLikesPerPost, 10);
    } finally {
      rawDb.close();
    }

    // 4. Verify weeklyDailyCounts for 7 days (newest to oldest) in local time
    const nowDate = new Date(2026, 10, 1, 15, 30, 0, 0); // 2026-11-01 15:30 local
    const day0 = new Date(2026, 10, 1, 10, 0, 0, 0).getTime(); // 2026-11-01
    const day2 = new Date(2026, 9, 30, 21, 15, 0, 0).getTime(); // 2026-10-30
    const day6 = new Date(2026, 9, 26, 0, 5, 0, 0).getTime(); // 2026-10-26 (6 days ago start boundary)
    const day7Old = new Date(2026, 9, 25, 23, 59, 59, 0).getTime(); // 2026-10-25 (outside 7-day window)

    store.groupBumper.record(log('80001', '10001', { bumpedAt: day0 }));
    store.groupBumper.record(log('80002', '10001', { bumpedAt: day0 + 1000 }));
    store.groupBumper.record(log('80003', '10001', { bumpedAt: day2 }));
    store.groupBumper.record(log('80004', '10001', { bumpedAt: day6 }));
    store.groupBumper.record(log('80005', '10001', { bumpedAt: day7Old }));

    const stats = store.groupBumper.weeklyDailyCounts(nowDate.getTime());
    assert.deepEqual(stats, [
      { date: '2026-11-01', count: 2 },
      { date: '2026-10-31', count: 0 },
      { date: '2026-10-30', count: 1 },
      { date: '2026-10-29', count: 0 },
      { date: '2026-10-28', count: 0 },
      { date: '2026-10-27', count: 0 },
      { date: '2026-10-26', count: 1 },
    ]);
  }));

test('WO58: bumperSetupLabels maps 加入小组 to setup_open_group and extractBumperPost parses Reel links', async () =>
  fixture((store) => {
    const joinIdx = bumperSetupLabels.indexOf('加入小组');
    assert.ok(joinIdx >= 0);
    assert.equal(bumperSetupKinds[joinIdx], 'setup_open_group');
    assert.equal(bumperSetupLabels.length, bumperSetupKinds.length);
    assert.equal(extractBumperPost('/reel/9876543210/', '12345')?.postId, '9876543210');

    // Verify prepareOperation accepts setup_open_group for 加入小组 without violating SQLite CHECK constraint
    const opId = randomUUID();
    store.groupBumper.prepareOperation({
      binding: {
        accountId: '10001',
        profileId,
        connectionEpoch: randomUUID(),
        leaseId: randomUUID(),
        generation: 1,
        operationId: opId,
        jobId: randomUUID(),
        stepId: randomUUID(),
        actionDigest: bumperDigest({
          purpose: 'group-bumper',
          label: '加入小组',
          accountId: '10001',
        }),
      },
      runId: randomUUID(),
      actionKind: bumperSetupKinds[joinIdx]!,
      groupId: '12345',
      groupName: 'Test Group',
    });
    assert.equal(store.groupBumper.getOperation(opId)?.actionKind, 'setup_open_group');
  }));

test('WO60/WO61: settings expose maxPostsPerPage=3 and maxConcurrentProfiles=8 defaults', () => {
  const settings = BumperSettings.parse({});
  assert.equal(settings.maxPostsPerPage, 3);
  assert.equal(settings.maxConcurrentProfiles, 8);
});

test('WO60: concurrency semaphore queues profiles above maxConcurrentProfiles', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    r.saveSettings({ ...r.settings(), maxConcurrentProfiles: 1 });
    const ids = [randomUUID(), randomUUID()];
    let concurrent = 0,
      peak = 0;
    const release: Array<() => void> = [];
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (_id, _g, _p, _s, cb) => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise<void>((res) => {
            let done = false;
            const finish = () => {
              done = true;
              res();
            };
            release.push(finish);
            const tick = () => {
              if (done) return;
              if (cb.cancelled()) finish();
              else setTimeout(tick, 5);
            };
            tick();
          });
          concurrent--;
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    await service.start({ profileIds: ids, groupIds: ['12345'], pageIds: ['20001'] });
    for (let i = 0; i < 40 && release.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
    await new Promise((x) => setTimeout(x, 30));
    const queued = (await service.state()).profileCounts;
    assert.equal(peak, 1);
    assert.equal(Object.values(queued).filter((s) => s.status === '排队等待并发槽位…').length, 1);
    release.shift()?.();
    for (let i = 0; i < 60 && release.length < 1; i++) await new Promise((x) => setTimeout(x, 5));
    release.shift()?.();
    for (let i = 0; i < 60 && service.hasActiveExecution(); i++)
      await new Promise((x) => setTimeout(x, 10));
    assert.equal(peak, 1);
    assert.equal(service.hasActiveExecution(), false);
  }));

test('WO60: append run starts only idle profiles and keeps running profiles untouched; page mode is tracked separately', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    const runs: Array<{ id: string; groupId: string; runId: string | undefined }> = [];
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (id, g, _p, _s, cb) => {
          runs.push({ id, groupId: g[0]!.id, runId: cb.runId });
          while (!cb.cancelled()) await new Promise((x) => setTimeout(x, 5));
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    await service.start({ profileIds: [a], groupIds: ['12345'], pageIds: ['20001'] });
    await assert.rejects(
      () => service.start({ profileIds: [a], groupIds: ['12345'], pageIds: ['20001'] }),
      /所选浏览器正在运行顶贴任务/,
    );
    await service.start({ profileIds: [a, b], groupIds: ['12345'], pageIds: ['20001'] });
    const page = await service.startPageBumper({ profileIds: [c], pageIds: ['20001'] });
    for (let i = 0; i < 40 && runs.length < 3; i++) await new Promise((x) => setTimeout(x, 5));
    assert.deepEqual(runs.map((x) => x.id).sort(), [a, b, c].sort());
    assert.equal(runs.find((x) => x.id === c)?.groupId, '-');
    assert.notEqual(runs.find((x) => x.id === a)?.runId, runs.find((x) => x.id === b)?.runId);
    assert.equal(page.pageBumperRunning, true);
    assert.equal(page.pageBumperProfileCounts?.[c]?.running, true);
    assert.equal(page.profileCounts[c], undefined);
    assert.equal(service.isProfileRunningInMode(c, 'page-bumper'), true);
    assert.equal(service.isProfileRunningInMode(a, 'group-bumper'), true);
    // 停止小组顶贴「全部」不影响专页顶贴
    await service.stop(undefined, 'group-bumper');
    for (let i = 0; i < 60 && service.hasActiveExecutionInMode('group-bumper'); i++)
      await new Promise((x) => setTimeout(x, 10));
    assert.equal(service.hasActiveExecutionInMode('group-bumper'), false);
    assert.equal(service.isProfileRunning(c), true);
    await service.stop(undefined, 'page-bumper');
    for (let i = 0; i < 60 && service.hasActiveExecution(); i++)
      await new Promise((x) => setTimeout(x, 10));
    const result = store.tasks.runtimeSnapshot().profileResults?.find((row) => row.profileId === c);
    assert.equal(result?.source, 'page-bumper');
    assert.equal(result?.name, '专页顶贴');
  }));

test('WO60: adding targets while running saves rows without fetching avatars', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    let refreshCalls = 0;
    const id = randomUUID();
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (_id, _g, _p, _s, cb) => {
          while (!cb.cancelled()) await new Promise((x) => setTimeout(x, 5));
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      async () => {
        refreshCalls++;
        return { updated: 0, failed: 0, needsBrowser: 0 };
      },
      0,
    );
    await service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] });
    const state = await service.manage('pages/add', { items: [{ id: '30003', name: '' }] });
    assert.equal(refreshCalls, 0);
    assert.ok(state.pages.some((p) => p.id === '30003'));
    assert.match(state.statusText, /运行中暂不抓取头像/);
    await service.stop([id]);
  }));

test('WO60: shared group sync unifies avatars without swapping and never downgrades local avatars', async () =>
  fixture((store) => {
    store.groupBumper.upsertTargets('groups', { items: [{ id: '55555', name: 'g' }] });
    store.groupBumper.updateAvatar('groups', '55555', 'https://example.com/a.jpg');
    const b = store.groupBumper.targets('groups').find((g) => g.id === '55555');
    const i = store.groupInviter.listGroups().find((g) => g.groupId === '55555');
    assert.equal(b?.avatarUrl, 'https://example.com/a.jpg');
    assert.equal(i?.avatarUrl, 'https://example.com/a.jpg');
    const local = 'data:image/webp;base64,' + 'A'.repeat(64);
    store.groupBumper.updateAvatar('groups', '55555', local);
    store.groupBumper.updateAvatar('groups', '55555', 'https://example.com/b.jpg');
    assert.equal(
      store.groupBumper.targets('groups').find((g) => g.id === '55555')?.avatarUrl,
      local,
    );
    assert.equal(
      store.groupInviter.listGroups().find((g) => g.groupId === '55555')?.avatarUrl,
      local,
    );
  }));

test('WO60-B: shared group rename syncs both ways when both sides already have real names', async () =>
  fixture(async (store) => {
    store.groupInviter.upsertGroups({ items: [{ groupId: '66666', groupName: '旧群名' }] });
    assert.equal(store.groupBumper.targets('groups').find((g) => g.id === '66666')?.name, '旧群名');
    await new Promise((r) => setTimeout(r, 5));
    store.groupBumper.upsertTargets('groups', { items: [{ id: '66666', name: '新群名' }] });
    assert.equal(
      store.groupInviter.listGroups().find((g) => g.groupId === '66666')?.groupName,
      '新群名',
    );
    await new Promise((r) => setTimeout(r, 5));
    store.groupInviter.upsertGroups({ items: [{ groupId: '66666', groupName: '再改名' }] });
    assert.equal(store.groupBumper.targets('groups').find((g) => g.id === '66666')?.name, '再改名');
    // 占位名不会覆盖真实名
    await new Promise((r) => setTimeout(r, 5));
    store.groupBumper.upsertTargets('groups', { items: [{ id: '66666', name: '' }] });
    assert.equal(
      store.groupInviter.listGroups().find((g) => g.groupId === '66666')?.groupName,
      '再改名',
    );
  }));

test('WO60-B: pages/add and pages/refresh status is mirrored to pageBumperStatusText', async () =>
  fixture(async (store) => {
    const r = store.groupBumper;
    r.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    r.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const id = randomUUID();
    const service = new GroupBumperService(
      r,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        run: async (_id, _g, _p, _s, cb) => {
          while (!cb.cancelled()) await new Promise((x) => setTimeout(x, 5));
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      async () => ({ updated: 0, failed: 0, needsBrowser: 0 }),
      0,
    );
    await service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] });
    const added = await service.manage('pages/add', { items: [{ id: '30003', name: '' }] });
    assert.match(added.pageBumperStatusText ?? '', /运行中暂不抓取头像/);
    await service.stop([id]);
    for (let i = 0; i < 60 && service.hasActiveExecution(); i++)
      await new Promise((x) => setTimeout(x, 10));
    const refreshed = await service.manage('pages/refresh', { ids: ['20001'] });
    assert.match(refreshed.pageBumperStatusText ?? '', /读取资料/);
  }));

test('stop revokes control immediately, waits for worker exit, and records a clean stopped reason after a closed-channel error', async () =>
  fixture(async (store) => {
    const repo = store.groupBumper;
    repo.upsertTargets('groups', { items: [{ id: '12345', name: 'g' }] });
    repo.upsertTargets('pages', { items: [{ id: '20001', name: 'p' }] });
    const id = randomUUID();
    let held = false,
      nativeStopped = false,
      exited = false;
    const service = new GroupBumperService(
      repo,
      {
        ready: () => true,
        busy: async () => false,
        hasControl: () => held,
        run: async (_id, _g, _p, _s, cb) => {
          held = true;
          while (!cb.cancelled()) await new Promise((r) => setTimeout(r, 2));
          await new Promise((r) => setTimeout(r, 30));
          exited = true;
          throw Error('KERNEL_CLOSED');
        },
        stop: async () => {
          nativeStopped = true;
          held = false;
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    await service.start({ profileIds: [id], groupIds: ['12345'], pageIds: ['20001'] });
    const stop = service.stop([id]);
    assert.equal(nativeStopped, true);
    assert.equal(exited, false);
    const state = await stop;
    assert.equal(exited, true);
    assert.equal(service.hasActiveExecution(), false);
    assert.equal(state.profileCounts[id]?.status, '已停止');
    const result = store.tasks.runtimeSnapshot().profileResults?.find((r) => r.profileId === id);
    assert.equal(result?.state, 'STOPPED');
    assert.equal(result?.reason, '已停止');
    assert.equal(result?.failedSteps, 0);
  }));
