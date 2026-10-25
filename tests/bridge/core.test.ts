import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/bridge/store.js';
import { Core, type Peer } from '../../src/bridge/core.js';
test('fresh and existing journals index current profile status without changing the data contract', () => {
  const store = new Store(':memory:');
  try {
    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM operations WHERE profileId=? AND status IN (?,?)')
      .all(randomUUID(), 'UNKNOWN', 'ACKNOWLEDGED');
    assert.ok(plan.some((row) => String(row.detail).includes('operations_profile_status')));
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(store.unresolved(randomUUID()), []);
  } finally {
    store.close();
  }
});
async function start(c: Core, p: Peer) {
  await c.sync(p);
  await c.synced(p, p.controlId!, []);
  await c.resume(p.profileId);
  await c.resumed(p, p.controlId!);
}
import { Intent, Action, type Command } from '../../src/bridge/protocol.js';
const tick = () => new Promise((r) => setImmediate(r));
function setup(timeout = 500) {
  const s = new Store(':memory:');
  const c = new Core(s, timeout);
  return {
    s,
    c,
    async close() {
      await c.shutdown();
      s.close();
    },
  };
}
function writeIntent(profileId: string) {
  return { profileId, operationId: randomUUID(), action: { kind: 'createTab' as const } };
}
function intent(profileId: string, operationId = randomUUID()) {
  return { profileId, operationId, action: { kind: 'observe' as const, tabId: 1 } };
}

test('a parent stop cannot turn an unsynchronized peer into ready or accept its earlier SYNC reply', async () => {
  const { c, close } = setup();
  try {
    const peer = c.connect(
      randomUUID(),
      () => {},
      () => {},
    );
    await c.sync(peer);
    const oldSync = peer.controlId!;
    await c.stop(peer.profileId);
    const stop = peer.controlId!;
    assert.equal(await c.synced(peer, oldSync, []), false);
    assert.equal(await c.stopped(peer, stop), true);
    assert.equal(peer.synced, false);
    assert.equal(peer.phase, 'RECOVERING');
    await assert.rejects(async () => await c.resume(peer.profileId), /RECONCILIATION_REQUIRED/);
    await c.sync(peer);
    const freshSync = peer.controlId!;
    assert.notEqual(freshSync, oldSync);
    assert.notEqual(freshSync, stop);
    assert.equal(await c.stopped(peer, stop), false);
    assert.equal(await c.synced(peer, freshSync, []), true);
    assert.equal(peer.phase, 'PAUSED');
    assert.equal(peer.paused, true);
  } finally {
    await close();
  }
});
test('未知字段与未授权动作被 schema 拒绝', () => {
  assert.throws(() => Action.parse({ kind: 'rawCdp', method: 'Runtime.evaluate' }));
  assert.throws(() => Intent.parse({ ...intent(randomUUID()), secret: 'injected' }));
});

