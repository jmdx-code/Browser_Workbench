import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProfileActorRegistry } from '../src/application/profile-actor-registry.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { ManagedProfileSession } from '../src/domain/profile-actor.js';
import type { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { ReservationRequest } from '../src/shared/material-index.js';
import type { KernelState } from '../src/shared/kernel-state.js';
import { postFixture, postRequest, postAction, dispatchedPost } from './fixtures/material-post.js';

// Original registry/control/outbox/SQL; native inventory and STOP are simulated, no FB input.
async function controlOwner(
  store: WorkspaceStore,
  r: ReservationRequest,
  stop: () => Promise<void>,
) {
  const profile: RuntimeProfile = {
    id: r.context.profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: r.context.accountId, name: null, avatar: null },
  };
  const registry = new ProfileActorRegistry(
    () => [profile],
    store.tasks,
    store.tasks.settlements,
    store.taskControls,
    store.taskTabs,
    randomUUID,
  );
  const inventory: KernelState = {
    version: 1,
    profileId: profile.id,
    browserSessionEpoch: r.proof.browserSessionEpoch,
    tabs: [
      {
        ownershipId: r.proof.ownershipId,
        url: 'https://www.facebook.com/',
        state: 'READY',
        proof: r.proof,
        reason: 'fixture',
      },
    ],
    operations: [],
  };
  let current: ManagedProfileSession['current'] = () => r.context;
  const port: ManagedProfileSession = {
    profileId: profile.id,
    profile: () => profile,
    current: async () => await current(),
    inventory: async () => structuredClone(inventory),
    setFailureHandler: () => {},
    notify: async () => {
      throw Error('unexpected notification');
    },
    sendGuarded: async () => {
      throw Error('unexpected browser input');
    },
    stop: async (binding) => {
      await stop();
      current = () => null;
      inventory.tabs[0]!.state = 'CLOSED';
      if (
        !(await store.tasks.operations(r.jobId)).some((op) =>
          ['DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status),
        )
      ) {
        const tab = await store.taskTabs.get(r.proof.ownershipId);
        await store.taskTabs.confirmClosed(r.proof.ownershipId, tab.revision, inventory);
      }
      return { ...binding, state: 'stopped' };
    },
  };
  await registry.attach(port);
  return { registry, profile };
}

test('pause between material reservation and dispatch waits for original STOP then resumes original progress and reclaims unconsumed content', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog),
      plan = await store.tasks.get(r.jobId);
    await store.materials.reserve(r);
    const op = await store.materialPosts.prepare(await postAction(store, r, 'OPEN_COMPOSER'));
    let release!: () => void;
    const stopped = new Promise<void>((done) => {
      release = done;
    });
    const h = await controlOwner(store, r, () => stopped);
    const pausing = h.registry.control(r.jobId, 'pause');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await store.tasks.get(r.jobId)).state, 'PAUSING');
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
    assert.equal(
      (await store.tasks.operations(r.jobId)).find((value) => value.id === op.id)?.status,
      'CANCELLED',
    );
    await assert.rejects(async () => await store.tasks.resume(r.jobId), /先核对|不能继续/);
    release();
    assert.equal((await pausing).state, 'PAUSED');
    assert.equal((await store.tasks.get(r.jobId)).controlConfirmed, true);
    assert.equal((await store.taskTabs.get(r.proof.ownershipId)).state, 'CLOSED');
    assert.equal((await store.tasks.resume(r.jobId)).state, 'QUEUED');
    assert.equal((await store.tasks.claimNext([h.profile], new Set(['post'])))?.id, plan.id);
    const context = { ...r.context, leaseId: randomUUID(), generation: r.context.generation + 1 },
      proof = { ...r.proof, ownershipId: randomUUID(), tabId: 43, targetId: randomUUID() };
    await store.taskTabs.register(r.jobId, proof, context);
    const next = await store.materials.reserve({ ...r, attemptId: randomUUID(), context, proof });
    assert.equal(
      next.intent.fingerprint,
      (await store.materials.reservation(r.attemptId)).intent.fingerprint,
    );
    assert.equal(next.intent.ordinal, 1);
    assert.equal((await store.tasks.get(r.jobId)).version, plan.version);
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) n FROM material_publications').get()?.n, 0);
    } finally {
      db.close();
    }
  });
});

test('lost STOP receipt keeps original owner and account lock although local unsent material is cancelled', async () => {
  await postFixture(async (store, file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const h = await controlOwner(store, r, async () => {
      throw Error('STOP_REPLY_LOST');
    });
    await assert.rejects(h.registry.control(r.jobId, 'stop'), /STOP_REPLY_LOST/);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'NOT_PUBLISHED');
    assert.equal((await store.tasks.get(r.jobId)).state, 'STOPPING');
    assert.equal((await store.tasks.get(r.jobId)).controlConfirmed, false);
    assert.equal((await h.registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare('SELECT job_id FROM task_account_locks WHERE account_id=?')
          .get(r.context.accountId)?.job_id,
        r.jobId,
      );
    } finally {
      db.close();
    }
  });
});

test('unknown dispatched opener survives pause and confirmed STOP without automatic material verdict or consumption', async () => {
  await postFixture(async (store, _file, catalog) => {
    const r = await postRequest(store, catalog);
    await store.materials.reserve(r);
    const op = await dispatchedPost(store, r, 'OPEN_COMPOSER');
    await store.tasks.markBoundUnknown(op.binding, 'fixture unknown');
    const h = await controlOwner(store, r, async () => {});
    const result = await h.registry.control(r.jobId, 'pause');
    assert.equal(result.state, 'REVIEW');
    assert.equal(result.controlConfirmed, true);
    assert.equal(await store.materialPosts.result(r.attemptId), null);
    assert.equal((await store.materials.reservation(r.attemptId)).state, 'REVIEW');
    assert.equal((await store.tasks.operations(r.jobId))[0]?.status, 'UNKNOWN');
    assert.equal((await store.tasks.steps(r.jobId))[0]?.progress.published, 0);
    await assert.rejects(async () => await store.tasks.resume(r.jobId), /先核对|不能继续/);
  });
});
