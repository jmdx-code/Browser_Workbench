import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { GroupInviterBrowserAdapter } from '../src/infrastructure/group-inviter-runner.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Core } from '../src/bridge/core.js';
import type { GroupInviterRepository } from '../src/application/group-inviter-service.js';
import type { Page } from 'playwright-core';
import {
  groupInvitationEffect,
  type GroupInvitationState,
} from '../src/infrastructure/group-inviter-effects.js';

const group = {
  groupId: '1234567890',
  groupName: '测试小组',
  avatarUrl: null,
  totalInvitedCount: 0,
  createdAt: 1,
  updatedAt: 1,
};
const actor = {
  version: 1,
  source: 'CometSettingsDropdownTriggerQuery',
  accountId: '123456789',
  name: 'Current User',
  type: 'User',
  checkedAt: 1,
};
const state = (): GroupInvitationState => ({
  url: 'https://www.facebook.com/groups/1234567890/',
  accountId: actor.accountId,
  visible: true,
  ready: true,
  dialog: true,
  menu: false,
  dialogCount: 1,
  joined: true,
  items: [],
  timeOrigin: 1,
});

for (const retained of [false, true])
  test(`invitation reads current home identity before binding, independent of cached ID (idle=${retained})`, async () => {
    const profileId = randomUUID(),
      proof = {
        profileId,
        ownershipId: randomUUID(),
        browserSessionEpoch: randomUUID(),
        tabId: 7,
        targetId: 'native',
      };
    const peer = { profileId, epoch: 1, online: true, synced: true },
      calls: string[] = [];
    const observed = { actor, proof };
    const kernel = {
      withSummary: async (_: unknown, fn: Function) =>
        fn({ inventory: () => ({ operations: [], tabs: [], workspaceMain: null }) }),
      inspectIdleFacebookPage: async (
        _: unknown,
        _guard: unknown,
        _story: unknown,
        home: boolean,
      ) => {
        assert.equal(home, true);
        calls.push('idle-home');
        return retained ? observed : null;
      },
      inspectFacebookIdentity: async (...args: unknown[]) => {
        assert.equal(args[6], true);
        calls.push('home');
        return observed;
      },
      connectFacebook: async (_: unknown, id: string, _guard: unknown, p: unknown) => {
        assert.equal(id, actor.accountId);
        assert.equal(p, proof);
        calls.push('bind');
        throw Error('CONNECTED_AFTER_IDENTITY');
      },
    } as unknown as KernelBridge;
    const adapter = new GroupInviterBrowserAdapter(
      {} as GroupInviterRepository,
      () => kernel,
      () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
      () => {
        throw Error('must not read account cache');
      },
    );
    await assert.rejects(
      adapter.inviteForGroup(profileId, group, 1, {
        isCancelled: () => false,
        setProfileStatus: () => {},
        addSessionInvited: () => {},
      }),
      /CONNECTED_AFTER_IDENTITY/,
    );
    assert.deepEqual(calls, retained ? ['idle-home', 'bind'] : ['idle-home', 'home', 'bind']);
  });

test('STOP during home identity read prevents binding or invitations', async () => {
  const profileId = randomUUID(),
    peer = { profileId, epoch: 1, online: true, synced: true };
  let stopped = false,
    connects = 0;
  const kernel = {
    withSummary: async (_: unknown, fn: Function) =>
      fn({ inventory: () => ({ operations: [], tabs: [] }) }),
    inspectIdleFacebookPage: async () => null,
    inspectFacebookIdentity: async () => {
      stopped = true;
      return { actor };
    },
    connectFacebook: async () => {
      connects++;
    },
  } as unknown as KernelBridge;
  const adapter = new GroupInviterBrowserAdapter(
    {} as GroupInviterRepository,
    () => kernel,
    () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
    () => null,
  );
  await assert.rejects(
    adapter.inviteForGroup(profileId, group, 1, {
      isCancelled: () => stopped,
      setProfileStatus: () => {},
      addSessionInvited: () => {},
    }),
    /CANCELLED/,
  );
  assert.equal(connects, 0);
});