test('旧插件不派发未声明的新能力；能力声明后正常派发', async () => {
  const { s, c, close } = setup();
  const sent: Command[] = [];
  const p = c.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND') sent.push(m as Command);
    },
    () => {},
  );
  await start(c, p);
  const activation = {
    profileId: p.profileId,
    operationId: randomUUID(),
    action: { kind: 'activateTab' as const, tabId: 1 },
  };
  const surface = {
    profileId: p.profileId,
    operationId: randomUUID(),
    action: {
      kind: 'mediaClick' as const,
      tabId: 1,
      documentEpoch: 0,
      routeEpoch: 0,
      mediaIndex: 0,
      mediaNodeId: 1,
      mediaSource: '',
      surface: { containerCSS: '.player', hitCSS: '.surface' },
    },
  };
  try {
    await assert.rejects(async () => await c.submit(activation), /EXTENSION_CAPABILITY_REQUIRED/);
    await assert.rejects(async () => await c.submit(surface), /EXTENSION_CAPABILITY_REQUIRED/);
    assert.equal(s.list().length, 0);
    p.capabilities = ['task-activation', 'media-surface-input'];
    const row = await c.submit(activation);
    await tick();
    assert.equal(sent.length, 1);
    await c.reply(p, { type: 'RESULT', commandId: row.commandId, status: 'VERIFIED' });
  } finally {
    await close();
  }
});
test('同一资料严格串行，不同资料独立派发', async () => {
  const { s, c, close } = setup();
  const sent: Command[] = [];
  const a = c.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND') sent.push(m as Command);
    },
    () => {},
  );
  const b = c.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND') sent.push(m as Command);
    },
    () => {},
  );
  await start(c, a);
  await start(c, b);
  const x = await c.submit(intent(a.profileId)),
    y = await c.submit(intent(a.profileId)),
    z = await c.submit(intent(b.profileId));
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(s.get(y.commandId)!.status, 'PREPARED');
  await c.reply(a, { type: 'RESULT', commandId: x.commandId, status: 'VERIFIED' });
  await tick();
  assert.equal(sent.length, 3);
  await c.reply(a, { type: 'RESULT', commandId: y.commandId, status: 'VERIFIED' });
  await c.reply(b, { type: 'RESULT', commandId: z.commandId, status: 'VERIFIED' });
  await close();
});
test('派发前 SQLite 已是 DISPATCHING', async () => {
  const { s, c, close } = setup();
  const p = c.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND')
        assert.equal(s.get((m as Command).commandId)!.status, 'DISPATCHING');
    },
    () => {},
  );
  await start(c, p);
  await c.submit(intent(p.profileId));
  await tick();
  await close();
});
test('operationId 重复不再派发，参数冲突被拒绝', async () => {
  const { c, close } = setup();
  let count = 0;
  const p = c.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND') count++;
    },
    () => {},
  );
  await start(c, p);
  const i = intent(p.profileId);
  const x = await c.submit(i);
  await c.submit(i);
  await assert.rejects(async () => await c.submit({ ...i, action: { kind: 'observe', tabId: 2 } }));
  await tick();
  assert.equal(count, 1);
  await c.reply(p, { type: 'RESULT', commandId: x.commandId, status: 'VERIFIED' });
  await c.submit(i);
  await tick();
  assert.equal(count, 1);
  await close();
});
test('断线把在途动作设 UNKNOWN，排队动作取消', async () => {
  const { s, c, close } = setup();
  const p = c.connect(
    randomUUID(),
    () => {},
    () => {},
  );
  await start(c, p);
  const x = await c.submit(writeIntent(p.profileId)),
    y = await c.submit(writeIntent(p.profileId));
  await tick();
  await c.disconnect(p);
  await tick();
  assert.equal(s.get(x.commandId)!.status, 'UNKNOWN');
  assert.equal(s.get(y.commandId)!.status, 'CANCELLED');
  assert.equal(p.paused, true);
  await close();
});
test('缺失回执使资料暂停，后续队列不执行', async () => {
  const { s, c, close } = setup(15);
  let count = 0;
  const p = c.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND') count++;
    },
    () => {},
  );
  await start(c, p);
  const x = await c.submit(writeIntent(p.profileId)),
    y = await c.submit(writeIntent(p.profileId));
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(s.get(x.commandId)!.status, 'UNKNOWN');
  assert.equal(s.get(y.commandId)!.status, 'CANCELLED');
  assert.equal(count, 1);
  assert.equal(p.paused, true);
  await close();
});
test('停止不将已派发动作误标取消，排队动作不执行', async () => {
  const { s, c, close } = setup();
  const p = c.connect(
    randomUUID(),
    () => {},
    () => {},
  );
  await start(c, p);
  const x = await c.submit(writeIntent(p.profileId)),
    y = await c.submit(writeIntent(p.profileId));
  await tick();
  await c.stop(p.profileId);
  await tick();
  assert.equal(s.get(x.commandId)!.status, 'UNKNOWN');
  assert.equal(s.get(y.commandId)!.status, 'CANCELLED');
  await assert.rejects(async () => await c.submit(writeIntent(p.profileId)));
  await close();
});
test('克隆资料的第二个在线连接被拒绝', async () => {
  const { c, close } = setup();
  const id = randomUUID();
  c.connect(
    id,
    () => {},
    () => {},
  );
  assert.throws(() =>
    c.connect(
      id,
      () => {},
      () => {},
    ),
  );
  await close();
});
test('重连默认暂停，旧连接回执不能结算新操作', async () => {
  const { s, c, close } = setup();
  const id = randomUUID();
  const old = c.connect(
    id,
    () => {},
    () => {},
  );
  await start(c, old);
  const x = await c.submit(writeIntent(id));
  await tick();
  await c.disconnect(old);
  const fresh = c.connect(
    id,
    () => {},
    () => {},
  );
  assert.notEqual(old.epoch, fresh.epoch);
  assert.equal(fresh.paused, true);
  assert.equal(
    await c.reply(old, { type: 'RESULT', commandId: x.commandId, status: 'VERIFIED' }),
    false,
  );
  assert.equal(s.get(x.commandId)!.status, 'UNKNOWN');
  await close();
});
test('输入派发 ACKNOWLEDGED 不被当成 VERIFIED', async () => {
  const { s, c, close } = setup();
  const p = c.connect(
    randomUUID(),
    () => {},
    () => {},
  );
  await start(c, p);
  const x = await c.submit(writeIntent(p.profileId));
  await tick();
  await c.reply(p, {
    type: 'RESULT',
    commandId: x.commandId,
    status: 'ACKNOWLEDGED',
    evidence: { inputDispatched: true },
  });
  assert.equal(s.get(x.commandId)!.status, 'ACKNOWLEDGED');
  await close();
});
test('重启恢复在途和 ACK 为 UNKNOWN，未派发队列取消', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chrome-new-'));
  const file = path.join(dir, 'db.sqlite');
  let s = new Store(file);
  const profileId = randomUUID();
  const a = s.prepare(intent(profileId)).row,
    b = s.prepare(intent(profileId)).row,
    d = s.prepare(intent(profileId)).row;
  s.set(a.commandId, 'DISPATCHING');
  s.set(b.commandId, 'ACKNOWLEDGED');
  s.close();
  s = new Store(file);
  assert.equal(s.get(a.commandId)!.status, 'UNKNOWN');
  assert.equal(s.get(b.commandId)!.status, 'UNKNOWN');
  assert.equal(s.get(d.commandId)!.status, 'CANCELLED');
  s.close();
  rmSync(dir, { recursive: true });
});
test('一致性备份包含提交记录，恢复后不盲目重派', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chrome-backup-'));
  const s = new Store(path.join(dir, 'db.sqlite'));
  const row = s.prepare(intent(randomUUID())).row;
  s.set(row.commandId, 'ACKNOWLEDGED');
  await s.backup(path.join(dir, 'snapshot.sqlite'));
  const restored = new Store(path.join(dir, 'snapshot.sqlite'));
  assert.equal(restored.get(row.commandId)!.status, 'UNKNOWN');
  s.close();
  restored.close();
  rmSync(dir, { recursive: true });
});
