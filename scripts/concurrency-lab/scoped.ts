import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { ProfileActorRegistry } from '../../src/application/profile-actor-registry.js';
import type { ManagedProfileSession } from '../../src/domain/profile-actor.js';
import type { RuntimeProfile } from '../../src/domain/tasks.js';
import type { ExecutionSession } from '../../src/shared/task-execution.js';

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return {
    samples: values.length,
    totalMs: values.reduce((a, b) => a + b, 0),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: at(1),
  };
}
export async function runScoped(config: {
  scratch: string;
  reportDir: string;
  scopeSource: string;
}) {
  const source = JSON.parse(await readFile(config.scopeSource, 'utf8'));
  assert.ok(path.basename(source.scratch).startsWith('workbench-concurrency-lab-'));
  assert.equal(await readFile(path.join(source.scratch, '.isolated-lab'), 'utf8'), source.id);
  const origin = path.join(source.scratch, 'e1-depth-100-h100-r0.sqlite');
  const copy = path.join(config.scratch, 'scoped-copy.sqlite');
  const original = new DatabaseSync(origin, { readOnly: true });
  try {
    await backup(original, copy);
  } finally {
    original.close();
  }
  const store = await WorkspaceStore.open(copy);
  const db: DatabaseSync = (store as any).db;
  const repo: any = store.tasks;
  const profiles = db
    .prepare('SELECT DISTINCT profile_id AS id FROM task_plans ORDER BY profile_id')
    .all()
    .map((row) => String(row.id));
  assert.equal(profiles.length, 100);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_plans').get()!.n, 10100);
  const indexesBefore = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='task_plans'")
    .all();
  const listSamples: number[] = [];
  const expected = new Map<string, string[]>();
  // Warm repository parsing once, then compare the exact same plan IDs/order in all paths.
  for (const plan of repo.list()) {
    const ids = expected.get(plan.profileId) ?? [];
    ids.push(plan.id);
    expected.set(plan.profileId, ids);
  }
  const batchId = String(db.prepare('SELECT batch_id FROM task_plans LIMIT 1').get()!.batch_id);
  const profileSQL = 'SELECT * FROM task_plans WHERE profile_id=? ORDER BY created_at,rowid';
  const batchSQL = 'SELECT 1 AS found FROM task_plans WHERE batch_id=? LIMIT 1';
  const explain = (sql: string, value: string) =>
    db.prepare('EXPLAIN QUERY PLAN ' + sql).all(value);
  const beforeExplain = {
    profile: explain(profileSQL, profiles[0]!),
    batch: explain(batchSQL, batchId),
  };
  for (let index = 0; index < profiles.length; index++) {
    const start = performance.now();
    const selected = repo.list().filter((plan: any) => plan.profileId === profiles[index]);
    listSamples.push(performance.now() - start);
    assert.deepEqual(
      selected.map((plan: any) => plan.id),
      expected.get(profiles[index]!),
    );
    if (index % 25 === 24) console.log(JSON.stringify({ fullReadsComplete: index + 1 }));
  }
  const measureProfile = () => {
    const samples: number[] = [];
    for (const profile of profiles) {
      const start = performance.now();
      const selected = store.tasks.plansForProfile(profile);
      samples.push(performance.now() - start);
      assert.deepEqual(
        selected.map((plan: any) => plan.id),
        expected.get(profile),
      );
    }
    return stats(samples);
  };
  const measureBatch = () => {
    const samples: number[] = [];
    for (let index = 0; index < 100; index++) {
      const value = index % 2 === 0 ? batchId : '00000000-0000-4000-8000-000000000000';
      const start = performance.now();
      const result = store.tasks.batchExists(value);
      samples.push(performance.now() - start);
      assert.equal(result, index % 2 === 0);
    }
    return stats(samples);
  };
  const profileBefore = measureProfile(),
    batchBefore = measureBatch();
  // Candidate indexes are applied ONLY to the generated copy, not production/migrations.
  db.exec(
    'CREATE INDEX lab_task_profile_order ON task_plans(profile_id,created_at); CREATE INDEX lab_task_batch ON task_plans(batch_id)',
  );
  const afterExplain = {
    profile: explain(profileSQL, profiles[0]!),
    batch: explain(batchSQL, batchId),
  };
  const profileAfter = measureProfile(),
    batchAfter = measureBatch();
  store.close();

  // Deep-history matrix (h4 / h20 / h100): pure scoped reads + 4-stage stop latency across 50 RUNNING profiles
  const depthMatrix: Record<string, unknown> = {};
  for (const [depth, r0File, r50File] of [
    [4, 'e1-forward-100-h4-r0.sqlite', 'e1-mixed-100-h4-r50.sqlite'],
    [20, 'e1-depth-100-h20-r0.sqlite', 'e1-mixed-100-h20-r50.sqlite'],
    [100, 'e1-depth-100-h100-r0.sqlite', 'e1-mixed-100-h100-r50.sqlite'],
  ] as const) {
    const stopCopy = path.join(config.scratch, `stop-h${depth}-r50.sqlite`);
    const srcDb = new DatabaseSync(path.join(source.scratch, r50File), { readOnly: true });
    try {
      await backup(srcDb, stopCopy);
    } finally {
      srcDb.close();
    }
    const stopStore = await WorkspaceStore.open(stopCopy);
    try {
      const stopDb: DatabaseSync = (stopStore as any).db;
      const profileRows = stopDb
        .prepare(
          'SELECT profile_id AS id, MAX(account_id) AS accountId FROM task_plans GROUP BY profile_id ORDER BY profile_id',
        )
        .all();
      const profileIds = profileRows.map((r) => String(r.id));
      const runtimeProfiles: RuntimeProfile[] = profileRows.map((row, idx) => ({
        id: String(row.id),
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: {
          state: 'logged-in',
          id: String(row.accountId ?? 'lab-only-' + idx),
          name: 'synthetic-' + idx,
          avatar: null,
        },
      }));

      // 1. Pure read comparison on h{depth}
      const legacyListSamples: number[] = [];
      const scopedProfileSamples: number[] = [];
      const scopedActivePlanSamples: number[] = [];
      for (const pid of profileIds) {
        const s0 = performance.now();
        const leg = stopStore.tasks.list().filter((p) => p.profileId === pid);
        legacyListSamples.push(performance.now() - s0);

        const s1 = performance.now();
        const scp = stopStore.tasks.plansForProfile(pid);
        scopedProfileSamples.push(performance.now() - s1);
        assert.deepEqual(
          scp.map((p) => p.id),
          leg.map((p) => p.id),
        );

        const s2 = performance.now();
        const act = stopStore.tasks.plansForProfile(pid, [
          'RUNNING',
          'PAUSING',
          'STOPPING',
          'REVIEW',
        ]);
        scopedActivePlanSamples.push(performance.now() - s2);
        assert.equal(act.length <= 1, true);
      }

      // 2. Full 4-stage stop benchmark across all 50 RUNNING plans
      const runningPlans = stopStore.tasks.livePlans().filter((p) => p.state === 'RUNNING');
      assert.equal(runningPlans.length, 50);

      const registry = new ProfileActorRegistry(
        () => runtimeProfiles,
        stopStore.tasks,
        stopStore.tasks.settlements,
        stopStore.taskControls,
        stopStore.taskTabs,
        randomUUID,
      );

      const stage1Samples: number[] = [];
      const stage2Samples: number[] = [];
      const stage3Samples: number[] = [];
      const stage4Samples: number[] = [];
      const totalStopSamples: number[] = [];

      const origRequestControl = stopStore.tasks.requestControl.bind(stopStore.tasks);
      const origConfirm = stopStore.taskControls.confirm.bind(stopStore.taskControls);
      const stageMarks = new Map<
        string,
        { t0: number; t1: number; t2: number; t3: number; t4: number }
      >();

      stopStore.tasks.requestControl = (id, mode, reason) => {
        const res = origRequestControl(id, mode, reason);
        const mark = stageMarks.get(id);
        if (mark) mark.t1 = performance.now();
        return res;
      };
      stopStore.taskControls.confirm = (binding, receipt) => {
        const res = origConfirm(binding, receipt);
        const mark = stageMarks.get(binding.jobId);
        if (mark) mark.t3 = performance.now();
        return res;
      };

      for (const [idx, plan] of runningPlans.entries()) {
        const context: ExecutionSession = {
          profileId: plan.profileId,
          accountId: String(plan.accountId),
          connectionEpoch: randomUUID(),
          leaseId: randomUUID(),
          generation: 0,
        };
        const proof = {
          profileId: plan.profileId,
          ownershipId: randomUUID(),
          browserSessionEpoch: randomUUID(),
          tabId: 1000 + idx,
          targetId: randomUUID(),
        };
        stopStore.taskTabs.register(plan.id, proof, context);
        let liveContext: ExecutionSession | null = context;
        const port: ManagedProfileSession = {
          profileId: plan.profileId,
          profile: () => runtimeProfiles.find((p) => p.id === plan.profileId)!,
          current: () => liveContext,
          inventory: async () => ({
            version: 1,
            profileId: plan.profileId,
            browserSessionEpoch: proof.browserSessionEpoch,
            operations: [],
            workspaceMain: proof,
            tabs: [
              {
                ownershipId: proof.ownershipId,
                proof,
                state: 'READY',
                url: 'https://www.facebook.com/',
                reason: '',
              },
            ],
          }),
          notify: async (b, r) => ({ binding: b, resolution: r }),
          setFailureHandler: () => {},
          sendGuarded: async () => {
            throw Error('LAB_NO_SEND');
          },
          stop: async (binding) => {
            const mark = stageMarks.get(plan.id);
            if (mark) mark.t2 = performance.now();
            liveContext = null;
            return { ...binding, state: 'stopped' };
          },
        };
        registry.attach(port);
      }

      const wallStart = performance.now();
      for (const plan of runningPlans) {
        const mark = { t0: performance.now(), t1: 0, t2: 0, t3: 0, t4: 0 };
        stageMarks.set(plan.id, mark);
        const stopped = await registry.control(plan.id, 'stop', 'LAB_STOP');
        mark.t4 = performance.now();
        assert.equal(stopped.state, 'STOPPED');
        assert.equal(stopped.controlConfirmed, true);
        stage1Samples.push(mark.t1 - mark.t0);
        stage2Samples.push(mark.t2 - mark.t1);
        stage3Samples.push(mark.t3 - mark.t2);
        stage4Samples.push(mark.t4 - mark.t3);
        totalStopSamples.push(mark.t4 - mark.t0);
      }
      const wallClock50ProfilesMs = performance.now() - wallStart;
      assert.equal(stopDb.prepare('SELECT count(*) AS n FROM task_account_locks').get()!.n, 0);

      depthMatrix[`h${depth}`] = {
        historyPerProfile: depth,
        totalPlans: 100 * (depth + 1),
        pureReads100Profiles: {
          legacyListFilter: stats(legacyListSamples),
          scopedPlansForProfile: stats(scopedProfileSamples),
          scopedActivePlan: stats(scopedActivePlanSamples),
        },
        stopFourStage50RunningProfiles: {
          wallClock50ProfilesMs,
          stage1RequestEntry: stats(stage1Samples),
          stage2ActorRevocationAndTabRecheck: stats(stage2Samples),
          stage3NativeStopAndConfirm: stats(stage3Samples),
          stage4FinalRelease: stats(stage4Samples),
          endToEndPerProfile: stats(totalStopSamples),
        },
      };
      console.log(JSON.stringify({ phaseADepthComplete: depth, wallClock50ProfilesMs }));
    } finally {
      stopStore.close();
    }
  }

  const result = {
    experiment: 'E1-SCOPED',
    versions: process.versions,
    sourceConfig: config.scopeSource,
    source: origin,
    generatedCopy: copy,
    plans: 10100,
    profiles: 100,
    indexesBefore,
    beforeExplain,
    afterExplain,
    allPlanIdsAndOrderMatched: true,
    fullRead100: stats(listSamples),
    profileBefore,
    profileAfter,
    batchBefore,
    batchAfter,
    depthMatrix,
    limitations: [
      'generated database copies in scratch; no real browser or extension IPC transport delay',
      '4-stage stop uses real SqliteTaskRepository + SqliteTaskControlRepository + SqliteTaskTabRepository + ProfileActorRegistry with in-memory mock ManagedProfileSession',
    ],
  };
  await writeFile(
    path.join(config.reportDir, 'scoped-summary.json'),
    JSON.stringify(result, null, 2),
  );
  return result;
}
