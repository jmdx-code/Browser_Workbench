import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ResourceMaterialCatalog,
  ResourceMaterialOrigin,
  type ResourceMaterial,
} from '../shared/resource-materials.js';
import { validateResourceMaterial } from '../domain/resource-materials.js';
import { BROWSER_TEXT_INPUT_LIMIT } from '../shared/browser-actions.js';
import path from 'node:path';
import type { MaterialIndexRepository as CompatibleMaterialIndexRepository } from '../domain/material-index.js';
import { validateSnapshot } from './material-snapshot-validation.js';
import { sameTabProof } from '../domain/task-tabs.js';
import {
  CompleteMaterialScan,
  MaterialCatalog,
  MaterialPostIntent,
  MaterialReservation,
  ReserveMaterial,
  type Catalog,
  type ReservationRequest,
} from '../shared/material-index.js';
import type { MaterialScan } from '../shared/materials.js';
import { sameExecution } from '../shared/task-execution.js';
import { ProductError } from '../domain/workspace.js';
import { assertMaterialHistoryEligibility } from '../domain/material-post.js';
import { transaction } from './sqlite-transaction.js';
import {
  assertArchiveSourcesAvailable,
  resourceCatalogPaths,
  materialSourcePaths,
} from './material-archive-source-protection.js';
import type { SqliteTaskRepository } from './task-store.js';
import {
  currentMaterialUsageAccounts,
  historicalArchiveTestEnabled,
  materialUsageSourceKey,
  materialSourceAlreadyUsed,
} from './material-usage-store.js';
import type { SqliteTaskTabRepository } from './task-tab-store.js';
import { resourceSupportsDestination } from '../domain/resource-table.js';