test('home identity waits for mounted native actor and never needs the post composer', async () => {
  const kernel = Object.create(KernelBridge.prototype),
    wait = Reflect.get(kernel, 'waitInvitationHomeIdentity') as Function;
  let reads = 0;
  const page = {
    url: () => 'https://www.facebook.com/',
    evaluate: async () => ({
      url: 'https://www.facebook.com/',
      ready: 'complete',
      timeOrigin: 1,
      actor: ++reads === 1 ? null : actor,
    }),
  };
  const result = await wait.call(kernel, page, () => {});
  assert.equal(result.actor.accountId, actor.accountId);
  assert.equal(reads, 2);
});
test('login page is explained and connection errors are not retried as missing identity', async () => {
  const kernel = Object.create(KernelBridge.prototype),
    wait = Reflect.get(kernel, 'waitInvitationHomeIdentity') as Function;
  await assert.rejects(
    wait.call(kernel, { url: () => 'https://www.facebook.com/checkpoint/' }, () => {}),
    /尚未登录或需要完成账号验证/,
  );
  let reads = 0;
  await assert.rejects(
    wait.call(
      kernel,
      {
        url: () => 'https://www.facebook.com/',
        evaluate: async () => {
          reads++;
          throw Error('CONNECTION_LOST');
        },
      },
      () => {},
    ),
    /CONNECTION_LOST/,
  );
  assert.equal(reads, 1);
});

async function verify(states: GroupInvitationState[]) {
  const adapter = new GroupInviterBrowserAdapter(
    {} as GroupInviterRepository,
    () => undefined,
    () => undefined,
    () => null,
  );
  let reads = 0,
    scrolls = 0,
    executions = 0,
    confirmed = 0,
    reserved = 0,
    reconciled = 0;
  const page = {
    evaluate: async (fn: Function) => {
      if (fn.name === 'projectGroupInvitationState')
        return states[Math.min(reads++, states.length - 1)];
      scrolls++;
    },
  } as unknown as Page;
  const conn = {
    context: async () => ({}),
    execute: async () => {
      executions++;
      return { value: ['987654321', '987654322'] };
    },
    reconcile: async () => {
      reconciled++;
    },
  };
  Reflect.get(adapter, 'scopes').set(conn, {
    guard: () => {},
    page,
    groupId: group.groupId,
    jobId: randomUUID(),
    stepId: randomUUID(),
    stopId: randomUUID(),
    pendingSetup: new Map(),
  });
  const call = Reflect.get(adapter, 'execBoundOp') as Function;
  const promise = call.call(
    adapter,
    conn,
    actor.accountId,
    'send-group-invites',
    async () => {},
    async () => {
      confirmed++;
    },
    async () => {
      reserved++;
    },
  );
  return {
    promise,
    counts: () => ({ reads, scrolls, executions, confirmed, reserved, reconciled }),
  };
}
test('virtualized result pages and non-checkbox invited rows confirm one submission once', async () => {
  const first = {
    ...state(),
    recipients: [{ id: '987654321', invited: true, member: false, checked: false }],
  };
  const second = {
    ...state(),
    items: [{ id: '987654322', invited: true, member: false, checked: false }],
  };
  const run = await verify([state(), first, second]);
  await run.promise;
  assert.deepEqual(run.counts(), {
    reads: 3,
    scrolls: 1,
    executions: 1,
    confirmed: 1,
    reserved: 1,
    reconciled: 1,
  });
});
test('result observations cannot be combined across documents or accounts', async () => {
  for (const changed of [
    { ...state(), timeOrigin: 2 },
    { ...state(), accountId: '111111111' },
  ]) {
    const first = {
      ...state(),
      items: [{ id: '987654321', invited: true, member: false, checked: false }],
    };
    const run = await verify([state(), first, changed]);
    await assert.rejects(run.promise, /账号、小组或可见状态发生变化/);
    assert.equal(run.counts().executions, 1);
    assert.equal(run.counts().confirmed, 0);
    assert.equal(run.counts().reconciled, 0);
  }
});
test('missing recipients, dialog closure and unrelated rows never become successful invitations', () => {
  assert.equal(
    groupInvitationEffect(
      'send-group-invites',
      { ...state(), dialog: false },
      group.groupId,
      actor.accountId,
      ['987654321'],
    ),
    false,
  );
  assert.equal(
    groupInvitationEffect(
      'send-group-invites',
      {
        ...state(),
        recipients: [{ id: '999999999', invited: true, member: false, checked: false }],
      },
      group.groupId,
      actor.accountId,
      ['987654321'],
    ),
    false,
  );
});

