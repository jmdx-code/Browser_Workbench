import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Step } from '../../src/shared/contracts.js';
import type { Timing } from '../../src/shared/task-timing.js';
import type { RuntimeProfile } from '../../src/domain/tasks.js';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';

export async function workspaceFixture<T>(
  run: (store: WorkspaceStore, file: string, dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-test-'));
  const file = path.join(dir, 'workspace.sqlite');
  const store = await WorkspaceStore.open(file);
  try {
    return await run(store, file, dir);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export function makeRuntimeProfiles(count = 1, sharedAccount = false): RuntimeProfile[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: randomUUID(),
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: {
      state: 'logged-in',
      id: sharedAccount ? '10000000000001' : `1000000000${String(idx + 1).padStart(4, '0')}`,
      name: `Account ${idx + 1}`,
      avatar: null,
    },
  }));
}

export function assignSamplePlan(
  store: WorkspaceStore,
  options?: {
    steps?: Step[];
    profile?: RuntimeProfile;
    timing?: Timing;
    expectedResourceRevision?: number;
    closeBrowserOnFinish?: boolean;
  },
) {
  const profile = options?.profile ?? makeRuntimeProfiles(1)[0]!;
  const steps = options?.steps ?? [
    {
      id: randomUUID(),
      type: 'feed' as const,
      durationMinutes: 5,
      maxLikes: 2,
      minLikeCount: 0,
    },
  ];
  const combo = store.createCombination({
    name: 'Test Combo',
    note: '',
    steps,
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  const [plan] = store.tasks.assign(
    {
      requestId: randomUUID(),
      combinationId: combo.id,
      version: combo.version,
      profileIds: [profile.id],
      ...(options?.timing ? { timing: options.timing } : {}),
      ...(options?.expectedResourceRevision !== undefined
        ? { expectedResourceRevision: options.expectedResourceRevision }
        : {}),
      ...(options?.closeBrowserOnFinish !== undefined
        ? { closeBrowserOnFinish: options.closeBrowserOnFinish }
        : {}),
    },
    [profile],
  );
  if (!plan) throw Error('EXPECTED_ASSIGNED_PLAN');
  return { combo, plan, profile };
}
