import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ProductError } from '../domain/workspace.js';
import { assertCompleteIdOrder, nextSortOrder } from './persistence/sqlite-query-helpers.js';
import { transaction } from './sqlite-transaction.js';
import {
  normalizeTargetListKind,
  TargetListCommand,
  TargetListKind,
  type NormalizedTargetListKind,
  type TargetFolder,
} from '../shared/target-list.js';
const normalizedTables: Record<NormalizedTargetListKind, readonly [string, string]> = {
  shared_groups: ['shared_facebook_groups', 'group_id'],
  bumper_pages: ['group_bumper_pages', 'page_id'],
};
export class SqliteTargetLists {
  constructor(private readonly db: DatabaseSync) {}
  folders(kind: TargetListKind): TargetFolder[] {
    const normalizedKind = normalizeTargetListKind(TargetListKind.parse(kind));
    return this.db
      .prepare(
        'SELECT id,list_kind listKind,name,sort_order sortOrder,created_at createdAt FROM target_list_folders WHERE list_kind=? ORDER BY sort_order,created_at,id',
      )
      .all(normalizedKind) as unknown as TargetFolder[];
  }
  command(input: unknown) {
    const c = TargetListCommand.parse(input);
    return transaction(this.db, () => {
      if (c.action === 'create') {
        const listKind = normalizeTargetListKind(c.listKind);
        this.db
          .prepare('INSERT INTO target_list_folders VALUES(?,?,?,?,?)')
          .run(randomUUID(), listKind, c.name, this.folders(listKind).length, Date.now());
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
          const [targetTable, key] =
            normalizedTables[
              normalizeTargetListKind(TargetListKind.parse(String(folder.list_kind)))
            ];
          const items = this.db
            .prepare(
              `SELECT ${key} id FROM ${targetTable} WHERE folder_id=? ORDER BY sort_order,created_at DESC,${key}`,
            )
            .all(c.id);
          let next = nextSortOrder(this.db, targetTable, 'folder_id IS NULL');
          const move = this.db.prepare(
            `UPDATE ${targetTable} SET folder_id=NULL,sort_order=? WHERE ${key}=?`,
          );
          for (const item of items) move.run(next++, String(item.id));
          this.db.prepare('DELETE FROM target_list_folders WHERE id=?').run(c.id);
        }
        return;
      }
      const listKind = normalizeTargetListKind(c.listKind);
      if (c.action === 'reorder-folders') {
        assertCompleteIdOrder(
          c.orderedFolderIds,
          new Set(this.folders(listKind).map((f) => f.id)),
          'FOLDER_ORDER_INVALID',
          '分组列表已变化，请刷新',
        );
        const stmt = this.db.prepare('UPDATE target_list_folders SET sort_order=? WHERE id=?');
        c.orderedFolderIds.forEach((id, i) => stmt.run(i, id));
        return;
      }
      const [table, key] = normalizedTables[listKind];
      if (
        c.folderId &&
        !this.db
          .prepare('SELECT 1 FROM target_list_folders WHERE id=? AND list_kind=?')
          .get(c.folderId, listKind)
      ) {
        throw new ProductError('FOLDER_NOT_FOUND', '目标分组不存在', 404);
      }
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
      const update = this.db.prepare(`UPDATE ${table} SET folder_id=?,sort_order=? WHERE ${key}=?`);
      [...ids, ...existing.filter((id) => !ids.includes(id))].forEach((id, i) =>
        update.run(c.folderId, i, id),
      );
    });
  }
}