for (const reserved of [false, true])
  test(`inviter control ends without changing pending recipient verdicts (reserved=${reserved})`, async () => {
    const profileId = randomUUID(),
      peer = { profileId, epoch: 1, online: true, synced: true };
    const operation = {
      binding: { operationId: randomUUID(), accountId: actor.accountId, actionDigest: '' },
      state: 'UNKNOWN',
      reason: 'GROUP_INVITER_CURRENT_ACCOUNT_OR_VISIBILITY_CHANGED',
      disposition: undefined as unknown,
    };
    operation.binding.actionDigest = createHash('sha256')
      .update(
        JSON.stringify({
          purpose: 'group-inviter',
          label: 'enter-group',
          accountId: actor.accountId,
          operationId: operation.binding.operationId,
        }),
      )
      .digest('hex');
    let notifications = 0;
    const kernel = {
      withSummary: async (_: unknown, fn: Function) =>
        fn({
          inventory: () => ({ operations: [operation], tabs: [] }),
          notify: async (binding: unknown, resolution: { outcome: string }) => {
            assert.equal(binding, operation.binding);
            assert.equal(resolution.outcome, 'ENDED_UNKNOWN');
            notifications++;
            operation.disposition = resolution;
          },
        }),
      inspectIdleFacebookPage: async () => {
        throw Error('IDENTITY_REACHED');
      },
    } as unknown as KernelBridge;
    const repo = { hasInvitesForOperation: () => reserved } as unknown as GroupInviterRepository;
    const adapter = new GroupInviterBrowserAdapter(
      repo,
      () => kernel,
      () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
      () => null,
    );
    await assert.rejects(
      adapter.inviteForGroup(profileId, group, 1, {
        isCancelled: () => false,
        setProfileStatus: () => {},
        addSessionInvited: () => {},
      }),
      /IDENTITY_REACHED/,
    );
    assert.equal(notifications, 1);
    assert.equal(operation.state, 'UNKNOWN');
  });

test('hidden invitation page is activated once and verified before input continues', async () => {
  const adapter = new GroupInviterBrowserAdapter(
    {} as GroupInviterRepository,
    () => undefined,
    () => undefined,
    () => null,
  );
  let visible = false,
    activated = 0,
    executions = 0;
  const page = { evaluate: async () => ({ ...state(), visible }) };
  const conn = {
    context: async () => ({}),
    execute: async () => {
      assert.equal(visible, true);
      executions++;
      return { value: undefined };
    },
    reconcile: async () => {},
  };
  Reflect.get(adapter, 'scopes').set(conn, {
    guard: () => {},
    activate: async () => {
      activated++;
      visible = true;
    },
    page,
    groupId: group.groupId,
    jobId: randomUUID(),
    stepId: randomUUID(),
    stopId: randomUUID(),
    pendingSetup: new Map(),
  });
  await Reflect.get(adapter, 'execBoundOp').call(
    adapter,
    conn,
    actor.accountId,
    'open-invite-modal',
    async () => {},
  );
  assert.equal(activated, 1);
  assert.equal(executions, 1);
});

test('fresh searched-recipient proof requires every exact ID, actor, group and current document', () => {
  const current = {
    ...state(),
    items: [{ id: '987654322', invited: true, member: false, checked: false }],
  };
  const value = {
    friendIds: ['987654321', '987654322'],
    proof: {
      accountId: actor.accountId,
      groupId: group.groupId,
      timeOrigin: 1,
      friendIds: ['987654321', '987654322'],
    },
  };
  const check = (v: unknown) =>
    groupInvitationEffect('send-group-invites', current, group.groupId, actor.accountId, v);
  assert.equal(check(value), true);
  for (const proof of [
    { ...value.proof, timeOrigin: 2 },
    { ...value.proof, accountId: '111111111' },
    { ...value.proof, groupId: '999999999' },
    { ...value.proof, friendIds: ['987654322'] },
  ])
    assert.equal(check({ ...value, proof }), false);
  assert.equal(
    groupInvitationEffect(
      'send-group-invites',
      { ...current, items: [] },
      group.groupId,
      actor.accountId,
      value,
    ),
    false,
  );
});

test('native mobile identity verification stops before input or reservation', async () => {
  const adapter = new GroupInviterBrowserAdapter(
    {} as GroupInviterRepository,
    () => undefined,
    () => undefined,
    () => null,
  );
  let executions = 0,
    reservations = 0;
  const page = { evaluate: async () => ({ ...state(), verificationRequired: true }) };
  const conn = {
    context: async () => ({}),
    execute: async () => {
      executions++;
    },
  };
  Reflect.get(adapter, 'scopes').set(conn, {
    guard: () => {},
    page,
    groupId: group.groupId,
    jobId: randomUUID(),
    stepId: randomUUID(),
    stopId: randomUUID(),
    pendingSetup: new Map(),
  });
  await assert.rejects(
    Reflect.get(adapter, 'execBoundOp').call(
      adapter,
      conn,
      actor.accountId,
      'join-group',
      async () => {},
      undefined,
      async () => {
        reservations++;
      },
    ),
    /需要手机验证或操作受限/,
  );
  assert.equal(executions, 0);
  assert.equal(reservations, 0);
});
