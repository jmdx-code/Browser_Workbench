import { profileTaskResultMigration } from './profile-task-result-migration.js';
import { DEFAULT_CONCURRENT_PROFILES } from '../shared/task-capacity.js';
import { groupInviterConfirmationMigration } from './group-inviter-store.js';
import {
  SqliteDataCleanup,
  dataCleanupMigration,
  physicalHistoryCleanupMigration,
  cleanupQuotaMigration,
  cleanupIndexesMigration,
} from './data-cleanup-store.js';
import type { SynchronousRepository } from '../domain/persistence.js';
import { taskRecordMigration } from './task-record-migration.js';
import { taskCapacityMigration } from './task-capacity-migration.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { taskMigration } from './task-migration.js';
import { taskExecutionMigration } from './task-execution-migration.js';
import { taskTabMigration } from './task-tab-migration.js';
import { settlementMigration } from './settlement-migration.js';
import { taskControlMigration } from './task-control-migration.js';
import { SqliteTaskControlRepository } from './task-control-store.js';
import { browseIntentMigration } from './browse-intent-migration.js';
import { SqliteBrowseIntentRepository } from './browse-intent-store.js';
import { materialIndexMigration } from './material-index-migration.js';
import { SqliteMaterialIndexRepository } from './material-index-store.js';
import { materialPostMigration } from './material-post-migration.js';
import { SqliteMaterialPostRepository } from './material-post-store.js';
import { materialUploadStageMigration } from './material-upload-stage-migration.js';
import { SqliteMaterialUploadStageRepository } from './material-upload-stage-store.js';
import { materialCacheCleanupMigration } from './material-cache-cleanup-migration.js';
import { SqliteMaterialCacheCleanupRepository } from './material-cache-cleanup-store.js';
import { materialArchivePreparationMigration } from './material-archive-migration.js';
import { SqliteMaterialArchivePreparationRepository } from './material-archive-store.js';
import { SqliteTaskTabRepository } from './task-tab-store.js';
import { SqliteTaskRepository } from './task-store.js';
import { transaction } from './sqlite-transaction.js';
import { resourceTableMigration } from './resource-table-migration.js';
import { taskResourceMigration } from './task-resource-migration.js';
import { SqliteResourceTableRepository } from './resource-table-store.js';
import { postObservationMigration } from './post-observation-migration.js';
import { materialArchiveExecutionMigration } from './material-archive-execution-migration.js';
import { browseActionMigration } from './browse-action-migration.js';
import { taskEndingMigration } from './task-ending-migration.js';
import { marketplaceTaskMigration } from './marketplace-task-migration.js';
import { materialUsageMigration } from './material-usage-migration.js';
import { marketplaceFilterMigration } from './marketplace-filter-migration.js';
import { taskTimingMigration } from './task-timing-migration.js';
import { taskStepOutcomeMigration } from './task-step-outcome-migration.js';
import { taskPageLifecycleMigration } from './task-page-lifecycle-migration.js';
import { storyVideoDerivationMigration } from './story-video-derivation-migration.js';
import { SqliteMaterialUsageRepository } from './material-usage-store.js';
import { SqliteMaterialArchiveExecutionRepository } from './material-archive-execution-store.js';
import { assertArchiveSourcesAvailable } from './material-archive-source-protection.js';
import { SqliteFacebookSubmissionObservationRepository } from './facebook-submission-observation-store.js';
import { SqliteGroupInviterRepository } from './group-inviter-store.js';
import {
  ProductError,
  type CachedProfileAccount,
  WorkspaceRepository as CompatibleWorkspaceRepository,
} from '../domain/workspace.js';
import {
  MaintenanceSettings,
  UpdateMaintenanceSettings,
  type MaintenanceUpdate,
} from '../shared/runtime-log.js';
import {
  WorkspacePreferences,
  UpdateWorkspacePreferences,
  type PreferenceUpdate,
} from '../shared/workspace-preferences.js';
import {
  CombinationSchema,
  CombinationDraftSchema,
  SavedCombinationSchema,
  type Combination,
  type Group,
  type Profile,
  type SavedCombination,
} from '../shared/contracts.js';

