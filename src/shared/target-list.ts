import { z } from 'zod';
import { Id, sReq, trimReq } from './contracts.js';
import { extractFacebookGroupId, extractFacebookPageId } from './facebook-target-id.js';
export type SelectByIdsCandidate = { id: string; keys: string[] };
const GROUP_KINDS = new Set(['shared_groups', 'inviter_groups', 'bumper_groups', 'groups']);
export function normalizeTargetToken(kind: TargetListKind | 'profiles', raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (GROUP_KINDS.has(kind)) return extractFacebookGroupId(trimmed);
  return kind === 'bumper_pages' || kind === 'pages' ? extractFacebookPageId(trimmed) : trimmed;
}
export const buildTargetCandidates = (
  items: ReadonlyArray<{ id: string }>,
): SelectByIdsCandidate[] =>
  items.map((item) => ({ id: item.id, keys: [item.id.trim().toLowerCase()] }));
export function resolveSelectByIds(
  rawText: string,
  kind: TargetListKind | 'profiles',
  candidates: readonly SelectByIdsCandidate[],
): { tokens: string[]; matchedIds: string[]; unmatchedTokens: string[] } {
  const allCandidateKeys = new Set(candidates.flatMap((c) => c.keys)),
    rawTokens: string[] = [];
  for (const seg of rawText
    .split(/[\r\n,，、;；\t]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const whole = normalizeTargetToken(kind, seg);
    if (kind === 'profiles' && /\s/.test(whole) && allCandidateKeys.has(whole.toLowerCase())) {
      rawTokens.push(whole);
      continue;
    }
    for (const part of seg.split(/\s+/)) {
      const norm = normalizeTargetToken(kind, part);
      if (norm) rawTokens.push(norm);
    }
  }
  const seen = new Set<string>(),
    tokens: string[] = [];
  for (const t of rawTokens) {
    const lower = t.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      tokens.push(t);
    }
  }
  const matchedSet = new Set<string>(),
    unmatchedTokens: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase(),
      variants = /^\d+$/.test(lower)
        ? [lower, '用户' + lower, '用户 ' + lower, '#' + lower]
        : [lower];
    let hit = false;
    for (const c of candidates)
      if (variants.some((v) => c.keys.includes(v))) {
        matchedSet.add(c.id);
        hit = true;
      }
    if (!hit) unmatchedTokens.push(token);
  }
  return {
    tokens,
    matchedIds: candidates.filter((c) => matchedSet.has(c.id)).map((c) => c.id),
    unmatchedTokens,
  };
}
export const TargetListKind = z.enum([
  'shared_groups',
  'bumper_pages',
  'inviter_groups',
  'bumper_groups',
  'groups',
  'pages',
]);
export type TargetListKind = z.infer<typeof TargetListKind>;
export type NormalizedTargetListKind = 'shared_groups' | 'bumper_pages';
export const normalizeTargetListKind = (kind: TargetListKind): NormalizedTargetListKind =>
  kind === 'bumper_pages' || kind === 'pages' ? 'bumper_pages' : 'shared_groups';
export interface TargetFolder {
  id: string;
  listKind: TargetListKind;
  name: string;
  sortOrder: number;
  createdAt: number;
}
const FolderName = trimReq(80);
export const TargetListCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), listKind: TargetListKind, name: FolderName }),
  z.object({ action: z.literal('rename'), id: Id, name: FolderName }),
  z.object({ action: z.literal('delete'), id: Id }),
  z.object({
    action: z.literal('reorder-folders'),
    listKind: TargetListKind,
    orderedFolderIds: z.array(Id).max(500),
  }),
  z.object({
    action: z.literal('reorder-items'),
    listKind: TargetListKind,
    folderId: Id.nullable(),
    orderedItemIds: z.array(sReq(120)).max(10000),
  }),
]);
export type TargetListCommand = z.infer<typeof TargetListCommand>;
