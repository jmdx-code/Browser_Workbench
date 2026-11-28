import type { Dispatch, SetStateAction } from 'react';
import {
  computeCascadeRects,
  computeDisplayTileSlots,
  computeMultiDisplayTilePlan,
} from '../../domain/window-layout.js';
import { bluestacksDisplayTitle, type BluestacksInstance } from '../../shared/bluestacks.js';
import { profileDisplayName, type Group, type Profile } from '../../shared/contracts.js';
import type {
  LayoutScreen,
  LayoutSettings,
  TileDisplayConfig,
} from '../../shared/window-layout.js';
import {
  IconAlertTriangle,
  IconLayoutGrid,
  IconMonitor,
  IconSmartphone,
  IconWindow,
} from '../icons.js';
import {
  UI_BETWEEN,
  UI_CARD,
  UI_CHECKBOX,
  UI_INPUT,
  UI_INPUT_SM,
  UI_ROW_BT,
  UI_ROW_SM,
  UI_SELECT,
} from '../ui/primitives.js';
import { Btn, Fld } from './shared/module-ui.js';
const BS_LAYOUT_STORAGE_KEY = 'wb.windowLayout.bluestacks.v1';
const BS_DEFAULT: StoredBsLayout = { scope: 'selected', columns: 4, gap: 8, displayId: '' };
export interface StoredBsLayout {
  scope: 'selected' | 'all_online';
  columns: number;
  gap: number;
  displayId: string;
}
export function readStoredBsLayout(): StoredBsLayout {
  try {
    const raw = window.localStorage.getItem(BS_LAYOUT_STORAGE_KEY);
    if (!raw) return BS_DEFAULT;
    const p = JSON.parse(raw) as Partial<StoredBsLayout>;
    const clamp = (v: unknown, min: number, max: number, fb: number) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.max(min, Math.min(max, Math.round(v)))
        : fb;
    return {
      scope: p.scope === 'all_online' ? 'all_online' : 'selected',
      columns: clamp(p.columns, 1, 10, 4),
      gap: clamp(p.gap, 0, 48, 8),
      displayId: typeof p.displayId === 'string' ? p.displayId : '',
    };
  } catch {
    return BS_DEFAULT;
  }
}
export function saveStoredBsLayout(next: StoredBsLayout) {
  try {
    window.localStorage.setItem(BS_LAYOUT_STORAGE_KEY, JSON.stringify(next));
  } catch {}
}
type CascadeKey =
  | 'cascadeWidth'
  | 'cascadeHeight'
  | 'cascadeStepX'
  | 'cascadeStepY'
  | 'cascadeStartX'
  | 'cascadeStartY';
const CASCADE_SPECS: ReadonlyArray<
  [CascadeKey, string, number, number, number, (s: number) => string]
> = [
  ['cascadeWidth', '统一宽度 (留空自动)', 480, 3840, 960, () => '自动'],
  ['cascadeHeight', '统一高度 (留空自动)', 360, 2160, 720, () => '自动'],
  ['cascadeStepX', '横向错位步进 (px)', 8, 200, 28, (s) => String(Math.max(24, s * 3))],
  ['cascadeStepY', '纵向错位步进 (px)', 8, 200, 34, (s) => String(Math.max(28, s * 4))],
  ['cascadeStartX', '起始 X 偏移 (px)', 0, 2000, 0, () => '12'],
  ['cascadeStartY', '起始 Y 偏移 (px)', 0, 2000, 0, () => '12'],
];
const TILE_NUMS: ReadonlyArray<[string, 'rows' | 'cols' | 'startSlot', number, number, number]> = [
  ['行 (0=自动)', 'rows', 0, 8, 0],
  ['列 (0=自动)', 'cols', 0, 8, 0],
  ['起始位置', 'startSlot', 1, 64, 1],
];
export const clampInt = (raw: string, min: number, max: number, fb: number) =>
  Math.max(min, Math.min(max, Number(raw) || fb));
