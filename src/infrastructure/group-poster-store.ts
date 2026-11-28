import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { mediaReference } from '../domain/resource-table.js';
import {
  BumperIdsInput,
  BumperTargetsInput,
  isLocalAvatar,
  type BumperTarget,
} from '../shared/group-bumper.js';
import * as GP from '../shared/group-poster.js';
import { sameBinding, type Binding } from '../shared/task-execution.js';
import * as Q from './persistence/sqlite-query-helpers.js';
import {
  ensurePostBumpRecordsSchema,
  syncPosterLogToPostBumpRecords,
} from './post-bump-records-store.js';
import { recordAvatarURL, saveRecordAvatar } from './record-avatar-store.js';
import { transaction } from './sqlite-transaction.js';
import {
  ensureTargetLibrarySchema,
  SqliteTargetLibraryRepository,
} from './target-library-store.js';
export const groupPosterOperationsMigration = `
CREATE TABLE IF NOT EXISTS group_poster_operations(operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, profile_id TEXT NOT NULL, account_id TEXT NOT NULL, connection_epoch TEXT NOT NULL, lease_id TEXT NOT NULL, generation INTEGER NOT NULL, job_id TEXT NOT NULL, step_id TEXT NOT NULL, action_digest TEXT NOT NULL, action_kind TEXT NOT NULL CHECK(action_kind IN ('setup_search_group','setup_open_group','setup_browse_group','setup_join_group','setup_dismiss_welcome','setup_open_composer','setup_fill_caption','setup_fill_composer','setup_upload_media','setup_wait_media_ready','submit_post')), group_id TEXT NOT NULL, group_name TEXT NOT NULL, material_id TEXT DEFAULT NULL, post_id TEXT DEFAULT NULL, post_url TEXT DEFAULT NULL, log_id TEXT DEFAULT NULL, resolution_id TEXT DEFAULT NULL, resolution_outcome TEXT CHECK(resolution_outcome IN ('VERIFIED', 'NOT_APPLIED', 'ENDED_UNKNOWN') OR resolution_outcome IS NULL), evidence_digest TEXT DEFAULT NULL, status TEXT NOT NULL CHECK(status IN ('PREPARED', 'VERIFIED', 'NOT_APPLIED', 'PENDING_REVIEW')), kernel_settled INTEGER NOT NULL DEFAULT 0 CHECK(kernel_settled IN (0, 1)), review_reason TEXT DEFAULT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_group_poster_operations_profile_settled ON group_poster_operations(profile_id, kernel_settled);
CREATE INDEX IF NOT EXISTS idx_group_poster_operations_group_material_status ON group_poster_operations(group_id, material_id, status);
`;
const asMediaKind = (v: unknown): GP.PosterMediaKind =>
  ['none', 'image', 'video'].includes(Q.s(v)) ? (Q.s(v) as GP.PosterMediaKind) : 'none';