function directoryKey(directory: string) {
  if (!path.isAbsolute(directory) || path.basename(directory).toLowerCase() === '已发')
    throw Error('MATERIAL_ROOT_INVALID');
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class SqliteMaterialIndexRepository implements MaterialIndexRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: SqliteTaskRepository,
    private readonly tabs: SqliteTaskTabRepository,
  ) {}
  resourceCatalog(id: string) {
    z.uuid().parse(id);
    const row = this.db.prepare('SELECT body FROM material_catalogs WHERE id=?').get(id);
    if (!row) throw new ProductError('MATERIAL_CATALOG_NOT_FOUND', '素材索引不存在', 404);
    return ResourceMaterialCatalog.parse(JSON.parse(String(row.body)) as unknown);
  }
  indexResources(jobId: string, catalogId: string, snapshots: ResourceMaterial[]) {
    z.uuid().parse(catalogId);
    return transaction(this.db, () => {
      const fixed = this.tasks.resources.snapshot(jobId);
      const sources = snapshots.map((snapshot) => {
        const row = fixed.table.rows.find((item) => item.id === snapshot.source);
        if (!row) throw Error('RESOURCE_MATERIAL_ROW_NOT_IN_PLAN');
        const origin = {
          version: 1 as const,
          combinationId: fixed.binding.combinationId,
          revision: fixed.binding.resourceRevision,
          row,
        };
        const payload = validateResourceMaterial(snapshot, origin);
        if (createHash('sha256').update(payload).digest('hex') !== snapshot.fingerprint)
          throw Error('RESOURCE_MATERIAL_FINGERPRINT_MISMATCH');
        return { origin, snapshot, payload };
      });
      if (new Set(sources.map((source) => source.snapshot.source)).size !== sources.length)
        throw Error('RESOURCE_MATERIAL_ROW_DUPLICATED');
      const existing = this.db
        .prepare('SELECT id FROM material_catalogs WHERE id=?')
        .get(catalogId);
      if (existing) {
        const original = this.resourceCatalog(catalogId);
        if (
          original.combinationId !== fixed.binding.combinationId ||
          original.resourceRevision !== fixed.binding.resourceRevision ||
          JSON.stringify(original.sources.map(({ origin, snapshot }) => ({ origin, snapshot }))) !==
            JSON.stringify(sources.map(({ origin, snapshot }) => ({ origin, snapshot })))
        )
          throw Error('MATERIAL_CATALOG_ID_CONFLICT');
        return original;
      }
      const key = `resource-table:${fixed.binding.combinationId}:${fixed.binding.resourceRevision}`;
      const revision = Number(
        this.db
          .prepare(
            'SELECT coalesce(max(revision),0)+1 AS revision FROM material_catalogs WHERE directory_key=?',
          )
          .get(key)?.revision,
      );
      const catalog = ResourceMaterialCatalog.parse({
        version: 1,
        id: catalogId,
        combinationId: fixed.binding.combinationId,
        resourceRevision: fixed.binding.resourceRevision,
        revision,
        createdAt: Date.now(),
        sources: sources.map(({ origin, snapshot }) => ({ id: randomUUID(), origin, snapshot })),
      });
      if (Buffer.byteLength(JSON.stringify(catalog), 'utf8') > 8 * 1024 * 1024)
        throw Error('RESOURCE_MATERIAL_CATALOG_LIMIT');
      assertArchiveSourcesAvailable(this.db, resourceCatalogPaths(catalog));
      this.db
        .prepare('INSERT INTO material_catalogs VALUES(?,?,?,?,?)')
        .run(catalog.id, key, revision, JSON.stringify(catalog), catalog.createdAt);
      for (const [index, source] of catalog.sources.entries()) {
        const payload = sources[index]?.payload;
        if (!payload) throw Error('MATERIAL_CONTENT_MISSING');
        const content = this.db
          .prepare('SELECT payload FROM material_contents WHERE fingerprint=?')
          .get(source.snapshot.fingerprint);
        if (content && content.payload !== payload) throw Error('MATERIAL_CONTENT_COLLISION');
        if (!content)
          this.db
            .prepare('INSERT INTO material_contents VALUES(?,1,?)')
            .run(source.snapshot.fingerprint, payload);
        this.db
          .prepare('INSERT INTO material_sources VALUES(?,?,?,?,?)')
          .run(
            source.id,
            catalog.id,
            source.snapshot.fingerprint,
            source.snapshot.source,
            JSON.stringify(source.snapshot),
          );
      }
      return catalog;
    });
  }
  reserveNextResource(input: Omit<ReservationRequest, 'sourceId'>) {
    const catalog = this.resourceCatalog(input.catalogId);
    const binding = this.tasks.resources.binding(input.jobId);
    if (
      !binding ||
      catalog.combinationId !== binding.combinationId ||
      catalog.resourceRevision !== binding.resourceRevision
    )
      throw Error('RESOURCE_MATERIAL_CATALOG_SCOPE');
    return this.reserveNext(input);
  }
  reserveNext(input: Omit<ReservationRequest, 'sourceId'>) {
    const request = ReserveMaterial.omit({ sourceId: true }).parse(input);
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT source_id FROM material_post_intents WHERE attempt_id=?')
        .get(request.attemptId);
      if (previous) return this.reserve({ ...request, sourceId: String(previous.source_id) });
      const step = this.tasks.steps(request.jobId).find((row) => row.id === request.stepId);
      const catalog =
        step?.spec.type === 'post' && step.spec.resourceMode === 'table'
          ? this.resourceCatalog(request.catalogId)
          : this.catalog(request.catalogId);
      for (const source of catalog.sources) {
        try {
          return this.reserve({ ...request, sourceId: source.id });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            ![
              'MATERIAL_CONTENT_RESERVED',
              'MATERIAL_CONTENT_ALREADY_USED_BY_ACCOUNT',
              'MATERIAL_CONTENT_ALREADY_CONSUMED',
              'MATERIAL_ARCHIVE_PENDING',
              'RESOURCE_BACKGROUND_EXECUTOR_REQUIRED',
              'RESOURCE_TEXT_INPUT_LIMIT',
              'RESOURCE_PURPOSE_MISMATCH',
              'RESOURCE_STORY_MULTI_MEDIA_REQUIRES_SEPARATE_ROWS',
            ].includes(error.message)
          )
            throw error;
        }
      }
      throw Error('MATERIAL_NO_ELIGIBLE_RESOURCE');
    });
  }
  catalog(id: string): Catalog {
    const row = this.db.prepare('SELECT body FROM material_catalogs WHERE id=?').get(id);
    if (!row) throw new ProductError('MATERIAL_CATALOG_NOT_FOUND', '素材索引不存在', 404);
    return MaterialCatalog.parse(JSON.parse(String(row.body)) as unknown);
  }
  current(directory: string) {
    const row = this.db
      .prepare('SELECT catalog_id FROM material_roots WHERE directory_key=?')
      .get(directoryKey(directory));
    return row ? this.catalog(String(row.catalog_id)) : null;
  }
  index(input: MaterialScan, catalogId: string): Catalog {
    const scan = CompleteMaterialScan.parse(input),
      key = directoryKey(scan.directory);
    const payloads = scan.packages.map(validateSnapshot);
    if (
      new Set(scan.packages.map((item) => item.source.toLowerCase())).size !== scan.packages.length
    )
      throw Error('MATERIAL_SOURCE_DUPLICATED');
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id FROM material_catalogs WHERE id=?')
        .get(catalogId);
      if (existing) {
        const original = this.catalog(catalogId);
        if (JSON.stringify(original.scan) !== JSON.stringify(scan))
          throw Error('MATERIAL_CATALOG_ID_CONFLICT');
        return original; // Old idempotent import must not roll the current root back.
      }
      const revision = Number(
        this.db
          .prepare(
            'SELECT coalesce(max(revision),0)+1 AS revision FROM material_catalogs WHERE directory_key=?',
          )
          .get(key)?.revision,
      );
      const catalog = MaterialCatalog.parse({
        id: catalogId,
        directory: scan.directory,
        revision,
        createdAt: Date.now(),
        scan,
        sources: scan.packages.map((snapshot) => ({ id: randomUUID(), snapshot })),
      });
      assertArchiveSourcesAvailable(
        this.db,
        catalog.sources.flatMap((s) =>
          s.snapshot.files.map((f) => path.join(catalog.directory, f.relativePath)),
        ),
      );
      this.db
        .prepare('INSERT INTO material_catalogs VALUES(?,?,?,?,?)')
        .run(catalog.id, key, revision, JSON.stringify(catalog), catalog.createdAt);
      for (const [index, source] of catalog.sources.entries()) {
        const payload = payloads[index];
        if (!payload) throw Error('MATERIAL_CONTENT_MISSING');
        const content = this.db
          .prepare('SELECT payload FROM material_contents WHERE fingerprint=?')
          .get(source.snapshot.fingerprint);
        if (content && content.payload !== payload) throw Error('MATERIAL_CONTENT_COLLISION');
        if (!content)
          this.db
            .prepare('INSERT INTO material_contents VALUES(?,1,?)')
            .run(source.snapshot.fingerprint, payload);
        this.db
          .prepare('INSERT INTO material_sources VALUES(?,?,?,?,?)')
          .run(
            source.id,
            catalog.id,
            source.snapshot.fingerprint,
            source.snapshot.source,
            JSON.stringify(source.snapshot),
          );
      }
      this.db
        .prepare(
          'INSERT INTO material_roots VALUES(?,?) ON CONFLICT(directory_key) DO UPDATE SET catalog_id=excluded.catalog_id',
        )
        .run(key, catalog.id);
      return catalog;
    });
  }
  reservation(id: string) {
    const row = this.db
      .prepare(
        'SELECT i.body,i.created_at,r.state,r.reason,r.updated_at FROM material_post_intents i JOIN material_reservations r USING(attempt_id) WHERE attempt_id=?',
      )
      .get(id);
    if (!row) throw new ProductError('MATERIAL_RESERVATION_NOT_FOUND', '素材预占不存在', 404);
    return MaterialReservation.parse({
      intent: JSON.parse(String(row.body)) as unknown,
      state: row.state,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  forPlan(jobId: string) {
    return this.db
      .prepare(
        'SELECT attempt_id FROM material_post_intents WHERE job_id=? ORDER BY created_at,attempt_id',
      )
      .all(jobId)
      .map((row) => this.reservation(String(row.attempt_id)));
  }
  reserve(input: ReservationRequest) {
    const request = ReserveMaterial.parse(input);
    return transaction(this.db, () => {
      const exists = this.db
        .prepare('SELECT attempt_id FROM material_post_intents WHERE attempt_id=?')
        .get(request.attemptId);
      if (exists) {
        const held = this.reservation(request.attemptId),
          original = ReserveMaterial.parse(
            Object.fromEntries(
              Object.keys(request).map((key) => [key, Reflect.get(held.intent, key)]),
            ),
          );
        if (JSON.stringify(original) !== JSON.stringify(request))
          throw Error('MATERIAL_ATTEMPT_ID_CONFLICT');
        return held; // Retrieval never revives REVIEW or grants input permission.
      }
      const plan = this.tasks.get(request.jobId),
        step = this.tasks.steps(plan.id).find((item) => item.id === request.stepId),
        catalog =
          step?.spec.type === 'post' && step.spec.resourceMode === 'table'
            ? this.resourceCatalog(request.catalogId)
            : this.catalog(request.catalogId),
        source = catalog.sources.find((item) => item.id === request.sourceId);
      if (
        plan.state !== 'RUNNING' ||
        !plan.accountId ||
        plan.profileId !== request.context.profileId ||
        plan.accountId !== request.context.accountId ||
        !step ||
        step.status !== 'ACTIVE' ||
        step.round !== plan.round ||
        step.position !== plan.position ||
        step.spec.type !== 'post' ||
        step.progress.revision !== request.expectedProgressRevision ||
        step.progress.published >= step.spec.count
      )
        throw Error('MATERIAL_TASK_NOT_READY');
      if (
        this.db
          .prepare('SELECT job_id FROM task_account_locks WHERE account_id=?')
          .get(plan.accountId)?.job_id !== plan.id
      )
        throw Error('MATERIAL_ACCOUNT_LOCK_REQUIRED');
      const tab = this.tabs.get(request.proof.ownershipId, plan.id);
      if (
        tab.jobId !== plan.id ||
        tab.state !== 'READY' ||
        !tab.context ||
        !sameExecution(tab.context, request.context) ||
        !sameTabProof(tab.proof, request.proof)
      )
        throw Error('MATERIAL_TARGET_MISMATCH');
      if (!source) throw Error('MATERIAL_CATALOG_STALE');
      if ('resourceRevision' in catalog && 'origin' in source) {
        const fixed = this.tasks.resources.snapshot(plan.id);
        const origin = ResourceMaterialOrigin.parse(source.origin);
        if (
          step.spec.resourceMode !== 'table' ||
          catalog.combinationId !== fixed.binding.combinationId ||
          catalog.resourceRevision !== fixed.binding.resourceRevision ||
          origin.combinationId !== fixed.binding.combinationId ||
          origin.revision !== fixed.binding.resourceRevision ||
          JSON.stringify(fixed.table.rows.find((row) => row.id === source.snapshot.source)) !==
            JSON.stringify(origin.row)
        )
          throw Error('RESOURCE_MATERIAL_CATALOG_SCOPE');
        validateResourceMaterial(source.snapshot, origin);
        if (!resourceSupportsDestination(origin.row, step.spec.destination ?? 'post'))
          throw Error('RESOURCE_PURPOSE_MISMATCH');
        if (step.spec.destination === 'story' && origin.row.media.length > 1)
          throw Error('RESOURCE_STORY_MULTI_MEDIA_REQUIRES_SEPARATE_ROWS');
        if (
          step.spec.destination !== 'story' &&
          origin.row.background === 'color' &&
          !origin.row.media.length &&
          this.db
            .prepare(
              "SELECT version FROM workspace_execution_contracts WHERE name='post-native-background'",
            )
            .get()?.version !== 1
        )
          throw Error('RESOURCE_BACKGROUND_EXECUTOR_REQUIRED');
        if (source.snapshot.text.length > BROWSER_TEXT_INPUT_LIMIT)
          throw Error('RESOURCE_TEXT_INPUT_LIMIT');
      } else if (
        !('directory' in catalog) ||
        step.spec.resourceMode === 'table' ||
        directoryKey(step.spec.resourceDirectory) !== directoryKey(catalog.directory) ||
        this.current(catalog.directory)?.id !== catalog.id
      )
        throw Error('MATERIAL_CATALOG_STALE');
      if (
        this.tasks
          .blockingOperations(plan.id)
          .some((op) => ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status))
      )
        throw Error('MATERIAL_OPERATION_PENDING');
      if (
        this.db
          .prepare(
            "SELECT attempt_id FROM material_reservations WHERE job_id=? AND state IN ('RESERVED','REVIEW') AND control_ended=0",
          )
          .get(plan.id)
      )
        throw Error('MATERIAL_PLAN_ALREADY_RESERVED');
      const historical = historicalArchiveTestEnabled(this.db);
      const usageKey = materialUsageSourceKey(
        'directory' in catalog ? catalog.directory : null,
        source.snapshot.source,
        'origin' in source ? ResourceMaterialOrigin.parse(source.origin) : undefined,
      );
      const pending = historical
        ? this.db
            .prepare(
              "SELECT attempt_id FROM material_reservations WHERE fingerprint=? AND state IN ('RESERVED','REVIEW')",
            )
            .get(source.snapshot.fingerprint)
        : this.db
            .prepare(
              "SELECT attempt_id FROM material_reservations WHERE usage_source_key=? AND (state='REVIEW' OR (state='RESERVED' AND (?=0 OR allow_repeat=0)))",
            )
            .get(usageKey, step.spec.allowRepeat ? 1 : 0);
      if (pending) throw Error('MATERIAL_CONTENT_RESERVED');
      if (historical) {
        const used = currentMaterialUsageAccounts(this.db, source.snapshot.fingerprint);
        assertMaterialHistoryEligibility(
          used.some((row) => row.account_id === plan.accountId),
          used.length > 0,
          step.spec.allowRepeat,
        );
      } else if (!step.spec.allowRepeat && materialSourceAlreadyUsed(this.db, usageKey))
        throw Error('MATERIAL_CONTENT_ALREADY_CONSUMED');
      if (
        historicalArchiveTestEnabled(this.db) &&
        this.db
          .prepare(
            "SELECT p.attempt_id FROM material_publications p JOIN material_archive_state s USING(attempt_id) WHERE p.fingerprint=? AND s.state<>'COMPLETED'",
          )
          .get(source.snapshot.fingerprint)
      )
        throw Error('MATERIAL_ARCHIVE_PENDING');
      const intent = MaterialPostIntent.parse({
          ...request,
          fingerprintVersion: 1,
          fingerprint: source.snapshot.fingerprint,
          directory: 'directory' in catalog ? catalog.directory : null,
          ...('origin' in source ? { resource: source.origin } : {}),
          snapshot: source.snapshot,
          allowRepeat: step.spec.allowRepeat,
          ordinal: step.progress.published + 1,
        }),
        now = Date.now();
      assertArchiveSourcesAvailable(this.db, materialSourcePaths(intent));
      this.db
        .prepare('INSERT INTO material_post_intents VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          intent.attemptId,
          plan.id,
          step.id,
          plan.accountId,
          intent.fingerprint,
          intent.sourceId,
          intent.ordinal,
          JSON.stringify(intent),
          now,
        );
      this.db
        .prepare(
          "INSERT INTO material_reservations(attempt_id,job_id,fingerprint,state,reason,updated_at,usage_source_key,allow_repeat) VALUES(?,?,?,'RESERVED','',?,?,?)",
        )
        .run(
          intent.attemptId,
          plan.id,
          intent.fingerprint,
          now,
          usageKey,
          !historical && step.spec.allowRepeat ? 1 : 0,
        );
      return this.reservation(intent.attemptId);
    });
  }
}

type MaterialIndexRepository = SynchronousRepository<CompatibleMaterialIndexRepository>;