const pctBox = (
  r: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => ({
  left: `${((r.x - b.x) / b.width) * 100}%`,
  top: `${((r.y - b.y) / b.height) * 100}%`,
  width: `${(r.width / b.width) * 100}%`,
  height: `${(r.height / b.height) * 100}%`,
});
function DisplaySelect(p: {
  displays: readonly LayoutScreen[];
  displayLabels: ReadonlyMap<string, string>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Fld label="目标显示器">
      <select className={UI_SELECT} value={p.value} onChange={(e) => p.onChange(e.target.value)}>
        {p.displays.map((d) => (
          <option key={d.id} value={d.id}>
            {p.displayLabels.get(d.id) ?? d.id} · {d.workArea.width}×{d.workArea.height}
          </option>
        ))}
      </select>
    </Fld>
  );
}
function NumFld(p: {
  label: string;
  min: number;
  max: number;
  value: number | string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  wrapClass?: string;
  onChange: (raw: string) => void;
}) {
  return (
    <Fld label={p.label} className={p.wrapClass}>
      <input
        type="number"
        min={p.min}
        max={p.max}
        disabled={p.disabled}
        placeholder={p.placeholder}
        className={p.className ?? UI_INPUT}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </Fld>
  );
}
export function WindowLayoutSettingsPanel(p: {
  mode: 'tile' | 'cascade';
  displays: readonly LayoutScreen[];
  displayLabels: ReadonlyMap<string, string>;
  tileConfigs: readonly TileDisplayConfig[];
  tileGap: number;
  tileOverflow: 'wrap' | 'keep';
  settings: LayoutSettings;
  setSettings: Dispatch<SetStateAction<LayoutSettings>>;
  busy: boolean;
  onReloadDisplays: () => void;
  onUpdateTileDisplay: (displayId: string, patch: Partial<TileDisplayConfig>) => void;
}) {
  return (
    <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
      <div className={UI_BETWEEN}>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <IconLayoutGrid size={15} />{' '}
          {p.mode === 'tile' ? '屏幕网格与起始槽位' : '堆叠尺寸与步进偏移'}
        </span>
        <Btn v="ghost" disabled={p.busy} onClick={p.onReloadDisplays}>
          重新读取屏幕
        </Btn>
      </div>
      {p.mode === 'tile' ? (
        <>
          <div className="flex flex-col gap-2.5">
            {p.displays.map((sc) => {
              const cfg = p.tileConfigs.find((i) => i.displayId === sc.id) ?? {
                displayId: sc.id,
                enabled: true,
                rows: 0,
                cols: 0,
                startSlot: 1,
              };
              const auto = cfg.rows === 0 || cfg.cols === 0;
              return (
                <div
                  key={sc.id}
                  className={`rounded-lg border p-3 transition-colors ${cfg.enabled ? 'border-slate-300 bg-slate-50/70' : 'border-slate-200 bg-slate-50/30 opacity-65'}`}
                >
                  <div className={UI_ROW_BT}>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-900">
                      <input
                        type="checkbox"
                        className={UI_CHECKBOX}
                        checked={cfg.enabled}
                        onChange={(e) =>
                          p.onUpdateTileDisplay(sc.id, { enabled: e.target.checked })
                        }
                      />
                      <IconMonitor size={14} />
                      <span>{p.displayLabels.get(sc.id) ?? '显示器'}</span>
                      <span className="font-mono font-normal text-slate-500">
                        {sc.workArea.width}×{sc.workArea.height} ·{' '}
                        {Math.round(sc.scaleFactor * 100)}%
                      </span>
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
                      <input
                        type="checkbox"
                        className={UI_CHECKBOX}
                        checked={auto}
                        onChange={(e) =>
                          p.onUpdateTileDisplay(
                            sc.id,
                            e.target.checked ? { rows: 0, cols: 0 } : { rows: 2, cols: 3 },
                          )
                        }
                      />{' '}
                      自动行列
                    </label>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2 max-[420px]:grid-cols-1">
                    {TILE_NUMS.map(([label, key, min, max, def]) => (
                      <NumFld
                        key={key}
                        label={label}
                        wrapClass="text-[11px]"
                        className={UI_INPUT_SM}
                        min={min}
                        max={max}
                        disabled={!cfg.enabled}
                        value={cfg[key]}
                        onChange={(raw) =>
                          p.onUpdateTileDisplay(sc.id, { [key]: clampInt(raw, min, max, def) })
                        }
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 max-[420px]:grid-cols-1">
            <NumFld
              label="窗口间距 (px)"
              min={0}
              max={48}
              value={p.tileGap}
              onChange={(raw) =>
                p.setSettings((pr) => ({ ...pr, tileGap: clampInt(raw, 0, 48, 0) }))
              }
            />
            <Fld label="窗口数超出槽位时">
              <select
                className={UI_SELECT}
                value={p.tileOverflow}
                onChange={(e) =>
                  p.setSettings((pr) => ({
                    ...pr,
                    tileOverflow: e.target.value === 'keep' ? 'keep' : 'wrap',
                  }))
                }
              >
                <option value="wrap">从首槽位轻微错位叠放</option>
                <option value="keep">超出窗口保留原位</option>
              </select>
            </Fld>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <DisplaySelect
            displays={p.displays}
            displayLabels={p.displayLabels}
            value={p.settings.displayId ?? ''}
            onChange={(id) =>
              p.setSettings((pr) => ({ ...pr, displayId: id || null, reservedArea: undefined }))
            }
          />
          <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
            {CASCADE_SPECS.map(([key, label, min, max, fb, ph]) => (
              <NumFld
                key={key}
                label={label}
                min={min}
                max={max}
                placeholder={ph(p.settings.step)}
                value={p.settings[key] ?? ''}
                onChange={(raw) =>
                  p.setSettings((pr) => ({
                    ...pr,
                    [key]: raw !== '' ? clampInt(raw, min, max, fb) : undefined,
                  }))
                }
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
export type DisplayBounds = { minX: number; minY: number; width: number; height: number };
export function normalizeTileConfigs(
  displays: readonly LayoutScreen[],
  saved?: readonly TileDisplayConfig[],
): TileDisplayConfig[] {
  const byId = new Map((saved ?? []).map((item) => [item.displayId, item]));
  const result = displays.map(
    (s) =>
      byId.get(s.id) ?? {
        displayId: s.id,
        enabled: saved && saved.length > 0 ? false : s.primary || displays.length === 1,
        rows: 0,
        cols: 0,
        startSlot: 1,
      },
  );
  if (!result.some((item) => item.enabled) && result[0])
    result[0] = { ...result[0], enabled: true };
  return result;
}
export function getTargetProfileIds(
  profiles: readonly Profile[],
  selectedIds: ReadonlySet<string>,
  scope: 'selected' | 'all_online',
  sort: 'list' | 'name',
  groups: readonly Group[] = [],
): string[] {
  const online = profiles.filter((p) => p.online);
  let target = scope === 'selected' ? online.filter((p) => selectedIds.has(p.id)) : online;
  if (sort === 'name') {
    const lbl = (p: Profile) => profileDisplayName(p, p.account?.name || p.id);
    target = [...target].sort((a, b) => lbl(a).localeCompare(lbl(b), 'zh-CN'));
  } else {
    const sortedGroups = [...groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const groupRank = new Map(sortedGroups.map((g, idx) => [g.id, idx]));
    const ungroupedRank = sortedGroups.length;
    target = [...target].sort((a, b) => {
      const ga = a.groupId ? (groupRank.get(a.groupId) ?? ungroupedRank) : ungroupedRank;
      const gb = b.groupId ? (groupRank.get(b.groupId) ?? ungroupedRank) : ungroupedRank;
      return ga !== gb ? ga - gb : (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
    });
  }
  return target.map((p) => p.id);
}
export function computeDisplayBounds(displays: readonly LayoutScreen[]): DisplayBounds {
  if (displays.length === 0) return { minX: 0, minY: 0, width: 1920, height: 1080 };
  const minX = Math.min(...displays.map((d) => d.workArea.x)),
    minY = Math.min(...displays.map((d) => d.workArea.y)),
    maxX = Math.max(...displays.map((d) => d.workArea.x + d.workArea.width)),
    maxY = Math.max(...displays.map((d) => d.workArea.y + d.workArea.height));
  return { minX, minY, width: Math.max(100, maxX - minX), height: Math.max(100, maxY - minY) };
}
export function WindowLayoutPreviewCanvas(p: {
  mode: 'tile' | 'cascade';
  displays: readonly LayoutScreen[];
  displayLabels: ReadonlyMap<string, string>;
  tileConfigs: readonly TileDisplayConfig[];
  tileGap: number;
  bounds: DisplayBounds;
  previewCount: number;
  previewTilePlan: ReturnType<typeof computeMultiDisplayTilePlan> | null;
  activeCascadeDisplay: LayoutScreen | undefined;
  previewCascadeRects: ReturnType<typeof computeCascadeRects>;
  onlineProfilesCount: number;
  onUpdateTileDisplay: (displayId: string, patch: Partial<TileDisplayConfig>) => void;
}) {
  const bRect = {
    x: p.bounds.minX,
    y: p.bounds.minY,
    width: p.bounds.width,
    height: p.bounds.height,
  };
  const smallTile =
    p.mode === 'tile' && p.previewTilePlan
      ? p.previewTilePlan.rects.reduce<{ width: number; height: number } | null>((min, rect) => {
          if (!rect || (rect.width >= 520 && rect.height >= 460)) return min;
          return !min || rect.width * rect.height < min.width * min.height
            ? { width: rect.width, height: rect.height }
            : min;
        }, null)
      : null;
  return (
    <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
      <div className={UI_ROW_BT}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-slate-900">多屏排版预览画布</span>
          <span className="text-xs text-slate-500">
            {p.mode === 'tile'
              ? '点击任意启用屏幕上的网格编号，可直接设定该屏「起始位置」（前序槽位留空给主工作区）。'
              : `预览 ${p.previewCount} 个窗口在目标显示器上的斜向阶梯分布。`}
          </span>
        </div>
        <div className={UI_ROW_SM}>
          {smallTile && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-800"
              title="部分网页按钮在过窄窗口中可能折叠，仍可执行排版"
            >
              <IconAlertTriangle size={12} /> 单窗尺寸偏小 ({smallTile.width}×{smallTile.height}{' '}
              &lt; 520×460)
            </span>
          )}
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
            {p.displays.length} 台显示器 · 预览 {p.previewCount} 窗
          </span>
        </div>
      </div>
      <div className="flex w-full items-center justify-center rounded-xl border border-slate-200 bg-slate-950/[0.03] p-4">
        <div
          className="relative overflow-hidden"
          style={{
            aspectRatio: `${p.bounds.width} / ${p.bounds.height}`,
            width: `min(100%, ${(310 * (p.bounds.width / p.bounds.height)).toFixed(2)}px)`,
          }}
        >
          {p.displays.map((screen) => {
            const cfg = p.tileConfigs.find((item) => item.displayId === screen.id);
            const planEntry = p.previewTilePlan?.entries.find((e) => e.display.id === screen.id);
            const screenSlots = planEntry
              ? planEntry.slots
              : p.mode === 'tile' && cfg?.enabled
                ? computeDisplayTileSlots(
                    screen,
                    Math.max(1, cfg.rows || 2),
                    Math.max(1, cfg.cols || 2),
                    p.tileGap,
                  )
                : [];
            return (
              <div
                key={screen.id}
                className="absolute overflow-hidden rounded-lg border-2 border-slate-400/70 bg-white shadow-sm"
                style={pctBox(screen.workArea, bRect)}
              >
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100/90 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                  <span>
                    {p.displayLabels.get(screen.id)}
                    {planEntry ? ` (${planEntry.rows}×${planEntry.cols})` : ''}
                  </span>
                  <span className="font-mono font-normal text-slate-500">
                    {screen.workArea.width}×{screen.workArea.height}
                  </span>
                </div>
                <div className="relative h-[calc(100%-20px)] w-full">
                  {p.mode === 'tile' &&
                    cfg?.enabled &&
                    screenSlots.map((slot, slotIdx) => {
                      const slotNum = slotIdx + 1,
                        skipped = slotNum < cfg.startSlot,
                        assigned = planEntry?.slotWindowIndices[slotIdx] ?? [];
                      return (
                        <button
                          key={slotNum}
                          type="button"
                          title={`设第 ${slotNum} 格为起始槽位`}
                          onClick={() => p.onUpdateTileDisplay(screen.id, { startSlot: slotNum })}
                          style={pctBox(slot, screen.workArea)}
                          className={`absolute flex flex-col items-center justify-center rounded border text-[11px] font-semibold transition-colors ${skipped ? 'border-dashed border-slate-300 bg-slate-100/70 text-slate-400 hover:border-slate-500' : assigned.length > 0 ? 'border-slate-800 bg-slate-900/10 text-slate-900 hover:bg-slate-900/15' : 'border-slate-300 bg-white/80 text-slate-500 hover:border-slate-500'}`}
                        >
                          <span>#{slotNum}</span>
                          {assigned.length > 0 && (
                            <span className="text-[10px] font-normal text-slate-600">
                              窗 {assigned.map((idx) => idx + 1).join(',')}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  {p.mode === 'cascade' &&
                    p.activeCascadeDisplay?.id === screen.id &&
                    p.previewCascadeRects.map((rect, idx) => (
                      <div
                        key={idx}
                        style={{ ...pctBox(rect, screen.workArea), zIndex: idx + 1 }}
                        className="absolute flex items-start justify-start rounded border border-slate-700 bg-white/95 p-1 text-[10px] font-semibold text-slate-800 shadow-xs"
                      >
                        窗 {idx + 1}
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {p.onlineProfilesCount === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
          <span>当前暂无在线浏览器，预览按 6 窗示例排布。打开任意浏览器后即可实时排版。</span>
        </div>
      )}
    </section>
  );
}
export function BluestacksWindowLayoutSection(p: {
  bsScope: 'selected' | 'all_online';
  setBsScope: (next: 'selected' | 'all_online') => void;
  bsColumns: number;
  setBsColumns: (next: number) => void;
  bsGap: number;
  setBsGap: (next: number) => void;
  displays: readonly LayoutScreen[];
  displayLabels: ReadonlyMap<string, string>;
  selectedBsDisplay: LayoutScreen | undefined;
  setBsDisplayId: (id: string) => void;
  bsTileEst: { width: number; height: number } | null;
  bsOnline: readonly BluestacksInstance[];
  busy: boolean;
  onShowInstance: (inst: BluestacksInstance) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
      <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
        <div className={UI_BETWEEN}>
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <IconSmartphone size={15} /> 蓝蝶网格排版参数
          </span>
          {p.bsTileEst && (p.bsTileEst.width < 520 || p.bsTileEst.height < 460) && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800"
              title="单台可用区域小于 520×460，可能压缩界面元素，不影响继续平铺"
            >
              <IconAlertTriangle size={11} /> {p.bsTileEst.width}×{p.bsTileEst.height} &lt; 520×460
            </span>
          )}
        </div>
        <Fld label="作用范围">
          <select
            className={UI_SELECT}
            value={p.bsScope}
            onChange={(e) =>
              p.setBsScope(e.target.value === 'all_online' ? 'all_online' : 'selected')
            }
          >
            <option value="selected">仅已勾选蓝蝶</option>
            <option value="all_online">全部在线蓝蝶</option>
          </select>
        </Fld>
        {p.displays.length > 0 && (
          <DisplaySelect
            displays={p.displays}
            displayLabels={p.displayLabels}
            value={p.selectedBsDisplay?.id ?? ''}
            onChange={p.setBsDisplayId}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <NumFld
            label="每行窗口列数"
            min={1}
            max={10}
            value={p.bsColumns}
            onChange={(raw) => p.setBsColumns(clampInt(raw, 1, 10, 4))}
          />
          <NumFld
            label="窗口间距 (px)"
            min={0}
            max={48}
            value={p.bsGap}
            onChange={(raw) => p.setBsGap(clampInt(raw, 0, 48, 8))}
          />
        </div>
        <p className="m-0 text-[11px] leading-relaxed text-slate-500">
          蓝蝶窗口按所选显示器工作区自动适配纵横比网格排版（每行 {p.bsColumns} 台，间距 {p.bsGap}{' '}
          px，参数自动保存在本地）。
        </p>
      </section>
      <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
        <span className="text-sm font-semibold text-slate-900">
          在线蓝蝶窗口列表 ({p.bsOnline.length})
        </span>
        {p.bsOnline.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-3 text-xs text-amber-800">
            当前暂无已开机的蓝蝶模拟器窗口。启动任意蓝蝶实例后，可在此一键网格平铺或置前定位。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {p.bsOnline.map((inst) => (
              <div
                key={inst.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-900">
                    {bluestacksDisplayTitle(inst)}
                  </div>
                  <div className="truncate text-[11px] text-slate-500">
                    {inst.accountName || inst.instanceKey} · 端口 {inst.adbPort}
                  </div>
                </div>
                <Btn disabled={p.busy} onClick={() => p.onShowInstance(inst)}>
                  <IconWindow size={12} /> 置前
                </Btn>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
