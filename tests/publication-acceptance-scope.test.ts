import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { settlementFixture } from './fixtures/settlement.js';
import {
  PublicationAcceptanceScope,
  publicationAssignmentAllowed,
  publicationPlanAllowed,
  publicationOriginalAllowed,
} from '../src/infrastructure/publication-acceptance-scope.js';
import type { FacebookPostOriginal } from '../src/domain/facebook-post-execution.js';
import type { ResourceRowValue } from '../src/shared/resource-table.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { Plan } from '../src/shared/task-contracts.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { Combination } from '../src/shared/contracts.js';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { FacebookPublishingRuntime } from '../src/infrastructure/facebook-publishing-runtime.js';
import {
  postFixture,
  postRequest,
  dispatchedPost,
  deliverPostNotices,
} from './fixtures/material-post.js';

test('media story scope binds one original media row and Friends destination, not text or ordinary posts', async () => {
  await settlementFixture(async (store) => {
    for (const role of ['image', 'video'] as const) {
      const saved = await store.createCombination({
        name: 'Generated media story',
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: randomUUID(),
            type: 'post',
            destination: 'story',
            audience: 'friends',
            resourceMode: 'table',
            resourceDirectory: '',
            count: 1,
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: false,
          },
        ],
      });
      assert.ok(saved.saved);
      const row = {
        id: randomUUID(),
        text: 'Generated story',
        purpose: 'story' as const,
        background: 'plain' as const,
        media: [
          {
            kind: 'local' as const,
            source: path.resolve('audit/generated-story.' + (role === 'image' ? 'png' : 'mp4')),
            name: 'generated-story.' + (role === 'image' ? 'png' : 'mp4'),
            mediaType: role,
          },
        ],
      };
      await store.resourceTables.save(saved.id, 0, [row]);
      const scope = PublicationAcceptanceScope.parse({
        version: 6,
        id: randomUUID(),
        profileId: randomUUID(),
        accountId: '12345',
        combinationId: saved.id,
        combinationVersion: saved.version,
        resourceRevision: 1,
        audience: 'FRIENDS',
        maximumPublications: 1,
        resources: [
          {
            rowId: row.id,
            textSha256: createHash('sha256').update(row.text).digest('hex'),
            format: role === 'image' ? 'single-image' : 'video',
            media: [{ source: row.media[0]!.source, role, digest: 'a'.repeat(64), bytes: 100 }],
          },
        ],
      });
      const request = {
        requestId: scope.id,
        profileIds: [scope.profileId],
        combinationId: saved.id,
        version: saved.version,
        expectedResourceRevision: 1,
      };
      assert.equal(await publicationAssignmentAllowed(store, scope, request, saved.saved), true);
      for (const change of [
        { audience: 'SELF' },
        { version: 4 },
        { accountId: undefined },
        { maximumPublications: 2 },
      ])
        assert.equal(PublicationAcceptanceScope.safeParse({ ...scope, ...change }).success, false);
      const ordinary = structuredClone(saved.saved);
      Object.assign(ordinary.steps[0]!, { destination: 'post' });
      assert.equal(await publicationAssignmentAllowed(store, scope, request, ordinary), false);
    }
  });
});

