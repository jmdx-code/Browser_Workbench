import { BusinessResolution } from '../../src/shared/settlement.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProfileActorRegistry } from '../../src/application/profile-actor-registry.js';
import { TaskCycleHost } from '../../src/application/task-cycle-host.js';
import { TaskStepRunner } from '../../src/application/task-step-runner.js';
import type { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import type { BrowseStepExecutor, StepExecution } from '../../src/domain/browse-execution.js';
import type { ManagedProfileSession } from '../../src/domain/profile-actor.js';
import type { RuntimeProfile } from '../../src/domain/tasks.js';
import type { ExecutionSession } from '../../src/shared/task-execution.js';
import type { KernelState, TabProof } from '../../src/shared/kernel-state.js';
import type { BrowseReading } from '../../src/shared/browse-execution.js';
import type { Combination } from '../../src/shared/contracts.js';
import type { ResourceRowValue } from '../../src/shared/resource-table.js';
import type { Timing } from '../../src/shared/task-timing.js';

export async function browseHarness(
  store: WorkspaceStore,
  count = 1,
  combination?: Combination,
  resourceRows?: ResourceRowValue[],
  timing?: Timing,
) {
  const clock = {
    at: 0,
    nowMilliseconds() {
      return this.at;
    },
  };
  const profiles: RuntimeProfile[] = [],
    sessions = new Map<string, ExecutionSession>(),
    proofs = new Map<string, TabProof>(),
    ports = new Map<string, ManagedProfileSession>(),
    journals = new Map<string, KernelState>();
  const inputs = new Map<string, number>(),
    reads = new Map<string, number>();
  const registry = new ProfileActorRegistry(
    () => profiles,
    store.tasks,
    store.tasks.settlements,
    store.taskControls,
    store.taskTabs,
    randomUUID,
  );
  for (let i = 0; i < count; i++) {
    const id = randomUUID(),
      accountId = 'browse-fixture-' + id,
      epoch = randomUUID();
    const context: ExecutionSession = {
      profileId: id,
      accountId,
      connectionEpoch: epoch,
      leaseId: randomUUID(),
      generation: 0,
    };
    const proof: TabProof = {
      ownershipId: randomUUID(),
      profileId: id,
      browserSessionEpoch: randomUUID(),
      tabId: i + 42,
      targetId: randomUUID(),
    };
    const profile: RuntimeProfile = {
      id,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: accountId, name: null, avatar: null },
    };
    profiles.push(profile);
    sessions.set(id, context);
    proofs.set(id, proof);
    const remote: KernelState = {
      version: 1,
      profileId: id,
      browserSessionEpoch: proof.browserSessionEpoch,
      tabs: [],
      operations: [],
    };
    journals.set(id, remote);
    const port: ManagedProfileSession = {
      profileId: id,
      profile: () => profile,
      current: () => sessions.get(id) ?? null,
      inventory: async () => structuredClone(remote),
      setFailureHandler: () => {},
      notify: async (binding, resolution) => {
        const record = remote.operations.find(
          (op) => op.binding.operationId === binding.operationId,
        );
        assert.ok(record);
        record.state = 'RECONCILED';
        record.resolution = BusinessResolution.parse(resolution);
        return { binding, resolution };
      },
      sendGuarded: async (operation, guard) => {
        await guard();
        store.taskTabs.assertForInput(operation.binding, proof);
        inputs.set(id, (inputs.get(id) ?? 0) + 1);
        remote.operations.push({
          binding: operation.binding,
          state: 'ACKNOWLEDGED',
          reason: 'mock-input',
          resolution: null,
        });
        return { binding: operation.binding, evidence: { inputReturned: true, fixtureOnly: true } };
      },
      stop: async (binding) => {
        sessions.delete(id);
        for (const op of remote.operations)
          if (['DISPATCHING', 'ACKNOWLEDGED'].includes(op.state)) op.state = 'UNKNOWN';
        return { ...binding, state: 'stopped' };
      },
    };
    ports.set(id, port);
    await registry.attach(port);
    await registry.observe(id);
  }
  const host = new TaskCycleHost(registry, store.taskTabs, {
    currentTaskTab: async (plan) => {
      const proof = proofs.get(plan.profileId);
      assert.ok(proof);
      return proof;
    },
  });
  const sample = (execution: StepExecution): BrowseReading => {
    const proof = proofs.get(execution.plan.profileId);
    assert.ok(proof);
    const base = {
      proof,
      documentEpoch: 0,
      routeEpoch: 0,
      contentId: 'mock-content-' + execution.step.id,
      visible: true,
      ready: true,
    };
    return execution.step.spec.type === 'video'
      ? {
          type: 'video',
          ...base,
          paused: false,
          buffering: false,
          timeSeconds: clock.at / 1000,
          playbackRate: 1,
        }
      : {
          type:
            execution.step.spec.type === 'marketplace'
              ? 'marketplace'
              : execution.step.spec.type === 'friends'
                ? 'friends'
                : 'feed',
          ...base,
        };
  };
  const executors: BrowseStepExecutor[] = (
    ['video', 'feed', 'marketplace', 'friends'] as const
  ).map((type) => ({
    type,
    available: () => true,
    decide: async (execution, guard) => {
      await guard();
      reads.set(execution.plan.profileId, (reads.get(execution.plan.profileId) ?? 0) + 1);
      return { kind: 'observe', observation: sample(execution) };
    },
    verify: async (_execution, operation, intent, guard) => {
      await guard();
      return {
        outcome: 'VERIFIED',
        receipt: {
          binding: operation.binding,
          evidence: { independentlyRead: true, fixtureOnly: true },
        },
        effect:
          intent.kind === 'like'
            ? { kind: 'liked', contentId: intent.contentId, observedLiked: true }
            : { kind: 'auxiliary', purpose: intent.purpose, observed: true },
      };
    },
  }));
  const saved = store.createCombination(
    combination ?? {
      name: '浏览循环隔离测试',
      note: '仅模拟页面，不是FB',
      steps: [
        { id: randomUUID(), type: 'video', durationMinutes: 1, maxLikes: 2, minLikeCount: 500 },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    },
  );
  if (resourceRows) store.resourceTables.save(saved.id, 0, resourceRows);
  const assigned = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: saved.id,
      version: saved.version,
      ...(resourceRows ? { expectedResourceRevision: 1 } : {}),
      profileIds: profiles.map((row) => row.id),
      ...(timing ? { timing } : {}),
    },
    profiles,
  );
  const runner = new TaskStepRunner(
    store.tasks,
    store.browseIntents,
    store.taskTabs,
    host,
    executors,
    clock,
    randomUUID,
  );
  const claim = async () => {
    const plan = store.tasks.claimNext(
      await host.schedulingProfiles(),
      new Set(['video', 'feed', 'marketplace', 'friends']),
    );
    assert.ok(plan);
    return plan;
  };
  return {
    store,
    clock,
    profiles,
    sessions,
    proofs,
    ports,
    journals,
    inputs,
    reads,
    registry,
    host,
    executors,
    runner,
    assigned,
    saved,
    sample,
    claim,
  };
}
