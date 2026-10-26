import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { GroupInviterBrowserAdapter } from '../src/infrastructure/group-inviter-runner.js';
import type { GroupInviterRepository } from '../src/application/group-inviter-service.js';
import type { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Core } from '../src/bridge/core.js';

const groupId = '1234567890',
  friendId = '987654321';
function harness(repo: Pick<GroupInviterRepository, 'getInvitedFriendIdsForGroup'>) {
  const adapter = new GroupInviterBrowserAdapter(
    repo as GroupInviterRepository,
    () => undefined,
    () => undefined,
    () => null,
  );
  return {
    select: (group: string, id: string, owned: Set<string>, click: () => Promise<boolean>) =>
      Reflect.get(adapter, 'selectRecipient').call(
        adapter,
        group,
        id,
        owned,
        click,
      ) as Promise<boolean>,
    release: (group: string, owned: Set<string>) =>
      Reflect.get(adapter, 'releaseSelections').call(adapter, group, owned),
    claims: () => Reflect.get(adapter, 'selectingByGroup') as Map<string, Set<string>>,
  };
}
test('claim precedes async DB read and checkbox; other groups remain independent', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  let reads = 0,
    clicks = 0;
  const h = harness({
    getInvitedFriendIdsForGroup: async () => {
      if (++reads === 1) await gate;
      return new Set();
    },
  });
  const a = new Set<string>(),
    b = new Set<string>(),
    other = new Set<string>();
  const first = h.select(groupId, friendId, a, async () => {
    clicks++;
    return true;
  });
  assert.equal(
    await h.select(groupId, friendId, b, async () => {
      throw Error('duplicate checkbox');
    }),
    false,
  );
  assert.equal(await h.select('9999999999', friendId, other, async () => true), true);
  finish();
  assert.equal(await first, true);
  assert.equal(clicks, 1);
  h.release(groupId, b);
  assert.equal(h.claims().get(groupId)?.has(friendId), true);
  h.release(groupId, a);
  h.release('9999999999', other);
  assert.equal(h.claims().size, 0);
});

for (const failure of ['cancel-after-selection', 'reserve-error'])
  test(`actual group runner releases selected claims before native close on ${failure}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const profileId = randomUUID(),
      accountId = '123456789',
      ownedProof = {
        profileId,
        ownershipId: randomUUID(),
        browserSessionEpoch: randomUUID(),
        tabId: 1,
        targetId: 'fixture',
      };
    const peer = { profileId, epoch: 1, online: true, synced: true };
    let cancelled = false,
      closed = 0,
      reservations = 0;
    const locator = {
      first: () => locator,
      count: async () => 1,
      nth: () => locator,
      isVisible: async () => true,
    };
    const state = {
      url: `https://www.facebook.com/groups/${groupId}/`,
      accountId,
      visible: true,
      ready: true,
      dialog: true,
      menu: false,
      dialogCount: 1,
      dialogIndex: 0,
      joined: true,
      timeOrigin: 1,
      inviteButtonIndex: 0,
      sendButton: { index: 0, disabled: false },
      items: [
        {
          id: friendId,
          name: 'Fixture',
          checked: false,
          invited: false,
          member: false,
          disabled: false,
        },
      ],
    };
    const page = {
      url: () => state.url,
      evaluate: async (fn: Function) => (fn.toString().includes('Cover photo') ? null : state),
      getByRole: () => locator,
      locator: () => locator,
    };
    const repo = {
      getInvitedFriendIdsForGroup: () => new Set<string>(),
      reserveInvites: () => {
        reservations++;
        throw Error('RESERVE_FAILED');
      },
    } as unknown as GroupInviterRepository;
    let adapter: GroupInviterBrowserAdapter;
    const connection = {
      browser: { contexts: () => [{ pages: () => [page] }] },
      revokeInput: () => {},
      close: async () => {
        closed++;
        assert.equal(Reflect.get(adapter, 'selectingByGroup').size, 0);
      },
    };
    const kernel = {
      withSummary: async (_: unknown, fn: Function) =>
        fn({ inventory: () => ({ operations: [], tabs: [] }) }),
      inspectIdleFacebookPage: async () => ({ actor: { accountId }, proof: ownedProof }),
      connectFacebook: async () => connection,
    } as unknown as KernelBridge;
    adapter = new GroupInviterBrowserAdapter(
      repo,
      () => kernel,
      () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
      () => null,
    );
    Reflect.set(
      adapter,
      'execBoundOp',
      async (
        _conn: unknown,
        _account: string,
        label: string,
        _fn: unknown,
        _persist: unknown,
        prepare?: Function,
      ) => {
        if (label.startsWith('check-friend-')) return friendId;
        if (label === 'send-group-invites') {
          assert.ok(prepare);
          await prepare(randomUUID());
        }
        throw Error('UNEXPECTED_OPERATION:' + label);
      },
    );
    const run = adapter.inviteForGroup(
      profileId,
      {
        groupId,
        groupName: 'Fixture',
        avatarUrl: null,
        totalInvitedCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      1,
      {
        isCancelled: () => cancelled,
        addSessionInvited: () => {},
        setProfileStatus: (_id, status) => {
          if (failure === 'cancel-after-selection' && status.startsWith('已选')) {
            cancelled = true;
            throw Error('GROUP_INVITER_CANCELLED');
          }
        },
      },
    );
    let finished = false;
    const checked = assert
      .rejects(
        run,
        failure === 'cancel-after-selection' ? /GROUP_INVITER_CANCELLED/ : /RESERVE_FAILED/,
      )
      .finally(() => {
        finished = true;
      });
    for (let i = 0; i < 10 && !finished; i++) {
      for (let j = 0; j < 30; j++) await Promise.resolve();
      t.mock.timers.tick(2000);
    }
    await checked;
    assert.equal(closed, 1);
    assert.equal(reservations, failure === 'reserve-error' ? 1 : 0);
    assert.equal(Reflect.get(adapter, 'selectingByGroup').size, 0);
  });
