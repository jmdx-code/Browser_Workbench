import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ProductError } from '../domain/workspace.js';
import { transaction } from './sqlite-transaction.js';
import { TargetListCommand, TargetListKind, type TargetFolder } from '../shared/target-list.js';
const tables = {
  inviter_groups: ['group_inviter_groups', 'group_id'],
  bumper_groups: ['group_bumper_groups', 'group_id'],
  bumper_pages: ['group_bumper_pages', 'page_id'],
} as const;
export function ensureTargetColumns(db: DatabaseSync, table: string) {
  if (!Object.values(tables).some((t) => t[0] === table)) throw Error('TARGET_TABLE_INVALID');
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.length) return;
  if (!columns.some((c) => c.name === 'folder_id'))
    db.exec(`ALTER TABLE ${table} ADD COLUMN folder_id TEXT DEFAULT NULL`);
  if (!columns.some((c) => c.name === 'sort_order')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    db.exec(
      `WITH ordered AS (SELECT rowid rid, ROW_NUMBER() OVER(ORDER BY created_at DESC,rowid)-1 n FROM ${table}) UPDATE ${table} SET sort_order=(SELECT n FROM ordered WHERE rid=${table}.rowid)`,
    );
  }
}
export function finderListMigration(db: DatabaseSync) {
  if (
    !db
      .prepare('PRAGMA table_info(profile_metadata)')
      .all()
      .some((c) => c.name === 'sort_order')
  ) {
    db.exec('ALTER TABLE profile_metadata ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    db.exec(
      'WITH ordered AS (SELECT rowid rid,ROW_NUMBER() OVER(ORDER BY rowid)-1 n FROM profile_metadata) UPDATE profile_metadata SET sort_order=(SELECT n FROM ordered WHERE rid=profile_metadata.rowid)',
    );
  }
  db.exec(
    `CREATE TABLE IF NOT EXISTS target_list_folders(id TEXT PRIMARY KEY,list_kind TEXT NOT NULL CHECK(list_kind IN ('inviter_groups','bumper_groups','bumper_pages')),name TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS idx_target_list_folders_kind ON target_list_folders(list_kind,sort_order)`,
  );
  for (const [table] of Object.values(tables)) ensureTargetColumns(db, table);
}
export class SqliteTargetLists {
  constructor(private readonly db: DatabaseSync) {}
  folders(kind: TargetListKind): TargetFolder[] {
    TargetListKind.parse(kind);
    return this.db
      .prepare(
        'SELECT id,list_kind listKind,name,sort_order sortOrder,created_at createdAt FROM target_list_folders WHERE list_kind=? ORDER BY sort_order,created_at,id',
      )
      .all(kind) as unknown as TargetFolder[];
  }
  command(input: unknown) {
    const c = TargetListCommand.parse(input);
    return transaction(this.db, () => {
      if (c.action === 'create') {
        this.db
          .prepare('INSERT INTO target_list_folders VALUES(?,?,?,?,?)')
          .run(randomUUID(), c.listKind, c.name, this.folders(c.listKind).length, Date.now());
        return;
      }
      if (c.action === 'rename' || c.action === 'delete') {
        const folder = this.db
          .prepare('SELECT list_kind FROM target_list_folders WHERE id=?')
          .get(c.id);
        if (!folder) throw new ProductError('FOLDER_NOT_FOUND', '分组不存在', 404);
        if (c.action === 'rename')
          this.db.prepare('UPDATE target_list_folders SET name=? WHERE id=?').run(c.name, c.id);
        else {
          const [table] = tables[folder.list_kind as TargetListKind];
          const [targetTable, key] = tables[folder.list_kind as TargetListKind];
          const items = this.db
            .prepare(
              `SELECT ${key} id FROM ${targetTable} WHERE folder_id=? ORDER BY sort_order,created_at DESC,${key}`,
            )
            .all(c.id);
          let next = Number(
            this.db
              .prepare(
                `SELECT COALESCE(MAX(sort_order),-1)+1 n FROM ${table} WHERE folder_id IS NULL`,
              )
              .get()?.n,
          );
          const move = this.db.prepare(
            `UPDATE ${table} SET folder_id=NULL,sort_order=? WHERE ${key}=?`,
          );
          for (const item of items) move.run(next++, String(item.id));
          this.db.prepare('DELETE FROM target_list_folders WHERE id=?').run(c.id);
        }
        return;
      }
      if (c.action === 'reorder-folders') {
        const known = new Set(this.folders(c.listKind).map((f) => f.id));
        if (
          c.orderedFolderIds.length !== known.size ||
          new Set(c.orderedFolderIds).size !== known.size ||
          c.orderedFolderIds.some((id) => !known.has(id))
        )
          throw new ProductError('FOLDER_ORDER_INVALID', '分组列表已变化，请刷新');
        const stmt = this.db.prepare('UPDATE target_list_folders SET sort_order=? WHERE id=?');
        c.orderedFolderIds.forEach((id, i) => stmt.run(i, id));
        return;
      }
      const [table, key] = tables[c.listKind];
      if (
        c.folderId &&
        !this.db
          .prepare('SELECT 1 FROM target_list_folders WHERE id=? AND list_kind=?')
          .get(c.folderId, c.listKind)
      )
        throw new ProductError('FOLDER_NOT_FOUND', '目标分组不存在', 404);
      const ids = [...new Set(c.orderedItemIds)];
      for (const id of ids)
        if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(id))
          throw new ProductError('TARGET_NOT_FOUND', '条目已不存在', 404);
      const existing = this.db
        .prepare(
          `SELECT ${key} id FROM ${table} WHERE folder_id IS ? ORDER BY sort_order,created_at DESC,${key}`,
        )
        .all(c.folderId)
        .map((r) => String(r.id));
      const order = [...ids, ...existing.filter((id) => !ids.includes(id))];
      const update = this.db.prepare(`UPDATE ${table} SET folder_id=?,sort_order=? WHERE ${key}=?`);
      order.forEach((id, i) => update.run(c.folderId, i, id));
    });
  }
}
