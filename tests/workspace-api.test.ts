import { WorkspaceBackupService } from '../src/application/workspace-backup-service.js';
import { FilesystemWorkspaceBackupWriter } from '../src/infrastructure/workspace-backup-writer.js';
import { FilesystemWorkspaceRestore } from '../src/infrastructure/workspace-restore.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startBridgeServer } from '../src/bridge/server.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import { WorkspaceService } from '../src/application/workspace-service.js';
import { TaskService } from '../src/application/task-service.js';
import {
  TaskFeatureOverview,
  TaskFeatureOverviewV2,
  FEATURE_CONTRACT_HEADER,
} from '../src/shared/task-features.js';
import {
  TaskOverview,
  TaskHistory,
  TaskCapabilities,
  TaskRuntimeOverview,
} from '../src/shared/task-contracts.js';
import { BridgeProfileSource } from '../src/infrastructure/browser-source.js';
import { workspaceApi } from '../src/http/workspace-api.js';
import { GroupSchema, SavedCombinationSchema, WorkspaceSchema } from '../src/shared/contracts.js';
import { WorkspacePreferences } from '../src/shared/workspace-preferences.js';
import { WorkspaceMaintenance } from '../src/application/workspace-maintenance.js';
import { FilesystemRuntimeLog } from '../src/infrastructure/runtime-log.js';
import { MaintenanceOverview, RuntimeLogExport } from '../src/shared/runtime-log.js';
import { createServer } from 'node:net';
import { MaterialPreflightService } from '../src/application/material-preflight.js';
import { MaterialArrangement } from '../src/shared/material-arrangement.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialMediaReader } from '../src/infrastructure/material-media-reader.js';
import { FilesystemMaterialSnapshotVerifier } from '../src/infrastructure/material-source-verifier.js';
import {
  MaterialPreflightReport,
  MaterialPreviewScan,
  MaterialPackagePreview,
  MaterialPublishingReview,
} from '../src/shared/materials.js';
import { ProfileInspectionService } from '../src/application/profile-inspection.js';
import { ProfileInspections } from '../src/shared/profile-inspection.js';
import { ResourceTableService } from '../src/application/resource-table-service.js';
import { ArchiveManagementService } from '../src/application/archive-management.js';
import {
  ResourceSummaries,
  ResourceUsageSummaries,
  RESOURCE_SUMMARY_HEADER,
} from '../src/shared/resource-table.js';
test('real HTTP workspace preserves auth boundary, public schema, bulk move and draft lifecycle', async () => {
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
  const scanner = new FilesystemMaterialScanner();
  let materialScans = 0;
  const materials = new MaterialPreflightService(
    {
      scan: async (directory) => {
        materialScans++;
        return scanner.scan(directory);
      },
    },
    () => new Date().toISOString(),
    new FilesystemMaterialMediaReader(),
    new FilesystemMaterialSnapshotVerifier(),
  );
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
    appRoutes: ({ core, store, tasks }) => {
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
        new WorkspaceService(repo, new BridgeProfileSource(core, store, tasks, inspection)),
        new TaskService(repo.tasks, undefined, () => backups.assertIdle()),
        materials,
        inspection,
        new ResourceTableService(repo.resourceTables),
        new ArchiveManagementService(repo.archivePreparation, () => undefined),
        undefined,
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
    const resourceCombination = repo.createDraft({
      name: '生成资源摘要HTTP测试',
      note: '',
      steps: [],
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
    assert.equal((await post('/tasks/settings', { maxConcurrentProfiles: 100 })).status, 409);
    assert.equal(repo.tasks.settings().maxConcurrentProfiles, 4);
    const capacityHeaders = {
      cookie,
      origin: server.origin,
      'content-type': 'application/json',
      'x-workbench-task-capacity': '2',
    };
    const capacitySaved = await fetch(server.origin + '/api/workspace/tasks/settings', {
      method: 'POST',
      headers: capacityHeaders,
      body: JSON.stringify({ maxConcurrentProfiles: 100 }),
    });
    assert.equal(capacitySaved.status, 200);
    assert.equal(repo.tasks.settings().maxConcurrentProfiles, 100);
    const runtimeHeaders = {
      cookie,
      'x-workbench-task-contract': '4',
      'x-workbench-runtime-contract': '2',
    };
    assert.equal(
      (await fetch(server.origin + '/api/workspace/tasks/runtime', { headers: runtimeHeaders }))
        .status,
      409,
    );
    const currentRuntime = await fetch(server.origin + '/api/workspace/tasks/runtime', {
      headers: { ...runtimeHeaders, 'x-workbench-task-capacity': '2' },
    });
    assert.equal(currentRuntime.status, 200);
    assert.equal(
      TaskRuntimeOverview.parse(await currentRuntime.json()).settings.maxConcurrentProfiles,
      100,
    );
    await post('/tasks/settings', { maxConcurrentProfiles: 4 });
    const featureResponse = await fetch(server.origin + '/api/workspace/tasks/features', {
      headers: { cookie },
    });
    assert.equal(featureResponse.status, 200);
    const featureState = (await featureResponse.json()) as {
      controllerAvailable: boolean;
      features: { id: string; status: string }[];
    };
    assert.equal(featureState.controllerAvailable, false);
    assert.equal(featureState.features.length, 5);
    TaskFeatureOverview.parse(featureState);
    const featureV2 = await fetch(server.origin + '/api/workspace/tasks/features', {
      headers: { cookie, [FEATURE_CONTRACT_HEADER]: '2' },
    });
    assert.equal(featureV2.status, 200);
    const detailed = TaskFeatureOverviewV2.parse(await featureV2.json());
    assert.ok(
      detailed.features.every((feature) => !feature.enabled && feature.verification === 'pending'),
    );
    assert.equal(
      featureState.features.find((row) => row.id === 'marketplace')?.status,
      'verification-pending',
    );
    assert.equal(
      featureState.features.find((row) => row.id === 'feed')?.status,
      'verification-pending',
    );
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
    assert.equal(
      (
        await fetch(recordsUrl, {
          method: 'POST',
          headers: { cookie, origin: server.origin, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      409,
    );
    const reader = repo.tasks.recordReader as unknown as { readPage(...args: unknown[]): unknown };
    const read = reader.readPage.bind(reader);
    let calculations = 0;
    reader.readPage = (...args) => {
      calculations++;
      return read(...args);
    };
    try {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(recordsUrl, {
            method: 'POST',
            headers: {
              cookie,
              origin: server.origin,
              'content-type': 'application/json',
              'x-workbench-records-contract': '1',
              'x-workbench-task-contract': '4',
            },
            body: JSON.stringify({ limit: 50 }),
          }),
        ),
      );
      assert.ok(responses.every((response) => response.status === 200));
      const pages = await Promise.all(responses.map((response) => response.json()));
      assert.ok(pages.every((page) => JSON.stringify(page) === JSON.stringify(pages[0])));
      assert.equal(
        calculations,
        1,
        '10 identical real HTTP requests compute once; subsequent requests use committed-data cache',
      );
    } finally {
      reader.readPage = read;
    }

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
      409,
    );
    assert.equal(
      (
        await post('/tasks/command', {
          command: 'resume',
          plans: [
            {
              profileId: randomUUID(),
              planId: randomUUID(),
              expectedState: 'PAUSED',
              expectedUpdatedAt: 0,
            },
          ],
        })
      ).status,
      404,
    );
    assert.deepEqual(repo.tasks.list(), []);
    const taskHistoryUrl = server.origin + '/api/workspace/tasks/history';
    assert.equal(
      (
        await fetch(taskHistoryUrl, {
          method: 'POST',
          headers: {
            origin: server.origin,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ profileId: profileIds[0] }),
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/tasks/history', { profileId: profileIds[0] }, 'https://attacker.example'))
        .status,
      403,
    );
    assert.equal((await post('/tasks/history', { profileId: randomUUID() })).status, 404);
    assert.equal(
      (await post('/tasks/history', { profileId: profileIds[0], resolveUnknown: true })).status,
      400,
    );
    const historyResponse = await post('/tasks/history', { profileId: profileIds[0] });
    assert.equal(historyResponse.status, 200);
    const history = TaskHistory.parse(await historyResponse.json());
    assert.equal(history.profileId, profileIds[0]);
    assert.equal(history.selectedPlanId, null);
    assert.deepEqual(history.operations, []);
    assert.equal(repo.tasks.list().length, 0);
    const missingPlan = { profileId: profileIds[0], planId: randomUUID() };
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/archives/list', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify(missingPlan),
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/archives/list', missingPlan, 'https://attacker.example')).status,
      403,
    );
    assert.equal(
      (await post('/archives/list', { ...missingPlan, resolveUnknown: true })).status,
      400,
    );
    assert.equal((await post('/archives/list', missingPlan)).status, 409);
    const unavailableArchive = await post('/archives/resume', {
      ...missingPlan,
      attemptId: randomUUID(),
      expectedRevision: 0,
      expectedPreparationRevision: 0,
    });
    assert.equal(unavailableArchive.status, 409);
    assert.equal((await unavailableArchive.json()).code, 'ARCHIVE_EXECUTION_UNAVAILABLE');
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
    await writeFile(path.join(materialDirectory, 'body.txt'), 'private test body');
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(path.join(materialDirectory, 'image.png'), image);
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/materials/preflight', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify({ directory: materialDirectory }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post(
          '/materials/preflight',
          { directory: materialDirectory },
          'https://attacker.example',
        )
      ).status,
      403,
    );
    assert.equal(
      (await post('/materials/preflight', { directory: materialDirectory, script: 'invalid' }))
        .status,
      400,
    );
    assert.equal(
      (await fetch(server.origin + '/api/workspace/materials/preflight', { headers: { cookie } }))
        .status,
      405,
    );
    assert.equal(materialScans, 0);
    const materialReport = MaterialPreflightReport.parse(
      await (await post('/materials/preflight', { directory: materialDirectory })).json(),
    );
    assert.equal(materialScans, 1);
    assert.equal(materialReport.complete, true);
    assert.equal(materialReport.packages.length, 2);
    assert.equal(materialReport.publishingReady, false);
    assert.equal(JSON.stringify(materialReport).includes('private test body'), false);
    const previewRequest = await fetch(server.origin + '/api/workspace/materials/preflight', {
      method: 'POST',
      headers: {
        cookie,
        origin: server.origin,
        'content-type': 'application/json',
        'x-workbench-material-preview': '1',
      },
      body: JSON.stringify({ directory: materialDirectory }),
    });
    const previewScan = MaterialPreviewScan.parse(await previewRequest.json());
    assert.equal(JSON.stringify(previewScan).includes('private test body'), false);
    assert.equal(materialScans, 2);
    const mediaSelection = { scanId: previewScan.scanId, source: 'image.png', fileIndex: 0 };
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/materials/media', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify(mediaSelection),
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/materials/media', mediaSelection, 'https://attacker.example')).status,
      403,
    );
    assert.equal(
      (await fetch(server.origin + '/api/workspace/materials/media', { headers: { cookie } }))
        .status,
      405,
    );
    assert.equal(
      (await post('/materials/media', { ...mediaSelection, filePath: '/private.png' })).status,
      400,
    );
    assert.equal(
      (await post('/materials/media', { ...mediaSelection, source: '../private.png' })).status,
      404,
    );
    const binary = await post('/materials/media', mediaSelection);
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get('content-type'), 'image/png');
    assert.equal(binary.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(binary.headers.get('cache-control'), 'no-store');
    assert.equal(binary.headers.get('content-length'), String(image.length));
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), image);
    await writeFile(
      path.join(materialDirectory, 'image.png'),
      Buffer.concat([image, Buffer.from('changed')]),
    );
    const changedMedia = await post('/materials/media', mediaSelection);
    assert.equal(changedMedia.status, 409);
    assert.equal(
      ((await changedMedia.json()) as { code: string }).code,
      'MATERIAL_PREVIEW_MEDIA_CHANGED',
    );
    assert.equal(materialScans, 2);
    const selection = { scanId: previewScan.scanId, source: 'body.txt' };
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/materials/preview', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify(selection),
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/materials/preview', selection, 'https://attacker.example')).status,
      403,
    );
    assert.equal(
      (await post('/materials/preview', { ...selection, source: '../private.txt' })).status,
      404,
    );
    assert.equal(
      (await post('/materials/preview', { ...selection, directory: materialDirectory })).status,
      400,
    );
    const preview = MaterialPackagePreview.parse(
      await (await post('/materials/preview', selection)).json(),
    );
    assert.equal(preview.text, 'private test body');
    const reviewSelection = { ...selection, profileIds: profileIds.slice(0, 2) };
    const arrangementRequest = {
      scanId: selection.scanId,
      profileIds,
      count: 1,
      allowRepeat: false,
    };
    assert.equal(
      (await post('/materials/arrangement', arrangementRequest, 'https://attacker.example')).status,
      403,
    );
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/materials/arrangement', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify(arrangementRequest),
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/materials/arrangement', { ...arrangementRequest, profileIds: [randomUUID()] }))
        .status,
      404,
    );
    assert.equal(
      (await post('/materials/arrangement', { ...arrangementRequest, queue: true })).status,
      400,
    );
    const arranged = MaterialArrangement.parse(
      await (await post('/materials/arrangement', arrangementRequest)).json(),
    );
    assert.equal(arranged.rows.length, 29);
    assert.equal(arranged.publishingReady, false);
    assert.ok(arranged.missing > 0);
    const row = arranged.rows[0];
    assert.ok(row);
    assert.equal(
      (
        await post('/materials/arrangement', {
          ...arrangementRequest,
          overrides: [{ profileId: randomUUID(), ordinal: row.ordinal, sourceIndex: 0 }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace/materials/review', {
          method: 'POST',
          headers: { origin: server.origin, 'content-type': 'application/json' },
          body: JSON.stringify(reviewSelection),
        })
      ).status,
      401,
    );
    assert.equal(
      (await post('/materials/review', reviewSelection, 'https://attacker.example')).status,
      403,
    );
    assert.equal(
      (await post('/materials/review', { ...reviewSelection, profileIds: [randomUUID()] })).status,
      404,
    );
    assert.equal(
      (await post('/materials/review', { ...reviewSelection, publishingReady: true })).status,
      400,
    );
    const reviewed = MaterialPublishingReview.parse(
      await (await post('/materials/review', reviewSelection)).json(),
    );
    assert.equal(reviewed.text, preview.text);
    assert.equal(reviewed.publishingReady, false);
    assert.deepEqual(
      reviewed.targets.map((target) => target.profileId),
      reviewSelection.profileIds,
    );
    assert.equal(JSON.stringify(reviewed).includes('mtimeNs'), false);
    await writeFile(path.join(materialDirectory, 'body.txt'), 'source changed');
    const changedReview = await post('/materials/review', reviewSelection);
    assert.equal(changedReview.status, 409);
    assert.equal(
      ((await changedReview.json()) as { code: string }).code,
      'MATERIAL_REVIEW_SOURCE_CHANGED',
    );
    assert.equal(preview.publishingReady, false);
    assert.equal(materialScans, 2);
    assert.equal(
      (await post('/groups/create', { name: 'A', color: 'blue' }, 'https://example.com')).status,
      403,
    );
    const group = GroupSchema.parse(
      await (await post('/groups/create', { name: '主力', color: 'green' })).json(),
    );
    assert.equal((await post('/profiles/move', { profileIds, groupId: group.id })).status, 200);
    assert.equal(
      (await post('/profiles/move', { profileIds: [randomUUID()], groupId: group.id })).status,
      404,
    );
    const draft = SavedCombinationSchema.parse(
      await (
        await post('/combinations/create-draft', {
          value: {
            name: '',
            note: '',
            steps: [],
            randomOrder: false,
            loop: { mode: 'finite', rounds: 1 },
          },
        })
      ).json(),
    );
    assert.equal(draft.version, 0);
    assert.equal(
      (await post('/combinations/publish', { id: draft.id, expectedRevision: 0 })).status,
      400,
    );
    const saved = SavedCombinationSchema.parse(
      await (
        await post('/combinations/draft', {
          id: draft.id,
          expectedRevision: 0,
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
    assert.equal(
      (await post('/combinations/publish', { id: saved.id, expectedRevision: saved.revision }))
        .status,
      200,
    );
    assert.equal(
      (await post('/combinations/start', { id: saved.id, version: 1, profileIds })).status,
      409,
    );
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
          resourceDirectory: materialDirectory,
          count: 1,
          allowRepeat: false,
          forbidSameAccountRepeat: true,
          archivePublished: false,
        },
      ],
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
    };
    const storyRequest = (contract: string) =>
      fetch(server.origin + '/api/workspace/combinations/create-draft', {
        method: 'POST',
        headers: {
          cookie,
          origin: server.origin,
          'content-type': 'application/json',
          'x-workbench-workspace-contract': contract,
        },
        body: JSON.stringify({ value: storyValue }),
      });
    const beforeStory = repo.combinations().length;
    assert.equal((await storyRequest('4')).status, 409);
    assert.equal(repo.combinations().length, beforeStory);
    assert.equal((await storyRequest('5')).status, 201);
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace', {
          headers: { cookie, 'x-workbench-workspace-contract': '4' },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(server.origin + '/api/workspace', {
          headers: { cookie, 'x-workbench-workspace-contract': '5' },
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
