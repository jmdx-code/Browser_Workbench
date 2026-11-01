import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalBrowserLabels } from '../src/infrastructure/local-browser-labels.js';
import {
  ExtensionUpdates,
  extensionReloadTasksBusy,
} from '../src/infrastructure/extension-updates.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { Store } from '../src/bridge/store.js';
import { Core } from '../src/bridge/core.js';
import type { TaskRepository } from '../src/domain/tasks.js';
import type { SettlementRepository } from '../src/domain/settlement.js';
import type { Operation } from '../src/shared/task-contracts.js';

test('WO51: idle queued reload is permitted, active admission, operations and notices remain busy', async () => {
  const workspace = await WorkspaceStore.open(':memory:');
  const bridge = new Store(':memory:');
  const core = new Core(bridge);
  const profileId = randomUUID();
  const combo = workspace.createCombination({
    name: 'WO51',
    note: '',
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
    steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
  });
  workspace.tasks.assign(
    { requestId: randomUUID(), combinationId: combo.id, version: 1, profileIds: [profileId] },
    [
      {
        id: profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: false,
        account: { state: 'unknown', id: null, name: null, avatar: null },
      },
    ],
  );
  let opening = false,
    notices = false,
    operations = false,
    releases = 0;
  const tasks: Pick<TaskRepository, 'plansForProfile' | 'blockingOperations' | 'operations'> = {
    plansForProfile: (...args) => workspace.tasks.plansForProfile(...args),
    operations: () => (operations ? [{} as Operation] : []),
    blockingOperations: () => (operations ? [{} as Operation] : []),
  };
  const settlements: SettlementRepository = {
    ...workspace.tasks.settlements,
    list: () =>
      notices
        ? [{ state: 'PENDING' } as Awaited<ReturnType<SettlementRepository['list']>>[number]]
        : [],
    claim: () => null,
    delivered: () => {},
    retry: () => {},
    recoverOnStartup: () => {},
  };
  const sent: unknown[] = [];
  const peer = core.connect(
    profileId,
    (m) => sent.push(m),
    () => {},
  );
  const ready = () => {
    peer.phase = 'PAUSED';
    peer.synced = true;
    peer.extensionVersion = '0.3.72';
    peer.capabilities = ['browser-window-reveal-v1'];
  };
  ready();
  const manager = new ExtensionUpdates(
    core,
    '0.3.73',
    'fixture',
    async (id) =>
      opening ||
      core.hasPendingControlOrOperation(id) ||
      (await extensionReloadTasksBusy(tasks, settlements, id)),
    async () => {
      releases++;
    },
  );
  try {
    for (const kind of ['opening', 'operations', 'notices']) {
      opening = kind === 'opening';
      operations = kind === 'operations';
      notices = kind === 'notices';
      assert.equal((await manager.reload([profileId])).skippedBusy, 1);
      await manager.automatic(peer);
      assert.equal(sent.length, 0);
    }
    opening = operations = notices = false;
    assert.equal((await manager.reload([profileId])).reloaded, 1);
    assert.equal(releases, 1);
    ready();
    await manager.reload([profileId]); // manual clears the previous automatic-attempt marker
    ready();
    manager.autoReloadAttempted.clear();
    await manager.automatic(peer);
    assert.equal(releases, 3);
    assert.equal(sent.length, 3);
    ready();
    const owner = randomUUID();
    await core.claimFixtureKernel(peer, owner);
    assert.equal((await manager.reload([profileId])).skippedBusy, 1);
    core.releaseFixtureKernel(peer, owner);
    // An idle page connection can own Core's fixture kernel without executing a task.
    // Preserve the existing releaseIdle path, then apply Core's final ownership guard.
    await core.claimFixtureKernel(peer, owner);
    const idleManager = new ExtensionUpdates(
      core,
      '0.3.73',
      'fixture',
      async (id) =>
        core.hasPendingControlOrOperation(id) ||
        (await extensionReloadTasksBusy(tasks, settlements, id)),
      async () => core.releaseFixtureKernel(peer, owner),
    );
    assert.equal((await idleManager.reload([profileId])).reloaded, 1);
  } finally {
    await core.shutdown();
    bridge.close();
    await workspace.close();
  }
});

for (const mode of ['late-name', 'cross-pass-conflict', 'single-large-folder'] as const) {
  test(`WO51: 64MiB resumable labels ${mode}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wo51-labels-'));
    const id = randomUUID(),
      extension = 'a'.repeat(32);
    const info: Record<string, { name: string }> = {};
    try {
      for (let index = 0; index < 17; index++) {
        const folder = mode === 'single-large-folder' ? 'Profile 1' : `Profile ${index + 1}`;
        info[folder] = { name: mode === 'single-large-folder' ? 'large-folder' : `name-${index}` };
        const directory = path.join(root, folder, 'Local Extension Settings', extension);
        await mkdir(directory, { recursive: true });
        const bytes = Buffer.alloc(4 * 1024 * 1024, 32);
        if (index === 16 || (mode === 'cross-pass-conflict' && index === 0)) bytes.write(id);
        await writeFile(path.join(directory, `${String(index).padStart(4, '0')}.ldb`), bytes);
      }
      await writeFile(
        path.join(root, 'Local State'),
        JSON.stringify({ profile: { info_cache: info } }),
      );
      const labels = new LocalBrowserLabels([extension], [root], () => 0);
      await labels.refresh([id]);
      assert.equal(
        labels.name(id),
        undefined,
        'never publish a match before all folders are scanned',
      );
      await labels.refresh([id]);
      assert.equal(
        labels.name(id),
        mode === 'cross-pass-conflict'
          ? undefined
          : mode === 'single-large-folder'
            ? 'large-folder'
            : 'name-16',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
