import { useState } from 'react';
import { extractGroupId } from '../shared/group-inviter.js';
import { extractBumperPageId } from '../shared/group-bumper.js';
import type { TargetListKind } from '../shared/target-list.js';
import type { Profile } from '../shared/contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import { IconClose } from './icons.js';

export interface SelectByIdsCandidate {
  id: string;
  keys: string[];
}

export function normalizeTargetToken(kind: TargetListKind | 'profiles', raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (kind === 'inviter_groups' || kind === 'bumper_groups') return extractGroupId(trimmed);
  if (kind === 'bumper_pages') return extractBumperPageId(trimmed);
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

export function buildProfileCandidates(
  profiles: readonly Profile[],
  inspections: readonly Inspection[],
): SelectByIdsCandidate[] {
  const inspectionByProfile = new Map(inspections.map((item) => [item.profileId, item]));
  return profiles.map((profile) => {
    const keys = new Set<string>();
    const addKey = (val: string | null | undefined) => {
      const cleaned = val?.trim().toLowerCase();
      if (cleaned) keys.add(cleaned);
    };
    addKey(profile.id);
    addKey(profile.account.id);
    addKey(inspectionByProfile.get(profile.id)?.account.id);
    addKey(profile.browserName);
    addKey(profile.alias);
    for (const label of [profile.browserName, profile.alias]) {
      const text = label?.trim() ?? '';
      const numMatch = /^(?:用户\s*|#)(\d+)$/i.exec(text);
      if (numMatch?.[1]) {
        keys.add(numMatch[1]);
        keys.add('用户' + numMatch[1]);
        keys.add('用户 ' + numMatch[1]);
        keys.add('#' + numMatch[1]);
      }
    }
    return {
      id: profile.id,
      keys: [...keys],
    };
  });
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

export function SelectByIdsDialog({
  title,
  kind,
  candidates,
  placeholder,
  onClose,
  onApply,
}: {
  title: string;
  kind: TargetListKind | 'profiles';
  candidates: readonly SelectByIdsCandidate[];
  placeholder?: string;
  onClose: () => void;
  onApply: (matchedIds: string[], mode: 'append' | 'replace') => void;
}) {
  const [text, setText] = useState('');
  const { tokens, matchedIds, unmatchedTokens } = resolveSelectByIds(text, kind, candidates);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="modal select-by-ids-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <p className="muted modal-desc">
          {kind === 'profiles'
            ? '支持粘贴多个 FB 账号 ID、浏览器编号（如 15 或 用户15）或浏览器名称，每行一个，也支持逗号、顿号、分号或空格分隔。'
            : '支持粘贴多个 ID 或完整 Facebook 链接，每行一个，也支持逗号、顿号、分号或空格分隔，会自动提取 ID 并去重。'}
        </p>
        <textarea
          autoFocus
          className="select-by-ids-textarea"
          aria-label="批量输入 ID"
          rows={8}
          placeholder={
            placeholder ??
            (kind === 'profiles'
              ? '每行输入一个 FB 账号 ID 或浏览器编号，例如：\n1000123456789\n15\n用户16'
              : '每行输入一个 ID 或链接，例如：\n123456789\nhttps://www.facebook.com/groups/987654321/')
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="select-by-ids-preview" role="status">
          <span>
            已识别 {tokens.length} 个去重 ID · 匹配到 {matchedIds.length} 项
          </span>
          {unmatchedTokens.length > 0 && (
            <small className="text-danger">
              未匹配：{unmatchedTokens.slice(0, 8).join('、')}
              {unmatchedTokens.length > 8 ? ` 等 ${unmatchedTokens.length} 个` : ''}
            </small>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            disabled={matchedIds.length === 0}
            onClick={() => {
              onApply(matchedIds, 'append');
              onClose();
            }}
          >
            追加选中 ({matchedIds.length})
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={matchedIds.length === 0}
            onClick={() => {
              onApply(matchedIds, 'replace');
              onClose();
            }}
          >
            覆盖选中 ({matchedIds.length})
          </button>
        </div>
      </div>
    </div>
  );
}