const migrations = [
  [
    'CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,color TEXT NOT NULL,sort_order INTEGER NOT NULL)',
    'CREATE TABLE profile_metadata(profile_id TEXT PRIMARY KEY,group_id TEXT REFERENCES groups(id),alias TEXT)',
    'CREATE TABLE combinations(id TEXT PRIMARY KEY,current_version INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,draft TEXT,updated_at INTEGER NOT NULL)',
    'CREATE TABLE combination_versions(combination_id TEXT NOT NULL REFERENCES combinations(id),version INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(combination_id,version))',
    "CREATE TRIGGER immutable_combination_version BEFORE UPDATE ON combination_versions BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_COMBINATION_VERSION'); END",
  ].join(';'),
  taskMigration,
  taskExecutionMigration,
  taskTabMigration,
  settlementMigration,
  taskControlMigration,
  browseIntentMigration,
  materialIndexMigration,
  materialPostMigration,
  materialUploadStageMigration,
  materialCacheCleanupMigration,
  materialArchivePreparationMigration,
  resourceTableMigration,
  taskResourceMigration,
  postObservationMigration,
  materialArchiveExecutionMigration,
  browseActionMigration,
  taskEndingMigration,
  marketplaceTaskMigration,
  materialUsageMigration,
  marketplaceFilterMigration,
  taskTimingMigration,
  taskStepOutcomeMigration,
  taskPageLifecycleMigration,
  "UPDATE workspace_execution_contracts SET version=2 WHERE name='task-page-lifecycle'",
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('post-home-preparation',1)",
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('browse-wheel-visual-anchor',2)",
  "CREATE TABLE workspace_preferences(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=0),default_time_zone TEXT,desktop_notifications TEXT NOT NULL CHECK(desktop_notifications IN ('off','failures','all'))); INSERT INTO workspace_preferences VALUES(1,0,NULL,'off')",
  'ALTER TABLE workspace_preferences ADD COLUMN log_retention_days INTEGER NOT NULL DEFAULT 14 CHECK(log_retention_days BETWEEN 1 AND 90)',
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('post-native-background',1); CREATE UNIQUE INDEX one_original_post_background ON material_post_operations(attempt_id) WHERE purpose='SET_BACKGROUND'",
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('story-friends-privacy',1); CREATE UNIQUE INDEX one_original_story_friends ON material_post_operations(attempt_id) WHERE purpose='SELECT_FRIENDS'; CREATE UNIQUE INDEX one_original_story_audience_check ON material_post_operations(attempt_id) WHERE purpose='VERIFY_AUDIENCE'; CREATE UNIQUE INDEX one_original_story_audience_close ON material_post_operations(attempt_id) WHERE purpose='CLOSE_AUDIENCE'",
  "INSERT INTO workspace_execution_contracts(name,version) VALUES('post-ai-label',1); CREATE UNIQUE INDEX one_original_post_ai_open ON material_post_operations(attempt_id) WHERE purpose='OPEN_AI_LABEL'; CREATE UNIQUE INDEX one_original_post_ai_set ON material_post_operations(attempt_id) WHERE purpose='SET_AI_LABEL'; CREATE UNIQUE INDEX one_original_post_ai_confirm ON material_post_operations(attempt_id) WHERE purpose='CONFIRM_AI_LABEL'",
  storyVideoDerivationMigration,
  taskRecordMigration,
  taskCapacityMigration,
  dataCleanupMigration,
  'ALTER TABLE workspace_preferences ADD COLUMN window_layout TEXT',
  profileTaskResultMigration,
  groupInviterConfirmationMigration,
  physicalHistoryCleanupMigration,
  cleanupQuotaMigration,
  cleanupIndexesMigration,
];
export const workspaceSchemaVersion = migrations.length;

