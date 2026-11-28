import { useMemo, type ReactNode } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../../shared/bluestacks.js';
import { profileDisplayName } from '../../../shared/contracts.js';
import { UI_ROW, UI_ROW_SM, UI_SELECT_SM } from '../../ui/primitives.js';
import { Btn } from './module-ui.js';
export interface TargetScopeOption {
  id: string;
  label: string;
  online: boolean;
  groupId?: string | null | undefined;
}
type TargetScopeGroup = { id: string; name: string };
export const mapProfilesToScopeOptions = (
  profiles: ReadonlyArray<{
    id: string;
    name?: string | null;
    browserName?: string | null;
    alias?: string | null;
    groupId?: string | null;
    online?: boolean | undefined;
  }>,
): TargetScopeOption[] =>
  profiles.map((p) => ({
    id: p.id,
    label: profileDisplayName(p, p.id),
    online: Boolean(p.online),
    groupId: p.groupId ?? null,
  }));
export const mapBluestacksToScopeOptions = (bs?: BluestacksState | null): TargetScopeOption[] =>
  (bs?.instances ?? []).map((i) => ({
    id: i.id,
    label: bluestacksDisplayTitle(i),
    online: i.online,
    groupId: i.folderId,
  }));
export function TargetScopeBar({
  carrier,
  items,
  groups = [],
  selectedIds,
  onSelect,
  extra,
}: {
  carrier: 'browser' | 'bluestacks';
  items: readonly TargetScopeOption[];
  groups?: readonly TargetScopeGroup[] | undefined;
  selectedIds: ReadonlySet<string>;
  onSelect?: ((next: Set<string>) => void) | undefined;
  extra?: ReactNode | undefined;
}) {
  const unitLabel = carrier === 'bluestacks' ? '蓝蝶窗口' : '浏览器';
  const { selectedTotal, selectedOnline, selectedOffline, onlineIds, groupChoices } =
    useMemo(() => {
      let selTotal = 0,
        selOnline = 0;
      const onIds: string[] = [],
        byGroup = new Map<string, string[]>();
      for (const item of items) {
        if (item.online) onIds.push(item.id);
        if (selectedIds.has(item.id)) {
          selTotal++;
          if (item.online) selOnline++;
        }
        if (item.groupId) {
          const list = byGroup.get(item.groupId) ?? [];
          list.push(item.id);
          byGroup.set(item.groupId, list);
        }
      }
      return {
        selectedTotal: selTotal,
        selectedOnline: selOnline,
        selectedOffline: selTotal - selOnline,
        onlineIds: onIds,
        groupChoices: groups
          .map((g) => ({ id: g.id, name: g.name, ids: byGroup.get(g.id) ?? [] }))
          .filter((g) => g.ids.length > 0),
      };
    }, [items, groups, selectedIds]);
  return (
    <div
      className="mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-xs shadow-2xs"
      role="region"
      aria-label="当前执行目标"
    >
      <div className={UI_ROW}>
        <span className="font-semibold text-slate-700">执行目标</span>
        {selectedTotal > 0 ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 font-medium text-blue-800">
            已选 <strong className="tabular-nums">{selectedTotal}</strong> 个{unitLabel}
            <span className="text-[11px] font-normal text-blue-700">
              （在线 {selectedOnline}
              {selectedOffline > 0 ? ` · 离线将唤醒 ${selectedOffline}` : ''}）
            </span>
          </span>
        ) : (
          <span className="inline-flex h-6 items-center rounded-md border border-amber-200 bg-amber-50 px-2 font-medium text-amber-800">
            尚未勾选{unitLabel}（请在左侧勾选或右侧快选）
          </span>
        )}
        {extra}
      </div>
      <div className={UI_ROW_SM}>
        {onSelect && (
          <>
            <Btn
              disabled={onlineIds.length === 0}
              onClick={() => onSelect(new Set(onlineIds))}
              title={`一键选中全部在线${unitLabel}`}
            >
              全选在线 ({onlineIds.length})
            </Btn>
            {groupChoices.length > 0 && (
              <select
                className={UI_SELECT_SM}
                aria-label="按分组快选账号"
                value=""
                onChange={(e) => {
                  const c = groupChoices.find((g) => g.id === e.target.value);
                  if (c) onSelect(new Set(c.ids));
                }}
              >
                <option value="">按分组快选…</option>
                {groupChoices.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.ids.length})
                  </option>
                ))}
              </select>
            )}
            {selectedTotal > 0 && (
              <Btn v="ghost" onClick={() => onSelect(new Set())}>
                清空
              </Btn>
            )}
          </>
        )}
      </div>
    </div>
  );
}
export function CarrierScopeBar(p: {
  isBs: boolean;
  bluestacksState?: BluestacksState | null | undefined;
  profiles?:
    | ReadonlyArray<{
        id: string;
        name?: string | null;
        browserName?: string | null;
        alias?: string | null;
        groupId?: string | null;
        online?: boolean | undefined;
      }>
    | undefined;
  profileGroups?: readonly TargetScopeGroup[] | undefined;
  selected: ReadonlySet<string>;
  onSelect?: ((next: Set<string>) => void) | undefined;
  extra?: ReactNode | undefined;
}) {
  const items = p.isBs
    ? mapBluestacksToScopeOptions(p.bluestacksState)
    : mapProfilesToScopeOptions(p.profiles ?? []);
  const groups = p.isBs
    ? (p.bluestacksState?.folders ?? []).map((f) => ({ id: f.id, name: f.name }))
    : p.profileGroups;
  return (
    <TargetScopeBar
      carrier={p.isBs ? 'bluestacks' : 'browser'}
      items={items}
      groups={groups}
      selectedIds={p.selected}
      onSelect={p.onSelect}
      extra={p.extra}
    />
  );
}
