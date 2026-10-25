import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  GroupInviterService,
  type GroupInviterRepository,
  type GroupInviterBrowserRunner,
} from '../src/application/group-inviter-service.js';
import { profileTaskResultLabel } from '../src/shared/profile-task-result.js';
import { ProductError } from '../src/domain/workspace.js';
import { ProfileTaskResult } from '../src/shared/task-contracts.js';
import {
  groupInvitationEffect,
  readGroupInvitationState,
} from '../src/infrastructure/group-inviter-effects.js';
import { GroupInviterBrowserAdapter } from '../src/infrastructure/group-inviter-runner.js';
import { persistenceError } from '../src/infrastructure/persistence-error.js';
import { MediaRuntimeComponent } from '../src/infrastructure/media-runtime-component.js';
import { extractPinnedMediaArchive } from '../src/infrastructure/pinned-media-archive.js';
import type { Core } from '../src/bridge/core.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
const group = {
  groupId: '1234567890',
  groupName: 'Test group',
  avatarUrl: null,
  totalInvitedCount: 0,
  createdAt: 1,
  updatedAt: 1,
};
function repository(overrides: Partial<GroupInviterRepository> = {}): GroupInviterRepository {
  return {
    listGroups: () => [group],
    upsertGroups: () => [group],
    updateGroupAvatar: () => {},
    deleteGroups: () => 0,
    getInvitesPerGroup: () => 1,
    setInvitesPerGroup: () => 1,
    getInvitedFriendIdsForGroup: () => new Set(),
    recordInvites: () => 0,
    getTotalInvitedByProfile: () => new Map(),
    listLogs: () => [],
    ...overrides,
  };
}
function browser(
  inviteForGroup: GroupInviterBrowserRunner['inviteForGroup'],
): GroupInviterBrowserRunner {
  return {
    isAvailable: () => true,
    isProfileReady: () => true,
    fetchGroupAvatar: async () => null,
    inviteForGroup,
  };
}

test('mobile verification ends this profile run as restricted without retrying or advancing groups', async () => {
  const profileId = randomUUID();
  let attempts = 0;
  const saved: unknown[] = [];
  const second = { ...group, groupId: '9876543210' };
  const service = new GroupInviterService(
    repository({
      listGroups: () => [group, second],
      saveProfileResult: (value) => {
        saved.push(value);
      },
    }),
    browser(async () => {
      attempts++;
      throw new ProductError('GROUP_INVITER_VERIFICATION_REQUIRED', '需要手机验证', 409);
    }),
  );
  await service.start({ profileIds: [profileId], groupIds: [group.groupId, second.groupId] });
  await flush();
  assert.equal(attempts, 1);
  assert.equal(service.isProfileRunning(profileId), false);
  assert.equal(
    (await service.state()).profileCounts[profileId]?.status,
    '受限 · 需要手机验证或操作受限',
  );
  assert.equal(saved.length, 1);
  const result = ProfileTaskResult.parse(saved[0]);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.reason, '受限 · 需要手机验证或操作受限');
  assert.match(profileTaskResultLabel(result).text, /上次受限 · 需要手机验证/);
  assert.equal(profileTaskResultLabel(result).tone, 'warn');
});

test('inviter reserves startup before awaiting and retains occupancy until runner drains after stop', async () => {
  const profileId = randomUUID(),
    startup = defer(),
    draining = defer();
  let entered = false;
  const service = new GroupInviterService(
    repository({
      getInvitesPerGroup: async () => {
        await startup.promise;
        return 1;
      },
    }),
    browser(async () => {
      entered = true;
      await draining.promise;
    }),
  );
  const input = { profileIds: [profileId], groupIds: [group.groupId] };
  const first = service.start(input);
  await assert.rejects(service.start(input), /正在运行/);
  assert.equal(service.isProfileRunning(profileId), true);
  startup.resolve();
  await first;
  await flush();
  assert.equal(entered, true);
  const stopped = await service.stopProfiles({ profileIds: [profileId] });
  assert.equal(stopped.profileCounts[profileId]?.status, '正在停止…');
  assert.equal(service.isProfileRunning(profileId), true);
  draining.resolve();
  await flush();
  assert.equal(service.isProfileRunning(profileId), false);
  assert.equal((await service.state()).profileCounts[profileId]?.status, '已停止');
});

