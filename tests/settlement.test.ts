import { latestMigrationBackupMarker } from './fixtures/workspace-schema.js';
import test from 'node:test';
import { dropControlSchema } from './fixtures/control.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { SqliteSettlementRepository } from '../src/infrastructure/settlement-store.js';
import { SettlementNotifier } from '../src/application/settlement-notifier.js';
import { settlementFixture, prepareBound, verifyBound } from './fixtures/settlement.js';
import type { NoticeReceipt } from '../src/shared/settlement.js';

test('business checkpoint and immutable settlement notice commit together; duplicate canonical evidence reuses ID', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const first = (await store.tasks.settlements.list())[0];
    assert.ok(first);
    assert.equal(first.state, 'PENDING');
    await store.tasks.settleBound(f.receipt, 'VERIFIED', {
      ...f.step.progress,
      revision: 1,
      likes: 1,
    });
    assert.deepEqual(await store.tasks.settlements.list(), [first]);
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.likes, 1);
    await assert.rejects(
      async () => await store.tasks.settleBound(f.receipt, 'NOT_APPLIED'),
      /重复结算/,
    );
    await assert.rejects(
      async () =>
        await store.tasks.settleBound({ ...f.receipt, evidence: { counter: 2 } }, 'VERIFIED'),
      /重复结算/,
    );
    const db = new DatabaseSync(file);
    try {
      assert.throws(() => db.exec("UPDATE task_settlement_notices SET body='{}'"), /IMMUTABLE/);
      assert.throws(() => db.exec('DELETE FROM task_settlement_notices'), /RETAIN/);
    } finally {
      db.close();
    }
  });
});
test('notification insert failure rolls back verdict, checkpoint and notice as one transaction', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await store.tasks.acknowledgeBound(f.receipt);
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TRIGGER reject_notice BEFORE INSERT ON task_settlement_notices BEGIN SELECT RAISE(ABORT,'FIXTURE_WRITE_FAILURE'); END",
    );
    db.close();
    await assert.rejects(
      async () =>
        await store.tasks.settleBound(f.receipt, 'VERIFIED', {
          ...f.step.progress,
          revision: 1,
          likes: 1,
        }),
      /FIXTURE_WRITE_FAILURE/,
    );
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'ACKNOWLEDGED');
    assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.likes, 0);
    assert.equal((await store.tasks.settlements.list()).length, 0);
  });
});
test('unknown cannot enqueue or accept late success; independent not-applied reconciliation queues only notification', async () => {
  await settlementFixture(async (store) => {
    const f = await prepareBound(store);
    await store.tasks.markBoundUnknown(f.binding, 'UNCERTAIN_INPUT');
    await assert.rejects(
      async () => await store.tasks.settlements.ensureSettled(f.binding),
      /已持久核验/,
    );
    await assert.rejects(
      async () => await store.tasks.settleBound(f.receipt, 'VERIFIED'),
      /独立核对/,
    );
    await store.tasks.reconcileBound(f.receipt, 'NOT_APPLIED');
    assert.equal((await store.tasks.settlements.list())[0]?.resolution.outcome, 'NOT_APPLIED');
    assert.equal((await store.tasks.operations(f.plan.id))[0]?.status, 'FAILED');
    assert.equal((await store.tasks.get(f.plan.id)).state, 'REVIEW');
  });
});
test('cross-repository claim is exclusive and receipt must match full stable resolution', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const other = await WorkspaceStore.open(file);
    try {
      const claimed = await store.tasks.settlements.claim(f.profile.id);
      assert.ok(claimed?.claimToken);
      const claimedToken = claimed.claimToken;
      assert.equal(other.tasks.settlements.claim(f.profile.id), null);
      assert.throws(
        () =>
          other.tasks.settlements.delivered(f.binding.operationId, claimedToken, {
            binding: f.binding,
            resolution: { ...claimed.resolution, id: randomUUID() },
          }),
        /回执不一致/,
      );
      assert.throws(
        () =>
          other.tasks.settlements.delivered(f.binding.operationId, randomUUID(), {
            binding: claimed.binding,
            resolution: claimed.resolution,
          }),
        /发送代次/,
      );
      other.tasks.settlements.delivered(f.binding.operationId, claimed.claimToken, {
        binding: claimed.binding,
        resolution: claimed.resolution,
      });
      assert.equal((await store.tasks.settlements.list())[0]?.state, 'DELIVERED');
    } finally {
      other.close();
    }
  });
});
test('lost acknowledgement retries same notification after backoff without changing business count or stable ID', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    let clock = 1000,
      calls = 0;
    const received: NoticeReceipt[] = [];
    const db = new DatabaseSync(file);
    try {
      const repo = new SqliteSettlementRepository(db, { id: randomUUID, now: () => clock }),
        notifier = new SettlementNotifier(repo);
      const port = {
        profileId: f.profile.id,
        notify: async (
          binding: NoticeReceipt['binding'],
          resolution: NoticeReceipt['resolution'],
        ) => {
          calls++;
          received.push({ binding, resolution });
          if (calls === 1) throw Error('REPLY_LOST_AFTER_REMOTE_COMMIT');
          return { binding, resolution };
        },
      };
      await notifier.flushOne(port);
      assert.equal(repo.list()[0]?.state, 'PENDING');
      assert.equal(await notifier.flushOne(port), false);
      clock = 10_000;
      await notifier.flushOne(port);
      assert.equal(repo.list()[0]?.state, 'DELIVERED');
      assert.deepEqual(received[0], received[1]);
      assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.likes, 1);
      assert.equal((await store.tasks.operations(f.plan.id)).length, 1);
    } finally {
      db.close();
    }
  });
});
test('one profile cannot claim a second notice while another repository owns its first sending attempt', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    await store.tasks.prepareOperation(f.plan.id, f.step.id, randomUUID(), {
      kind: 'observe',
      tabId: 42,
    });
    const op = await store.tasks.takeBoundOperation({
      profileId: f.binding.profileId,
      accountId: f.binding.accountId,
      connectionEpoch: f.binding.connectionEpoch,
      leaseId: f.binding.leaseId,
      generation: f.binding.generation,
    });
    assert.ok(op?.binding);
    const receipt = { binding: op.binding, evidence: { scrolled: true } };
    await store.tasks.acknowledgeBound(receipt);
    await store.tasks.settleBound(receipt, 'VERIFIED');
    const other = await WorkspaceStore.open(file);
    try {
      const first = await store.tasks.settlements.claim(f.profile.id);
      assert.ok(first?.claimToken);
      assert.equal(other.tasks.settlements.claim(f.profile.id), null);
      await store.tasks.settlements.delivered(first.binding.operationId, first.claimToken, {
        binding: first.binding,
        resolution: first.resolution,
      });
      const second = other.tasks.settlements.claim(f.profile.id);
      assert.ok(second);
      assert.notEqual(first.binding.operationId, second.binding.operationId);
    } finally {
      other.close();
    }
  });
});
test('restart explicitly recovers notification sending and rejects previous claim; opening alone does not recover', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const old = await store.tasks.settlements.claim(f.profile.id);
    assert.ok(old?.claimToken);
    const oldToken = old.claimToken;
    const reopened = await WorkspaceStore.open(file);
    try {
      assert.equal(reopened.tasks.settlements.list()[0]?.state, 'SENDING');
      reopened.tasks.settlements.recoverOnStartup();
      const fresh = reopened.tasks.settlements.claim(f.profile.id);
      assert.ok(fresh?.claimToken);
      assert.deepEqual(fresh.resolution, old.resolution);
      assert.throws(
        () =>
          reopened.tasks.settlements.delivered(f.binding.operationId, oldToken, {
            binding: old.binding,
            resolution: old.resolution,
          }),
        /发送代次/,
      );
      reopened.tasks.settlements.delivered(f.binding.operationId, fresh.claimToken, {
        binding: fresh.binding,
        resolution: fresh.resolution,
      });
      assert.equal((await store.tasks.steps(f.plan.id))[0]?.progress.likes, 1);
    } finally {
      reopened.close();
    }
  });
});
test('one hanging profile does not block another; concurrent flush cannot claim same profile twice', async () => {
  await settlementFixture(async (store) => {
    const first = await prepareBound(store),
      second = await prepareBound(store);
    await verifyBound(store, first);
    await verifyBound(store, second);
    const notifier = new SettlementNotifier(store.tasks.settlements);
    let release: ((value: NoticeReceipt) => void) | undefined;
    let expected: NoticeReceipt | undefined;
    const port = {
      profileId: first.profile.id,
      notify: async (
        binding: NoticeReceipt['binding'],
        resolution: NoticeReceipt['resolution'],
      ) => {
        expected = { binding, resolution };
        return await new Promise<NoticeReceipt>((resolve) => {
          release = resolve;
        });
      },
    };
    const waiting = notifier.flushOne(port);
    assert.equal(await notifier.flushOne(port), false);
    await notifier.flushOne({
      profileId: second.profile.id,
      notify: async (binding, resolution) => ({ binding, resolution }),
    });
    assert.equal((await store.tasks.settlements.list(second.profile.id))[0]?.state, 'DELIVERED');
    assert.ok(release && expected);
    release(expected);
    await waiting;
    assert.equal((await store.tasks.settlements.list(first.profile.id))[0]?.state, 'DELIVERED');
  });
});
test('schema4 migration backs up unchanged business verdict, leaves backfill explicit and does not replay input', async () => {
  await settlementFixture(async (store, file) => {
    const f = await prepareBound(store);
    await verifyBound(store, f);
    const db = new DatabaseSync(file);
    db.exec(
      dropControlSchema +
        'DROP TRIGGER immutable_settlement_notice; DROP TRIGGER retain_settlement_notice; DROP TABLE task_settlement_delivery; DROP TABLE task_settlement_notices; PRAGMA user_version=4',
    );
    db.close();
    const migrated = await WorkspaceStore.open(file);
    try {
      assert.equal(migrated.tasks.operations(f.plan.id)[0]?.status, 'VERIFIED');
      assert.equal(migrated.tasks.settlements.list().length, 0);
      assert.equal(migrated.tasks.steps(f.plan.id)[0]?.progress.likes, 1);
      migrated.tasks.settlements.ensureSettled(f.binding);
      assert.equal(migrated.tasks.settlements.list().length, 1);
      const name = (await readdir(path.dirname(file))).find((row) =>
        row.includes(latestMigrationBackupMarker),
      );
      assert.ok(name);
      const backup = new DatabaseSync(path.join(path.dirname(file), name), { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 4);
      } finally {
        backup.close();
      }
    } finally {
      migrated.close();
    }
  });
});
