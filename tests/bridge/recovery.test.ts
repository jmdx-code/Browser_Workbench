import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Core, type Peer } from '../../src/bridge/core.js';
import { Store } from '../../src/bridge/store.js';
import { Journal, type Storage } from '../../extension/journal.js';
import {
  VERSION,
  canonicalAction,
  type Command,
  type JournalEntry,
} from '../../src/bridge/protocol.js';
const tick = () => new Promise((r) => setImmediate(r));
async function synced(core: Core, peer: Peer, entries: JournalEntry[] = []) {
  await core.sync(peer);
  assert.equal(await core.synced(peer, peer.controlId!, entries), true);
}
async function running(core: Core, peer: Peer) {
  await synced(core, peer);
  await core.resume(peer.profileId);
  await core.resumed(peer, peer.controlId!);
}
function command(operationId = randomUUID()): Command {
  return {
    type: 'COMMAND',
    version: VERSION,
    commandId: randomUUID(),
    operationId,
    connectionEpoch: randomUUID(),
    deadline: Date.now() + 1000,
    action: { kind: 'createTab' },
  };
}
class MemoryStorage implements Storage {
  data: Record<string, unknown> = {};
  async get(key: string | null) {
    return structuredClone(key === null ? this.data : { [key]: this.data[key] });
  }
  async set(value: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(value));
  }
  async remove(keys: string[]) {
    for (const key of keys) delete this.data[key];
  }
}
test('停止必须确认，旧回执、未完成恢复回执不能开启执行', async () => {
  const store = new Store(':memory:'),
    core = new Core(store);
  const peer = core.connect(
    randomUUID(),
    () => {},
    () => {},
  );
  await running(core, peer);
  await core.stop(peer.profileId);
  const stopId = peer.controlId!;
  await assert.rejects(
    async () => await core.resume(peer.profileId),
    /CONTROL_CONFIRMATION_PENDING/,
  );
  assert.equal(await core.stopped(peer, randomUUID()), false);
  assert.equal(peer.phase, 'STOPPING');
  assert.equal(await core.stopped(peer, stopId), true);
  await core.resume(peer.profileId);
  assert.equal(peer.phase, 'STARTING');
  assert.equal(peer.paused, true);
  assert.equal(await core.stopped(peer, stopId), false);
  await assert.rejects(
    async () =>
      await core.submit({
        profileId: peer.profileId,
        operationId: randomUUID(),
        action: { kind: 'createTab' },
      }),
    /PAUSED/,
  );
  await core.resumed(peer, peer.controlId!);
  assert.equal(peer.phase, 'RUNNING');
  await core.shutdown();
  store.close();
});
test('停止确认超时必须重新对账，不能用核对结果绕过', async () => {
  const store = new Store(':memory:'),
    core = new Core(store, 15);
  const peer = core.connect(
    randomUUID(),
    () => {},
    () => {},
  );
  await running(core, peer);
  await core.stop(peer.profileId);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(peer.error, 'STOP_CONFIRMATION_TIMEOUT');
  assert.equal(peer.synced, false);
  await assert.rejects(async () => await core.resume(peer.profileId), /RECONCILIATION_REQUIRED/);
  await synced(core, peer);
  await core.resume(peer.profileId);
  await core.resumed(peer, peer.controlId!);
  assert.equal(peer.phase, 'RUNNING');
  await core.shutdown();
  store.close();
});
test('ACK 可只读核对，阻止第二次写入；核对记录与证据持久化', async () => {
  const store = new Store(':memory:'),
    core = new Core(store);
  const peer = core.connect(
    randomUUID(),
    () => {},
    () => {},
  );
  await running(core, peer);
  const row = await core.submit({
    profileId: peer.profileId,
    operationId: randomUUID(),
    action: { kind: 'createTab' },
  });
  await tick();
  await core.reply(peer, { type: 'RESULT', commandId: row.commandId, status: 'ACKNOWLEDGED' });
  await assert.rejects(
    async () =>
      await core.submit({
        profileId: peer.profileId,
        operationId: randomUUID(),
        action: { kind: 'createTab' },
      }),
    /RESULT_REVIEW_REQUIRED/,
  );
  const read = await core.submit({
    profileId: peer.profileId,
    operationId: randomUUID(),
    action: { kind: 'observe', tabId: 1 },
  });
  await tick();
  await core.reply(peer, { type: 'RESULT', commandId: read.commandId, status: 'VERIFIED' });
  await core.review(peer.profileId, row.commandId, 'ABANDON', '不确定结果，停止追踪且不重放', {
    observationCommandId: read.commandId,
  });
  assert.equal(store.get(row.commandId)?.status, 'ABANDONED');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reviews').get()!.n, 1);
  await core.shutdown();
  store.close();
});
test('扩展按 operationId 去重，数据库回退生成的新 commandId 不重复执行', async () => {
  const storage = new MemoryStorage(),
    journal = new Journal(storage),
    cmd = command();
  const prepared = await journal.prepare(cmd);
  assert.equal(prepared.fresh, true);
  await journal.finish(prepared.entry!, {
    status: 'ACKNOWLEDGED',
    evidence: { inputDispatched: true },
  });
  const retry = { ...cmd, commandId: randomUUID() };
  const duplicate = await journal.prepare(retry);
  assert.equal(duplicate.fresh, false);
  assert.equal(duplicate.entry!.status, 'ACKNOWLEDGED');
  assert.equal(duplicate.entry!.commandId, cmd.commandId);
  const restored = new Store(':memory:');
  restored.reconcile(randomUUID(), []);
  const profileId = randomUUID();
  restored.reconcile(profileId, await journal.snapshot());
  const recovered = restored.prepare({
    profileId,
    operationId: cmd.operationId,
    action: cmd.action,
  });
  assert.equal(recovered.fresh, false);
  assert.equal(recovered.row.status, 'UNKNOWN');
  await assert.rejects(
    journal.prepare({ ...retry, action: { kind: 'closeTab', tabId: 1 } }),
    /OPERATION_ID_CONFLICT/,
  );
  restored.close();
});
test('日志上限拒绝不会增长，读取不占副作用日志容量', async () => {
  const storage = new MemoryStorage(),
    journal = new Journal(storage, 1);
  await journal.prepare(command());
  for (let i = 0; i < 10; i++) await assert.rejects(journal.prepare(command()), /JOURNAL_LIMIT/);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await journal.prepare({ ...command(), action: { kind: 'observe', tabId: 1 } })).entry,
      undefined,
    );
  assert.equal(Object.keys(storage.data).length, 1);
});
test('旧版日志迁移先保留副作用摘要，旧读取记录不进入新索引', async () => {
  const storage = new MemoryStorage(),
    journal = new Journal(storage);
  const cmd = command(),
    read = command();
  storage.data['command:' + cmd.commandId] = {
    status: 'ACKNOWLEDGED',
    fingerprint: JSON.stringify({ action: cmd.action, operationId: cmd.operationId }),
  };
  storage.data['command:' + read.commandId] = {
    status: 'VERIFIED',
    fingerprint: JSON.stringify({
      action: { kind: 'observe', tabId: 1 },
      operationId: read.operationId,
    }),
  };
  await journal.migrate();
  const entries = await journal.snapshot();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.legacyFixture, true);
  assert.equal(entries[0]!.status, 'ACKNOWLEDGED');
  assert.equal(Object.keys(storage.data).filter((k) => k.startsWith('command:')).length, 0);
  await journal.migrate();
  assert.equal((await journal.snapshot()).length, 1);
});
test('对账快照冲突全量拒绝，已核对结果不被旧 ACK 降级', () => {
  const store = new Store(':memory:'),
    profileId = randomUUID(),
    cmd = command();
  const entry: JournalEntry = {
    operationId: cmd.operationId,
    commandId: cmd.commandId,
    action: cmd.action,
    digest: createHash('sha256').update(canonicalAction(cmd.action)).digest('hex'),
    status: 'ACKNOWLEDGED',
    legacyFixture: false,
  };
  assert.throws(
    () =>
      store.reconcile(profileId, [
        entry,
        { ...entry, operationId: randomUUID(), digest: 'a'.repeat(64) },
      ]),
    /JOURNAL_DIGEST/,
  );
  assert.equal(store.list().length, 0);
  assert.throws(() => store.reconcile(profileId, [entry, entry]), /DUPLICATE_JOURNAL/);
  assert.equal(store.list().length, 0);
  store.reconcile(profileId, [entry]);
  store.review(cmd.commandId, 'ABANDON', '回退后不重放未知操作');
  store.reconcile(profileId, [entry]);
  assert.equal(store.get(cmd.commandId)?.status, 'ABANDONED');
  store.close();
});
