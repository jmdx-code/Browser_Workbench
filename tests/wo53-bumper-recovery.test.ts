import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistenceClient } from '../src/infrastructure/persistence-client.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import {
  recoverBumperOperations,
  bumperDigest,
} from '../src/infrastructure/group-bumper-recovery.js';
import {
  executeBumperOperation,
  isBumperFatal,
  observeBumperGraphql,
  verifyBumperPageAlias,
} from '../src/infrastructure/group-bumper-runner.js';
import { bumperVideoCredit, type BumperVideoSample } from '../src/domain/bumper-video.js';
import type { Binding } from '../src/shared/task-execution.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Peer } from '../src/bridge/core.js';
import type { Page, Request, Response } from 'playwright-core';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';

function binding(): Binding {
  return {
    profileId: randomUUID(),
    accountId: '111',
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 1,
    operationId: randomUUID(),
    jobId: randomUUID(),
    stepId: randomUUID(),
    actionDigest: 'a'.repeat(64),
  };
}
async function fixture(work: (client: PersistenceClient) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wo53-'));
  const client = await PersistenceClient.open(directory);
  try {
    await work(client);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test('WO53: real persistence worker commits confirmed effects once and replays the same settlement after reply loss', async () =>
  fixture(async (client) => {
    const repo = client.workspace.groupBumper,
      b = binding();
    await repo.upsertTargets('groups', { items: [{ id: '123', name: 'group' }] });
    await repo.upsertTargets('pages', { items: [{ id: '222', name: 'page' }] });
    const comments = await repo.saveComments({ texts: ['hello'], consumeCommentOnUse: false });
    const comment = comments[0]!;
    const log = {
      id: randomUUID(),
      profileId: b.profileId,
      accountId: b.accountId,
      groupId: '123',
      groupName: 'group',
      pageId: '222',
      pageName: 'page',
      postId: '333',
      postUrl: 'https://www.facebook.com/groups/123/posts/333/',
      liked: false,
      commentText: 'hello',
      bumpedAt: Date.now(),
    };
    await repo.prepareOperation({
      binding: b,
      runId: randomUUID(),
      actionKind: 'submit_comment',
      groupId: '123',
      groupName: 'group',
      pageId: '222',
      pageName: 'page',
      postId: '333',
      postUrl: log.postUrl,
      logId: log.id,
      commentId: comment.id,
      commentText: 'hello',
    });
    const resolution = {
      id: randomUUID(),
      outcome: 'VERIFIED' as const,
      evidenceDigest: 'b'.repeat(64),
    };
    await repo.confirmSubmission(b.operationId, log, comment.id, resolution);
    const again = await repo.confirmSubmission(b.operationId, log, comment.id, {
      ...resolution,
      id: randomUUID(),
    });
    assert.deepEqual(again, resolution);
    assert.equal(await repo.total(), 1);
    assert.equal((await repo.targets('groups'))[0]?.totalBumpedCount, 1);
    assert.equal((await repo.comments())[0]?.usedCount, 1);
    const journal = new KernelJournal(new MemoryKernelStorage());
    await journal.initialize(b.profileId, randomUUID());
    await journal.begin(b);
    await journal.finish(b, 'ACKNOWLEDGED');
    let notifications = 0;
    const kernel = {
      withSummary: async (_peer: unknown, fn: (port: unknown) => Promise<unknown>) =>
        fn({
          inventory: () => journal.snapshot(),
          notify: async (incoming: Binding, r: typeof resolution) => {
            assert.deepEqual(incoming, b);
            assert.deepEqual(r, resolution);
            notifications++;
            await journal.reconcile(incoming, r);
            if (notifications === 1) throw Error('reply lost after native commit');
            return { binding: incoming, resolution: r };
          },
        }),
    } as unknown as KernelBridge;
    const peer = { profileId: b.profileId } as Peer;
    await assert.rejects(
      recoverBumperOperations(kernel, peer, repo, () => {}),
      /reply lost/,
    );
    assert.equal((await repo.getOperation(b.operationId))?.status, 'SETTLEMENT_PENDING');
    await recoverBumperOperations(kernel, peer, repo, () => {});
    assert.equal((await repo.getOperation(b.operationId))?.status, 'SETTLED');
    assert.equal(notifications, 1);
    assert.equal(await repo.total(), 1);
    assert.equal((await repo.comments())[0]?.usedCount, 1);
  }));

test('WO53: legacy setup disposition is durable across lost replies; uncertain business and foreign digests remain pending', async () =>
  fixture(async (client) => {
    const repo = client.workspace.groupBumper,
      setup = binding(),
      business = { ...binding(), profileId: setup.profileId };
    setup.actionDigest = bumperDigest({
      purpose: 'group-bumper',
      label: '打开小组页面',
      accountId: setup.accountId,
    });
    const journal = new KernelJournal(new MemoryKernelStorage());
    await journal.initialize(setup.profileId, randomUUID());
    await journal.begin(setup);
    await journal.finish(setup, 'ACKNOWLEDGED');
    await journal.begin(business);
    await journal.finish(business, 'ACKNOWLEDGED');
    let count = 0;
    let endNotRequired = false;
    const kernel = {
      withSummary: async (_peer: unknown, fn: (p: unknown) => Promise<unknown>) =>
        fn({
          inventory: () => journal.snapshot(),
          notify: async (b: Binding, r: Parameters<KernelJournal['endUnknown']>[1]) => {
            count++;
            await journal.endUnknown(b, r);
            throw Error(endNotRequired ? 'KERNEL_END_NOT_REQUIRED' : 'end reply lost');
          },
        }),
    } as unknown as KernelBridge;
    const peer = { profileId: setup.profileId } as Peer;
    await assert.rejects(
      recoverBumperOperations(kernel, peer, repo, () => {}),
      /end reply lost/,
    );
    const fixed = (await repo.getOperation(setup.operationId))?.resolution;
    await recoverBumperOperations(kernel, peer, repo, () => {});
    assert.deepEqual((await repo.getOperation(setup.operationId))?.resolution, fixed);
    assert.equal((await repo.getOperation(setup.operationId))?.status, 'SETTLED');
    assert.equal(await repo.getOperation(business.operationId), null);
    assert.equal(
      (await journal.snapshot()).operations.find(
        (o) => o.binding.operationId === business.operationId,
      )?.state,
      'ACKNOWLEDGED',
    );
    assert.equal(count, 1);

    const repeat = { ...binding(), profileId: setup.profileId };
    repeat.actionDigest = bumperDigest({
      purpose: 'group-bumper',
      label: '浏览小组帖子',
      accountId: repeat.accountId,
    });
    await journal.begin(repeat);
    await journal.finish(repeat, 'ACKNOWLEDGED');
    endNotRequired = true;
    await recoverBumperOperations(kernel, peer, repo, () => {});
    assert.equal((await repo.getOperation(repeat.operationId))?.status, 'SETTLED');
    assert.equal(count, 2);
  }));

test('WO53: setup failure after dispatch persists disposition but never sends ENDED_UNKNOWN through reconcile', async () => {
  const b = binding();
  let mutations = 0,
    outcome = '',
    settled = 0;
  const conn = {
    get nativeMutationCalls() {
      return { input: mutations };
    },
    execute: async (_b: Binding, work: () => Promise<unknown>) => ({ value: await work() }),
    reconcile: async () => {
      throw Error('must not reconcile');
    },
  };
  await assert.rejects(
    executeBumperOperation({
      connection: conn as unknown as Parameters<typeof executeBumperOperation>[0]['connection'],
      binding: b,
      label: '打开小组页面',
      work: async () => {
        mutations++;
        return true;
      },
      verify: async () => false,
      assertCurrent: async () => {},
      stop: async () => {},
      settlement: {
        auxiliary: true,
        save: async (r) => {
          outcome = r.outcome;
          return r;
        },
        settled: async () => {
          settled++;
        },
        review: async () => {},
      },
    }),
    /结果待核对/,
  );
  assert.equal(outcome, 'ENDED_UNKNOWN');
  assert.equal(settled, 0);
});

test('WO53: failed persistence prevents confirmed settlement and worker rejects mismatched submission context', async () =>
  fixture(async (client) => {
    const repo = client.workspace.groupBumper,
      b = binding();
    await assert.rejects(
      repo.confirmSubmission(b.operationId, {} as never, undefined, {
        id: randomUUID(),
        outcome: 'VERIFIED',
        evidenceDigest: 'b'.repeat(64),
      }),
      /BUMPER_RESULT_CONTEXT_CHANGED/,
    );
    assert.equal(await repo.total(), 0);
    let inputs = 0;
    await assert.rejects(
      repo
        .prepareOperation({
          binding: { ...b, actionDigest: 'invalid' },
          runId: randomUUID(),
          actionKind: 'submit_like',
          groupId: '123',
          groupName: 'g',
        })
        .then(() => {
          inputs++;
        }),
    );
    assert.equal(inputs, 0);
  }));

test('WO53: stale GraphQL restriction and late responses cannot contaminate the active operation', async () => {
  const listeners = new Map<string, (value: never) => void>();
  const page = {
    on: (name: string, fn: (v: never) => void) => listeners.set(name, fn),
    off: (name: string) => listeners.delete(name),
  } as unknown as Page;
  const observer = observeBumperGraphql(page, {
    actorId: '111',
    feedbackId: 'feedback',
    kind: 'like',
  });
  const request = (actor: string) =>
    ({
      method: () => 'POST',
      url: () => 'https://www.facebook.com/api/graphql/',
      postData: () =>
        new URLSearchParams({
          fb_api_req_friendly_name: 'CometUFIFeedbackReactMutation',
          variables: JSON.stringify({ input: { actor_id: actor, feedback_id: 'feedback' } }),
        }).toString(),
    }) as Request;
  const foreign = request('222');
  listeners.get('request')!(foreign as never);
  listeners.get('response')!({
    request: () => foreign,
    text: async () => '{"errors":[{"code":368}]}',
    status: () => 200,
  } as Response as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(observer.restricted(), false);
  const own = request('111');
  listeners.get('request')!(own as never);
  listeners.get('response')!({
    request: () => own,
    text: async () => '{"errors":[{"code":368}]}',
    status: () => 200,
  } as Response as never);
  await new Promise((r) => setImmediate(r));
  assert.equal(observer.restricted(), true);
  await observer.close();
  assert.equal(listeners.size, 0);
});

test('WO53: real video advancement, bounded frame-only evidence, frozen playback, seek and source changes', () => {
  const p: BumperVideoSample = {
    time: 1,
    frames: 24,
    source: 'video-a',
    paused: false,
    ended: false,
    ready: 4,
  };
  assert.equal(bumperVideoCredit(p, { ...p, time: 2, frames: 48 }, 1000, 1000, 0).grantedMs, 1000);
  assert.equal(bumperVideoCredit(p, p, 1000, 1000, 0).grantedMs, 0);
  const frames = bumperVideoCredit(p, { ...p, frames: 48 }, 1000, 1000, 0);
  assert.equal(frames.grantedMs, 1000);
  assert.equal(bumperVideoCredit(p, { ...p, frames: 48 }, 1000, 1000, 1500).grantedMs, 0);
  assert.equal(bumperVideoCredit(p, { ...p, time: 99 }, 1000, 1000, 0).grantedMs, 0);
  assert.equal(
    bumperVideoCredit(p, { ...p, time: 2, source: 'video-b' }, 1000, 1000, 0).sourceChanged,
    true,
  );
  for (const reason of [
    'KERNEL_DEBUGGER_DETACHED',
    'KERNEL_CONNECTION_LOST',
    'KERNEL_RPC_SEND_UNKNOWN',
    'KERNEL_RPC_RESULT_UNKNOWN',
    'KERNEL_BOUND_EXECUTION_UNAVAILABLE',
  ])
    assert.equal(isBumperFatal(Error(reason)), true);
});

test(
  'WO53: stop cannot allow restart while the original worker still has a pending continuation',
  { timeout: 5000 },
  async () => {
    const id = randomUUID(),
      t: BumperTarget = {
        id: '123',
        name: 'g',
        avatarUrl: null,
        folderId: null,
        sortOrder: 0,
        totalBumpedCount: 0,
        createdAt: 0,
        updatedAt: 0,
      };
    let finish!: () => void, began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const blocked = new Promise<void>((r) => {
      finish = r;
    });
    const service = new GroupBumperService(
      {
        targets: () => [t],
        settings: () => BumperSettings.parse({}),
        todayCounts: () => ({}),
        saveProfileResult: () => {},
      } as never,
      {
        ready: () => true,
        busy: async () => false,
        stop: async () => {},
        hasControl: () => false,
        run: async (_id, _groups, _pages, _settings, cb) => {
          began();
          await blocked;
          assert.equal(cb.cancelled(), true);
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );
    const input = { profileIds: [id], groupIds: ['123'], pageIds: ['123'] };
    await service.start(input);
    await started;
    let stopReturned = false;
    const stopping = service.stop().then(() => {
      stopReturned = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(stopReturned, false);
    await assert.rejects(service.start(input), /正在运行/);
    finish();
    await stopping;
    assert.equal(stopReturned, true);
    for (let i = 0; i < 30 && service.hasActiveExecution(); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(service.hasActiveExecution(), false);
  },
);

test('WO53: a same-name candidate cannot replace a numeric Page identity without native canonical-ID evidence', async () => {
  const resolve = async (kind: 'groups' | 'pages', id: string) => {
    assert.equal(kind, 'pages');
    return {
      canonicalId: ['1114172675105164', '61578473189457'].includes(id) ? '61578473189457' : id,
      name: 'Same name',
      avatarUrl: null,
    };
  };
  assert.equal(await verifyBumperPageAlias('1114172675105164', '61578473189457', resolve), true);
  assert.equal(await verifyBumperPageAlias('61578473189457', '1114172675105164', resolve), true);
  assert.equal(await verifyBumperPageAlias('1114172675105164', '99999999999999', resolve), false);
  assert.equal(
    await verifyBumperPageAlias('1114172675105164', '61578473189457', async () => ({
      canonicalId: null,
      name: 'Same name',
      avatarUrl: null,
    })),
    false,
  );
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      assert.ok(
        ['888880001', '999990002'].includes(new URL(String(input)).searchParams.get('id') ?? ''),
      );
      const canonical =
        new URL(String(input)).searchParams.get('id') === '888880001' ? '999990001' : '999990002';
      return new Response(
        `<meta property="al:android:url" content="fb://profile/${canonical}"><meta property="og:title" content="Same name | Facebook"><meta property="og:image" content="https://example.test/avatar.png">`,
        { status: 200 },
      );
    };
    assert.equal(await verifyBumperPageAlias('888880001', '999990001'), true);
    assert.equal(await verifyBumperPageAlias('888880001', '999990002'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