test('unchecked, cancelled and failed candidates release only their own pre-reservation claims', async () => {
  const h = harness({ getInvitedFriendIdsForGroup: () => new Set() });
  for (const failure of ['unchecked', 'cancelled', 'connection-error']) {
    const owned = new Set<string>();
    const attempt = h.select(groupId, friendId, owned, async () => {
      if (failure === 'unchecked') return false;
      throw Error(failure);
    });
    if (failure === 'unchecked') assert.equal(await attempt, false);
    else await assert.rejects(attempt, new RegExp(failure));
    assert.equal(owned.size, 0);
    assert.equal(h.claims().size, 0);
    const next = new Set<string>();
    assert.equal(await h.select(groupId, friendId, next, async () => true), true);
    // Successful check followed by cancel/exception before reserve: runner's finally releases it.
    h.release(groupId, next);
    assert.equal(h.claims().size, 0);
  }
  const bad = harness({
      getInvitedFriendIdsForGroup: async () => {
        throw Error('DB_READ_FAILED');
      },
    }),
    owned = new Set<string>();
  await assert.rejects(
    bad.select(groupId, friendId, owned, async () => true),
    /DB_READ_FAILED/,
  );
  assert.equal(owned.size, 0);
  assert.equal(bad.claims().size, 0);
});
test('durable PENDING/CONFIRMED take over claims; a stale snapshot cannot cause another checkbox', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inviter-selection-'));
  const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
  try {
    const repo = store.groupInviter,
      h = harness(repo),
      owned = new Set<string>(),
      operationId = randomUUID();
    const row = {
      profileId: randomUUID(),
      accountId: '123456789',
      friendId,
      friendName: 'Fixture',
      groupId,
    };
    const stale = repo.getInvitedFriendIdsForGroup(groupId);
    assert.equal(stale.has(friendId), false);
    assert.equal(await h.select(groupId, friendId, owned, async () => true), true);
    repo.reserveInvites(operationId, [row]);
    h.release(groupId, owned);
    assert.equal(h.claims().size, 0);
    for (const confirmed of [false, true]) {
      if (confirmed) repo.recordInvites([row], operationId);
      assert.equal(stale.has(friendId), false);
      assert.equal(
        await h.select(groupId, friendId, new Set(), async () => {
          throw Error('committed recipient clicked again');
        }),
        false,
      );
    }
    assert.equal(repo.listLogs().length, 1); // This query returns CONFIRMED rows only.
    assert.equal(repo.getTotalInvitedByProfile().get(row.profileId), 1);
    assert.equal(h.claims().size, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