test('one color-post authorization requires the exact colored row, SELF audience and actor', async () => {
  await settlementFixture(async (store) => {
    const saved = await store.createCombination({
      name: 'Generated color sample',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          audience: 'self',
          resourceMode: 'table',
          resourceDirectory: '',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
    });
    assert.ok(saved.saved);
    const row = {
      id: randomUUID(),
      text: 'Generated color text',
      background: 'color' as const,
      media: [],
    };
    await store.resourceTables.save(saved.id, 0, [row]);
    const scope = PublicationAcceptanceScope.parse({
      version: 5,
      id: randomUUID(),
      profileId: randomUUID(),
      accountId: '12345',
      combinationId: saved.id,
      combinationVersion: 1,
      resourceRevision: 1,
      audience: 'SELF',
      background: 'color',
      maximumPublications: 1,
      resources: [
        {
          rowId: row.id,
          textSha256: createHash('sha256').update(row.text).digest('hex'),
          format: 'text',
          media: [],
        },
      ],
    });
    const request = {
      requestId: scope.id,
      profileIds: [scope.profileId],
      combinationId: saved.id,
      version: 1,
      expectedResourceRevision: 1,
    };
    assert.equal(await publicationAssignmentAllowed(store, scope, request, saved.saved), true);
    const profile: RuntimeProfile = {
      id: scope.profileId,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '12345', name: null, avatar: null },
    };
    const plan = (await store.tasks.assign(request, [profile]))[0];
    assert.ok(plan);
    assert.equal(await publicationPlanAllowed(store, scope, plan), true);
    assert.equal(
      await publicationPlanAllowed(store, scope, { ...plan, accountId: '99999' }),
      false,
    );
    for (const change of [
      { audience: 'FRIENDS' },
      { background: undefined },
      { accountId: undefined },
      { version: 1 },
      { version: 4 },
      { maximumPublications: 2 },
    ])
      assert.equal(PublicationAcceptanceScope.safeParse({ ...scope, ...change }).success, false);
    await store.resourceTables.save(saved.id, 1, [{ ...row, background: 'plain' }]);
    assert.equal(
      await publicationAssignmentAllowed(
        store,
        { ...scope, resourceRevision: 2 },
        { ...request, expectedResourceRevision: 2 },
        saved.saved,
      ),
      false,
    );
    const wrong = structuredClone(saved.saved);
    const step = wrong.steps[0];
    assert.ok(step?.type === 'post');
    step.destination = 'story';
    step.audience = 'friends';
    assert.equal(await publicationAssignmentAllowed(store, scope, request, wrong), false);
  });
});

test('one Friends text story authorization is pinned to its actor, row and destination without reopening SELF samples', async () => {
  await settlementFixture(async (store) => {
    const saved = await store.createCombination({
      name: 'Generated finite story',
      note: 'No browser execution',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          destination: 'story',
          audience: 'friends',
          resourceMode: 'table',
          resourceDirectory: '',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
    });
    assert.ok(saved.saved);
    const row = {
      id: randomUUID(),
      text: 'Generated authorized story',
      media: [],
      background: 'plain' as const,
      purpose: 'story' as const,
    };
    await store.resourceTables.save(saved.id, 0, [row]);
    const profile: RuntimeProfile = {
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: '12345', name: null, avatar: null },
    };
    const scope = PublicationAcceptanceScope.parse({
      version: 4,
      id: randomUUID(),
      profileId: profile.id,
      accountId: '12345',
      combinationId: saved.id,
      combinationVersion: 1,
      resourceRevision: 1,
      audience: 'FRIENDS',
      maximumPublications: 1,
      resources: [
        {
          rowId: row.id,
          textSha256: createHash('sha256').update(row.text).digest('hex'),
          format: 'text',
          media: [],
        },
      ],
    });
    const request = {
      requestId: scope.id,
      profileIds: [profile.id],
      combinationId: saved.id,
      version: 1,
      expectedResourceRevision: 1,
    };
    assert.equal(await publicationAssignmentAllowed(store, scope, request, saved.saved), true);
    assert.equal(
      await publicationAssignmentAllowed(
        store,
        scope,
        { ...request, profileIds: [randomUUID()] },
        saved.saved,
      ),
      false,
    );
    const wrong = structuredClone(saved.saved);
    const step = wrong.steps[0];
    assert.ok(step?.type === 'post');
    step.destination = 'post';
    step.audience = 'self';
    assert.equal(await publicationAssignmentAllowed(store, scope, request, wrong), false);
    const plan = (await store.tasks.assign(request, [profile]))[0];
    assert.ok(plan);
    assert.equal(await publicationPlanAllowed(store, scope, plan), true);
    assert.equal(
      await publicationPlanAllowed(store, scope, { ...plan, accountId: '99999' }),
      false,
    );
    for (const change of [
      { audience: 'SELF' },
      { accountId: undefined },
      { maximumPublications: 2 },
      { version: 1 },
    ])
      assert.equal(PublicationAcceptanceScope.safeParse({ ...scope, ...change }).success, false);
  });
});