export class WorkspaceStore implements WorkspaceRepository {
  maintenanceSettings() {
    const row = this.db
      .prepare('SELECT revision,log_retention_days FROM workspace_preferences WHERE id=1')
      .get();
    return MaintenanceSettings.parse({
      version: 1,
      revision: row?.revision,
      logRetentionDays: row?.log_retention_days,
    });
  }
  updateMaintenanceSettings(input: MaintenanceUpdate) {
    const request = UpdateMaintenanceSettings.parse(input);
    return transaction(this.db, () => {
      const changed = this.db
        .prepare(
          'UPDATE workspace_preferences SET revision=revision+1,log_retention_days=? WHERE id=1 AND revision=?',
        )
        .run(request.logRetentionDays, request.expectedRevision);
      if (changed.changes !== 1)
        throw new ProductError(
          'PREFERENCES_REVISION_CONFLICT',
          '设置已在其他窗口修改，请重新读取后保存',
          409,
        );
      return this.maintenanceSettings();
    });
  }
  taskNotificationCursor() {
    return Number(
      this.db.prepare('SELECT coalesce(max(sequence),0) AS sequence FROM task_events').get()
        ?.sequence,
    );
  }
  taskNotificationEvents(after: number) {
    if (!Number.isSafeInteger(after) || after < 0) throw Error('TASK_NOTIFICATION_CURSOR_INVALID');
    return this.db
      .prepare(
        "SELECT sequence,type FROM task_events WHERE sequence>? AND type IN ('FAILED','COMPLETED') ORDER BY sequence LIMIT 100",
      )
      .all(after)
      .map((row) => ({
        sequence: Number(row.sequence),
        type: row.type === 'FAILED' ? ('FAILED' as const) : ('COMPLETED' as const),
      }));
  }
  preferences() {
    const row = this.db.prepare('SELECT * FROM workspace_preferences WHERE id=1').get();
    const rawColors =
      typeof row?.combination_colors === 'string' && row.combination_colors
        ? row.combination_colors
        : '{}';
    return WorkspacePreferences.parse({
      version: 1,
      revision: row?.revision,
      defaultTimeZone: row?.default_time_zone,
      desktopNotifications: row?.desktop_notifications,
      combinationColors: JSON.parse(rawColors) as unknown,
      ...(typeof row?.window_layout === 'string'
        ? { windowLayout: JSON.parse(row.window_layout) as unknown }
        : {}),
    });
  }
  updatePreferences(input: PreferenceUpdate) {
    const request = UpdateWorkspacePreferences.parse(input);
    return transaction(this.db, () => {
      const changed =
        request.values.combinationColors !== undefined
          ? this.db
              .prepare(
                'UPDATE workspace_preferences SET revision=revision+1,default_time_zone=?,desktop_notifications=?,combination_colors=? WHERE id=1 AND revision=?',
              )
              .run(
                request.values.defaultTimeZone,
                request.values.desktopNotifications,
                JSON.stringify(request.values.combinationColors),
                request.expectedRevision,
              )
          : this.db
              .prepare(
                'UPDATE workspace_preferences SET revision=revision+1,default_time_zone=?,desktop_notifications=? WHERE id=1 AND revision=?',
              )
              .run(
                request.values.defaultTimeZone,
                request.values.desktopNotifications,
                request.expectedRevision,
              );
      if (changed.changes !== 1)
        throw new ProductError(
          'PREFERENCES_REVISION_CONFLICT',
          '设置已在其他窗口修改，请重新读取后保存',
          409,
        );
      if (request.values.windowLayout !== undefined)
        this.db
          .prepare('UPDATE workspace_preferences SET window_layout=? WHERE id=1')
          .run(JSON.stringify(request.values.windowLayout));
      return this.preferences();
    });
  }
  async backup(file: string) {
    await backup(this.db, file);
  }
  readonly materialUsage: SqliteMaterialUsageRepository;
  readonly resourceTables: SqliteResourceTableRepository;
  readonly tasks: SqliteTaskRepository;
  readonly dataCleanup: SqliteDataCleanup;
  readonly taskTabs: SqliteTaskTabRepository;
  readonly taskControls: SqliteTaskControlRepository;
  readonly browseIntents: SqliteBrowseIntentRepository;
  readonly materials: SqliteMaterialIndexRepository;
  readonly materialPosts: SqliteMaterialPostRepository;
  readonly uploadStages: SqliteMaterialUploadStageRepository;
  readonly cacheCleanup: SqliteMaterialCacheCleanupRepository;
  readonly archivePreparation: SqliteMaterialArchivePreparationRepository;
  readonly archiveExecution: SqliteMaterialArchiveExecutionRepository;
  readonly submissionObservations: SqliteFacebookSubmissionObservationRepository;
  readonly groupInviter: SqliteGroupInviterRepository;
  private constructor(private readonly db: DatabaseSync) {
    this.materialUsage = new SqliteMaterialUsageRepository(db);
    this.resourceTables = new SqliteResourceTableRepository(db);
    this.tasks = new SqliteTaskRepository(db);
    this.dataCleanup = new SqliteDataCleanup(db);
    this.taskTabs = new SqliteTaskTabRepository(db, this.tasks);
    this.taskControls = new SqliteTaskControlRepository(db, this.tasks);
    this.browseIntents = new SqliteBrowseIntentRepository(db, this.tasks);
    this.materials = new SqliteMaterialIndexRepository(db, this.tasks, this.taskTabs);
    this.materialPosts = new SqliteMaterialPostRepository(db, this.tasks);
    this.uploadStages = new SqliteMaterialUploadStageRepository(db, this.taskTabs);
    this.cacheCleanup = new SqliteMaterialCacheCleanupRepository(
      db,
      this.uploadStages,
      this.taskTabs,
    );
    this.archivePreparation = new SqliteMaterialArchivePreparationRepository(db);
    this.archiveExecution = new SqliteMaterialArchiveExecutionRepository(
      db,
      this.archivePreparation,
    );
    this.submissionObservations = new SqliteFacebookSubmissionObservationRepository(db);
    this.groupInviter = new SqliteGroupInviterRepository(db);
  }
  static async open(file: string, onProgress?: (completed: number, total: number) => void) {
    let existed = true;
    try {
      await access(file);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      existed = false;
    }
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (typeof version !== 'number' || version > migrations.length)
        throw new ProductError('DATABASE_VERSION_TOO_NEW', '数据库版本不兼容，已停止打开', 409);
      if (existed && version < migrations.length) onProgress?.(0, 0);
      if (existed && version < migrations.length)
        await backup(db, file + '.before-v' + migrations.length + '-' + Date.now() + '.sqlite');
      db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      } catch {}
      for (let next = version; next < migrations.length; next++) {
        const sql = migrations[next];
        if (!sql) throw new Error('MIGRATION_MISSING');
        const rebuild =
          sql === materialUsageMigration ||
          sql === taskStepOutcomeMigration ||
          sql === taskPageLifecycleMigration;
        if (rebuild) db.exec('PRAGMA foreign_keys=OFF');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (
            sql !== cleanupQuotaMigration ||
            !db
              .prepare('PRAGMA table_info(data_cleanup_settings)')
              .all()
              .some((column) => column.name === 'history_max_count')
          )
            db.exec(sql);
          if (rebuild && db.prepare('PRAGMA foreign_key_check').all().length)
            throw Error('MATERIAL_USAGE_MIGRATION_FOREIGN_KEY_FAILED');
          db.exec('PRAGMA user_version=' + (next + 1));
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        } finally {
          if (rebuild) db.exec('PRAGMA foreign_keys=ON');
        }
      }
      const prefColumns = db.prepare('PRAGMA table_info(workspace_preferences)').all() as {
        name: string;
      }[];
      if (!prefColumns.some((col) => col.name === 'combination_colors'))
        db.exec(
          "ALTER TABLE workspace_preferences ADD COLUMN combination_colors TEXT NOT NULL DEFAULT '{}'",
        );
      const comboColumns = db.prepare('PRAGMA table_info(combinations)').all() as {
        name: string;
      }[];
      if (!comboColumns.some((col) => col.name === 'deleted_at'))
        db.exec('ALTER TABLE combinations ADD COLUMN deleted_at INTEGER DEFAULT NULL');
      db.exec(
        "CREATE TABLE IF NOT EXISTS profile_account_cache(profile_id TEXT PRIMARY KEY,account_state TEXT NOT NULL DEFAULT 'unknown',account_id TEXT,account_name TEXT,avatar_url TEXT,avatar_updated_at INTEGER NOT NULL DEFAULT 0)",
      );
      const store = new WorkspaceStore(db);
      store.resourceTables.pruneConsumedRows();
      // Initialize only a new database. Existing user choices survive reopen
      // and upgrades; the running installation can be changed through Settings.
      if (version === 0)
        store.tasks.setSettings({ maxConcurrentProfiles: DEFAULT_CONCURRENT_PROFILES });
      await store.tasks.recordReader.initialize(onProgress);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close() {
    this.tasks.closeCheckpoints();
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
  }
  private transaction<T>(work: () => T): T {
    return transaction(this.db, work);
  }
  groups(): Group[] {
    return this.db
      .prepare('SELECT id,name,color,sort_order AS "order" FROM groups ORDER BY sort_order,id')
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        color: row.color as Group['color'],
        order: Number(row.order),
      }));
  }
  createGroup(name: string, color: Group['color']): Group {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM groups WHERE name=?').get(name))
        throw new ProductError('GROUP_NAME_EXISTS', '分组名称已存在', 409);
      const group: Group = { id: randomUUID(), name, color, order: this.groups().length };
      this.db.prepare('INSERT INTO groups VALUES(?,?,?,?)').run(group.id, name, color, group.order);
      return group;
    });
  }
  renameGroup(id: string, name: string) {
    this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM groups WHERE id=?').get(id))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在', 404);
      if (this.db.prepare('SELECT id FROM groups WHERE name=? AND id<>?').get(name, id))
        throw new ProductError('GROUP_NAME_EXISTS', '分组名称已存在', 409);
      this.db.prepare('UPDATE groups SET name=? WHERE id=?').run(name, id);
    });
  }
  deleteGroup(id: string): number {
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM groups WHERE id=?').get(id))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在，请重新读取列表', 404);
      const moved = this.db
        .prepare('UPDATE profile_metadata SET group_id=NULL WHERE group_id=?')
        .run(id);
      this.db.prepare('DELETE FROM groups WHERE id=?').run(id);
      return Number(moved.changes);
    });
  }
  moveProfiles(profileIds: string[], groupId: string | null) {
    this.transaction(() => {
      if (groupId && !this.db.prepare('SELECT id FROM groups WHERE id=?').get(groupId))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在', 404);
      const insert = this.db.prepare(
        'INSERT INTO profile_metadata(profile_id,group_id) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET group_id=excluded.group_id',
      );
      for (const id of new Set(profileIds)) insert.run(id, groupId);
    });
  }
  renameProfile(id: string, alias: string) {
    this.db
      .prepare(
        'INSERT INTO profile_metadata(profile_id,alias) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET alias=excluded.alias',
      )
      .run(id, alias);
  }
  deleteProfiles(profileIds: string[]): number {
    return this.transaction(() => {
      const uniqueIds = [...new Set(profileIds)];
      for (const id of uniqueIds) {
        const active = this.db
          .prepare(
            "SELECT id FROM task_plans WHERE profile_id=? AND state NOT IN ('STOPPED','COMPLETED','FAILED') LIMIT 1",
          )
          .get(id);
        if (active)
          throw new ProductError('PROFILE_TASK_ACTIVE', '请先停止或完成该浏览器的任务再删除', 409);
      }
      const delMeta = this.db.prepare('DELETE FROM profile_metadata WHERE profile_id=?');
      const delCache = this.db.prepare('DELETE FROM profile_account_cache WHERE profile_id=?');
      for (const id of uniqueIds) {
        delMeta.run(id);
        delCache.run(id);
      }
      return uniqueIds.length;
    });
  }
  profileMetadata() {
    return new Map(
      this.db
        .prepare('SELECT * FROM profile_metadata')
        .all()
        .map((row) => [
          String(row.profile_id),
          {
            groupId: row.group_id === null ? null : String(row.group_id),
            alias: row.alias === null ? null : String(row.alias),
          },
        ]),
    );
  }
  profileAccountCache(): Map<string, CachedProfileAccount> {
    const validStates = new Set([
      'unknown',
      'logged-in',
      'logged-out',
      'restricted',
      'verification',
    ]);
    return new Map(
      this.db
        .prepare('SELECT * FROM profile_account_cache')
        .all()
        .map((row) => {
          const rawState = String(row.account_state ?? 'unknown');
          const state = (
            validStates.has(rawState) ? rawState : 'unknown'
          ) as Profile['account']['state'];
          return [
            String(row.profile_id),
            {
              state,
              id:
                row.account_id === null || row.account_id === undefined
                  ? null
                  : String(row.account_id),
              name:
                row.account_name === null || row.account_name === undefined
                  ? null
                  : String(row.account_name),
              avatar:
                ['logged-out', 'restricted', 'verification'].includes(state) ||
                row.avatar_url === null ||
                row.avatar_url === undefined
                  ? null
                  : String(row.avatar_url),
              avatarUpdatedAt: Number(row.avatar_updated_at ?? 0),
            },
          ];
        }),
    );
  }
  updateProfileAccountCache(profileId: string, update: Partial<CachedProfileAccount>): void {
    const existing = this.profileAccountCache().get(profileId) ?? {
      state: 'unknown' as const,
      id: null,
      name: null,
      avatar: null,
      avatarUpdatedAt: 0,
    };
    const nextState = update.state ?? existing.state;
    const isAbnormal = ['logged-out', 'restricted', 'verification'].includes(nextState);
    const nextId = update.id !== undefined ? update.id : existing.id;
    const nextName = update.name !== undefined ? update.name : existing.name;
    const nextAvatar = isAbnormal
      ? null
      : update.avatar !== undefined
        ? update.avatar
        : existing.avatar;
    if (
      existing.state === nextState &&
      existing.id === nextId &&
      existing.name === nextName &&
      existing.avatar === nextAvatar &&
      update.avatarUpdatedAt === undefined
    ) {
      return;
    }
    this.transaction(() => {
      const nextUpdatedAt =
        update.avatarUpdatedAt !== undefined
          ? update.avatarUpdatedAt
          : update.avatar !== undefined && update.avatar !== null
            ? Date.now()
            : existing.avatarUpdatedAt;
      this.db
        .prepare(
          `INSERT INTO profile_account_cache(profile_id,account_state,account_id,account_name,avatar_url,avatar_updated_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(profile_id) DO UPDATE SET
             account_state=excluded.account_state,
             account_id=excluded.account_id,
             account_name=excluded.account_name,
             avatar_url=excluded.avatar_url,
             avatar_updated_at=excluded.avatar_updated_at`,
        )
        .run(profileId, nextState, nextId, nextName, nextAvatar, nextUpdatedAt);
    });
  }
  combinations() {
    return this.db
      .prepare('SELECT id FROM combinations WHERE deleted_at IS NULL ORDER BY updated_at DESC,id')
      .all()
      .map((row) => this.get(String(row.id)));
  }
  private get(id: string): SavedCombination {
    const row = this.db
      .prepare('SELECT * FROM combinations WHERE id=? AND deleted_at IS NULL')
      .get(id);
    if (!row) throw new ProductError('COMBINATION_NOT_FOUND', '任务组合不存在', 404);
    const version = Number(row.current_version);
    const saved =
      version > 0
        ? this.db
            .prepare('SELECT body FROM combination_versions WHERE combination_id=? AND version=?')
            .get(id, version)
        : null;
    return SavedCombinationSchema.parse({
      id,
      version,
      revision: Number(row.revision),
      saved: saved ? (JSON.parse(String(saved.body)) as unknown) : null,
      draft: row.draft === null ? null : (JSON.parse(String(row.draft)) as unknown),
      updatedAt: Number(row.updated_at),
    });
  }
  private checkRevision(id: string, revision: number) {
    const row = this.get(id);
    if (row.revision !== revision)
      throw new ProductError('REVISION_CONFLICT', '组合已在其他窗口修改，请重新打开后编辑', 409);
    return row;
  }
  createCombination(value: Combination) {
    const body = JSON.stringify(CombinationSchema.parse(value));
    return this.transaction(() => {
      const id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO combinations(id,current_version,revision,draft,updated_at) VALUES(?,1,0,NULL,?)',
        )
        .run(id, Date.now());
      this.db.prepare('INSERT INTO combination_versions VALUES(?,1,?,?)').run(id, body, Date.now());
      return this.get(id);
    });
  }
  writeDraft(id: string, expectedRevision: number, value: Combination) {
    const body = JSON.stringify(CombinationDraftSchema.parse(value));
    return this.transaction(() => {
      this.checkRevision(id, expectedRevision);
      this.db
        .prepare('UPDATE combinations SET draft=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(body, Date.now(), id);
      return this.get(id);
    });
  }
  publish(id: string, expectedRevision: number) {
    return this.transaction(() => {
      const row = this.checkRevision(id, expectedRevision);
      if (!row.draft) return row;
      const version = row.version + 1;
      const valid = CombinationSchema.parse(row.draft);
      for (const step of valid.steps)
        if (step.type === 'post' && step.allowRepeat) {
          const paths =
            step.resourceMode === 'table'
              ? this.resourceTables
                  .read(id)
                  .rows.flatMap((r) =>
                    r.media.filter((m) => m.kind === 'local').map((m) => m.source),
                  )
              : (this.materials
                  .current(step.resourceDirectory)
                  ?.sources.flatMap((s) =>
                    s.snapshot.files.map((f) => path.join(step.resourceDirectory, f.relativePath)),
                  ) ?? []);
          assertArchiveSourcesAvailable(this.db, paths);
        }
      this.db
        .prepare('INSERT INTO combination_versions VALUES(?,?,?,?)')
        .run(id, version, JSON.stringify(valid), Date.now());
      this.db
        .prepare(
          'UPDATE combinations SET current_version=?,draft=NULL,revision=revision+1,updated_at=? WHERE id=?',
        )
        .run(version, Date.now(), id);
      return this.get(id);
    });
  }
  discardDraft(id: string, expectedRevision: number) {
    return this.transaction(() => {
      const row = this.checkRevision(id, expectedRevision);
      if (row.version === 0)
        throw new ProductError(
          'NEW_DRAFT_HAS_NO_SAVED_VERSION',
          '新组合没有保存版，不能还原；草稿已保留',
          409,
        );
      this.db
        .prepare('UPDATE combinations SET draft=NULL,revision=revision+1,updated_at=? WHERE id=?')
        .run(Date.now(), id);
      return this.get(id);
    });
  }
  createDraft(value: Combination) {
    const body = JSON.stringify(CombinationDraftSchema.parse(value));
    return this.transaction(() => {
      const id = randomUUID();
      this.db
        .prepare(
          'INSERT INTO combinations(id,current_version,revision,draft,updated_at) VALUES(?,0,0,?,?)',
        )
        .run(id, body, Date.now());
      return this.get(id);
    });
  }
  copyCombination(id: string) {
    return this.transaction(() => {
      const original = this.get(id);
      const value = original.saved ?? original.draft;
      if (!value) throw new ProductError('COMBINATION_EMPTY', '组合没有可复制内容', 409);
      const copied = this.createDraft({
        ...value,
        name: value.name.slice(0, 72) + ' 副本',
        steps: value.steps.map((step) => ({ ...step, id: randomUUID() })),
      });
      const resources = this.resourceTables.read(id);
      if (resources.revision > 0)
        this.resourceTables.save(
          copied.id,
          0,
          resources.rows.map((row) => ({ ...row, id: randomUUID() })),
        );
      return copied;
    });
  }
  deleteCombination(id: string) {
    this.transaction(() => {
      this.get(id);
      const active = this.db
        .prepare(
          "SELECT id FROM task_plans WHERE combination_id=? AND state NOT IN ('STOPPED','COMPLETED','FAILED') LIMIT 1",
        )
        .get(id);
      if (active)
        throw new ProductError(
          'COMBINATION_IN_USE',
          '该任务组合正在被浏览器使用，请先停止相关任务再删除',
          409,
        );
      const now = Date.now();
      this.db
        .prepare('UPDATE combinations SET deleted_at=?,updated_at=? WHERE id=?')
        .run(now, now, id);
    });
  }
}

type WorkspaceRepository = SynchronousRepository<CompatibleWorkspaceRepository>;
