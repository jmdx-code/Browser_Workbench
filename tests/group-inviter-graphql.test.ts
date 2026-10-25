import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import {
  confirmedInvitationGraphQL,
  observeInvitationGraphQL,
  settleInvitationConfirmation,
} from '../src/infrastructure/group-inviter-runner.js';

const accountId = '123456789',
  groupId = '1234567890';
const selectedIds = Array.from({ length: 30 }, (_, i) => String(987654000 + i));
const variables = {
  input: { actor_id: accountId, group_id: groupId, user_ids: selectedIds },
  groupID: groupId,
};
const payload = {
  group: { id: groupId },
  user_facing_alert: null,
  added_users: selectedIds.map((id) => ({
    id,
    group_membership: { pending_invite: { id: 'pending-' + id } },
  })),
  already_invited_users: [],
  requested_users: [],
};
const input = {
  name: 'useGroupAddMembersMutation',
  variables,
  status: 200,
  body: JSON.stringify({ data: { group_add_member: payload }, extensions: { is_final: true } }),
  accountId,
  groupId,
  selectedIds,
};

test('exact actor/group mutation confirms 30 in SQLite without reopen or refresh', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'inviter-graphql-'));
  const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
  const profileId = randomUUID(),
    operationId = randomUUID();
  const rows = selectedIds.map((friendId) => ({
    profileId,
    accountId,
    groupId,
    friendId,
    friendName: 'Fixture',
  }));
  let credited = 0,
    reopens = 0,
    refreshes = 0;
  try {
    store.groupInviter.reserveInvites(operationId, rows);
    const confirmed = new Set<string>();
    const count = await settleInvitationConfirmation({
      selectedIds,
      confirmed,
      graphql: async () => confirmedInvitationGraphQL(input),
      assertCurrent: async () => {},
      persist: async (ids) => {
        credited += store.groupInviter.recordInvites(
          rows.filter((r) => ids.includes(r.friendId)),
          operationId,
        );
      },
      fallback: async () => {
        reopens++;
        refreshes++;
      },
    });
    assert.equal(count, 30);
    assert.equal(confirmed.size, 30);
    assert.equal(credited, 30);
    assert.equal(reopens, 0);
    assert.equal(refreshes, 0);
    const db = new DatabaseSync(path.join(directory, 'workspace.sqlite'), { readOnly: true });
    try {
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS n FROM group_inviter_logs WHERE confirmation='CONFIRMED'")
          .get()?.n,
        30,
      );
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS n FROM group_inviter_logs WHERE confirmation='PENDING'")
          .get()?.n,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const invalid = [
  {
    label: 'wrong request actor',
    changes: { variables: { input: { ...variables.input, actor_id: '111111111' } } },
  },
  {
    label: 'wrong request group',
    changes: { variables: { input: { ...variables.input, group_id: '111111111' } } },
  },
  {
    label: 'wrong response group',
    changes: {
      body: JSON.stringify({
        data: { group_add_member: { ...payload, group: { id: '111111111' } } },
      }),
    },
  },
  {
    label: 'non-null alert',
    changes: {
      body: JSON.stringify({
        data: { group_add_member: { ...payload, user_facing_alert: { title: 'Any language' } } },
      }),
    },
  },
  {
    label: 'top-level errors',
    changes: {
      body: JSON.stringify({ data: { group_add_member: payload }, errors: [{ code: 123 }] }),
    },
  },
  {
    label: 'errors in later chunk',
    changes: { body: input.body + '\n' + JSON.stringify({ errors: [{ message: 'error' }] }) },
  },
  { label: 'HTTP failure', changes: { status: 500 } },
  { label: 'different operation', changes: { name: 'OtherMutation' } },
  { label: 'missing group payload', changes: { body: JSON.stringify({ data: {} }) } },
  { label: 'malformed response', changes: { body: 'for (;;);not-json' } },
];
for (const scenario of invalid)
  test(scenario.label + ' rejects GraphQL and uses page fallback', async () => {
    let fallback = 0,
      persist = 0;
    const confirmed = new Set<string>();
    const ids = confirmedInvitationGraphQL({ ...input, ...scenario.changes });
    assert.deepEqual(ids, []);
    await settleInvitationConfirmation({
      selectedIds,
      confirmed,
      graphql: async () => ids,
      assertCurrent: async () => {},
      persist: async () => {
        persist++;
      },
      fallback: async () => {
        fallback++;
      },
    });
    assert.equal(fallback, 1);
    assert.equal(persist, 0);
    assert.equal(confirmed.size, 0);
  });

test('anti-XSSI and multi-line chunks accept selected numeric IDs from all three arrays only', () => {
  const partial = {
    ...payload,
    added_users: [{ id: selectedIds[0] }, { id: '111111111' }, { id: 'not-a-uid' }],
    already_invited_users: [{ id: selectedIds[1] }],
    requested_users: [{ id: selectedIds[2] }, { id: selectedIds[0] }],
  };
  const body =
    'for (;;);\n' +
    JSON.stringify({ data: { group_add_member: partial } }) +
    '\n' +
    JSON.stringify({ extensions: { is_final: true } });
  assert.deepEqual(confirmedInvitationGraphQL({ ...input, body }), selectedIds.slice(0, 3));
});

test('partial GraphQL evidence is persisted before page fallback', async () => {
  const confirmed = new Set<string>(),
    commits: string[][] = [];
  const first = selectedIds[0];
  assert.ok(first);
  await settleInvitationConfirmation({
    selectedIds,
    confirmed,
    graphql: async () => [first],
    assertCurrent: async () => {},
    persist: async (ids) => {
      commits.push(ids);
    },
    fallback: async () => {
      assert.equal(confirmed.has(first), true);
      assert.deepEqual(commits, [[first]]);
    },
  });
});

test('restriction/context guard blocks GraphQL settlement before persistence', async () => {
  let persisted = false,
    fallback = false;
  await assert.rejects(
    settleInvitationConfirmation({
      selectedIds,
      confirmed: new Set(),
      graphql: async () => selectedIds,
      assertCurrent: async () => {
        throw Error('RESTRICTED');
      },
      persist: async () => {
        persisted = true;
      },
      fallback: async () => {
        fallback = true;
      },
    }),
    /RESTRICTED/,
  );
  assert.equal(persisted, false);
  assert.equal(fallback, false);
});

test('native proof arriving during fallback settles remaining recipients without double credit', async () => {
  const confirmed = new Set<string>(),
    commits: string[][] = [];
  let reads = 0;
  const nativeCount = await settleInvitationConfirmation({
    selectedIds,
    confirmed,
    graphql: async () => (++reads === 1 ? [] : selectedIds),
    assertCurrent: async () => {},
    persist: async (ids) => {
      commits.push(ids);
    },
    fallback: async () => {
      const pageIds = selectedIds.slice(0, 7);
      commits.push(pageIds);
      for (const id of pageIds) confirmed.add(id);
    },
  });
  assert.equal(nativeCount, 23);
  assert.equal(confirmed.size, 30);
  assert.deepEqual(
    commits.map((ids) => ids.length),
    [7, 23],
  );
  assert.equal(new Set(commits.flat()).size, 30);
});

test('mutation response after old three-second cutoff still confirms without fallback', async () => {
  const events = new EventEmitter();
  const observer = observeInvitationGraphQL(
    events as unknown as Page,
    'profile',
    'operation',
    groupId,
    selectedIds,
    accountId,
  );
  const request = {
    url: () => 'https://www.facebook.com/api/graphql/',
    method: () => 'POST',
    postData: () =>
      new URLSearchParams({
        fb_api_req_friendly_name: input.name,
        variables: JSON.stringify(variables),
      }).toString(),
  };
  events.emit('request', request);
  const timer = setTimeout(
    () =>
      events.emit('response', {
        request: () => request,
        status: () => 200,
        text: async () => input.body,
      }),
    3200,
  );
  try {
    observer.endSubmission();
    const confirmed = new Set<string>();
    let fallback = 0;
    await settleInvitationConfirmation({
      selectedIds,
      confirmed,
      graphql: observer.confirmations,
      assertCurrent: async () => {},
      persist: async () => {},
      fallback: async () => {
        fallback++;
      },
    });
    assert.equal(confirmed.size, 30);
    assert.equal(fallback, 0);
  } finally {
    clearTimeout(timer);
    await observer.close();
  }
});