const sha256Json = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function initGroupPosterSchema(db: DatabaseSync): void {
  ensureTargetLibrarySchema(db);
  ensurePostBumpRecordsSchema(db);
  Q.ensureRecordAvatarSchema(db);
  Q.ensureProfileTaskResultsSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_poster_materials(id TEXT PRIMARY KEY, caption TEXT NOT NULL, media_source TEXT NOT NULL DEFAULT '', background TEXT NOT NULL DEFAULT 'plain', ai_label TEXT NOT NULL DEFAULT 'default', local_file_path TEXT, media_kind TEXT NOT NULL DEFAULT 'none', cache_status TEXT NOT NULL DEFAULT 'ready', cache_error TEXT, selected INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER DEFAULT NULL, thumbnail_data_url TEXT DEFAULT NULL);
    CREATE INDEX IF NOT EXISTS idx_group_poster_materials_sort ON group_poster_materials(sort_order, created_at, id);
    CREATE TABLE IF NOT EXISTS group_poster_usage(log_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, group_id TEXT NOT NULL, material_id TEXT NOT NULL, posted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS group_poster_usage_lookup ON group_poster_usage(group_id, material_id); CREATE INDEX IF NOT EXISTS group_poster_usage_day ON group_poster_usage(profile_id, posted_at);
    CREATE TABLE IF NOT EXISTS group_poster_settings(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); INSERT OR IGNORE INTO group_poster_settings(id, body) VALUES(1, '{}');
    CREATE TABLE IF NOT EXISTS group_poster_tasks(id TEXT PRIMARY KEY, material_id TEXT NOT NULL, caption_preview TEXT NOT NULL DEFAULT '', group_ids_json TEXT NOT NULL DEFAULT '[]', account_mode TEXT NOT NULL DEFAULT 'selected' CHECK(account_mode IN ('selected', 'all_online')), profile_ids_json TEXT NOT NULL DEFAULT '[]', scheduled_at INTEGER DEFAULT NULL, status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'running', 'completed', 'partial', 'failed', 'cancelled')), total_groups INTEGER NOT NULL DEFAULT 0, posted_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, status_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, started_at INTEGER DEFAULT NULL, finished_at INTEGER DEFAULT NULL);
    CREATE INDEX IF NOT EXISTS idx_group_poster_tasks_created_at ON group_poster_tasks(created_at DESC);
  `);
  db.exec(groupPosterOperationsMigration);
  db.prepare(
    "UPDATE group_poster_tasks SET status = CASE WHEN posted_count > 0 THEN 'partial' ELSE 'cancelled' END, status_reason = CASE WHEN posted_count > 0 THEN '部分成功 · 软件重启前已发 ' || posted_count || '/' || total_groups || ' 组' ELSE '已停止 · 软件重启中断' END, finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
  ).run(Date.now());
}
function mapOperationRow(r: Record<string, unknown>): GP.PosterOperationRecord {
  const rawRo = r.resolution_outcome,
    ro =
      rawRo === 'VERIFIED' || rawRo === 'NOT_APPLIED' || rawRo === 'ENDED_UNKNOWN'
        ? rawRo
        : undefined;
  return {
    binding: Q.rowBinding(r),
    runId: Q.s(r.run_id),
    actionKind: GP.PosterActionKind.parse(Q.s(r.action_kind)),
    groupId: Q.s(r.group_id),
    groupName: Q.s(r.group_name),
    materialId: Q.sn(r.material_id) ?? undefined,
    postId: Q.sn(r.post_id) ?? undefined,
    postUrl: Q.sn(r.post_url) ?? undefined,
    logId: Q.sn(r.log_id) ?? undefined,
    resolution:
      r.resolution_id != null && ro && r.evidence_digest != null
        ? { id: Q.s(r.resolution_id), outcome: ro, evidenceDigest: Q.s(r.evidence_digest) }
        : undefined,
    status: GP.PosterOperationStatus.parse(Q.s(r.status)),
    kernelSettled: Q.b(r.kernel_settled),
    reviewReason: Q.sn(r.review_reason) ?? undefined,
    createdAt: Q.n(r.created_at),
    updatedAt: Q.n(r.updated_at),
  };
}
function mapTaskRow(r: Record<string, unknown>): GP.PosterTask {
  const st = Q.s(r.status, 'scheduled');
  return {
    ...(Q.camel(r) as Omit<GP.PosterTask, 'groupIds' | 'profileIds' | 'accountMode' | 'status'>),
    groupIds: Q.parseJsonStringArray(r.group_ids_json),
    profileIds: Q.parseJsonStringArray(r.profile_ids_json),
    accountMode: (Q.s(r.account_mode, 'selected') === 'all_online'
      ? 'all_online'
      : 'selected') as GP.PosterTaskAccountMode,
    status: (['scheduled', 'running', 'completed', 'partial', 'failed', 'cancelled'].includes(st)
      ? st
      : 'scheduled') as GP.PosterTaskStatus,
  };
}
export class SqliteGroupPosterRepository {
  private readonly targetLibrary: SqliteTargetLibraryRepository;
  private run = (sql: string, args: SQLInputValue[] = []) => Q.run(this.db, sql, ...args);
  constructor(private readonly db: DatabaseSync) {
    initGroupPosterSchema(this.db);
    this.targetLibrary = new SqliteTargetLibraryRepository(this.db);
  }
  getOperation(operationId: string): GP.PosterOperationRecord | null {
    const r = Q.getRow(
      this.db,
      'SELECT * FROM group_poster_operations WHERE operation_id = ?',
      operationId,
    );
    return r ? mapOperationRow(r) : null;
  }
  listOperationsByProfile(profileId: string, includeSettled = false): GP.PosterOperationRecord[] {
    const sql = includeSettled
      ? 'SELECT * FROM group_poster_operations WHERE profile_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM group_poster_operations WHERE profile_id = ? AND kernel_settled = 0 ORDER BY created_at ASC';
    return Q.allRows(this.db, sql, profileId).map(mapOperationRow);
  }
  prepareOperation(input: {
    binding: Binding;
    runId: string;
    actionKind: GP.PosterActionKind;
    groupId: string;
    groupName: string;
    materialId?: string | undefined;
    postId?: string | undefined;
    postUrl?: string | undefined;
    logId?: string | undefined;
  }): GP.PosterOperationRecord {
    const actionKind = GP.PosterActionKind.parse(input.actionKind),
      b = input.binding;
    return transaction(this.db, () => {
      const existing = this.getOperation(b.operationId);
      if (existing) {
        if (
          !sameBinding(existing.binding, b) ||
          existing.actionKind !== actionKind ||
          existing.runId !== input.runId ||
          existing.groupId !== input.groupId
        )
          throw Error('POSTER_OPERATION_CONTEXT_CHANGED');
        return existing;
      }
      const now = Date.now(),
        cols =
          'operation_id,run_id,profile_id,account_id,connection_epoch,lease_id,generation,job_id,step_id,action_digest,action_kind,group_id,group_name,material_id,post_id,post_url,log_id,resolution_id,resolution_outcome,evidence_digest,status,kernel_settled,review_reason,created_at,updated_at';
      Q.insertFrom(
        this.db,
        'group_poster_operations',
        cols,
        { ...input, ...b },
        {
          connection_epoch: String(b.connectionEpoch),
          action_kind: actionKind,
          status: 'PREPARED',
          kernel_settled: 0,
          created_at: now,
          updated_at: now,
        },
      );
      return (
        this.getOperation(b.operationId) ?? {
          ...input,
          actionKind,
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
    res: GP.PosterOperationResolution,
  ): GP.PosterOperationResolution {
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (!row) throw Error('POSTER_OPERATION_MISSING');
      const apply = (next: GP.PosterOperationStatus) => {
        this.run(
          'UPDATE group_poster_operations SET resolution_id=?, resolution_outcome=?, evidence_digest=?, status=?, updated_at=? WHERE operation_id=?',
          [res.id, res.outcome, res.evidenceDigest, next, Date.now(), operationId],
        );
        return res;
      };
      if (row.resolution) {
        if (row.resolution.outcome === res.outcome) return row.resolution;
        if (
          !row.kernelSettled &&
          row.resolution.outcome === 'NOT_APPLIED' &&
          res.outcome === 'ENDED_UNKNOWN'
        )
          return apply(
            row.status === 'PENDING_REVIEW' || row.actionKind === 'submit_post'
              ? 'PENDING_REVIEW'
              : 'NOT_APPLIED',
          );
        throw Error('POSTER_RESOLUTION_CONFLICT');
      }
      return apply(
        res.outcome === 'VERIFIED'
          ? 'VERIFIED'
          : row.status === 'PENDING_REVIEW' ||
              (row.actionKind === 'submit_post' && res.outcome === 'ENDED_UNKNOWN')
            ? 'PENDING_REVIEW'
            : 'NOT_APPLIED',
      );
    });
  }
  markOperationKernelSettled(operationId: string): void {
    const row = this.getOperation(operationId);
    if (!row) throw Error('POSTER_OPERATION_MISSING');
    if (!row.kernelSettled)
      Q.run(
        this.db,
        'UPDATE group_poster_operations SET kernel_settled=1, updated_at=? WHERE operation_id=?',
        Date.now(),
        operationId,
      );
  }
  markOperationReview(operationId: string, reason: string): void {
    const row = this.getOperation(operationId);
    if (!row) throw Error('POSTER_OPERATION_MISSING');
    if (row.status !== 'VERIFIED')
      Q.run(
        this.db,
        "UPDATE group_poster_operations SET status='PENDING_REVIEW', review_reason=?, updated_at=? WHERE operation_id=?",
        GP.stripAnsi(reason),
        Date.now(),
        operationId,
      );
  }
  resolvePendingOperation(input: GP.ResolvePendingOperationInput): {
    operationId: string;
    resolution: GP.PendingOperationResolution;
    status: GP.PosterOperationStatus;
  } {
    const parsed = GP.ResolvePendingOperationInput.parse(input);
    return transaction(this.db, () => {
      const row = this.getOperation(parsed.operationId);
      if (!row) throw Error('POSTER_OPERATION_MISSING');
      const targetOutcome = parsed.resolution === 'confirmed' ? 'VERIFIED' : 'NOT_APPLIED',
        targetStatus: GP.PosterOperationStatus = targetOutcome;
      if (row.kernelSettled && row.resolution && row.resolution.outcome !== 'ENDED_UNKNOWN') {
        if (row.resolution.outcome === targetOutcome)
          return {
            operationId: parsed.operationId,
            resolution: parsed.resolution,
            status: row.status,
          };
        throw Error('POSTER_RESOLUTION_CONFLICT');
      }
      const now = Date.now(),
        note = GP.stripAnsi((parsed.note ?? parsed.reason ?? '').trim()).slice(0, 500),
        nextReason = note || row.reviewReason || null,
        resId = randomUUID(),
        evDigest = sha256Json({
          manualResolution: parsed.resolution,
          operationId: parsed.operationId,
          note,
          at: now,
        });
      let logId = row.logId ?? null;
      if (parsed.resolution === 'confirmed' && row.actionKind === 'submit_post') {
        logId = logId ?? randomUUID();
        const acctRow = Q.sqliteTableExists(this.db, 'profile_account_cache')
          ? Q.getRow(
              this.db,
              'SELECT account_name FROM profile_account_cache WHERE profile_id=? AND account_id=? LIMIT 1',
              row.binding.profileId,
              row.binding.accountId,
            )
          : undefined;
        const matRow = row.materialId
          ? Q.getRow(
              this.db,
              'SELECT caption, media_source, media_kind FROM group_poster_materials WHERE id=? LIMIT 1',
              row.materialId,
            )
          : undefined;
        const finalPostId = row.postId?.trim() || '',
          postUrl =
            row.postUrl?.trim() ||
            (finalPostId && row.groupId && row.groupId !== '__page_timeline__'
              ? `https://www.facebook.com/groups/${encodeURIComponent(row.groupId)}/posts/${encodeURIComponent(finalPostId)}/`
              : '');
        const logEntry: GP.PosterLog = {
          id: logId,
          profileId: row.binding.profileId,
          accountId: row.binding.accountId,
          accountName: Q.s(acctRow?.account_name).trim() || row.binding.accountId,
          accountAvatar: null,
          identityType: 'personal',
          groupId: row.groupId,
          groupName: row.groupName,
          groupAvatar: null,
          materialId: row.materialId ?? '',
          captionPreview: matRow
            ? GP.formatPosterCaptionPreview(
                Q.s(matRow.caption),
                Q.s(matRow.media_source),
                asMediaKind(matRow.media_kind),
              )
            : GP.formatPosterCaptionPreview(''),
          postId: finalPostId,
          postUrl,
          postedAt: now,
        };
        if (row.materialId) this.recordPost(logEntry);
        else syncPosterLogToPostBumpRecords(this.db, logEntry);
      }
      this.run(
        'UPDATE group_poster_operations SET log_id=COALESCE(log_id, ?), resolution_id=?, resolution_outcome=?, evidence_digest=?, status=?, kernel_settled=1, review_reason=?, updated_at=? WHERE operation_id=?',
        [logId, resId, targetOutcome, evDigest, targetStatus, nextReason, now, parsed.operationId],
      );
      return {
        operationId: parsed.operationId,
        resolution: parsed.resolution,
        status: targetStatus,
      };
    });
  }
  confirmPostSubmission(
    operationId: string,
    rec: GP.PosterLog,
    res: GP.PosterOperationResolution,
  ): GP.PosterOperationResolution {
    return transaction(this.db, () => {
      const row = this.getOperation(operationId);
      if (
        !row ||
        row.actionKind !== 'submit_post' ||
        row.binding.profileId !== rec.profileId ||
        row.groupId !== rec.groupId ||
        res.outcome !== 'VERIFIED'
      )
        throw Error('POSTER_RESULT_CONTEXT_CHANGED');
      if (row.resolution) {
        if (row.resolution.outcome !== 'VERIFIED') throw Error('POSTER_RESOLUTION_CONFLICT');
        return row.resolution;
      }
      this.recordPost(rec);
      this.run(
        "UPDATE group_poster_operations SET post_id=?, post_url=?, log_id=?, resolution_id=?, resolution_outcome='VERIFIED', evidence_digest=?, status='VERIFIED', updated_at=? WHERE operation_id=?",
        [rec.postId, rec.postUrl, rec.id, res.id, res.evidenceDigest, Date.now(), operationId],
      );
      return res;
    });
  }
  settings = () =>
    Q.readSingletonJson(
      this.db,
      'group_poster_settings',
      'body',
      (o) => GP.PosterSettings.parse(o),
      () => GP.PosterSettings.parse({}),
    );
  saveSettings(input: unknown): GP.PosterSettings {
    const s = GP.PosterSettings.parse(input);
    Q.run(this.db, 'UPDATE group_poster_settings SET body=? WHERE id=1', JSON.stringify(s));
    return s;
  }
  targets = (): BumperTarget[] =>
    this.targetLibrary.listGroups().map((r) => ({
      id: r.groupId,
      name: r.groupName,
      avatarUrl: r.avatarUrl,
      folderId: r.folderId,
      sortOrder: r.sortOrder,
      totalBumpedCount: r.postedCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  upsertTargets(input: unknown): BumperTarget[] {
    this.targetLibrary.upsertGroups(
      BumperTargetsInput.parse(input).items.map((i) => ({
        id: i.id,
        name: i.name.trim() || i.id,
        folderId: i.folderId ?? null,
      })),
    );
    return this.targets();
  }
  deleteTargets = (input: unknown): number =>
    transaction(this.db, () =>
      Q.deleteByJsonIds(
        this.db,
        'shared_facebook_groups',
        'group_id',
        BumperIdsInput.parse(input).ids,
      ),
    );
  applyResolvedTargetMetadata = (
    originalId: string,
    resolved: { canonicalId?: string | null; name?: string | null; avatarUrl?: string | null },
  ): boolean => this.targetLibrary.applyResolvedTargetMetadata('group', originalId, resolved);
  materials(): GP.PosterMaterial[] {
    const sql =
      'SELECT id, caption, media_source, background, ai_label, local_file_path, media_kind, cache_status, cache_error, selected, used_count, sort_order, created_at, updated_at, last_used_at, CASE WHEN thumbnail_data_url IS NOT NULL AND length(thumbnail_data_url) > 0 THEN 1 ELSE 0 END AS has_thumbnail FROM group_poster_materials ORDER BY sort_order, created_at, id';
    return Q.allRows(this.db, sql).map(
      (r) =>
        ({
          ...Q.camel(r, 'selected,has_thumbnail'),
          background:
            Q.s(r.media_source).trim().length > 0
              ? 'plain'
              : Q.s(r.background) === 'color'
                ? 'color'
                : 'plain',
          aiLabel: (['default', 'on', 'off'].includes(Q.s(r.ai_label))
            ? Q.s(r.ai_label)
            : 'default') as GP.PosterMaterialAiLabel,
          mediaKind: asMediaKind(r.media_kind),
          cacheStatus: (['ready', 'downloading', 'expired', 'error'].includes(Q.s(r.cache_status))
            ? Q.s(r.cache_status)
            : 'ready') as GP.PosterCacheStatus,
          selected: Q.b(r.selected ?? 1),
        }) as GP.PosterMaterial,
    );
  }
  saveMaterials(input: unknown): GP.PosterMaterial[] {
    const rawItems = (
      typeof input === 'object' && input && 'items' in input && Array.isArray(input.items)
        ? input.items
        : []
    ) as Array<Record<string, unknown> | undefined>;
    const { items, replaceAll } = GP.PosterMaterialsInput.parse(input),
      now = Date.now();
    return transaction(this.db, () => {
      const cur = this.materials(),
        byId = new Map(cur.map((m) => [m.id, m])),
        resolved = items.map((item, idx) => ({
          item,
          raw: rawItems[idx],
          id: item.id?.trim() || randomUUID(),
          idx,
        }));
      if (replaceAll === true) {
        if (!resolved.length) Q.run(this.db, 'DELETE FROM group_poster_materials');
        else
          Q.run(
            this.db,
            'DELETE FROM group_poster_materials WHERE id NOT IN (SELECT value FROM json_each(?))',
            JSON.stringify(resolved.map((x) => x.id)),
          );
      }
      const has = (r: Record<string, unknown> | undefined, k: string) =>
          Boolean(r && typeof r === 'object' && k in r),
        upd = this.db.prepare(
          'INSERT INTO group_poster_materials(id,caption,media_source,background,ai_label,local_file_path,media_kind,cache_status,cache_error,selected,used_count,sort_order,created_at,updated_at,last_used_at,thumbnail_data_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET caption=excluded.caption, media_source=excluded.media_source, background=excluded.background, ai_label=excluded.ai_label, local_file_path=excluded.local_file_path, media_kind=excluded.media_kind, cache_status=excluded.cache_status, cache_error=excluded.cache_error, selected=excluded.selected, sort_order=excluded.sort_order, updated_at=excluded.updated_at, thumbnail_data_url=CASE WHEN group_poster_materials.media_source=excluded.media_source THEN group_poster_materials.thumbnail_data_url ELSE NULL END',
        );
      let nextOrder = cur.reduce((m, x) => Math.max(m, x.sortOrder), -1) + 1;
      for (const { item, raw, id, idx } of resolved) {
        const prev = byId.get(id),
          rawSrc = (item.mediaSource ?? '').trim(),
          ref = rawSrc ? Q.parseWithFallback(() => mediaReference(rawSrc), null) : null,
          src = ref ? ref.source : rawSrc,
          bg = src
            ? 'plain'
            : item.background === 'color'
              ? 'color'
              : has(raw, 'background')
                ? 'plain'
                : (prev?.background ?? 'plain'),
          ai = has(raw, 'aiLabel') ? (item.aiLabel ?? 'default') : (prev?.aiLabel ?? 'default'),
          chg = !prev || prev.mediaSource !== src,
          loc = ref?.kind === 'local';
        upd.run(
          id,
          item.caption.trim(),
          src,
          bg,
          ai,
          !src ? null : chg ? (loc ? src : null) : prev.localFilePath,
          !src
            ? 'none'
            : !chg
              ? prev.mediaKind
              : ref
                ? ref.mediaType === 'image'
                  ? 'image'
                  : 'video'
                : /\.(?:png|jpe?g|webp|gif)$/i.test(src)
                  ? 'image'
                  : 'video',
          !src ? 'ready' : !chg ? prev.cacheStatus : !ref ? 'error' : loc ? 'ready' : 'downloading',
          !src ? null : !chg ? prev.cacheError : !ref ? '不支持的媒体路径或链接格式' : null,
          (item.selected ?? prev?.selected ?? true) ? 1 : 0,
          prev?.usedCount ?? 0,
          replaceAll === true ? idx : prev ? prev.sortOrder : nextOrder++,
          prev?.createdAt ?? now,
          now,
          prev?.lastUsedAt ?? null,
        );
      }
      return this.materials();
    });
  }
  deleteMaterials(input: unknown): number {
    const { ids } = GP.PosterMaterialIdsInput.parse(input);
    return transaction(this.db, () => {
      Q.run(
        this.db,
        "DELETE FROM group_poster_tasks WHERE material_id IN (SELECT value FROM json_each(?)) AND status='scheduled'",
        JSON.stringify(ids),
      );
      return Q.deleteByJsonIds(this.db, 'group_poster_materials', 'id', ids);
    });
  }
  updateMaterialCache(
    id: string,
    c: {
      localFilePath: string | null;
      mediaKind: GP.PosterMediaKind;
      cacheStatus: GP.PosterCacheStatus;
      cacheError: string | null;
      thumbnailDataUrl?: string | null | undefined;
    },
  ): void {
    const now = Date.now();
    this.run(
      'UPDATE group_poster_materials SET local_file_path=?,media_kind=?,cache_status=?,cache_error=?,thumbnail_data_url=CASE WHEN ?=1 THEN ? ELSE thumbnail_data_url END,updated_at=?,last_used_at=CASE WHEN ?=1 THEN ? ELSE last_used_at END WHERE id=?',
      [
        c.localFilePath,
        c.mediaKind,
        c.cacheStatus,
        c.cacheError,
        c.thumbnailDataUrl !== undefined ? 1 : 0,
        c.thumbnailDataUrl ?? null,
        now,
        c.cacheStatus === 'ready' && c.localFilePath ? 1 : 0,
        now,
        id,
      ],
    );
  }
  getMaterialThumbnail(id: string): { thumbnailDataUrl: string | null; updatedAt: number } | null {
    const r = Q.getRow(
      this.db,
      'SELECT thumbnail_data_url, updated_at FROM group_poster_materials WHERE id=?',
      id,
    );
    return r
      ? {
          thumbnailDataUrl:
            typeof r.thumbnail_data_url === 'string' && r.thumbnail_data_url
              ? r.thumbnail_data_url
              : null,
          updatedAt: Q.n(r.updated_at),
        }
      : null;
  }
  saveMaterialThumbnail(id: string, dataUrl: string): boolean {
    const t = dataUrl.trim();
    return (
      t.startsWith('data:image/') &&
      t.length <= 140 * 1024 &&
      Number(
        Q.run(
          this.db,
          'UPDATE group_poster_materials SET thumbnail_data_url=?, updated_at=? WHERE id=?',
          t,
          Date.now(),
          id,
        ).changes ?? 0,
      ) > 0
    );
  }
  getMaterialMediaPath(
    id: string,
  ): { localFilePath: string | null; mediaKind: GP.PosterMediaKind } | null {
    const r = Q.getRow(
      this.db,
      'SELECT local_file_path, media_kind FROM group_poster_materials WHERE id=?',
      id,
    );
    return r
      ? {
          localFilePath: Q.nonEmptyTrimmed(r.local_file_path),
          mediaKind: asMediaKind(r.media_kind),
        }
      : null;
  }
  listExpiredDriveMaterials(
    cutoffMs: number,
  ): Array<{ id: string; mediaSource: string; localFilePath: string }> {
    const out: Array<{ id: string; mediaSource: string; localFilePath: string }> = [],
      sql =
        "SELECT id, media_source, local_file_path FROM group_poster_materials WHERE local_file_path IS NOT NULL AND trim(local_file_path) <> '' AND COALESCE(last_used_at, updated_at) < ?";
    for (const r of Q.allRows(this.db, sql, cutoffMs)) {
      const id = Q.s(r.id),
        src = Q.s(r.media_source).trim(),
        lp = Q.s(r.local_file_path).trim();
      if (id && src && lp && Q.parseWithFallback(() => mediaReference(src).kind === 'drive', false))
        out.push({ id, mediaSource: src, localFilePath: lp });
    }
    return out;
  }
  markMaterialCacheExpired = (id: string): void =>
    void Q.run(
      this.db,
      "UPDATE group_poster_materials SET local_file_path=NULL, cache_status='expired', cache_error=NULL, updated_at=? WHERE id=?",
      Date.now(),
      id,
    );
  private hasGroupStatus = (groupId: string, materialId: string, pending: boolean) =>
    Boolean(
      this.db
        .prepare('SELECT 1 FROM group_poster_usage WHERE group_id=? AND material_id=? LIMIT 1')
        .get(groupId, materialId) ||
      this.db
        .prepare(
          `SELECT 1 FROM group_poster_operations WHERE group_id=? AND material_id=? AND status IN ${pending ? "('VERIFIED','PENDING_REVIEW')" : "('VERIFIED')"} LIMIT 1`,
        )
        .get(groupId, materialId),
    );
  hasGroupVerifiedPost = (g: string, m: string) => this.hasGroupStatus(g, m, false);
  hasGroupPostedMaterial = (g: string, m: string) => this.hasGroupStatus(g, m, true);
  postedGroupIdsByMaterial(): Record<string, string[]> {
    const map: Record<string, string[]> = {},
      sql =
        "SELECT material_id, group_id FROM group_poster_usage WHERE material_id IS NOT NULL AND group_id IS NOT NULL UNION SELECT material_id, group_id FROM group_poster_operations WHERE material_id IS NOT NULL AND group_id IS NOT NULL AND status IN ('VERIFIED','PENDING_REVIEW')";
    for (const r of Q.allRows(this.db, sql)) {
      const m = Q.s(r.material_id).trim(),
        g = Q.s(r.group_id).trim();
      if (m && g) (map[m] ??= []).push(g);
    }
    return map;
  }
  listTasks = (limit = 100): GP.PosterTask[] =>
    Q.allRows(
      this.db,
      'SELECT * FROM group_poster_tasks ORDER BY created_at DESC, id DESC LIMIT ?',
      Q.clampLimit(limit, 1, 500),
    ).map(mapTaskRow);
  saveTask(t: GP.PosterTask): GP.PosterTask {
    const cols =
      'id,material_id,caption_preview,group_ids_json,account_mode,profile_ids_json,scheduled_at,status,total_groups,posted_count,skipped_count,status_reason,created_at,started_at,finished_at';
    Q.upsertFrom(this.db, 'group_poster_tasks', 'id', cols, '*', t, {
      group_ids_json: JSON.stringify(t.groupIds),
      profile_ids_json: JSON.stringify(t.profileIds),
    });
    return t;
  }
  deleteTask = (id: string): boolean =>
    Number(Q.run(this.db, 'DELETE FROM group_poster_tasks WHERE id=?', id).changes ?? 0) > 0;
  recordPost(input: GP.PosterLog): boolean {
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM group_poster_usage WHERE log_id=? LIMIT 1').get(input.id))
        return false;
      let avatar = input.accountAvatar;
      if (
        input.identityType === 'personal' &&
        !isLocalAvatar(avatar) &&
        Q.sqliteTableExists(this.db, 'profile_account_cache')
      ) {
        const c = Q.getRow(
          this.db,
          'SELECT avatar_url FROM profile_account_cache WHERE profile_id=? AND account_id=? LIMIT 1',
          input.profileId,
          input.accountId,
        );
        if (c?.avatar_url && String(c.avatar_url).trim()) avatar = String(c.avatar_url).trim();
      }
      saveRecordAvatar(
        this.db,
        input.identityType === 'page' ? 'page' : 'account',
        input.accountId,
        avatar,
        input.postedAt,
      );
      saveRecordAvatar(this.db, 'group', input.groupId, input.groupAvatar, input.postedAt);
      this.run(
        'INSERT OR IGNORE INTO group_poster_usage(log_id, profile_id, group_id, material_id, posted_at) VALUES(?,?,?,?,?)',
        [input.id, input.profileId, input.groupId, input.materialId, input.postedAt],
      );
      syncPosterLogToPostBumpRecords(this.db, input);
      this.run(
        'UPDATE group_poster_materials SET used_count=used_count+1,last_used_at=?,updated_at=? WHERE id=?',
        [input.postedAt, input.postedAt, input.materialId],
      );
      this.targetLibrary.incrementGroupPostedCount(input.groupId, 1);
      return true;
    });
  }
  logs(
    search = '',
    limit = 200,
    before?: number,
    beforeId = '\uffff',
    materialId?: string,
  ): GP.PosterLog[] {
    const mid = materialId?.trim() ?? '',
      sql = `SELECT p.*, COALESCE(u.material_id, '') AS material_id FROM post_bump_records p LEFT JOIN group_poster_usage u ON u.log_id = p.source_log_id WHERE p.record_type = 'post' AND p.status = 'success' AND (p.created_at < ? OR (p.created_at = ? AND COALESCE(p.source_log_id, p.id) < ?)) AND (?='' OR u.material_id=?) AND (?='' OR instr(lower(p.group_name||' '||p.group_id||' '||p.account_name||' '||p.account_id||' '||p.caption_preview||' '||p.post_url),lower(?))>0) ORDER BY p.created_at DESC, COALESCE(p.source_log_id, p.id) DESC LIMIT ?`;
    return Q.allRows(
      this.db,
      sql,
      ...Q.cursorPaginationParams(before ?? Date.now() + 1000, beforeId),
      mid,
      mid,
      search,
      search,
      Q.clampLimit(limit, 1, 1000),
    ).map((r) => ({
      id: Q.s(r.source_log_id ?? r.id),
      profileId: Q.s(r.profile_id),
      accountId: Q.s(r.account_id),
      accountName: Q.s(r.account_name),
      accountAvatar: recordAvatarURL(r.page_id ? 'page' : 'account', Q.s(r.account_id)),
      identityType: r.page_id ? ('page' as const) : ('personal' as const),
      groupId: Q.s(r.group_id),
      groupName: Q.s(r.group_name),
      groupAvatar: recordAvatarURL('group', Q.s(r.group_id)),
      materialId: Q.s(r.material_id),
      postId: Q.s(r.post_id),
      postUrl: Q.s(r.post_url),
      captionPreview: Q.s(r.caption_preview),
      postedAt: Q.n(r.created_at),
    }));
  }
  pendingReviewOperations(limit = 100): GP.PosterPendingOperation[] {
    const sql =
      "SELECT operation_id AS id, profile_id, account_id, group_id, group_name, material_id, review_reason AS reason, updated_at FROM group_poster_operations WHERE status='PENDING_REVIEW' ORDER BY updated_at DESC, operation_id DESC LIMIT ?";
    return Q.allRows(this.db, sql, Q.clampLimit(limit, 1, 500)).map((r) => {
      const item = Q.camel(r) as unknown as GP.PosterPendingOperation;
      return { ...item, reason: item.reason ? GP.stripAnsi(item.reason) : item.reason };
    });
  }
  deleteLogs(input: unknown): number {
    const { ids, all } = z
      .object({ ids: z.array(z.string()).max(1000).default([]), all: z.boolean().default(false) })
      .strict()
      .parse(input);
    return transaction(this.db, () => {
      const [idJson, flag] = [JSON.stringify(ids), all ? 1 : 0],
        opsCh = Number(
          this.run(
            "DELETE FROM group_poster_operations WHERE kernel_settled=1 AND status='VERIFIED' AND (?=1 OR log_id IN (SELECT value FROM json_each(?)))",
            [flag, idJson],
          ).changes,
        ),
        useCh = Number(
          this.run(
            'DELETE FROM group_poster_usage WHERE ?=1 OR log_id IN(SELECT value FROM json_each(?))',
            [flag, idJson],
          ).changes,
        ),
        ch = Number(
          this.run(
            "DELETE FROM post_bump_records WHERE record_type='post' AND (?=1 OR source_log_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))",
            [flag, idJson, idJson],
          ).changes,
        );
      if (ch > 0 || useCh > 0 || opsCh > 0) {
        this.run(
          'UPDATE shared_facebook_groups SET posted_count=(SELECT COUNT(*) FROM group_poster_usage WHERE group_poster_usage.group_id=shared_facebook_groups.group_id)',
        );
        this.run(
          'UPDATE group_poster_materials SET used_count=(SELECT COUNT(*) FROM group_poster_usage WHERE group_poster_usage.material_id=group_poster_materials.id)',
        );
      }
      return ch;
    });
  }
  total = () =>
    Q.countSql(
      this.db,
      "SELECT COUNT(*) n FROM post_bump_records WHERE record_type='post' AND status='success' AND carrier='browser'",
    );
  todayCounts = (): Record<string, number> =>
    Object.fromEntries(
      Q.allRows(
        this.db,
        'SELECT profile_id,COUNT(*) n FROM group_poster_usage WHERE posted_at>=? GROUP BY profile_id',
        Q.localDayStartMs(),
      ).map((r) => [Q.s(r.profile_id), Q.n(r.n)]),
    );
  saveProfileResult = (input: unknown) => Q.upsertProfileTaskResult(this.db, input, true);
}