test('cancel during startup never dispatches', async () => {
  const startup = defer(),
    profileId = randomUUID();
  let entered = 0;
  const service = new GroupInviterService(
    repository({
      getInvitesPerGroup: async () => {
        await startup.promise;
        return 1;
      },
    }),
    browser(async () => {
      entered++;
    }),
  );
  const running = service.start({ profileIds: [profileId], groupIds: [group.groupId] });
  const stopping = service.stopProfiles({ profileIds: [profileId] });
  startup.resolve();
  await stopping;
  await assert.rejects(running);
  assert.equal(entered, 0);
});

test('same group accounts overlap and claim different recipients; failure is not overwritten with success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = defer();
  let entered = 0,
    inFlight = 0,
    max = 0;
  const saved: unknown[] = [];
  const repo = repository({
    saveProfileResult: (value) => {
      saved.push(value);
    },
  });
  const adapter = new GroupInviterBrowserAdapter(
    repo,
    () => undefined,
    () => undefined,
    () => null,
  );
  const clicked: string[] = [];
  const service = new GroupInviterService(
    repo,
    browser(async () => {
      const ordinal = ++entered;
      inFlight++;
      max = Math.max(max, inFlight);
      const owned = new Set<string>();
      try {
        for (const id of ['987654321', '987654322']) {
          const selected = await Reflect.get(adapter, 'selectRecipient').call(
            adapter,
            group.groupId,
            id,
            owned,
            async () => {
              clicked.push(id);
              return true;
            },
          );
          if (selected) break;
        }
        if (ordinal === 1) await first.promise;
        if (ordinal === 2) throw Error('独立结果未确认');
      } finally {
        Reflect.get(adapter, 'releaseSelections').call(adapter, group.groupId, owned);
        inFlight--;
      }
    }),
  );
  await service.start({ profileIds: [randomUUID(), randomUUID()], groupIds: [group.groupId] });
  await flush();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(5000);
    await flush();
  }
  assert.equal(entered, 2);
  assert.equal(max, 2);
  assert.deepEqual(clicked, ['987654321', '987654322']);
  first.resolve();
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(entered, 2);
  assert.equal(max, 2);
  assert.equal((await service.state()).running, false);
  assert.equal(
    saved.map((r) => ProfileTaskResult.parse(r)).filter((r) => r.state === 'FAILED').length,
    1,
  );
});

