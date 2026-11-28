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
import { BackdropModal, Btn, ModalHeading } from './modules/shared/module-ui.js';
import { UI_TEXTAREA } from './ui/primitives.js';
export { buildTargetCandidates, normalizeTargetToken, type SelectByIdsCandidate };
export function buildProfileCandidates(
  profiles: readonly Profile[],
  inspections: readonly Inspection[],
): SelectByIdsCandidate[] {
  const byProf = new Map(inspections.map((item) => [item.profileId, item]));
  return profiles.map((p) => {
    const keys = new Set<string>();
    const add = (val: string | null | undefined) => {
      const cleaned = val?.trim().toLowerCase();
      if (cleaned) keys.add(cleaned);
    };
    [p.id, p.account.id, byProf.get(p.id)?.account.id, p.browserName, p.alias].forEach(add);
    for (const label of [p.browserName, p.alias]) {
      const m = /^(?:用户\s*|#)(\d+)$/i.exec(label?.trim() ?? '');
      if (m?.[1])
        ['' + m[1], '用户' + m[1], '用户 ' + m[1], '#' + m[1]].forEach((k) => keys.add(k));
    }
    return { id: p.id, keys: [...keys] };
  });
}
export function SelectByIdsDialog({
  title,
  kind,
  candidates,
  description,
  placeholder,
  onClose,
  onApply,
}: {
  title: string;
  kind: TargetListKind | 'profiles';
  candidates: readonly SelectByIdsCandidate[];
  description?: string;
  placeholder?: string;
  onClose: () => void;
  onApply: (matchedIds: string[], mode: 'append' | 'replace') => void;
}) {
  const [text, setText] = useState('');
  const { tokens, matchedIds, unmatchedTokens } = resolveSelectByIds(text, kind, candidates);
  const isProf = kind === 'profiles';
  return (
    <BackdropModal label={title} modalClass="w-[min(460px,92vw)]" onClose={onClose}>
      <ModalHeading title={title} className="px-0 pt-0 pb-2.5" onClose={onClose} />
      <p className="m-0 text-xs leading-relaxed text-[var(--text-3)]">
        {description ??
          (isProf
            ? '支持粘贴多个 FB 账号 ID、浏览器编号（如 15 或 用户15）或浏览器名称，每行一个，也支持逗号、顿号、分号或空格分隔。'
            : '支持粘贴多个 ID 或完整 Facebook 链接，每行一个，也支持逗号、顿号、分号或空格分隔，会自动提取 ID 并去重。')}
      </p>
      <textarea
        autoFocus
        className={UI_TEXTAREA + ' min-h-[130px] font-mono'}
        aria-label="批量输入 ID"
        rows={8}
        placeholder={
          placeholder ??
          (isProf
            ? '每行输入一个 FB 账号 ID 或浏览器编号，例如：\n1000123456789\n15\n用户16'
            : '每行输入一个 ID 或链接，例如：\n123456789\nhttps://www.facebook.com/groups/987654321/')
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div
        className="flex flex-col gap-1 rounded-md border border-[var(--line)] bg-slate-50 px-2.5 py-2 text-xs text-[var(--text-2)]"
        role="status"
      >
        <span>
          已识别 {tokens.length} 个去重 ID · 匹配到 {matchedIds.length} 项
        </span>
        {unmatchedTokens.length > 0 && (
          <small className="text-rose-600">
            未匹配：{unmatchedTokens.slice(0, 8).join('、')}
            {unmatchedTokens.length > 8 ? ` 等 ${unmatchedTokens.length} 个` : ''}
          </small>
        )}
      </div>
      <div className="mt-1 flex shrink-0 justify-end gap-2">
        <Btn sm={false} onClick={onClose}>
          取消
        </Btn>
        {(['append', 'replace'] as const).map((mode) => (
          <Btn
            key={mode}
            sm={false}
            v={mode === 'replace' ? 'primary' : undefined}
            disabled={matchedIds.length === 0}
            onClick={() => {
              onApply(matchedIds, mode);
              onClose();
            }}
          >
            {mode === 'append' ? '追加' : '覆盖'}选中 ({matchedIds.length})
          </Btn>
        ))}
      </div>
    </BackdropModal>
  );
}