test('remaining album/video scope counts both prior submissions and cannot reopen single-image or text', async () => {
  const profileId = randomUUID(),
    previousPlanId = randomUUID(),
    previousSingleImagePlanId = randomUUID();
  const text = 'Generated original authorized text';
  const sha = createHash('sha256').update(text).digest('hex');
  const resources = (['multi-image', 'video'] as const).map((format) => ({
    rowId: randomUUID(),
    textSha256: sha,
    format,
    media: Array.from({ length: format === 'multi-image' ? 2 : 1 }, (_, index) => ({
      source: path.resolve(
        'audit/generated-' + format + '-' + index + (format === 'video' ? '.mp4' : '.png'),
      ),
      role: format === 'video' ? ('video' as const) : ('image' as const),
      digest: 'a'.repeat(64),
      bytes: 123,
    })),
  }));
  const scope = PublicationAcceptanceScope.parse({
    version: 3,
    id: randomUUID(),
    profileId,
    combinationId: randomUUID(),
    combinationVersion: 1,
    resourceRevision: 1,
    audience: 'SELF',
    maximumPublications: 2,
    previousPlanId,
    previousSingleImagePlanId,
    resources,
  });
  const snapshot = {
    loop: { mode: 'finite', rounds: 1 },
    randomOrder: false,
    steps: resources.map(() => ({
      type: 'post',
      count: 1,
      audience: 'self',
      resourceMode: 'table',
      allowRepeat: false,
    })),
  } as unknown as Combination;
  const request = {
    requestId: scope.id,
    profileIds: [profileId],
    combinationId: scope.combinationId,
    version: 1,
    expectedResourceRevision: 1,
  };
  const single = {
    id: previousSingleImagePlanId,
    profileId,
    accountId: 'generated-account',
    state: 'FAILED',
    reason: 'PUBLISH_RESULT_UNCONFIRMED',
    snapshot: { steps: [{ type: 'post' }] },
  };
  let singleEnding: string | null = randomUUID(),
    singleState = 'REVIEW';
  const store = {
    tasks: {
      get: (id: string) =>
        id === previousPlanId
          ? { ...single, id, profileId, accountId: 'generated-account', controlConfirmed: true }
          : single,
      endingId: (id: string) => (id === previousPlanId ? previousPlanId : singleEnding),
      operations: (id: string) => [{ id, binding: { profileId } }],
    },
    materialPosts: { link: (id: string) => ({ purpose: 'SUBMIT', attemptId: id }) },
    materials: {
      reservation: (id: string) => ({
        state: singleState,
        intent: {
          context: { profileId, accountId: 'generated-account' },
          snapshot: { format: id === previousPlanId ? 'text' : 'single-image', text },
        },
      }),
    },
    resourceTables: {
      readVersion: () => ({
        rows: resources.map((row) => ({
          id: row.rowId,
          text,
          background: 'plain',
          media: row.media.map((file) => ({
            kind: 'local',
            source: file.source,
            mediaType: file.role,
          })),
        })),
      }),
    },
  } as unknown as WorkspaceStore;
  assert.equal(await publicationAssignmentAllowed(store, scope, request, snapshot), true);
  singleEnding = null;
  assert.equal(await publicationAssignmentAllowed(store, scope, request, snapshot), false);
  singleEnding = randomUUID();
  singleState = 'PUBLISHED';
  assert.equal(await publicationAssignmentAllowed(store, scope, request, snapshot), false);
  singleState = 'REVIEW';
  single.profileId = randomUUID();
  assert.equal(await publicationAssignmentAllowed(store, scope, request, snapshot), false);
  for (const changed of [
    { ...scope, previousSingleImagePlanId: undefined },
    { ...scope, previousSingleImagePlanId: previousPlanId },
    { ...scope, maximumPublications: 3 },
    { ...scope, resources: resources.toReversed() },
    { ...scope, resources: [{ ...resources[0], format: 'single-image' }, resources[1]] },
    { ...scope, version: 2 },
  ])
    assert.equal(PublicationAcceptanceScope.safeParse(changed).success, false);
});

