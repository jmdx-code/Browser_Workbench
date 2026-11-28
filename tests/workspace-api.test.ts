import { WorkspaceBackupService } from '../src/application/workspace-backup-service.js';
import { FilesystemWorkspaceBackupWriter } from '../src/infrastructure/workspace-backup-writer.js';
import { FilesystemWorkspaceRestore } from '../src/infrastructure/workspace-restore.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBridgeServer } from '../src/bridge/server.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { TaskService } from '../src/application/task-service.js';
import {
  TaskOverview,
  TaskCapabilities,
  TaskRecords,
  TaskRuntimeOverview,
} from '../src/shared/task-contracts.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { GroupSchema, SavedCombinationSchema, WorkspaceSchema } from '../src/shared/contracts.js';
import { WorkspacePreferences } from '../src/shared/workspace-preferences.js';
import { WorkspaceMaintenance } from '../src/application/workspace-media-maintenance.js';
import { FilesystemRuntimeLog } from '../src/infrastructure/runtime-log.js';
import { MaintenanceOverview, RuntimeLogExport } from '../src/shared/runtime-log.js';
import { createServer } from 'node:net';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { ProfileInspections } from '../src/shared/profile-inspection.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import {
  ResourceSummaries,
  ResourceUsageSummaries,
  RESOURCE_SUMMARY_HEADER,
} from '../src/shared/resource-table.js';
test('real HTTP workspace preserves auth boundary, public schema, reorder and save lifecycle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workspace-http-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const repo = await WorkspaceStore.open(path.join(dir, 'workspace.sqlite'));
  // Also exercise legacy clients without the >50 capacity header.
  repo.tasks.setSettings({ maxConcurrentProfiles: 2 });
  let inspectCalls = 0;
  const inspection = new ProfileInspectionService(
    {
      connection: () => null,
      assertIdle: async () => {
        inspectCalls++;
      },
      read: async () => {
        throw Error('OFFLINE');
      },
    },
    Date.now,
  );
  const server = await startBridgeServer({
    root: process.cwd(),
    dataDir: dir,
    port,
    extensionIds: ['a'.repeat(32)],
    appRoutes: ({ core, store }) => {
      const backups = new WorkspaceBackupService(
        repo.tasks,
        new FilesystemWorkspaceBackupWriter(
          (file) => repo.backup(file),
          async (file) => store.backup(file),
          '0.1.40',
        ),
        new FilesystemWorkspaceRestore(dir),
      );
      return workspaceApi(
        new WorkspaceService(repo, new BridgeProfileSource(core, store, inspection)),
        new TaskService(repo.tasks, undefined, () => backups.assertIdle()),
        inspection,
        new ResourceTableService(repo.resourceTables),
        undefined,
        backups,
        undefined,
        undefined,
        undefined,
        new WorkspaceMaintenance(repo, new FilesystemRuntimeLog(path.join(dir, 'logs')), {
          logDirectory: path.join(dir, 'logs'),
          cacheDirectory: path.join(dir, 'cache'),
        }),
      );
    },
  });
  try {
    const profileIds = Array.from({ length: 29 }, () => randomUUID());
    for (const id of profileIds) await server.store.pair(id, 'private-test-secret', 'a'.repeat(32));
    assert.equal((await fetch(server.origin + '/api/workspace')).status, 401);
    const landing = await fetch(server.origin);
    const cookie = landing.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const preferenceUrl = server.origin + '/api/workspace/preferences';
    assert.equal((await fetch(preferenceUrl)).status, 401);
    const preferences = WorkspacePreferences.parse(
      await (await fetch(preferenceUrl, { headers: { cookie } })).json(),
    );
    const preferenceInput = {
      expectedRevision: preferences.revision,
      values: { defaultTimeZone: 'Asia/Taipei', desktopNotifications: 'failures' },
    };
    const savePreferences = () =>
      fetch(preferenceUrl, {
        method: 'POST',
        headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
        body: JSON.stringify(preferenceInput),
      });
    assert.equal((await savePreferences()).status, 200);
    assert.equal((await savePreferences()).status, 409);
    assert.equal(
      (
        await fetch(preferenceUrl, {
          method: 'POST',
          headers: {
            cookie,
            origin: 'https://foreign.invalid',
            'content-type': 'application/json',
          },
          body: JSON.stringify(preferenceInput),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(preferenceUrl, {
          method: 'POST',
          headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            ...preferenceInput,
            expectedRevision: 1,
            values: { ...preferenceInput.values, defaultTimeZone: 'invalid/zone' },
          }),
        })
      ).status,
      400,
    );
    assert.equal(repo.preferences().revision, 1);
    const maintenanceUrl = server.origin + '/api/workspace/maintenance';
    assert.equal((await fetch(maintenanceUrl)).status, 401);
    const maintenance = MaintenanceOverview.parse(
      await (await fetch(maintenanceUrl, { headers: { cookie } })).json(),
    );
    assert.equal(maintenance.settings.revision, 1);
    const saveMaintenance = (days: number, origin = server.origin) =>
      fetch(maintenanceUrl + '/settings', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, logRetentionDays: days }),
      });
    assert.equal((await saveMaintenance(7, 'https://foreign.invalid')).status, 403);
    assert.equal((await saveMaintenance(91)).status, 400);
    assert.equal((await saveMaintenance(7)).status, 200);
    assert.equal((await saveMaintenance(8)).status, 409);
    assert.equal(repo.preferences().defaultTimeZone, 'Asia/Taipei');
    assert.equal(repo.maintenanceSettings().logRetentionDays, 7);
    const logs = RuntimeLogExport.parse(
      await (await fetch(maintenanceUrl + '/logs', { headers: { cookie } })).json(),
    );
    assert.deepEqual(logs.records, []);
    const backupStatus = await fetch(server.origin + '/api/workspace/backups/status', {
      headers: { cookie },
    });
    assert.equal(backupStatus.status, 200);
    assert.equal((await backupStatus.json()).canCreate, true);
    const createdBackup = await fetch(server.origin + '/api/workspace/backups/create', {
      method: 'POST',
      headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ directory: dir }),
    });
    assert.equal(createdBackup.status, 200);
    const backupResult = await createdBackup.json();
    assert.equal(backupResult.files.length, 2);
    assert.equal(backupResult.includesSourceMedia, false);
    const summaryUrl = server.origin + '/api/workspace/resource-tables/summaries';
    assert.equal(
      (await fetch(summaryUrl, { headers: { [RESOURCE_SUMMARY_HEADER]: '2' } })).status,
      401,
    );
    const resourceCombination = repo.createCombination({
      name: '生成资源摘要HTTP测试',
      note: '',
      steps: [{ id: randomUUID(), type: 'feed', durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    });
    repo.resourceTables.save(resourceCombination.id, 0, [
      { id: randomUUID(), text: '生成正文', media: [], background: 'plain' },
    ]);
    const legacy = ResourceSummaries.parse(
      await (await fetch(summaryUrl, { headers: { cookie } })).json(),
    );
    assert.deepEqual(Object.keys(legacy[0]!).sort(), [
      'combinationId',
      'remaining',
      'revision',
      'verifiedReady',
    ]);
    const usageResponse = await fetch(summaryUrl, {
      headers: { cookie, [RESOURCE_SUMMARY_HEADER]: '2' },
    });
    assert.equal(usageResponse.headers.get('cache-control'), 'no-store');
    const usage = ResourceUsageSummaries.parse(await usageResponse.json());
    assert.equal(usage[0]?.remaining, 1);
    assert.equal(usage[0]?.published, 0);
    assert.equal(
      (await fetch(summaryUrl, { headers: { cookie, [RESOURCE_SUMMARY_HEADER]: '3' } })).status,
      409,
    );
    assert.equal((await fetch(server.origin + '/api/workspace/tasks')).status, 401);
    const overview = TaskOverview.parse(
      await (await fetch(server.origin + '/api/workspace/tasks', { headers: { cookie } })).json(),
    );
    assert.equal(overview.dispatchEnabled, false);
    assert.equal(overview.plans.length, 0);
    assert.equal(overview.settings.maxConcurrentProfiles, 2);
    assert.equal((await fetch(server.origin + '/api/state', { headers: { cookie } })).status, 404);
    assert.equal(
      (
        await fetch(server.origin + '/api/command', {
          method: 'POST',
          headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      404,
    );
    const post = (route: string, value: unknown, origin = server.origin) =>
      fetch(server.origin + '/api/workspace' + route, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    const capabilities = TaskCapabilities.parse(
      await (
        await fetch(server.origin + '/api/workspace/tasks/capabilities', { headers: { cookie } })
      ).json(),
    );
    assert.deepEqual(capabilities.types, []);
    const settingsSaved = await post('/tasks/settings', { maxConcurrentProfiles: 4 });
    assert.equal(settingsSaved.status, 200);
    assert.deepEqual(await settingsSaved.json(), { maxConcurrentProfiles: 4 });
    assert.equal(repo.tasks.settings().maxConcurrentProfiles, 4);
    for (const invalid of [
      { maxConcurrentProfiles: 0 },
      { maxConcurrentProfiles: 101 },
      { maxConcurrentProfiles: 2.5 },
      { maxConcurrentProfiles: 2, unknown: true },
    ]) {
      assert.equal((await post('/tasks/settings', invalid)).status, 400);
      assert.equal(repo.tasks.settings().maxConcurrentProfiles, 4);
    }
    assert.equal(
      (await post('/tasks/settings', { maxConcurrentProfiles: 1 }, 'https://example.com')).status,
      403,
    );
    assert.equal(repo.tasks.settings().maxConcurrentProfiles, 4);
    const capacitySaved = await post('/tasks/settings', { maxConcurrentProfiles: 100 });
    assert.equal(capacitySaved.status, 200);
    assert.equal(repo.tasks.settings().maxConcurrentProfiles, 100);
    const currentRuntime = await fetch(server.origin + '/api/workspace/tasks/runtime', {
      headers: { cookie, 'x-workbench-runtime-contract': '2' },
    });
    assert.equal(currentRuntime.status, 200);
    assert.equal(
      TaskRuntimeOverview.parse(await currentRuntime.json()).settings.maxConcurrentProfiles,
      100,
    );
    await post('/tasks/settings', { maxConcurrentProfiles: 4 });
    await post('/tasks/settings', { maxConcurrentProfiles: 2 });
    const taskRuntime = TaskRuntimeOverview.parse(
      await (
        await fetch(server.origin + '/api/workspace/tasks/runtime', {
          headers: { cookie, 'x-workbench-runtime-contract': '2' },
        })
      ).json(),
    );
    assert.deepEqual(taskRuntime.currentSteps, []);
    assert.equal(
      (await fetch(server.origin + '/api/workspace/tasks/runtime', { headers: { cookie } })).status,
      409,
    );
    const recordsUrl = server.origin + '/api/workspace/tasks/records';
    const recordResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(recordsUrl, {
          method: 'POST',
          headers: {
            cookie,
            origin: server.origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ limit: 50 }),
        }),
      ),
    );
    assert.ok(recordResponses.every((response) => response.status === 200));
    const pages = await Promise.all(
      recordResponses.map(async (response) => TaskRecords.parse(await response.json())),
    );
    assert.ok(pages.every((page) => JSON.stringify(page) === JSON.stringify(pages[0])));

    assert.equal(
      (
        await post('/tasks/start', {
          requestId: randomUUID(),
          combinationId: randomUUID(),
          version: 1,
          profileIds,
        })
      ).status,
      409,
    );
    assert.deepEqual(repo.tasks.list(), []);
    assert.equal(
      (
        await post('/tasks/command', {
          command: 'pause',
          plans: [
            {
              profileId: profileIds[0],
              planId: randomUUID(),
              expectedState: 'QUEUED',
              expectedUpdatedAt: 0,
            },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post('/tasks/command', {
          command: 'stop',
          plans: [
            {
              profileId: randomUUID(),
              planId: randomUUID(),
              expectedState: 'RUNNING',
              expectedUpdatedAt: 0,
            },
          ],
        })
      ).status,
      404,
    );
    assert.deepEqual(repo.tasks.list(), []);
    assert.equal((await post('/tasks/history', { profileId: profileIds[0] })).status, 404);
    assert.equal((await fetch(server.origin + '/api/workspace/profiles/inspection')).status, 401);
    assert.equal(
      (await post('/profiles/inspect', { profileIds, url: 'https://evil.test/' })).status,
      400,
    );
    assert.equal((await post('/profiles/inspect', { profileIds: [randomUUID()] })).status, 404);
    const checked = await post('/profiles/inspect', {
      profileIds: [profileIds[0], profileIds[1], profileIds[0]],
    });
    assert.equal(checked.status, 202);
    const legacyAccepted = await checked.json();
    assert.equal(Object.hasOwn(legacyAccepted.results[0], 'avatarObservation'), false);
    const accepted = ProfileInspections.parse(legacyAccepted);
    assert.equal(accepted.results.length, 2);
    assert.ok(accepted.results.every((row) => row.reason === 'PROFILE_OFFLINE'));
    assert.equal(inspectCalls, 0);
    const inspectionRows = ProfileInspections.parse(
      await (
        await fetch(server.origin + '/api/workspace/profiles/inspection', { headers: { cookie } })
      ).json(),
    );
    assert.equal(inspectionRows.results.length, 2);
    const displayResponse = await fetch(server.origin + '/api/workspace/profiles/inspection', {
      headers: { cookie, 'x-workbench-inspection-display': '1' },
    });
    const displayRows = await displayResponse.json();
    assert.equal(Object.hasOwn(displayRows.results[0], 'avatarObservation'), true);
    assert.equal(displayRows.results[0].avatarObservation, null);
    assert.equal(Object.hasOwn(displayRows.results[0], 'nameObservation'), false);
    const namesResponse = await fetch(server.origin + '/api/workspace/profiles/inspection', {
      headers: { cookie, 'x-workbench-inspection-display': '2' },
    });
    const namesRows = await namesResponse.json();
    assert.equal(Object.hasOwn(namesRows.results[0], 'nameObservation'), true);
    assert.equal(namesRows.results[0].nameObservation, null);
    assert.equal(inspectCalls, 0);
    const materialDirectory = path.join(dir, 'materials');
    await mkdir(materialDirectory);
    assert.equal(
      (await post('/groups/create', { name: 'A', color: 'blue' }, 'https://example.com')).status,
      403,
    );
    const group = GroupSchema.parse(
      await (await post('/groups/create', { name: '主力', color: 'green' })).json(),
    );
    assert.equal(
      (await post('/profiles/reorder', { orderedProfileIds: profileIds, groupId: group.id }))
        .status,
      200,
    );
    const created = SavedCombinationSchema.parse(
      await (
        await post('/combinations/create', {
          value: {
            name: '视频10',
            note: '',
            steps: [
              {
                id: randomUUID(),
                type: 'video',
                durationMinutes: 10,
                maxLikes: 2,
                minLikeCount: 500,
              },
            ],
            randomOrder: false,
            loop: { mode: 'finite', rounds: 1 },
          },
        })
      ).json(),
    );
    assert.equal(created.version, 1);
    const saved = SavedCombinationSchema.parse(
      await (
        await post('/combinations/save', {
          id: created.id,
          expectedRevision: created.revision,
          value: {
            name: '视频15',
            note: '',
            steps: [
              {
                id: randomUUID(),
                type: 'video',
                durationMinutes: 15,
                maxLikes: 2,
                minLikeCount: 500,
              },
            ],
            randomOrder: false,
            loop: { mode: 'finite', rounds: 1 },
          },
        })
      ).json(),
    );
    assert.equal(saved.version, 2);
    assert.equal(saved.draft, null);
    const response = await fetch(server.origin + '/api/workspace', { headers: { cookie } });
    const serialized = await response.text();
    const snapshot = WorkspaceSchema.parse(JSON.parse(serialized) as unknown);
    assert.equal(snapshot.profiles.length, 29);
    assert.ok(snapshot.profiles.every((profile) => profile.groupId === group.id));
    assert.ok(
      snapshot.profiles.every((profile) => profile.account.state === 'unknown' && !profile.online),
    );
    assert.equal(serialized.includes('private-test-secret'), false);
    assert.equal(snapshot.combinations[0]?.saved?.steps[0]?.type, 'video');
    assert.equal(snapshot.support.comboExecution, false);
    const inspected = await post('/backups/inspect-restore', { directory: backupResult.directory });
    assert.equal(inspected.status, 200);
    const restoreInspection = await inspected.json();
    assert.equal(restoreInspection.profiles, 29);
    assert.equal(restoreInspection.id, backupResult.id);
    assert.equal(
      (
        await post(
          '/backups/prepare-restore',
          { directory: backupResult.directory },
          'https://external.example',
        )
      ).status,
      403,
    );
    const prepared = await post('/backups/prepare-restore', { directory: backupResult.directory });
    assert.equal(prepared.status, 200);
    assert.equal((await prepared.json()).state, 'READY');
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/backups/restore-status', {
          headers: { cookie },
        })
      ).status,
      200,
    );
    assert.equal(repo.combinations().length, snapshot.combinations.length);
    const storyValue = {
      name: 'Friends story contract',
      note: '',
      steps: [
        {
          id: randomUUID(),
          type: 'post',
          destination: 'story',
          audience: 'friends',
          resourceMode: 'table',
          resourceDirectory: '',
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    };
    assert.equal(
      (
        await post('/combinations/create', {
          value: {
            ...storyValue,
            steps: [
              {
                ...storyValue.steps[0],
                resourceMode: 'directory',
                resourceDirectory: materialDirectory,
              },
            ],
          },
        })
      ).status,
      400,
    );
    const storyRequest = () =>
      fetch(server.origin + '/api/workspace/combinations/create', {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value: storyValue }),
      });
    assert.equal((await storyRequest()).status, 201);
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace', {
          headers: { cookie },
        })
      ).status,
      200,
    );
  } finally {
    await server.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
