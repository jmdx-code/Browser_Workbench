import { z } from 'zod';
import { extractFacebookGroupId, extractFacebookPageId } from './facebook-target-id.js';

export interface SelectByIdsCandidate {
  id: string;
  keys: string[];
}

export function normalizeTargetToken(kind: TargetListKind | 'profiles', raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (
    kind === 'shared_groups' ||
    kind === 'inviter_groups' ||
    kind === 'bumper_groups' ||
    kind === 'groups'
  )
    return extractFacebookGroupId(trimmed);
  if (kind === 'bumper_pages' || kind === 'pages') return extractFacebookPageId(trimmed);
  return trimmed;
}

export function buildTargetCandidates(
  items: ReadonlyArray<{ id: string }>,
): SelectByIdsCandidate[] {
  return items.map((item) => ({
    id: item.id,
    keys: [item.id.trim().toLowerCase()],
  }));
}

export function resolveSelectByIds(
  rawText: string,
  kind: TargetListKind | 'profiles',
  candidates: readonly SelectByIdsCandidate[],
): {
  tokens: string[];
  matchedIds: string[];
  unmatchedTokens: string[];
} {
  const allCandidateKeys = new Set(candidates.flatMap((c) => c.keys));
  const rawSegments = rawText
    .split(/[\r\n,，、;；\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const rawTokens: string[] = [];
  for (const seg of rawSegments) {
    const normalizedWhole = normalizeTargetToken(kind, seg);
    if (
      kind === 'profiles' &&
      /\s/.test(normalizedWhole) &&
      allCandidateKeys.has(normalizedWhole.toLowerCase())
    ) {
      rawTokens.push(normalizedWhole);
      continue;
    }
    for (const part of seg.split(/\s+/)) {
      const norm = normalizeTargetToken(kind, part);
      if (norm) rawTokens.push(norm);
    }
  }

  const seenTokens = new Set<string>();
  const tokens: string[] = [];
  for (const token of rawTokens) {
    const lower = token.toLowerCase();
    if (!seenTokens.has(lower)) {
      seenTokens.add(lower);
      tokens.push(token);
    }
  }

  const matchedSet = new Set<string>();
  const unmatchedTokens: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const numericVariants = /^\d+$/.test(lower)
      ? [lower, '用户' + lower, '用户 ' + lower, '#' + lower]
      : [lower];
    let hit = false;
    for (const candidate of candidates) {
      if (numericVariants.some((v) => candidate.keys.includes(v))) {
        matchedSet.add(candidate.id);
        hit = true;
      }
    }
    if (!hit) unmatchedTokens.push(token);
  }

  const matchedIds = candidates.filter((c) => matchedSet.has(c.id)).map((c) => c.id);
  return {
    tokens,
    matchedIds,
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

export function normalizeTargetListKind(kind: TargetListKind): NormalizedTargetListKind {
  return kind === 'bumper_pages' || kind === 'pages' ? 'bumper_pages' : 'shared_groups';
}

export interface TargetFolder {
  id: string;
  listKind: TargetListKind;
  name: string;
  sortOrder: number;
  createdAt: number;
}
export const TargetListCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    listKind: TargetListKind,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ action: z.literal('rename'), id: z.uuid(), name: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal('delete'), id: z.uuid() }),
  z.object({
    action: z.literal('reorder-folders'),
    listKind: TargetListKind,
    orderedFolderIds: z.array(z.uuid()).max(500),
  }),
  z.object({
    action: z.literal('reorder-items'),
    listKind: TargetListKind,
    folderId: z.uuid().nullable(),
    orderedItemIds: z.array(z.string().min(1).max(120)).max(10000),
  }),
]);
export type TargetListCommand = z.infer<typeof TargetListCommand>;
