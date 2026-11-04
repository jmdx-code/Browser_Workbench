import { useState } from 'react';
import {
  buildTargetCandidates,
  normalizeTargetToken,
  resolveSelectByIds,
  type SelectByIdsCandidate,
  type TargetListKind,
} from '../shared/target-list.js';
import type { Profile } from '../shared/contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import { IconClose } from './icons.js';

export {
  buildTargetCandidates,
  normalizeTargetToken,
  resolveSelectByIds,
  type SelectByIdsCandidate,
};

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
