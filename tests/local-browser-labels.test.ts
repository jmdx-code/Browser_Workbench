import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalBrowserLabels } from '../src/infrastructure/local-browser-labels.js';
import { Store } from '../src/bridge/store.js';
import { Core } from '../src/bridge/core.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';

test('window count and disconnect update public presence without losing profile identity', async () => {
  const store = new Store(':memory:');
  const core = new Core(store);
  const id = randomUUID();
  store.pair(id, 'generated-secret', 'a'.repeat(32));
  const peer = core.connect(
    id,
    () => {},
    () => {},
  );
  peer.synced = true;
  peer.phase = 'PAUSED';
  const source = new BridgeProfileSource(core, store, new WatchTasks(core), undefined, {
    name: () => '004',
  });
  try {
    assert.equal((await source.profiles())[0]?.online, true);
    assert.equal((await source.profiles())[0]?.browserName, '004');
    peer.browserWindowCount = 0;
    assert.equal((await source.profiles())[0]?.online, false);
    assert.equal((await source.profiles())[0]?.phase, 'OFFLINE');
    peer.browserWindowCount = 1;
    assert.equal((await source.profiles())[0]?.online, true);
    await core.disconnect(peer);
    assert.equal((await source.profiles())[0]?.online, false);
    assert.equal((await source.profiles())[0]?.browserName, '004');
  } finally {
    await core.shutdown();
    store.close();
  }
});

test('local profile labels follow browser rename; ambiguous copies are never guessed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-labels-'));
  const id = randomUUID(),
    extension = 'a'.repeat(32);
  let now = 0;
  const labels = new LocalBrowserLabels([extension], [root], () => now);
  async function profile(folder: string, name: string) {
    const storage = path.join(root, folder, 'Local Extension Settings', extension);
    await mkdir(storage, { recursive: true });
    await writeFile(path.join(storage, '000001.log'), 'profileId:' + id);
    await writeFile(
      path.join(root, 'Local State'),
      JSON.stringify({ profile: { info_cache: { [folder]: { name } } } }),
    );
  }
  try {
    await profile('Profile 2', '004');
    await labels.refresh([id]);
    assert.equal(labels.name(id), '004');
    await profile('Profile 2', '新名称');
    now += 15001;
    await labels.refresh([id]);
    assert.equal(labels.name(id), '新名称');
    await profile('Profile 3', '副本');
    await writeFile(
      path.join(root, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { 'Profile 2': { name: '新名称' }, 'Profile 3': { name: '副本' } } },
      }),
    );
    now += 15001;
    await labels.refresh([id]);
    assert.equal(labels.name(id), undefined);
    assert.equal(labels.name(randomUUID()), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
