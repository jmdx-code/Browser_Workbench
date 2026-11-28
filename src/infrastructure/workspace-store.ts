import { SqliteTargetLists } from './target-list-store.js';
import { SqliteTargetLibraryRepository } from './target-library-store.js';
import { SqliteGroupBumperRepository } from './group-bumper-store.js';
import { SqliteGroupPosterRepository } from './group-poster-store.js';
import { DEFAULT_CONCURRENT_PROFILES } from '../shared/task-policies.js';
import { SqliteDataCleanup } from './data-cleanup-store.js';
import type { SynchronousRepository } from '../domain/persistence.js';
import { SqliteActivityStatsRepository } from './activity-stats-store.js';
import { SqlitePostBumpRecordsRepository } from './post-bump-records-store.js';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SqliteTaskRepository } from './task-store.js';
import { transaction } from './sqlite-transaction.js';
import { prepareCached } from './sqlite-statement-cache.js';
import { SqliteResourceTableRepository } from './resource-table-store.js';
import { SqliteMaterialUsageRepository } from './material-usage-store.js';
import { SqliteGroupInviterRepository } from './group-inviter-store.js';
import { SqliteBluestacksRepository } from './bluestacks-store.js';
import { SqliteAutoSchedulerRepository } from './auto-scheduler-store.js';
import { SqliteGoogleSheetsRepository } from './google-sheets-store.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import {
  initializeOrMigrateWorkspaceDb,
  workspaceSchemaVersion,
} from './persistence/workspace-migrations.js';
import {
  type AccountCacheUpdateInput,
  mergeAccountCacheUpdate,
} from '../shared/account-state-policy.js';
import {
  ProfileLaunchBinding,
  type ProfileLaunchBinding as ProfileLaunchBindingValue,
} from '../shared/profile-lifecycle.js';
import { isLocalAvatar } from '../shared/group-bumper.js';
import {
  ProductError,
  failError,
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
  SavedCombinationSchema,
  type Combination,
  type Group,
  type Profile,
  type SavedCombination,
} from '../shared/contracts.js';
export { workspaceSchemaVersion };
const VALID_ACCOUNT_STATES = new Set([
  'unknown',
  'logged-in',
  'logged-out',
  'restricted',
  'verification',
]);
export class WorkspaceStore implements WorkspaceRepository {
  private stmt = (sql: string) => prepareCached(this.db, sql);
  targetFolders = (kind: import('../shared/target-list.js').TargetListKind) =>
    new SqliteTargetLists(this.db).folders(kind);
  targetListCommand = (input: unknown) => new SqliteTargetLists(this.db).command(input);
  reorderGroups(ids: string[]) {
    return this.transaction(() => {
      const curIds = new Set(this.groups().map((g) => g.id));
      Q.assertCompleteIdOrder(ids, curIds, 'GROUP_ORDER_INVALID', '分组列表已变化，请刷新');
      const stmt = this.stmt('UPDATE groups SET sort_order=? WHERE id=?');
      ids.forEach((id, i) => stmt.run(i, id));
    });
  }
  ensureProfileOrders(ids: string[]) {
    const insSql = 'INSERT INTO profile_metadata(profile_id,group_id,sort_order) VALUES(?,NULL,?)';
    this.transaction(() => {
      let next = Q.nextSortOrder(this.db, 'profile_metadata', 'group_id IS NULL');
      const get = this.stmt('SELECT 1 FROM profile_metadata WHERE profile_id=?'),
        ins = this.stmt(insSql);
      for (const id of ids) if (!get.get(id)) ins.run(id, next++);
    });
  }
  reorderProfiles(ids: string[], groupId: string | null) {
    const insSql =
      'INSERT INTO profile_metadata(profile_id,group_id,sort_order) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET group_id=excluded.group_id,sort_order=excluded.sort_order';
    const selSql =
      'SELECT profile_id FROM profile_metadata WHERE group_id IS ? ORDER BY sort_order,profile_id';
    return this.transaction(() => {
      if (groupId && !this.stmt('SELECT id FROM groups WHERE id=?').get(groupId))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在', 404);
      const stmt = this.stmt(insSql),
        moved = [...new Set(ids)];
      const rest = this.stmt(selSql)
        .all(groupId)
        .map((r) => String(r.profile_id))
        .filter((id) => !moved.includes(id));
      [...moved, ...rest].forEach((id, i) => stmt.run(id, groupId, i));
    });
  }
  maintenanceSettings() {
    const sql = 'SELECT revision,log_retention_days FROM workspace_preferences WHERE id=1';
    const row = this.stmt(sql).get();
    return MaintenanceSettings.parse({
      version: 1,
      revision: row?.revision,
      logRetentionDays: row?.log_retention_days,
    });
  }
  updateMaintenanceSettings(input: MaintenanceUpdate) {
    const req = UpdateMaintenanceSettings.parse(input),
      sql =
        'UPDATE workspace_preferences SET revision=revision+1,log_retention_days=? WHERE id=1 AND revision=?';
    return transaction(this.db, () => {
      if (this.stmt(sql).run(req.logRetentionDays, req.expectedRevision).changes !== 1)
        failError('PREFERENCES_REVISION_CONFLICT', '设置已在其他窗口修改，请重新读取后保存', 409);
      return this.maintenanceSettings();
    });
  }
  taskNotificationCursor = () =>
    Number(
      this.stmt('SELECT coalesce(max(sequence),0) AS sequence FROM task_events').get()?.sequence,
    );
  taskNotificationEvents(after: number) {
    if (!Number.isSafeInteger(after) || after < 0) throw Error('TASK_NOTIFICATION_CURSOR_INVALID');
    const sql =
      "SELECT sequence,type FROM task_events WHERE sequence>? AND type IN ('FAILED','COMPLETED') ORDER BY sequence LIMIT 100";
    return this.stmt(sql)
      .all(after)
      .map((r) => ({
        sequence: Number(r.sequence),
        type: r.type === 'FAILED' ? ('FAILED' as const) : ('COMPLETED' as const),
      }));
  }
  preferences() {
    const row = this.stmt('SELECT * FROM workspace_preferences WHERE id=1').get();
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
    const req = UpdateWorkspacePreferences.parse(input),
      v = req.values;
    return transaction(this.db, () => {
      const hasColors = v.combinationColors !== undefined;
      const sql = hasColors
        ? 'UPDATE workspace_preferences SET revision=revision+1,default_time_zone=?,desktop_notifications=?,combination_colors=? WHERE id=1 AND revision=?'
        : 'UPDATE workspace_preferences SET revision=revision+1,default_time_zone=?,desktop_notifications=? WHERE id=1 AND revision=?';
      const args = hasColors
        ? [
            v.defaultTimeZone,
            v.desktopNotifications,
            JSON.stringify(v.combinationColors),
            req.expectedRevision,
          ]
        : [v.defaultTimeZone, v.desktopNotifications, req.expectedRevision];
      if (this.stmt(sql).run(...args).changes !== 1)
        failError('PREFERENCES_REVISION_CONFLICT', '设置已在其他窗口修改，请重新读取后保存', 409);
      if (v.windowLayout !== undefined)
        this.stmt('UPDATE workspace_preferences SET window_layout=? WHERE id=1').run(
          JSON.stringify(v.windowLayout),
        );
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
  readonly targetLibrary: SqliteTargetLibraryRepository;
  readonly groupInviter: SqliteGroupInviterRepository;
  readonly groupBumper: SqliteGroupBumperRepository;
  readonly groupPoster: SqliteGroupPosterRepository;
  readonly bluestacks: SqliteBluestacksRepository;
  readonly autoScheduler: SqliteAutoSchedulerRepository;
  readonly googleSheets: SqliteGoogleSheetsRepository;
  readonly postBumpRecords: SqlitePostBumpRecordsRepository;
  readonly activityStats: SqliteActivityStatsRepository;
  private constructor(private readonly db: DatabaseSync) {
    this.materialUsage = new SqliteMaterialUsageRepository(db);
    this.resourceTables = new SqliteResourceTableRepository(db);
    this.tasks = new SqliteTaskRepository(db);
    this.dataCleanup = new SqliteDataCleanup(db);
    this.targetLibrary = new SqliteTargetLibraryRepository(db);
    this.groupInviter = new SqliteGroupInviterRepository(db);
    this.groupBumper = new SqliteGroupBumperRepository(db);
    this.groupPoster = new SqliteGroupPosterRepository(db);
    this.bluestacks = new SqliteBluestacksRepository(db);
    this.autoScheduler = new SqliteAutoSchedulerRepository(db);
    this.googleSheets = new SqliteGoogleSheetsRepository(db);
    this.postBumpRecords = new SqlitePostBumpRecordsRepository(db);
    this.activityStats = new SqliteActivityStatsRepository(db);
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
      const version = await initializeOrMigrateWorkspaceDb(db, file, existed, onProgress),
        store = new WorkspaceStore(db);
      store.resourceTables.pruneConsumedRows();
      if (existed && file !== ':memory:') {
        try {
          const pages = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0),
            free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
          if (
            version < workspaceSchemaVersion ||
            (pages > 0 && free >= 1024 && free / pages > 0.25)
          )
            db.exec(
              'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);',
            );
        } catch {}
        try {
          const dir = path.dirname(file),
            prefix = path.basename(file) + '.before-v';
          const entries = (await readdir(dir)).filter(
            (n) => n.startsWith(prefix) && n.endsWith('.sqlite'),
          );
          if (entries.length > 2) {
            const stampOf = (n: string) => Number(/-(\d+)\.sqlite$/.exec(n)?.[1] ?? 0);
            entries.sort((a, b) => stampOf(b) - stampOf(a) || b.localeCompare(a));
            for (const stale of entries.slice(2))
              await unlink(path.join(dir, stale)).catch(() => {});
          }
        } catch {}
      }
      if (version === 0)
        store.tasks.setSettings({ maxConcurrentProfiles: DEFAULT_CONCURRENT_PROFILES });
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
  }
  private transaction = <T>(work: () => T): T => transaction(this.db, work);
  groups = (): Group[] =>
    this.stmt('SELECT id,name,color,sort_order AS "order" FROM groups ORDER BY sort_order,id')
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        color: r.color as Group['color'],
        order: Number(r.order),
      }));
  createGroup(name: string, color: Group['color']): Group {
    return this.transaction(() => {
      if (this.stmt('SELECT id FROM groups WHERE name=?').get(name))
        throw new ProductError('GROUP_NAME_EXISTS', '分组名称已存在', 409);
      const group: Group = { id: randomUUID(), name, color, order: this.groups().length };
      this.stmt('INSERT INTO groups VALUES(?,?,?,?)').run(group.id, name, color, group.order);
      return group;
    });
  }
  renameGroup(id: string, name: string) {
    this.transaction(() => {
      if (!this.stmt('SELECT id FROM groups WHERE id=?').get(id))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在', 404);
      if (this.stmt('SELECT id FROM groups WHERE name=? AND id<>?').get(name, id))
        throw new ProductError('GROUP_NAME_EXISTS', '分组名称已存在', 409);
      this.stmt('UPDATE groups SET name=? WHERE id=?').run(name, id);
    });
  }
  deleteGroup(id: string): number {
    const sql =
      'SELECT profile_id FROM profile_metadata WHERE group_id=? ORDER BY sort_order,profile_id';
    return this.transaction(() => {
      if (!this.stmt('SELECT id FROM groups WHERE id=?').get(id))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在，请重新读取列表', 404);
      const ids = this.stmt(sql)
        .all(id)
        .map((r) => String(r.profile_id));
      this.moveProfiles(ids, null);
      this.stmt('DELETE FROM groups WHERE id=?').run(id);
      return ids.length;
    });
  }
  moveProfiles(profileIds: string[], groupId: string | null) {
    const sql =
      'INSERT INTO profile_metadata(profile_id,group_id,sort_order) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET group_id=excluded.group_id,sort_order=excluded.sort_order';
    this.transaction(() => {
      if (groupId && !this.stmt('SELECT id FROM groups WHERE id=?').get(groupId))
        throw new ProductError('GROUP_NOT_FOUND', '分组不存在', 404);
      const insert = this.stmt(sql);
      let order = Q.nextSortOrder(this.db, 'profile_metadata', 'group_id IS ?', groupId);
      for (const id of new Set(profileIds)) insert.run(id, groupId, order++);
    });
  }
  renameProfile = (id: string, alias: string) => {
    const sql =
      'INSERT INTO profile_metadata(profile_id,alias) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET alias=excluded.alias';
    this.stmt(sql).run(id, alias);
  };
  deleteProfiles(profileIds: string[]): number {
    return this.transaction(() => {
      const uniqueIds = [...new Set(profileIds)],
        busySql =
          "SELECT id FROM task_plans WHERE profile_id=? AND state NOT IN ('STOPPED','COMPLETED','FAILED') LIMIT 1";
      for (const id of uniqueIds)
        if (this.stmt(busySql).get(id))
          throw new ProductError('PROFILE_TASK_ACTIVE', '请先停止或完成该浏览器的任务再删除', 409);
      const tables = [
        'profile_metadata',
        'profile_account_cache',
        'profile_task_results',
        'profile_launch_bindings',
      ];
      for (const t of tables) {
        const st = this.stmt(`DELETE FROM ${t} WHERE profile_id=?`);
        for (const id of uniqueIds) st.run(id);
      }
      return uniqueIds.length;
    });
  }
  profileMetadata = () =>
    new Map(
      this.stmt('SELECT * FROM profile_metadata')
        .all()
        .map((r) => [
          Q.s(r.profile_id),
          { groupId: Q.sn(r.group_id), alias: Q.sn(r.alias), order: Q.n(r.sort_order) },
        ]),
    );
  profileAccountCache(): Map<string, CachedProfileAccount> {
    return new Map(
      this.stmt('SELECT * FROM profile_account_cache')
        .all()
        .map((row) => {
          const rs = Q.s(row.account_state, 'unknown'),
            state = (VALID_ACCOUNT_STATES.has(rs) ? rs : 'unknown') as Profile['account']['state'],
            rawAv = Q.sn(row.avatar_url);
          const avatar =
            rawAv && isLocalAvatar(rawAv)
              ? state === 'logged-out'
                ? null
                : rawAv
              : ['logged-out', 'restricted', 'verification'].includes(state)
                ? null
                : rawAv;
          return [
            Q.s(row.profile_id),
            {
              state,
              id: Q.sn(row.account_id),
              name: Q.sn(row.account_name),
              avatar,
              avatarUpdatedAt: Q.nn(row.avatar_updated_at) ?? 0,
            },
          ];
        }),
    );
  }
  updateProfileAccountCache(profileId: string, update: AccountCacheUpdateInput): void {
    const merged = mergeAccountCacheUpdate({
      existing: this.profileAccountCache().get(profileId),
      incoming: update,
    });
    if (!merged.changed && update.avatarUpdatedAt === undefined) return;
    const cols = 'profile_id,account_state,account_id,account_name,avatar_url,avatar_updated_at';
    this.transaction(() =>
      Q.upsertFrom(this.db, 'profile_account_cache', 'profile_id', cols, '*', merged.next, {
        profile_id: profileId,
        account_state: merged.next.state,
        account_id: merged.next.id,
        account_name: merged.next.name,
        avatar_url: merged.next.avatar,
      }),
    );
  }
  profileLaunchBindings = (): ProfileLaunchBindingValue[] =>
    this.stmt('SELECT * FROM profile_launch_bindings')
      .all()
      .flatMap((r) => {
        const p = ProfileLaunchBinding.safeParse(Q.camel(r));
        return p.success ? [p.data] : [];
      });
  upsertProfileLaunchBindings(bindings: readonly ProfileLaunchBindingValue[]): void {
    if (!bindings.length) return;
    const cols =
      'profile_id,browser_kind,executable_path,user_data_dir,profile_directory,browser_name,window_name,verified_at';
    this.transaction(() => {
      for (const item of bindings)
        Q.upsertFrom(
          this.db,
          'profile_launch_bindings',
          'profile_id',
          cols,
          '*',
          ProfileLaunchBinding.parse(item),
        );
    });
  }
  combinations = () => {
    const sql = 'SELECT id FROM combinations WHERE deleted_at IS NULL ORDER BY updated_at DESC,id';
    return this.stmt(sql)
      .all()
      .map((r) => this.get(String(r.id)));
  };
  private get(id: string): SavedCombination {
    const row = this.stmt('SELECT * FROM combinations WHERE id=? AND deleted_at IS NULL').get(id);
    if (!row) throw new ProductError('COMBINATION_NOT_FOUND', '任务组合不存在', 404);
    const version = Number(row.current_version),
      sql = 'SELECT body FROM combination_versions WHERE combination_id=? AND version=?';
    const saved = version > 0 ? this.stmt(sql).get(id, version) : null;
    return SavedCombinationSchema.parse({
      id,
      version,
      revision: Number(row.revision),
      saved: saved ? (JSON.parse(String(saved.body)) as unknown) : null,
      draft: null,
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
    const body = JSON.stringify(CombinationSchema.parse(value)),
      sql =
        'INSERT INTO combinations(id,current_version,revision,draft,updated_at) VALUES(?,1,0,NULL,?)';
    return this.transaction(() => {
      const id = randomUUID(),
        now = Date.now();
      this.stmt(sql).run(id, now);
      this.stmt('INSERT INTO combination_versions VALUES(?,1,?,?)').run(id, body, now);
      return this.get(id);
    });
  }
  saveCombination(id: string, expectedRevision: number, value: Combination) {
    const valid = CombinationSchema.parse(value),
      sql =
        'UPDATE combinations SET current_version=?,draft=NULL,revision=revision+1,updated_at=? WHERE id=?';
    return this.transaction(() => {
      const version = this.checkRevision(id, expectedRevision).version + 1,
        now = Date.now();
      this.stmt('INSERT INTO combination_versions VALUES(?,?,?,?)').run(
        id,
        version,
        JSON.stringify(valid),
        now,
      );
      this.stmt(sql).run(version, now, id);
      return this.get(id);
    });
  }
  deleteCombination(id: string) {
    const busySql =
      "SELECT id FROM task_plans WHERE combination_id=? AND state NOT IN ('STOPPED','COMPLETED','FAILED') LIMIT 1";
    this.transaction(() => {
      this.get(id);
      if (this.stmt(busySql).get(id))
        failError('COMBINATION_IN_USE', '该任务组合正在被浏览器使用，请先停止相关任务再删除', 409);
      const now = Date.now();
      this.stmt('UPDATE combinations SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, id);
    });
  }
}
type WorkspaceRepository = SynchronousRepository<CompatibleWorkspaceRepository>;
