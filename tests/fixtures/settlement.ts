import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import type { RuntimeProfile } from '../../src/domain/tasks.js';
import type { Action } from '../../src/shared/browser-actions.js';
import type { Plan } from '../../src/shared/task-contracts.js';
import type { ExecutionSession } from '../../src/shared/task-execution.js';
export async function settlementFixture(
  work: (store: WorkspaceStore, file: string) => void | Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workbench-settlement-')),
    file = path.join(dir, 'workspace.sqlite'),
    store = await WorkspaceStore.open(file);
  try {
    await work(store, file);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
export function prepareBound(
  store: WorkspaceStore,
  maxLikes = 1,
  action?: Action,
  beforeDispatch?: (plan: Plan, context: ExecutionSession) => void,
) {
  const profileId = randomUUID(),
    accountId = 'fixture-' + profileId;
  const profile: RuntimeProfile = {
    id: profileId,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: accountId, name: null, avatar: null },
  };
  const saved = store.createCombination({
    name: '结算通知隔离测试',
    note: '不是FB',
    steps: [{ id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  store.tasks.assign(
    { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [profileId] },
    [profile],
  );
  const plan = store.tasks.claimNext([profile], new Set(['video']));
  assert.ok(plan);
  const step = store.tasks.steps(plan.id)[0];
  assert.ok(step);
  const context = {
    profileId,
    accountId,
    connectionEpoch: randomUUID(),
    leaseId: randomUUID(),
    generation: 0,
  };
  beforeDispatch?.(plan, context);
  store.tasks.prepareOperation(
    plan.id,
    step.id,
    randomUUID(),
    action ?? {
      kind: 'click',
      tabId: 42,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '#counter' },
    },
  );
  const op = store.tasks.takeBoundOperation(context);
  assert.ok(op?.binding);
  const receipt = { binding: op.binding, evidence: { counter: 1 } };
  return { plan, step, binding: op.binding, receipt, profile };
}
export function verifyBound(store: WorkspaceStore, fixture: ReturnType<typeof prepareBound>) {
  store.tasks.acknowledgeBound(fixture.receipt);
  store.tasks.settleBound(fixture.receipt, 'VERIFIED', {
    ...fixture.step.progress,
    revision: 1,
    likes: 1,
  });
}
