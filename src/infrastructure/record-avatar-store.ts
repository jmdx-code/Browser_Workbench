import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const RecordAvatarKind = z.enum(['account', 'page', 'group']);
type Kind = z.infer<typeof RecordAvatarKind>;
export function recordAvatarURL(kind: Kind, id: string): string {
  return `/api/workspace/record-avatar?kind=${kind}&id=${encodeURIComponent(id)}`;
}
function libraryAvatar(db: DatabaseSync, kind: Kind, id: string): string | null {
  let image: unknown;
  const exists = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (kind === 'group' && exists('shared_facebook_groups'))
    image = db
      .prepare('SELECT avatar_url FROM shared_facebook_groups WHERE group_id=?')
      .get(id)?.avatar_url;
  else if (kind === 'page' && exists('group_bumper_pages'))
    image = db
      .prepare('SELECT avatar_url FROM group_bumper_pages WHERE page_id=?')
      .get(id)?.avatar_url;
  else if (kind === 'account' && exists('profile_account_cache'))
    image = db
      .prepare(
        'SELECT avatar_url FROM profile_account_cache WHERE account_id=? AND avatar_url IS NOT NULL ORDER BY avatar_updated_at DESC LIMIT 1',
      )
      .get(id)?.avatar_url;
  return typeof image === 'string' && image ? image : null;
}
export function readRecordAvatar(db: DatabaseSync, kind: Kind, id: string): string | null {
  const image = libraryAvatar(db, kind, id);
  if (image) return image;
  const cached = db
    .prepare('SELECT image FROM record_avatar_cache WHERE kind=? AND entity_id=?')
    .get(kind, id)?.image;
  return typeof cached === 'string' && cached ? cached : null;
}
export function saveRecordAvatar(
  db: DatabaseSync,
  kind: Kind,
  id: string,
  image: string | null | undefined,
  at: number,
): void {
  if (!image || !/^(?:data:image\/(?:jpeg|webp|png|gif);base64,|https:\/\/)/.test(image)) return;
  // The normal entity library is authoritative. Cache only historical identities
  // that no longer have a usable library entry; never duplicate an image per log.
  if (libraryAvatar(db, kind, id)) return;
  db.prepare(
    'INSERT INTO record_avatar_cache VALUES(?,?,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET image=excluded.image,updated_at=excluded.updated_at WHERE excluded.updated_at>=updated_at',
  ).run(kind, id, image, at);
}
