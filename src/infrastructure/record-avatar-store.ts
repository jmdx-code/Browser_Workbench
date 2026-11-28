import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { isExpiredFbCdnUrl } from '../shared/activity-stats.js';
import { sqliteTableExists } from './persistence/sqlite-query-helpers.js';
export { isExpiredFbCdnUrl };
export const RecordAvatarKind = z.enum(['account', 'page', 'group']);
type Kind = z.infer<typeof RecordAvatarKind>;
export function recordAvatarURL(kind: Kind, id: string): string {
  return `/api/workspace/record-avatar?kind=${kind}&id=${encodeURIComponent(id)}`;
}
function usableAvatar(raw: unknown): string | null {
  return typeof raw === 'string' && raw && !isExpiredFbCdnUrl(raw) ? raw : null;
}
function libraryAvatar(db: DatabaseSync, kind: Kind, id: string): string | null {
  let image: unknown;
  if (kind === 'group' && sqliteTableExists(db, 'shared_facebook_groups')) {
    image = db
      .prepare('SELECT avatar_url FROM shared_facebook_groups WHERE group_id=?')
      .get(id)?.avatar_url;
  } else if (kind === 'page' && sqliteTableExists(db, 'group_bumper_pages')) {
    image = db
      .prepare('SELECT avatar_url FROM group_bumper_pages WHERE page_id=?')
      .get(id)?.avatar_url;
  } else if (kind === 'account') {
    if (sqliteTableExists(db, 'profile_account_cache')) {
      image = db
        .prepare(
          'SELECT avatar_url FROM profile_account_cache WHERE account_id=? AND avatar_url IS NOT NULL ORDER BY avatar_updated_at DESC LIMIT 1',
        )
        .get(id)?.avatar_url;
    }
    if (!usableAvatar(image) && sqliteTableExists(db, 'bluestacks_instances')) {
      image = db
        .prepare(
          "SELECT avatar_url FROM bluestacks_instances WHERE (account_id=? OR numeric_account_id=?) AND avatar_url IS NOT NULL AND TRIM(avatar_url)<>'' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(id, id)?.avatar_url;
    }
  }
  return usableAvatar(image);
}
export function readRecordAvatar(db: DatabaseSync, kind: Kind, id: string): string | null {
  const image = libraryAvatar(db, kind, id);
  if (image) return image;
  const cached = db
    .prepare('SELECT image FROM record_avatar_cache WHERE kind=? AND entity_id=?')
    .get(kind, id)?.image;
  return usableAvatar(cached);
}
export function saveRecordAvatar(
  db: DatabaseSync,
  kind: Kind,
  id: string,
  image: string | null | undefined,
  at: number,
): void {
  if (
    !id ||
    !image ||
    !/^(?:data:image\/(?:jpeg|webp|png|gif);base64,|https:\/\/)/.test(image) ||
    isExpiredFbCdnUrl(image) ||
    libraryAvatar(db, kind, id)
  )
    return;
  db.prepare(
    'INSERT INTO record_avatar_cache VALUES(?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET image=excluded.image,updated_at=excluded.updated_at WHERE excluded.updated_at>=updated_at',
  ).run(kind, id, image, at);
}
export interface KnownAvatarSets {
  accounts: Set<string>;
  pages: Set<string>;
  groups: Set<string>;
}
export function loadKnownAvatarSets(db: DatabaseSync): KnownAvatarSets {
  const accounts = new Set<string>(),
    pages = new Set<string>(),
    groups = new Set<string>();
  const addIds = (sql: string, set: Set<string>) => {
    for (const r of db.prepare(sql).all() as Array<Record<string, unknown>>) {
      const id = typeof r.id === 'string' ? r.id.trim() : '';
      const url = typeof r.url === 'string' ? r.url.trim() : '';
      if (id && url && !isExpiredFbCdnUrl(url)) set.add(id);
    }
  };
  if (sqliteTableExists(db, 'record_avatar_cache')) {
    for (const r of db
      .prepare("SELECT kind, entity_id, image FROM record_avatar_cache WHERE TRIM(image)<>''")
      .all() as Array<Record<string, unknown>>) {
      const k = String(r.kind ?? ''),
        id = String(r.entity_id ?? '').trim(),
        url = String(r.image ?? '').trim();
      if (!id || !url || isExpiredFbCdnUrl(url)) continue;
      if (k === 'account') accounts.add(id);
      else if (k === 'page') pages.add(id);
      else if (k === 'group') groups.add(id);
    }
  }
  if (sqliteTableExists(db, 'profile_account_cache'))
    addIds(
      "SELECT account_id AS id, avatar_url AS url FROM profile_account_cache WHERE account_id IS NOT NULL AND avatar_url IS NOT NULL AND TRIM(avatar_url)<>''",
      accounts,
    );
  if (sqliteTableExists(db, 'bluestacks_instances')) {
    addIds(
      "SELECT account_id AS id, avatar_url AS url FROM bluestacks_instances WHERE TRIM(account_id)<>'' AND avatar_url IS NOT NULL AND TRIM(avatar_url)<>''",
      accounts,
    );
    addIds(
      "SELECT numeric_account_id AS id, avatar_url AS url FROM bluestacks_instances WHERE TRIM(numeric_account_id)<>'' AND avatar_url IS NOT NULL AND TRIM(avatar_url)<>''",
      accounts,
    );
  }
  if (sqliteTableExists(db, 'group_bumper_pages'))
    addIds(
      "SELECT page_id AS id, avatar_url AS url FROM group_bumper_pages WHERE avatar_url IS NOT NULL AND TRIM(avatar_url)<>''",
      pages,
    );
  if (sqliteTableExists(db, 'shared_facebook_groups'))
    addIds(
      "SELECT group_id AS id, avatar_url AS url FROM shared_facebook_groups WHERE avatar_url IS NOT NULL AND TRIM(avatar_url)<>''",
      groups,
    );
  return { accounts, pages, groups };
}
