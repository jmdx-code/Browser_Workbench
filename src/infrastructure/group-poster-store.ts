import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from './sqlite-transaction.js';
import {
  ensureTargetLibrarySchema,
  SqliteTargetLibraryRepository,
} from './target-library-store.js';
import { ensureTargetColumns } from './target-list-store.js';
import { migrateGroupInviterSchema } from './group-inviter-store.js';
import {
  ensureGroupBumperDecouplingSchema,
  migrateBumperSettingsDefault50,
} from './group-bumper-store.js';
import { mediaReference } from '../domain/resource-table.js';
import { sameBinding, type Binding } from '../shared/task-execution.js';
import { ProfileTaskResult } from '../shared/task-contracts.js';
import {
  BumperTargetsInput,
  BumperIdsInput,
  isLocalAvatar,
  type BumperDailyStat,
  type BumperTarget,
} from '../shared/group-bumper.js';
import {
  PosterActionKind,
  PosterOperationStatus,
  PosterSettings,
  PosterMaterialsInput,
  PosterMaterialIdsInput,
  PosterToggleMaterialsInput,
  type PosterCacheStatus,
  type PosterLog,
  type PosterMaterial,
  type PosterMaterialBackground,
  type PosterMediaKind,
  type PosterOperationRecord,
  type PosterOperationResolution,
  type PosterPendingOperation,
} from '../shared/group-poster.js';

function formatLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function ensurePosterMaterialColumns(db: DatabaseSync): void {
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(group_poster_materials)')
      .all()
      .map((c) => String(c.name)),
  );
  if (!cols.has('background')) {
    db.exec(
      "ALTER TABLE group_poster_materials ADD COLUMN background TEXT NOT NULL DEFAULT 'plain'",
    );
  }
  if (!cols.has('last_used_at')) {
    db.exec('ALTER TABLE group_poster_materials ADD COLUMN last_used_at INTEGER DEFAULT NULL');
  }
  if (!cols.has('thumbnail_data_url')) {
    db.exec('ALTER TABLE group_poster_materials ADD COLUMN thumbnail_data_url TEXT DEFAULT NULL');
  }
}

export const groupPosterMigration = `
CREATE TABLE IF NOT EXISTS group_poster_materials(
  id TEXT PRIMARY KEY,
  caption TEXT NOT NULL,
  media_source TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT 'plain',
  local_file_path TEXT,
  media_kind TEXT NOT NULL DEFAULT 'none',
  cache_status TEXT NOT NULL DEFAULT 'ready',
  cache_error TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER DEFAULT NULL,
  thumbnail_data_url TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_poster_materials_sort ON group_poster_materials(sort_order, created_at, id);
CREATE TABLE IF NOT EXISTS group_poster_logs(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  account_avatar TEXT,
  identity_type TEXT NOT NULL DEFAULT 'personal',
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  group_avatar TEXT,
  material_id TEXT NOT NULL,
  caption_preview TEXT NOT NULL DEFAULT '',
  post_id TEXT NOT NULL,
  post_url TEXT NOT NULL,
  posted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_poster_logs_group_material ON group_poster_logs(group_id, material_id);
CREATE INDEX IF NOT EXISTS idx_group_poster_logs_profile_time ON group_poster_logs(profile_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_poster_logs_posted_at ON group_poster_logs(posted_at DESC);
CREATE TABLE IF NOT EXISTS group_poster_settings(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
INSERT OR IGNORE INTO group_poster_settings(id, body) VALUES(1, '{}');
`;

export const groupPosterOperationsMigration = `
CREATE TABLE IF NOT EXISTS group_poster_operations(
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_epoch TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK(action_kind IN (
    'setup_search_group',
    'setup_open_group',
    'setup_browse_group',
    'setup_join_group',
    'setup_dismiss_welcome',
    'setup_open_composer',
    'setup_fill_caption',
    'setup_fill_composer',
    'setup_upload_media',
    'setup_wait_media_ready',
    'submit_post'
  )),
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  material_id TEXT DEFAULT NULL,
  post_id TEXT DEFAULT NULL,
  post_url TEXT DEFAULT NULL,
  log_id TEXT DEFAULT NULL,
  resolution_id TEXT DEFAULT NULL,
  resolution_outcome TEXT CHECK(resolution_outcome IN ('VERIFIED', 'NOT_APPLIED', 'ENDED_UNKNOWN') OR resolution_outcome IS NULL),
  evidence_digest TEXT DEFAULT NULL,
  status TEXT NOT NULL CHECK(status IN ('PREPARED', 'VERIFIED', 'NOT_APPLIED', 'PENDING_REVIEW')),
  kernel_settled INTEGER NOT NULL DEFAULT 0 CHECK(kernel_settled IN (0, 1)),
  review_reason TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_poster_operations_profile_settled
  ON group_poster_operations(profile_id, kernel_settled);
CREATE INDEX IF NOT EXISTS idx_group_poster_operations_group_material_status
  ON group_poster_operations(group_id, material_id, status);
`;