test('finite four-format authorization pins batch, profile, revision, rows and original bytes without enabling other plans', async () => {
  await settlementFixture(async (store) => {
    const text = 'Generated authorized text',
      sha = createHash('sha256').update(text).digest('hex');
    const formats = ['text', 'single-image', 'multi-image', 'video'] as const;
    const resources = formats.map((format, index) => ({
      rowId: randomUUID(),
      textSha256: sha,
      format,
      media: Array.from(
        { length: format === 'text' ? 0 : format === 'multi-image' ? 2 : 1 },
        (_, member) => ({
          source: path.resolve(
            `audit/generated-${index}-${member}.${format === 'video' ? 'mp4' : 'png'}`,
          ),
          role: format === 'video' ? ('video' as const) : ('image' as const),
          digest: String(index + 1).repeat(64),
          bytes: 123,
        }),
      ),
    }));
    const rows: ResourceRowValue[] = resources.map((row) => ({
      id: row.rowId,
      text,
      background: 'plain',
      purpose: 'post',
      media: row.media.map((file) => ({
        kind: 'local',
        source: file.source,
        name: path.basename(file.source),
        mediaType: file.role,
      })),
    }));
    const saved = await store.createCombination({
      name: 'Generated finite acceptance',
      note: 'No browser input',
      steps: formats.map(() => ({
        id: randomUUID(),
        type: 'post',
        resourceMode: 'table',
        resourceDirectory: '',
        audience: 'self',
        count: 1,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: false,
      })),
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    await store.resourceTables.save(saved.id, 0, rows);
    assert.ok(saved.saved);
    const profile: RuntimeProfile = {
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: 'generated-account', name: null, avatar: null },
    };
    const scope = PublicationAcceptanceScope.parse({
      version: 1,
      id: randomUUID(),
      profileId: profile.id,
      combinationId: saved.id,
      combinationVersion: saved.version,
      resourceRevision: 1,
      audience: 'SELF',
      maximumPublications: 4,
      resources,
    });
    const request = {
      requestId: scope.id,
      combinationId: saved.id,
      version: saved.version,
      expectedResourceRevision: 1,
      profileIds: [profile.id],
    };
    assert.equal(await publicationAssignmentAllowed(store, scope, request, saved.saved), true);
    for (const changed of [
      { requestId: randomUUID() },
      { profileIds: [randomUUID()] },
      { profileIds: [profile.id, randomUUID()] },
      { expectedResourceRevision: 2 },
      { version: 2 },
    ])
      assert.equal(
        await publicationAssignmentAllowed(store, scope, { ...request, ...changed }, saved.saved),
        false,
      );
    assert.equal(
      await publicationAssignmentAllowed(store, scope, request, {
        ...saved.saved,
        randomOrder: true,
      }),
      false,
    );
    assert.equal(
      await publicationAssignmentAllowed(store, scope, request, {
        ...saved.saved,
        loop: { mode: 'until-stopped' },
      }),
      false,
    );
    const [plan] = await store.tasks.assign(request, [profile]);
    assert.ok(plan);
    assert.equal(await publicationPlanAllowed(store, scope, plan), true);
    assert.equal(
      await publicationPlanAllowed(store, scope, { ...plan, batchId: randomUUID() }),
      false,
    );
    const pinned = PublicationAcceptanceScope.parse({ ...scope, version: 7, accountId: '12345' });
    assert.equal(await publicationAssignmentAllowed(store, pinned, request, saved.saved), true);
    assert.equal(
      await publicationPlanAllowed(store, pinned, { ...plan, accountId: '12345' }),
      true,
    );
    assert.equal(
      await publicationPlanAllowed(store, pinned, { ...plan, accountId: '54321' }),
      false,
    );
    assert.equal(
      PublicationAcceptanceScope.safeParse({ ...pinned, accountId: undefined }).success,
      false,
    );
    assert.equal(
      PublicationAcceptanceScope.safeParse({
        ...pinned,
        maximumPublications: 1,
        resources: [resources[0]],
      }).success,
      true,
    );
    for (const [index, row] of resources.entries()) {
      const original = {
        link: { purpose: 'UPLOAD_MEDIA' },
        intent: {
          directory: null,
          jobId: plan.id,
          context: { profileId: profile.id },
          allowRepeat: false,
          resource: { combinationId: saved.id, revision: 1, row: rows[index] },
          snapshot: {
            format: row.format,
            text,
            files: row.media.map((file) => ({
              role: file.role,
              digest: file.digest,
              bytes: file.bytes,
            })),
          },
        },
      } as unknown as FacebookPostOriginal;
      const current: Plan = { ...plan, position: index };
      assert.equal(publicationOriginalAllowed(scope, current, original), true);
      const uploadOnly = PublicationAcceptanceScope.parse({ ...scope, submitDisabled: true });
      assert.equal(publicationOriginalAllowed(uploadOnly, current, original), true);
      const submission = structuredClone(original);
      submission.link.purpose = 'SUBMIT';
      assert.equal(publicationOriginalAllowed(scope, current, submission), true);
      assert.equal(publicationOriginalAllowed(uploadOnly, current, submission), false);
      assert.equal(
        PublicationAcceptanceScope.safeParse({ ...scope, submitDisabled: false }).success,
        false,
      );
      assert.equal(
        publicationOriginalAllowed(scope, { ...current, position: (index + 1) % 4 }, original),
        false,
      );
      const changed = structuredClone(original);
      changed.intent.snapshot.text += 'changed';
      assert.equal(publicationOriginalAllowed(scope, current, changed), false);
      if (row.media.length) {
        const altered = structuredClone(original);
        altered.intent.snapshot.files[0]!.digest = 'f'.repeat(64);
        assert.equal(publicationOriginalAllowed(scope, current, altered), false);
      }
    }
    const changed = structuredClone(scope);
    changed.resources[0]!.textSha256 = 'f'.repeat(64);
    assert.equal(await publicationAssignmentAllowed(store, changed, request, saved.saved), false);
    await store.resourceTables.save(saved.id, 1, [
      { ...rows[0]!, text: 'new head' },
      ...rows.slice(1),
    ]);
    assert.equal(
      await publicationPlanAllowed(store, scope, plan),
      true,
      'original pinned revision remains unchanged',
    );
  });
});

test('authorization rejects missing or repeated formats, excess posts and unsupported media', () => {
  const one = {
    version: 1,
    id: randomUUID(),
    profileId: randomUUID(),
    combinationId: randomUUID(),
    combinationVersion: 1,
    resourceRevision: 1,
    audience: 'SELF',
    maximumPublications: 1,
    resources: [{ rowId: randomUUID(), textSha256: 'a'.repeat(64), format: 'text', media: [] }],
  };
  assert.equal(PublicationAcceptanceScope.safeParse(one).success, true);
  assert.equal(
    PublicationAcceptanceScope.safeParse({ ...one, maximumPublications: 4 }).success,
    false,
  );
  assert.equal(
    PublicationAcceptanceScope.safeParse({ ...one, maximumPublications: 5 }).success,
    false,
  );
  assert.equal(PublicationAcceptanceScope.safeParse({ ...one, audience: 'PUBLIC' }).success, false);
  assert.equal(
    PublicationAcceptanceScope.safeParse({
      ...one,
      resources: [{ ...one.resources[0], format: 'single-image' }],
    }).success,
    false,
  );
  assert.equal(
    PublicationAcceptanceScope.safeParse({
      ...one,
      resources: Array.from({ length: 4 }, () => ({ ...one.resources[0], rowId: randomUUID() })),
      maximumPublications: 4,
    }).success,
    false,
  );
});

test('normal runtime permits only the exact finite assignment while public post capability remains closed', async () => {
  await settlementFixture(async (store, file) => {
    const saved = await store.createCombination({
      name: 'Generated scoped text',
      note: 'No browser input',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          resourceMode: 'table',
          resourceDirectory: '',
          audience: 'self',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const row = {
      id: randomUUID(),
      text: 'Generated finite text',
      media: [],
      background: 'plain' as const,
    };
    await store.resourceTables.save(saved.id, 0, [row]);
    const profile: RuntimeProfile = {
      id: randomUUID(),
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: 'generated-finite-account', name: null, avatar: null },
    };
    const scope = PublicationAcceptanceScope.parse({
      version: 1,
      id: randomUUID(),
      profileId: profile.id,
      combinationId: saved.id,
      combinationVersion: saved.version,
      resourceRevision: 1,
      audience: 'SELF',
      maximumPublications: 1,
      resources: [
        {
          rowId: row.id,
          textSha256: createHash('sha256').update(row.text).digest('hex'),
          format: 'text',
          media: [],
        },
      ],
    });
    const bridgeStore = new Store(':memory:'),
      core = new Core(bridgeStore),
      kernel = new KernelBridge(core, new WatchTasks(core));
    const runtime = new FacebookPublishingRuntime(
      kernel,
      core,
      store,
      path.dirname(file),
      () => [profile],
      {},
      undefined,
      'preserve-current',
      undefined,
      undefined,
      undefined,
      scope,
    );
    try {
      assert.equal(await runtime.available(), true);
      assert.equal((await runtime.supportedTypes()).includes('post'), false);
      const request = {
        requestId: scope.id,
        combinationId: saved.id,
        version: saved.version,
        expectedResourceRevision: 1,
        profileIds: [profile.id],
      };
      await assert.rejects(
        async () => await runtime.start({ ...request, requestId: randomUUID() }),
        /尚未完成真实验收/,
      );
      assert.equal((await store.tasks.list()).length, 0);
      const result = await runtime.start(request);
      assert.equal((await store.tasks.list()).length, 1);
      assert.deepEqual(
        await runtime.start(request),
        result,
        'retry returns original batch, not another publication allowance',
      );
      assert.equal((await store.tasks.operations((await store.tasks.list())[0]!.id)).length, 0);
    } finally {
      await runtime.close();
      kernel.close();
      bridgeStore.close();
    }
  });
});

test('remaining three formats require the original failed text submit and confirmed end, not a fresh four-post allowance', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const original = await dispatchedPost(store, r, 'SUBMIT'),
      intent = (await store.materials.reservation(r.attemptId)).intent;
    const formats = ['single-image', 'multi-image', 'video'] as const;
    const resources = formats.map((format, index) => ({
      rowId: randomUUID(),
      format,
      textSha256: createHash('sha256').update(intent.snapshot.text).digest('hex'),
      media: Array.from({ length: index === 1 ? 2 : 1 }, (_, member) => ({
        source: path.resolve(`audit/remaining-${index}-${member}.${index === 2 ? 'mp4' : 'png'}`),
        role: index === 2 ? ('video' as const) : ('image' as const),
        digest: 'a'.repeat(64),
        bytes: 123,
      })),
    }));
    const saved = await store.createCombination({
      name: 'Generated remaining formats',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: formats.map(() => ({
        id: randomUUID(),
        type: 'post',
        audience: 'self',
        resourceMode: 'table',
        resourceDirectory: '',
        count: 1,
        allowRepeat: false,
        forbidSameAccountRepeat: true,
        archivePublished: false,
      })),
    });
    await store.resourceTables.save(
      saved.id,
      0,
      resources.map((row) => ({
        id: row.rowId,
        text: intent.snapshot.text,
        background: 'plain',
        media: row.media.map((file) => ({
          kind: 'local',
          source: file.source,
          name: path.basename(file.source),
          mediaType: file.role,
        })),
      })),
    );
    const scope = PublicationAcceptanceScope.parse({
      version: 2,
      id: randomUUID(),
      profileId: r.context.profileId,
      combinationId: saved.id,
      combinationVersion: saved.version,
      resourceRevision: 1,
      audience: 'SELF',
      maximumPublications: 3,
      previousPlanId: r.jobId,
      resources,
    });
    const request = {
      requestId: scope.id,
      combinationId: saved.id,
      version: saved.version,
      profileIds: [scope.profileId],
      expectedResourceRevision: 1,
    };
    assert.ok(saved.saved);
    assert.equal(await publicationAssignmentAllowed(store, scope, request, saved.saved), false);
    await store.tasks.markBoundUnknown(original.binding, 'GENERATED_UNCONFIRMED');
    const control = await store.tasks.requestControl(r.jobId, 'pause', 'GENERATED_UNCONFIRMED');
    assert.ok(control.controlRequestId);
    await store.tasks.confirmControl(r.jobId, control.controlRequestId);
    const ending = await store.tasks.requestEnd(r.jobId),
      stop = {
        profileId: scope.profileId,
        connectionEpoch: randomUUID(),
        requestId: ending,
        state: 'stopped' as const,
      };
    await store.tasks.prepareEnd(r.jobId, stop);
    await deliverPostNotices(store, scope.profileId);
    await store.tasks.finishEnd(r.jobId, stop);
    assert.equal(await publicationAssignmentAllowed(store, scope, request, saved.saved), true);
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
    const changed = structuredClone(scope);
    changed.resources[0]!.textSha256 = 'b'.repeat(64);
    assert.equal(await publicationAssignmentAllowed(store, changed, request, saved.saved), false);
    assert.equal(PublicationAcceptanceScope.safeParse({ ...scope, version: 1 }).success, false);
    assert.equal(
      PublicationAcceptanceScope.safeParse({ ...scope, maximumPublications: 4 }).success,
      false,
    );
  }, false);
});