test('profile startup gaps accumulate in order while earlier accounts remain running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const ids = [randomUUID(), randomUUID(), randomUUID()],
    entered: string[] = [],
    drain = defer();
  const service = new GroupInviterService(
    repository(),
    browser(async (id) => {
      entered.push(id);
      await drain.promise;
    }),
  );
  await service.start({ profileIds: ids, groupIds: [group.groupId] });
  await flush();
  assert.deepEqual(entered, ids.slice(0, 1));
  t.mock.timers.tick(799);
  await flush();
  assert.equal(entered.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(entered, ids.slice(0, 2));
  t.mock.timers.tick(799);
  await flush();
  assert.equal(entered.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(entered, ids);
  drain.resolve();
  await flush();
  assert.equal((await service.state()).running, false);
});

test('unconfirmed native stop retains profile until explicit successful retry', async () => {
  const profileId = randomUUID();
  let retried = false;
  const runner = browser(async () => {
    throw Error('GROUP_INVITER_STOP_UNCONFIRMED');
  });
  runner.retryStop = async () => {
    retried = true;
  };
  const service = new GroupInviterService(repository(), runner);
  await service.start({ profileIds: [profileId], groupIds: [group.groupId] });
  await flush();
  assert.equal(service.isProfileRunning(profileId), true);
  assert.equal((await service.state()).running, true);
  await service.stopProfiles({ profileIds: [profileId] });
  assert.equal(retried, true);
  assert.equal(service.isProfileRunning(profileId), false);
  assert.equal((await service.state()).running, false);
});

test('actual adapter refuses old pending operations without sending any resolution or connecting', async () => {
  const profileId = randomUUID();
  let connects = 0,
    notifications = 0;
  const peer = { profileId, epoch: 1, online: true, synced: true };
  const core = { peers: new Map([[profileId, peer]]) } as unknown as Core;
  const kernel = {
    withSummary: async (_peer: unknown, fn: (port: unknown) => unknown) =>
      fn({
        inventory: () => ({
          operations: [
            {
              state: 'UNKNOWN',
              binding: {
                operationId: randomUUID(),
                accountId: '123456789',
                actionDigest: 'f'.repeat(64),
              },
            },
          ],
          tabs: [],
        }),
        notify: () => {
          notifications++;
        },
      }),
    connectFacebook: () => {
      connects++;
      throw Error('must not connect');
    },
  } as unknown as KernelBridge;
  const adapter = new GroupInviterBrowserAdapter(
    repository(),
    () => kernel,
    () => core,
    () => '123456789',
  );
  await assert.rejects(
    adapter.inviteForGroup(profileId, group, 1, {
      isCancelled: () => false,
      setProfileStatus: () => {},
      addSessionInvited: () => {},
    }),
    /待核对/,
  );
  assert.equal(notifications, 0);
  assert.equal(connects, 0);
});

test('invitation proof rejects modal closure, wrong actor/group, unchecked and unconfirmed recipients', () => {
  const state: Awaited<ReturnType<typeof readGroupInvitationState>> = {
    url: 'https://www.facebook.com/groups/1234567890/',
    accountId: '123456789',
    visible: true,
    ready: true,
    dialog: false,
    dialogCount: 0,
    menu: false,
    joined: true,
    items: [],
  };
  const check = (label: string, value: unknown, s = state) =>
    groupInvitationEffect(label, s, group.groupId, state.accountId!, value);
  assert.equal(check('send-group-invites', ['987654321']), false);
  const confirmed = {
    ...state,
    dialog: true,
    items: [{ id: '987654321', invited: true, member: false, checked: false }],
  };
  assert.equal(check('send-group-invites', ['987654321'], confirmed), true);
  assert.equal(check('send-group-invites', ['987654321', '999999999'], confirmed), false);
  assert.equal(
    check('send-group-invites', ['987654321'], { ...confirmed, accountId: '111111111' }),
    false,
  );
  assert.equal(
    check('send-group-invites', ['987654321'], {
      ...confirmed,
      url: 'https://www.facebook.com/groups/12345678901/',
    }),
    false,
  );
  assert.equal(check('check-friend-1', false, confirmed), false);
});

test('latest results survive reopen for every profile and distinguish partial completion; pending recipients never count as sent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-results-'));
  const file = path.join(dir, 'workspace.sqlite');
  let store = await WorkspaceStore.open(file);
  try {
    const ids = Array.from({ length: 65 }, () => randomUUID());
    const saved = store.createCombination({
      name: '单项测试 · 首页',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    const plans = store.tasks.assign(
      { requestId: randomUUID(), combinationId: saved.id, version: saved.version, profileIds: ids },
      ids.map((id) => ({
        id,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in' as const, id: 'test-' + id, name: null, avatar: null },
      })),
    );
    const db = new DatabaseSync(file);
    try {
      for (const [index, plan] of plans.entries()) {
        // Fixture terminal data; no executor or real browser. The real trigger
        // must produce the summary atomically with the terminal event.
        if (index === 0) {
          const endingId = randomUUID();
          db.prepare("UPDATE task_steps SET status='FAILED',outcome=? WHERE job_id=?").run(
            JSON.stringify({
              version: 1,
              kind: 'FAILED',
              reason: 'TEST_FAILURE',
              endedAt: 100,
              endingId,
              currentStop: {
                requestId: endingId,
                profileId: plan.profileId,
                connectionEpoch: randomUUID(),
                state: 'stopped',
              },
              submissionPhase: 'NOT_APPLICABLE',
              businessResult: 'NOT_APPLICABLE',
            }),
            plan.id,
          );
        }
        db.prepare("UPDATE task_plans SET state='COMPLETED' WHERE id=?").run(plan.id);
        db.prepare(
          "INSERT INTO task_events(job_id,type,detail,created_at) VALUES(?,'COMPLETED','{}',?)",
        ).run(plan.id, 100 + index);
      }
    } finally {
      db.close();
    }
    const operationId = randomUUID();
    const entry = {
      profileId: ids[0]!,
      accountId: '123456789',
      friendId: '987654321',
      friendName: 'Friend',
      groupId: group.groupId,
    };
    store.groupInviter.reserveInvites(operationId, [entry]);
    assert.equal(store.groupInviter.listLogs().length, 0);
    assert.equal(store.groupInviter.getTotalInvitedByProfile().size, 0);
    assert.equal(
      store.groupInviter.getInvitedFriendIdsForGroup(group.groupId).has(entry.friendId),
      true,
    );
    assert.throws(() => store.groupInviter.recordInvites([entry], randomUUID()), /MISMATCH/);
    assert.equal(store.groupInviter.recordInvites([entry], operationId), 1);
    store.close();
    store = await WorkspaceStore.open(file);
    const results = store.tasks.runtimeSnapshot().profileResults!;
    assert.equal(results.length, 65);
    const first = results.find((r) => r.profileId === plans[0]?.profileId);
    const second = results.find((r) => r.profileId === plans[1]?.profileId);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.failedSteps, 1);
    assert.match(profileTaskResultLabel(first).text, /部分失败/);
    assert.match(profileTaskResultLabel(second).text, /上次成功/);
    assert.equal(store.groupInviter.listLogs().length, 1);
    assert.equal(store.groupInviter.getTotalInvitedByProfile().get(ids[0]!), 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('persistence error carries SQLite diagnostics and repository path without request parameters', () => {
  const error = Object.assign(Error('database read failed'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 11,
    errstr: 'database disk image is malformed',
    secretParams: 'never copy',
  });
  assert.deepEqual(persistenceError(error, 'workspace.tasks.runtimeSnapshot'), {
    message: error.message,
    name: 'Error',
    repositoryPath: 'workspace.tasks.runtimeSnapshot',
    code: 'ERR_SQLITE_ERROR',
    sqliteCode: 11,
    sqliteMessage: error.errstr,
  });
});

test('optional media absence never triggers download, rejects text derivation clearly; unsupported platform stays unsupported', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-optional-media-'));
  try {
    const component = new MediaRuntimeComponent(dir);
    assert.equal((await component.status()).installed, false);
    await assert.rejects(component.directory(), /可选组件/);
    assert.equal((await component.status()).busy, false);
    const mac = new MediaRuntimeComponent(dir, 'darwin-arm64');
    assert.equal((await mac.status()).supported, false);
    await assert.rejects(mac.directory(), /可选组件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function zipFixture(entries: { name: string; data: string; mode?: number }[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = Buffer.from(entry.data),
      checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x0314, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(checksum, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(data.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    central.push(index, name);
    offset += header.length + name.length + data.length;
  }
  const end = Buffer.alloc(22),
    directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('component extraction admits only pinned binaries/license, rejects duplicates, links and path traversal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-pinned-zip-'));
  const wanted = [
    { name: 'runtime/bin/ffmpeg.exe', data: 'binary' },
    { name: 'runtime/LICENSE.txt', data: 'license' },
  ];
  try {
    const archive = path.join(dir, 'test.zip');
    await writeFile(
      archive,
      zipFixture([...wanted, { name: 'runtime/extra.txt', data: 'ignored' }]),
    );
    await extractPinnedMediaArchive(
      archive,
      path.join(dir, 'ok'),
      'runtime',
      ['ffmpeg.exe'],
      new AbortController().signal,
    );
    assert.equal(await readFile(path.join(dir, 'ok/runtime/bin/ffmpeg.exe'), 'utf8'), 'binary');
    await assert.rejects(access(path.join(dir, 'ok/runtime/extra.txt')));
    for (const [name, entries] of [
      ['duplicate', [...wanted, wanted[0]!]],
      ['link', [{ ...wanted[0]!, mode: 0o120777 }, wanted[1]!]],
      ['traversal', [...wanted, { name: '../outside.exe', data: 'bad' }]],
      ['missing', [wanted[0]!]],
    ] as const) {
      await writeFile(archive, zipFixture([...entries]));
      await assert.rejects(
        extractPinnedMediaArchive(
          archive,
          path.join(dir, name),
          'runtime',
          ['ffmpeg.exe'],
          new AbortController().signal,
        ),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('optional media installs into isolated data and repairs a corrupted binary using verified local component', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    t.skip('Pinned component currently Windows x64 only');
    return;
  }
  const config = JSON.parse(await readFile('config/media-runtime.json', 'utf8')) as {
    directory: string;
  };
  try {
    await access(path.join('vendor/media-runtime', config.directory));
  } catch {
    t.skip('Optional local vendor unavailable; network download not part of unit suite');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-component-install-'));
  try {
    const component = new MediaRuntimeComponent(dir);
    const install = async () => {
      await component.start();
      const deadline = Date.now() + 30000;
      while ((await component.status()).busy && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      assert.equal((await component.status()).busy, false);
      assert.equal((await component.status()).error, '');
      assert.equal((await component.status()).installed, true);
    };
    await install();
    const binaries = await component.directory();
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawn(path.join(binaries, 'ffprobe.exe'), ['-version'], { windowsHide: true });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve(output) : reject(Error('PROBE_FAILED'))));
    });
    assert.match(version, /ffprobe version/);
    await writeFile(path.join(binaries, 'ffprobe.exe'), 'corrupt');
    await install(); // Existing marker alone must not prevent repair.
    await component.directory();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [confirmed, pending] of [
  [28, 2],
  [0, 30],
  [30, 0],
])
  test(`inviter final status preserves confirmed ${confirmed} and pending ${pending}`, async () => {
    const id = randomUUID();
    const saved: unknown[] = [];
    const service = new GroupInviterService(
      repository({
        saveProfileResult: (value) => {
          saved.push(value);
        },
      }),
      browser(async (profile, _group, _limit, callbacks) => {
        await callbacks.addSessionInvited(profile, confirmed!);
        await callbacks.reportBatchResult?.(profile, confirmed!, pending!);
        await callbacks.setProfileStatus(
          profile,
          pending
            ? confirmed
              ? `已确认 ${confirmed} 人 · ${pending} 人待核对`
              : `邀请已提交 · ${pending} 人待核对`
            : `已确认 ${confirmed} 人`,
        );
      }),
    );
    await service.start({ profileIds: [id], groupIds: [group.groupId] });
    await flush();
    const state = await service.state();
    assert.equal(state.profileCounts[id]?.sessionInvited, confirmed);
    assert.match(state.profileCounts[id]?.status ?? '', pending ? /待核对/ : /已确认/);
    assert.equal(ProfileTaskResult.parse(saved[0]).reason, state.profileCounts[id]?.status);
    if (pending)
      assert.equal(profileTaskResultLabel(ProfileTaskResult.parse(saved[0])).tone, 'warn');
  });