export function rebuildGroupPosterOperationsEpochTextMigration(db: DatabaseSync): void {
  const hasTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_poster_operations'",
    )
    .get();
  if (!hasTable) {
    db.exec(groupPosterOperationsMigration);
    return;
  }
  db.exec(`
    DROP TABLE IF EXISTS group_poster_operations_next;
    CREATE TABLE group_poster_operations_next(
      operation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      connection_epoch TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      action_kind TEXT NOT NULL CHECK(action_kind IN (
        'setup_search_group',
        'setup_open_group',
        'setup_browse_group',
        'setup_join_group',
        'setup_dismiss_welcome',
        'setup_open_composer',
        'setup_fill_caption',
        'setup_fill_composer',
        'setup_upload_media',
        'setup_wait_media_ready',
        'submit_post'
      )),
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      material_id TEXT DEFAULT NULL,
      post_id TEXT DEFAULT NULL,
      post_url TEXT DEFAULT NULL,
      log_id TEXT DEFAULT NULL,
      resolution_id TEXT DEFAULT NULL,
      resolution_outcome TEXT CHECK(resolution_outcome IN ('VERIFIED', 'NOT_APPLIED', 'ENDED_UNKNOWN') OR resolution_outcome IS NULL),
      evidence_digest TEXT DEFAULT NULL,
      status TEXT NOT NULL CHECK(status IN ('PREPARED', 'VERIFIED', 'NOT_APPLIED', 'PENDING_REVIEW')),
      kernel_settled INTEGER NOT NULL DEFAULT 0 CHECK(kernel_settled IN (0, 1)),
      review_reason TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO group_poster_operations_next(
      operation_id, run_id, profile_id, account_id, connection_epoch, lease_id, generation,
      job_id, step_id, action_digest, action_kind, group_id, group_name, material_id,
      post_id, post_url, log_id, resolution_id, resolution_outcome, evidence_digest,
      status, kernel_settled, review_reason, created_at, updated_at
    )
    SELECT
      operation_id, run_id, profile_id, account_id, CAST(connection_epoch AS TEXT), lease_id, generation,
      job_id, step_id, action_digest, action_kind, group_id, group_name, material_id,
      post_id, post_url, log_id, resolution_id, resolution_outcome, evidence_digest,
      status, kernel_settled, review_reason, created_at, updated_at
    FROM group_poster_operations;
    DROP TABLE group_poster_operations;
    ALTER TABLE group_poster_operations_next RENAME TO group_poster_operations;
    CREATE INDEX IF NOT EXISTS idx_group_poster_operations_profile_settled
      ON group_poster_operations(profile_id, kernel_settled);
    CREATE INDEX IF NOT EXISTS idx_group_poster_operations_group_material_status
      ON group_poster_operations(group_id, material_id, status);
  `);
}

export function stage3OperationsAndDecouplingMigration(db: DatabaseSync): void {
  migrateGroupInviterSchema(db);
  migrateBumperSettingsDefault50(db);
  ensureGroupBumperDecouplingSchema(db);
  db.exec(groupPosterMigration);
  db.exec(groupPosterOperationsMigration);
  ensurePosterMaterialColumns(db);
}

