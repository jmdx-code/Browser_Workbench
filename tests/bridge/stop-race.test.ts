import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Core, type Peer } from '../../src/bridge/core.js';
import { Store } from '../../src/bridge/store.js';
async function start(core: Core, p: Peer) {
  await core.sync(p);
  await core.synced(p, p.controlId!, []);
  await core.resume(p.profileId);
  await core.resumed(p, p.controlId!);
}

test('立即停止再恢复，停止之前的排队任务仍然取消', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  let count = 0;
  const p = core.connect(
    randomUUID(),
    (m) => {
      if ((m as any).type === 'COMMAND') count++;
    },
    () => {},
  );
  await start(core, p);
  const a = await core.submit({
    profileId: p.profileId,
    operationId: randomUUID(),
    action: { kind: 'observe', tabId: 1 },
  });
  const b = await core.submit({
    profileId: p.profileId,
    operationId: randomUUID(),
    action: { kind: 'observe', tabId: 1 },
  });
  await core.stop(p.profileId);
  await assert.rejects(async () => await core.resume(p.profileId), /CONTROL_CONFIRMATION_PENDING/);
  await core.stopped(p, p.controlId!);
  await core.resume(p.profileId);
  await core.resumed(p, p.controlId!);
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 0);
  assert.equal(store.get(a.commandId)!.status, 'CANCELLED');
  assert.equal(store.get(b.commandId)!.status, 'CANCELLED');
  await core.shutdown();
  store.close();
});
test('旧连接重复 close 不会取消重连后的任务', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const id = randomUUID();
  const old = core.connect(
    id,
    () => {},
    () => {},
  );
  await core.disconnect(old);
  const fresh = core.connect(
    id,
    () => {},
    () => {},
  );
  await start(core, fresh);
  const a = await core.submit({
    profileId: id,
    operationId: randomUUID(),
    action: { kind: 'observe', tabId: 1 },
  });
  await core.disconnect(old);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.get(a.commandId)!.status, 'DISPATCHING');
  await core.reply(fresh, { type: 'RESULT', commandId: a.commandId, status: 'VERIFIED' });
  await core.shutdown();
  store.close();
});