export function stage4MediaAndPolishMigration(db: DatabaseSync): void {
  ensureTargetLibrarySchema(db);
  ensureTargetColumns(db, 'shared_facebook_groups');
  ensureTargetColumns(db, 'group_bumper_pages');
  migrateGroupInviterSchema(db);
  migrateBumperSettingsDefault50(db);
  ensureGroupBumperDecouplingSchema(db);
  db.exec(groupPosterMigration);
  db.exec(groupPosterOperationsMigration);
  ensurePosterMaterialColumns(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_group_inviter_logs_invited_at
      ON group_inviter_logs(invited_at DESC);
    CREATE INDEX IF NOT EXISTS idx_group_bumper_logs_bumped_at
      ON group_bumper_logs(bumped_at DESC);
    CREATE INDEX IF NOT EXISTS idx_group_poster_logs_posted_at
      ON group_poster_logs(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_group_poster_materials_sort
      ON group_poster_materials(sort_order, created_at, id);
  `);
}

export class SqliteGroupPosterRepository {
  private readonly targetLibrary: SqliteTargetLibraryRepository;

  constructor(private readonly db: DatabaseSync) {
    ensureTargetLibrarySchema(this.db);
    this.db.exec(groupPosterMigration);
    this.db.exec(groupPosterOperationsMigration);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profile_task_results(
        profile_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('task','group-inviter','group-bumper','page-bumper','group-poster')),
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('COMPLETED','FAILED','STOPPED')),
        reason TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        failed_steps INTEGER NOT NULL DEFAULT 0,
        skipped_steps INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.targetLibrary = new SqliteTargetLibraryRepository(this.db);
  }

  private mapOperationRow(r: Record<string, unknown>): PosterOperationRecord {
    const actionKind = PosterActionKind.parse(String(r.action_kind));
    const status = PosterOperationStatus.parse(String(r.status));
    const resolutionOutcome =
      r.resolution_outcome === 'VERIFIED' ||
      r.resolution_outcome === 'NOT_APPLIED' ||
      r.resolution_outcome === 'ENDED_UNKNOWN'
        ? r.resolution_outcome
        : undefined;
    return {
      binding: {
        operationId: String(r.operation_id),
        profileId: String(r.profile_id),
        accountId: String(r.account_id),
        connectionEpoch: String(r.connection_epoch),
        leaseId: String(r.lease_id),
        generation: Number(r.generation),
        jobId: String(r.job_id),
        stepId: String(r.step_id),
        actionDigest: String(r.action_digest),
      },
      runId: String(r.run_id),
      actionKind,
      groupId: String(r.group_id),
      groupName: String(r.group_name),
      materialId: r.material_id == null ? undefined : String(r.material_id),
      postId: r.post_id == null ? undefined : String(r.post_id),
      postUrl: r.post_url == null ? undefined : String(r.post_url),
      logId: r.log_id == null ? undefined : String(r.log_id),
      resolution:
        r.resolution_id != null && resolutionOutcome && r.evidence_digest != null
          ? {
              id: String(r.resolution_id),
              outcome: resolutionOutcome,
              evidenceDigest: String(r.evidence_digest),
            }
          : undefined,
      status,
      kernelSettled: Number(r.kernel_settled ?? 0) === 1,
      reviewReason: r.review_reason == null ? undefined : String(r.review_reason),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  getOperation(operationId: string): PosterOperationRecord | null {
    const r = this.db
      .prepare('SELECT * FROM group_poster_operations WHERE operation_id = ?')
      .get(operationId) as Record<string, unknown> | undefined;
    return r ? this.mapOperationRow(r) : null;
  }

  listOperationsByProfile(profileId: string, includeSettled = false): PosterOperationRecord[] {
    const rows = (
      includeSettled
        ? this.db
            .prepare(
              'SELECT * FROM group_poster_operations WHERE profile_id = ? ORDER BY created_at ASC',
            )
            .all(profileId)
        : this.db
            .prepare(
              'SELECT * FROM group_poster_operations WHERE profile_id = ? AND kernel_settled = 0 ORDER BY created_at ASC',
            )
            .all(profileId)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOperationRow(r));
  }

  prepareOperation(input: {
    binding: Binding;
    runId: string;
    actionKind: PosterActionKind;
    groupId: string;
    groupName: string;
    materialId?: string | undefined;
    postId?: string | undefined;
    postUrl?: string | undefined;
    logId?: string | undefined;
  }): PosterOperationRecord {
    const actionKind = PosterActionKind.parse(input.actionKind);
    const b = input.binding;
    return transaction(this.db, () => {
      const existing = this.getOperation(b.operationId);
      if (existing) {
        if (
          !sameBinding(existing.binding, b) ||
          existing.actionKind !== actionKind ||
          existing.runId !== input.runId ||
          existing.groupId !== input.groupId
        ) {
          throw Error('POSTER_OPERATION_CONTEXT_CHANGED');
        }
        return existing;
      }
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO group_poster_operations(
             operation_id, run_id, profile_id, account_id, connection_epoch, lease_id, generation,
             job_id, step_id, action_digest, action_kind, group_id, group_name, material_id,
             post_id, post_url, log_id, resolution_id, resolution_outcome, evidence_digest,
             status, kernel_settled, review_reason, created_at, updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          b.operationId,
          input.runId,
          b.profileId,
          b.accountId,
          String(b.connectionEpoch),
          b.leaseId,
          b.generation,
          b.jobId,
          b.stepId,
          b.actionDigest,
          actionKind,
          input.groupId,
          input.groupName,
          input.materialId ?? null,
          input.postId ?? null,
          input.postUrl ?? null,
          input.logId ?? null,
          null,
          null,
          null,
          'PREPARED',
          0,
          null,
          now,
          now,
        );
      return (
        this.getOperation(b.operationId) ?? {
          binding: b,
          runId: input.runId,
          actionKind,
          groupId: input.groupId,
          groupName: input.groupName,
          materialId: input.materialId,
          postId: input.postId,
          postUrl: input.postUrl,
          logId: input.logId,
          status: 'PREPARED',
          kernelSettled: false,
          createdAt: now,
          updatedAt: now,
        }
      );
    });
  }

  setOperationResolution(
    operationId: string,
    resolution: PosterOperationResolution,
  ): PosterOperationResolution {
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (!row) throw Error('POSTER_OPERATION_MISSING');
      if (row.resolution) {
        if (row.resolution.outcome === resolution.outcome) {
          return row.resolution;
        }
        if (
          !row.kernelSettled &&
          row.resolution.outcome === 'NOT_APPLIED' &&
          resolution.outcome === 'ENDED_UNKNOWN'
        ) {
          const nextStatusOnUpgrade: PosterOperationStatus =
            row.status === 'PENDING_REVIEW' || row.actionKind === 'submit_post'
              ? 'PENDING_REVIEW'
              : 'NOT_APPLIED';
          this.db
            .prepare(
              `UPDATE group_poster_operations
                  SET resolution_id = ?,
                      resolution_outcome = ?,
                      evidence_digest = ?,
                      status = ?,
                      updated_at = ?
                WHERE operation_id = ?`,
            )
            .run(
              resolution.id,
              resolution.outcome,
              resolution.evidenceDigest,
              nextStatusOnUpgrade,
              Date.now(),
              operationId,
            );
          return resolution;
        }
        throw Error('POSTER_RESOLUTION_CONFLICT');
      }
      const nextStatus: PosterOperationStatus =
        resolution.outcome === 'VERIFIED'
          ? 'VERIFIED'
          : row.status === 'PENDING_REVIEW' ||
              (row.actionKind === 'submit_post' && resolution.outcome === 'ENDED_UNKNOWN')
            ? 'PENDING_REVIEW'
            : 'NOT_APPLIED';
      this.db
        .prepare(
          `UPDATE group_poster_operations
              SET resolution_id = ?,
                  resolution_outcome = ?,
                  evidence_digest = ?,
                  status = ?,
                  updated_at = ?
            WHERE operation_id = ?`,
        )
        .run(
          resolution.id,
          resolution.outcome,
          resolution.evidenceDigest,
          nextStatus,
          Date.now(),
          operationId,
        );
      return resolution;
    });
  }

  markOperationKernelSettled(operationId: string): void {
    const row = this.getOperation(operationId);
    if (!row) throw Error('POSTER_OPERATION_MISSING');
    if (!row.kernelSettled) {
      this.db
        .prepare(
          'UPDATE group_poster_operations SET kernel_settled = 1, updated_at = ? WHERE operation_id = ?',
        )
        .run(Date.now(), operationId);
    }
  }

  markOperationReview(operationId: string, reason: string): void {
    const row = this.getOperation(operationId);
    if (!row) throw Error('POSTER_OPERATION_MISSING');
    if (row.status === 'VERIFIED') return;
    this.db
      .prepare(
        `UPDATE group_poster_operations
            SET status = 'PENDING_REVIEW',
                review_reason = ?,
                updated_at = ?
          WHERE operation_id = ?`,
      )
      .run(reason, Date.now(), operationId);
  }

  confirmPostSubmission(
    operationId: string,
    record: PosterLog,
    resolution: PosterOperationResolution,
  ): PosterOperationResolution {
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (
        !row ||
        row.actionKind !== 'submit_post' ||
        row.binding.profileId !== record.profileId ||
        row.groupId !== record.groupId ||
        resolution.outcome !== 'VERIFIED'
      ) {
        throw Error('POSTER_RESULT_CONTEXT_CHANGED');
      }
      if (row.resolution) {
        if (row.resolution.outcome !== 'VERIFIED') throw Error('POSTER_RESOLUTION_CONFLICT');
        return row.resolution;
      }
      this.recordPost(record);
      this.db
        .prepare(
          `UPDATE group_poster_operations
              SET post_id = ?,
                  post_url = ?,
                  log_id = ?,
                  resolution_id = ?,
                  resolution_outcome = 'VERIFIED',
                  evidence_digest = ?,
                  status = 'VERIFIED',
                  updated_at = ?
            WHERE operation_id = ?`,
        )
        .run(
          record.postId,
          record.postUrl,
          record.id,
          resolution.id,
          resolution.evidenceDigest,
          Date.now(),
          operationId,
        );
      return resolution;
    });
  }

  settings(): PosterSettings {
    const row = this.db.prepare('SELECT body FROM group_poster_settings WHERE id=1').get() as
      { body?: string } | undefined;
    try {
      return PosterSettings.parse(JSON.parse(String(row?.body ?? '{}')));
    } catch {
      return PosterSettings.parse({});
    }
  }

  saveSettings(input: unknown): PosterSettings {
    const settings = PosterSettings.parse(input);
    this.db
      .prepare('UPDATE group_poster_settings SET body=? WHERE id=1')
      .run(JSON.stringify(settings));
    return settings;
  }

  targets(): BumperTarget[] {
    return this.targetLibrary.listGroups().map((row) => ({
      id: row.groupId,
      name: row.groupName,
      avatarUrl: row.avatarUrl,
      folderId: row.folderId,
      sortOrder: row.sortOrder,
      totalBumpedCount: row.postedCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  upsertTargets(input: unknown): BumperTarget[] {
    const { items } = BumperTargetsInput.parse(input);
    this.targetLibrary.upsertGroups(
      items.map((item) => ({
        id: item.id,
        name: item.name.trim() || item.id,
        folderId: item.folderId ?? null,
      })),
    );
    return this.targets();
  }

  deleteTargets(input: unknown): number {
    const { ids } = BumperIdsInput.parse(input);
    return transaction(this.db, () =>
      Number(
        this.db
          .prepare(
            'DELETE FROM shared_facebook_groups WHERE group_id IN (SELECT value FROM json_each(?))',
          )
          .run(JSON.stringify(ids)).changes,
      ),
    );
  }

  updateAvatar(id: string, avatarUrl: string): void {
    const trimmed = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (!trimmed) return;
    this.targetLibrary.applyResolvedTargetMetadata('group', id, {
      avatarUrl: trimmed,
    });
  }

  applyResolvedTargetMetadata(
    originalId: string,
    resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): boolean {
    return this.targetLibrary.applyResolvedTargetMetadata('group', originalId, resolved);
  }

  materials(): PosterMaterial[] {
    return this.db
      .prepare(
        `SELECT id, caption, media_source, background, local_file_path, media_kind,
                cache_status, cache_error, selected, used_count, sort_order,
                created_at, updated_at, last_used_at,
                CASE WHEN thumbnail_data_url IS NOT NULL AND length(thumbnail_data_url) > 0 THEN 1 ELSE 0 END AS has_thumbnail
           FROM group_poster_materials
          ORDER BY sort_order, created_at, id`,
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        caption: String(r.caption),
        mediaSource: String(r.media_source ?? ''),
        background:
          String(r.media_source ?? '').trim().length > 0
            ? 'plain'
            : String(r.background) === 'color'
              ? 'color'
              : 'plain',
        localFilePath: r.local_file_path == null ? null : String(r.local_file_path),
        mediaKind: (['none', 'image', 'video'].includes(String(r.media_kind))
          ? String(r.media_kind)
          : 'none') as PosterMediaKind,
        cacheStatus: (['ready', 'downloading', 'expired', 'error'].includes(String(r.cache_status))
          ? String(r.cache_status)
          : 'ready') as PosterCacheStatus,
        cacheError: r.cache_error == null ? null : String(r.cache_error),
        selected: Number(r.selected ?? 1) === 1,
        usedCount: Number(r.used_count ?? 0),
        sortOrder: Number(r.sort_order ?? 0),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
        hasThumbnail: Number(r.has_thumbnail ?? 0) === 1,
      }));
  }

  saveMaterials(input: unknown): PosterMaterial[] {
    const rawItems =
      typeof input === 'object' &&
      input !== null &&
      'items' in input &&
      Array.isArray((input as { items?: unknown }).items)
        ? ((input as { items: unknown[] }).items as Array<Record<string, unknown>>)
        : [];
    const { items, replaceAll } = PosterMaterialsInput.parse(input);
    const now = Date.now();
    return transaction(this.db, () => {
      const existingById = new Map(this.materials().map((m) => [m.id, m]));
      const resolved = items.map((item, idx) => ({
        item,
        raw: rawItems[idx],
        id: item.id && item.id.trim() ? item.id.trim() : randomUUID(),
        idx,
      }));
      if (replaceAll === true) {
        if (resolved.length === 0) {
          this.db.prepare('DELETE FROM group_poster_materials').run();
        } else {
          const keepIds = resolved.map((x) => x.id);
          this.db
            .prepare(
              'DELETE FROM group_poster_materials WHERE id NOT IN (SELECT value FROM json_each(?))',
            )
            .run(JSON.stringify(keepIds));
        }
      }
      const upsert = this.db.prepare(
        `INSERT INTO group_poster_materials(
           id,caption,media_source,background,local_file_path,media_kind,cache_status,cache_error,selected,used_count,sort_order,created_at,updated_at,last_used_at,thumbnail_data_url
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(id) DO UPDATE SET
           caption=excluded.caption,
           media_source=excluded.media_source,
           background=excluded.background,
           local_file_path=excluded.local_file_path,
           media_kind=excluded.media_kind,
           cache_status=excluded.cache_status,
           cache_error=excluded.cache_error,
           selected=excluded.selected,
           sort_order=excluded.sort_order,
           updated_at=excluded.updated_at,
           thumbnail_data_url=CASE WHEN group_poster_materials.media_source = excluded.media_source THEN group_poster_materials.thumbnail_data_url ELSE NULL END`,
      );
      let nextOrder = this.materials().reduce((max, m) => Math.max(max, m.sortOrder), -1) + 1;
      for (const { item, raw, id, idx } of resolved) {
        const prev = existingById.get(id);
        const rawSource = (item.mediaSource ?? '').trim();
        let ref: ReturnType<typeof mediaReference> | null = null;
        if (rawSource) {
          try {
            ref = mediaReference(rawSource);
          } catch {
            ref = null;
          }
        }
        const mediaSource = ref ? ref.source : rawSource;
        const hasExplicitBg = Boolean(raw && typeof raw === 'object' && 'background' in raw);
        const effectiveBackground: PosterMaterialBackground = mediaSource
          ? 'plain'
          : item.background === 'color'
            ? 'color'
            : hasExplicitBg
              ? 'plain'
              : (prev?.background ?? 'plain');
        const sourceChanged = !prev || prev.mediaSource !== mediaSource;
        const isLocalSource = ref?.kind === 'local';
        const localFilePath = !mediaSource
          ? null
          : sourceChanged
            ? isLocalSource
              ? mediaSource
              : null
            : prev.localFilePath;
        const mediaKind: PosterMediaKind = !mediaSource
          ? 'none'
          : sourceChanged
            ? ref
              ? ref.mediaType === 'image'
                ? 'image'
                : 'video'
              : /\.(?:png|jpe?g|webp|gif)$/i.test(mediaSource)
                ? 'image'
                : 'video'
            : prev.mediaKind;
        const cacheStatus: PosterCacheStatus = !mediaSource
          ? 'ready'
          : sourceChanged
            ? !ref
              ? 'error'
              : isLocalSource
                ? 'ready'
                : 'downloading'
            : prev.cacheStatus;
        const cacheError = !mediaSource
          ? null
          : sourceChanged
            ? !ref
              ? '不支持的媒体路径或链接格式'
              : null
            : prev.cacheError;
        const sortOrder = replaceAll === true ? idx : prev ? prev.sortOrder : nextOrder++;
        upsert.run(
          id,
          item.caption.trim(),
          mediaSource,
          effectiveBackground,
          localFilePath,
          mediaKind,
          cacheStatus,
          cacheError,
          (item.selected ?? prev?.selected ?? true) ? 1 : 0,
          prev?.usedCount ?? 0,
          sortOrder,
          prev?.createdAt ?? now,
          now,
          prev?.lastUsedAt ?? null,
        );
      }
      return this.materials();
    });
  }

  deleteMaterials(input: unknown): number {
    const { ids } = PosterMaterialIdsInput.parse(input);
    return Number(
      this.db
        .prepare('DELETE FROM group_poster_materials WHERE id IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify(ids)).changes,
    );
  }

  toggleMaterials(input: unknown): PosterMaterial[] {
    const { ids, selected } = PosterToggleMaterialsInput.parse(input);
    this.db
      .prepare(
        'UPDATE group_poster_materials SET selected=?,updated_at=? WHERE id IN (SELECT value FROM json_each(?))',
      )
      .run(selected ? 1 : 0, Date.now(), JSON.stringify(ids));
    return this.materials();
  }

  updateMaterialCache(
    id: string,
    cache: {
      localFilePath: string | null;
      mediaKind: PosterMediaKind;
      cacheStatus: PosterCacheStatus;
      cacheError: string | null;
      thumbnailDataUrl?: string | null | undefined;
    },
  ): void {
    const now = Date.now();
    const shouldRefreshLastUsed = cache.cacheStatus === 'ready' && Boolean(cache.localFilePath);
    if (cache.thumbnailDataUrl !== undefined) {
      this.db
        .prepare(
          'UPDATE group_poster_materials SET local_file_path=?,media_kind=?,cache_status=?,cache_error=?,thumbnail_data_url=?,updated_at=?,last_used_at=CASE WHEN ?=1 THEN ? ELSE last_used_at END WHERE id=?',
        )
        .run(
          cache.localFilePath,
          cache.mediaKind,
          cache.cacheStatus,
          cache.cacheError,
          cache.thumbnailDataUrl,
          now,
          shouldRefreshLastUsed ? 1 : 0,
          now,
          id,
        );
      return;
    }
    this.db
      .prepare(
        'UPDATE group_poster_materials SET local_file_path=?,media_kind=?,cache_status=?,cache_error=?,updated_at=?,last_used_at=CASE WHEN ?=1 THEN ? ELSE last_used_at END WHERE id=?',
      )
      .run(
        cache.localFilePath,
        cache.mediaKind,
        cache.cacheStatus,
        cache.cacheError,
        now,
        shouldRefreshLastUsed ? 1 : 0,
        now,
        id,
      );
  }

  getMaterialThumbnail(id: string): { thumbnailDataUrl: string | null; updatedAt: number } | null {
    const row = this.db
      .prepare('SELECT thumbnail_data_url, updated_at FROM group_poster_materials WHERE id = ?')
      .get(id) as { thumbnail_data_url?: string | null; updated_at?: number } | undefined;
    if (!row) return null;
    return {
      thumbnailDataUrl:
        typeof row.thumbnail_data_url === 'string' && row.thumbnail_data_url.length > 0
          ? row.thumbnail_data_url
          : null,
      updatedAt: Number(row.updated_at ?? 0),
    };
  }

  saveMaterialThumbnail(id: string, thumbnailDataUrl: string): boolean {
    const trimmed = thumbnailDataUrl.trim();
    if (!trimmed.startsWith('data:image/') || trimmed.length > 48 * 1024) return false;
    const res = this.db
      .prepare(
        'UPDATE group_poster_materials SET thumbnail_data_url = ?, updated_at = ? WHERE id = ?',
      )
      .run(trimmed, Date.now(), id);
    return Number(res.changes ?? 0) > 0;
  }

  getMaterialMediaPath(
    id: string,
  ): { localFilePath: string | null; mediaKind: PosterMediaKind } | null {
    const row = this.db
      .prepare('SELECT local_file_path, media_kind FROM group_poster_materials WHERE id = ?')
      .get(id) as { local_file_path?: string | null; media_kind?: string } | undefined;
    if (!row) return null;
    return {
      localFilePath:
        typeof row.local_file_path === 'string' && row.local_file_path.trim().length > 0
          ? row.local_file_path.trim()
          : null,
      mediaKind: (['none', 'image', 'video'].includes(String(row.media_kind))
        ? String(row.media_kind)
        : 'none') as PosterMediaKind,
    };
  }

  listExpiredDriveMaterials(
    cutoffMs: number,
  ): Array<{ id: string; mediaSource: string; localFilePath: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, media_source, local_file_path
           FROM group_poster_materials
          WHERE local_file_path IS NOT NULL
            AND trim(local_file_path) <> ''
            AND COALESCE(last_used_at, updated_at) < ?`,
      )
      .all(cutoffMs) as Array<{
      id?: string;
      media_source?: string;
      local_file_path?: string;
    }>;
    const result: Array<{ id: string; mediaSource: string; localFilePath: string }> = [];
    for (const r of rows) {
      const id = String(r.id ?? '');
      const src = String(r.media_source ?? '').trim();
      const localPath = String(r.local_file_path ?? '').trim();
      if (!id || !src || !localPath) continue;
      try {
        const ref = mediaReference(src);
        if (ref.kind === 'drive') {
          result.push({ id, mediaSource: src, localFilePath: localPath });
        }
      } catch {
        // Ignore invalid mediaSource
      }
    }
    return result;
  }

  markMaterialCacheExpired(id: string): void {
    this.db
      .prepare(
        "UPDATE group_poster_materials SET local_file_path = NULL, cache_status = 'expired', cache_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
  }

  hasGroupPostedMaterial(groupId: string, materialId: string): boolean {
    if (
      this.db
        .prepare('SELECT 1 FROM group_poster_logs WHERE group_id=? AND material_id=? LIMIT 1')
        .get(groupId, materialId)
    ) {
      return true;
    }
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM group_poster_operations WHERE group_id=? AND material_id=? AND status IN ('VERIFIED', 'PENDING_REVIEW') LIMIT 1",
        )
        .get(groupId, materialId),
    );
  }

  recordPost(input: PosterLog): boolean {
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT 1 FROM group_poster_logs WHERE id=? LIMIT 1')
        .get(input.id);
      if (existing) return false;
      let resolvedAccountAvatar = input.accountAvatar;
      if (input.identityType === 'personal' && !isLocalAvatar(resolvedAccountAvatar)) {
        const hasCache = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_account_cache'",
            )
            .get(),
        );
        if (hasCache) {
          const cachedRow = this.db
            .prepare(
              'SELECT avatar_url FROM profile_account_cache WHERE profile_id=? AND (account_id=? OR account_id IS NULL) LIMIT 1',
            )
            .get(input.profileId, input.accountId) as { avatar_url?: string | null } | undefined;
          if (cachedRow?.avatar_url && String(cachedRow.avatar_url).trim()) {
            resolvedAccountAvatar = String(cachedRow.avatar_url).trim();
          }
        }
      }
      this.db
        .prepare(
          `INSERT INTO group_poster_logs(
             id,profile_id,account_id,account_name,account_avatar,identity_type,
             group_id,group_name,group_avatar,material_id,caption_preview,post_id,post_url,posted_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.profileId,
          input.accountId,
          input.accountName,
          resolvedAccountAvatar,
          input.identityType,
          input.groupId,
          input.groupName,
          input.groupAvatar,
          input.materialId,
          input.captionPreview,
          input.postId,
          input.postUrl,
          input.postedAt,
        );
      this.db
        .prepare(
          'UPDATE group_poster_materials SET used_count=used_count+1,last_used_at=?,updated_at=? WHERE id=?',
        )
        .run(input.postedAt, input.postedAt, input.materialId);
      this.targetLibrary.incrementGroupPostedCount(input.groupId, 1);
      return true;
    });
  }

  logs(search = '', limit = 200, before?: number, beforeId = '\uffff'): PosterLog[] {
    return this.db
      .prepare(
        `SELECT * FROM group_poster_logs
          WHERE (posted_at<? OR (posted_at=? AND id<?))
            AND (?='' OR instr(lower(group_name||' '||group_id||' '||account_name||' '||account_id||' '||caption_preview||' '||post_url),lower(?))>0)
          ORDER BY posted_at DESC,id DESC LIMIT ?`,
      )
      .all(
        before ?? Date.now() + 1000,
        before ?? Date.now() + 1000,
        beforeId,
        search,
        search,
        Math.max(1, Math.min(1000, limit)),
      )
      .map((r) => ({
        id: String(r.id),
        profileId: String(r.profile_id),
        accountId: String(r.account_id),
        accountName: String(r.account_name ?? ''),
        accountAvatar: r.account_avatar == null ? null : String(r.account_avatar),
        identityType: String(r.identity_type) === 'page' ? 'page' : 'personal',
        groupId: String(r.group_id),
        groupName: String(r.group_name ?? ''),
        groupAvatar: r.group_avatar == null ? null : String(r.group_avatar),
        materialId: String(r.material_id),
        captionPreview: String(r.caption_preview ?? ''),
        postId: String(r.post_id),
        postUrl: String(r.post_url),
        postedAt: Number(r.posted_at),
      }));
  }

  pendingReviewOperations(limit = 100): PosterPendingOperation[] {
    return this.db
      .prepare(
        `SELECT operation_id, profile_id, account_id, group_id, group_name, material_id, review_reason, updated_at
           FROM group_poster_operations
          WHERE status = 'PENDING_REVIEW'
          ORDER BY updated_at DESC, operation_id DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit)))
      .map((r) => ({
        id: String(r.operation_id),
        profileId: String(r.profile_id),
        accountId: String(r.account_id),
        groupId: String(r.group_id),
        groupName: String(r.group_name),
        materialId: r.material_id == null ? null : String(r.material_id),
        reason: r.review_reason == null ? null : String(r.review_reason),
        updatedAt: Number(r.updated_at ?? 0),
      }));
  }

  deleteLogs(input: unknown): number {
    const { ids, all } = z
      .object({ ids: z.array(z.string()).max(1000).default([]), all: z.boolean().default(false) })
      .strict()
      .parse(input);
    return transaction(this.db, () => {
      const changes = Number(
        this.db
          .prepare(
            'DELETE FROM group_poster_logs WHERE ?=1 OR id IN (SELECT value FROM json_each(?))',
          )
          .run(all ? 1 : 0, JSON.stringify(ids)).changes,
      );
      if (changes > 0) {
        this.db
          .prepare(
            `UPDATE shared_facebook_groups
                SET posted_count = (
                  SELECT COUNT(*) FROM group_poster_logs
                   WHERE group_poster_logs.group_id = shared_facebook_groups.group_id
                )`,
          )
          .run();
      }
      return changes;
    });
  }

  total(): number {
    return Number(this.db.prepare('SELECT COUNT(*) n FROM group_poster_logs').get()?.n ?? 0);
  }

  todayCounts(): Record<string, number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Object.fromEntries(
      this.db
        .prepare(
          'SELECT profile_id,COUNT(*) n FROM group_poster_logs WHERE posted_at>=? GROUP BY profile_id',
        )
        .all(today.getTime())
        .map((r) => [String(r.profile_id), Number(r.n)]),
    );
  }

  weeklyDailyCounts(now = Date.now()): BumperDailyStat[] {
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);
    const tomorrow = new Date(base);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sixDaysAgo = new Date(base);
    sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
    const startMs = sixDaysAgo.getTime();
    const endMs = tomorrow.getTime();

    const buckets = new Map<string, number>();
    const days: string[] = [];
    for (let offset = 0; offset <= 6; offset += 1) {
      const d = new Date(base);
      d.setDate(d.getDate() - offset);
      const ymd = formatLocalYmd(d);
      days.push(ymd);
      buckets.set(ymd, 0);
    }

    const rows = this.db
      .prepare('SELECT posted_at FROM group_poster_logs WHERE posted_at >= ? AND posted_at < ?')
      .all(startMs, endMs);
    for (const r of rows) {
      const ymd = formatLocalYmd(new Date(Number(r.posted_at)));
      if (buckets.has(ymd)) {
        buckets.set(ymd, (buckets.get(ymd) ?? 0) + 1);
      }
    }

    return days.map((date) => ({ date, count: buckets.get(date) ?? 0 }));
  }

  saveProfileResult(input: unknown): void {
    const result = ProfileTaskResult.parse(input);
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_task_results'")
      .get();
    if (!row) return;
    this.db
      .prepare(
        `INSERT INTO profile_task_results VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(profile_id) DO UPDATE SET
           source=excluded.source,
           run_id=excluded.run_id,
           name=excluded.name,
           state=excluded.state,
           reason=excluded.reason,
           finished_at=excluded.finished_at,
           failed_steps=excluded.failed_steps,
           skipped_steps=excluded.skipped_steps`,
      )
      .run(
        result.profileId,
        result.source,
        result.runId,
        result.name,
        result.state,
        result.reason,
        result.finishedAt,
        result.failedSteps,
        result.skippedSteps,
      );
  }
}
