import type { Dispatch, SetStateAction } from 'react';
import {
  computeCascadeRects,
  computeDisplayTileSlots,
  computeMultiDisplayTilePlan,
} from '../../domain/window-layout.js';
import { profileDisplayName, type Profile } from '../../shared/contracts.js';
import type {
  LayoutScreen,
  LayoutSettings,
  TileDisplayConfig,
} from '../../shared/window-layout.js';
import { IconLayoutGrid, IconMonitor } from '../icons.js';
import { UI_CARD, UI_CHECKBOX, UI_INPUT, UI_INPUT_SM, UI_SELECT } from '../ui/primitives.js';
import { Btn, Fld } from './shared/module-ui.js';

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
      <div className="flex items-center justify-between gap-2">
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
                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                      <Fld key={key} label={label} className="text-[11px]">
                        <input
                          type="number"
                          min={min}
                          max={max}
                          disabled={!cfg.enabled}
                          className={UI_INPUT_SM}
                          value={cfg[key]}
                          onChange={(e) =>
                            p.onUpdateTileDisplay(sc.id, {
                              [key]: clampInt(e.target.value, min, max, def),
                            })
                          }
                        />
                      </Fld>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 max-[420px]:grid-cols-1">
            <Fld label="窗口间距 (px)">
              <input
                type="number"
                min={0}
                max={48}
                className={UI_INPUT}
                value={p.tileGap}
                onChange={(e) =>
                  p.setSettings((pr) => ({ ...pr, tileGap: clampInt(e.target.value, 0, 48, 0) }))
                }
              />
            </Fld>
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
          <Fld label="目标显示器">
            <select
              className={UI_SELECT}
              value={p.settings.displayId ?? ''}
              onChange={(e) =>
                p.setSettings((pr) => ({
                  ...pr,
                  displayId: e.target.value || null,
                  reservedArea: undefined,
                }))
              }
            >
              {p.displays.map((d) => (
                <option key={d.id} value={d.id}>
                  {p.displayLabels.get(d.id) ?? d.id} · {d.workArea.width}×{d.workArea.height}
                </option>
              ))}
            </select>
          </Fld>
          <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
            {CASCADE_SPECS.map(([key, label, min, max, fb, ph]) => (
              <Fld key={key} label={label}>
                <input
                  type="number"
                  min={min}
                  max={max}
                  placeholder={ph(p.settings.step)}
                  className={UI_INPUT}
                  value={p.settings[key] ?? ''}
                  onChange={(e) =>
                    p.setSettings((pr) => ({
                      ...pr,
                      [key]:
                        e.target.value !== '' ? clampInt(e.target.value, min, max, fb) : undefined,
                    }))
                  }
                />
              </Fld>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export interface DisplayBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

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
): string[] {
  const online = profiles.filter((p) => p.online);
  let target =
    scope === 'selected' && selectedIds.size > 0
      ? online.filter((p) => selectedIds.has(p.id))
      : online;
  if (target.length === 0) target = online;
  if (sort === 'name') {
    const lbl = (p: Profile) => profileDisplayName(p, p.account?.name || p.id);
    target = [...target].sort((a, b) => lbl(a).localeCompare(lbl(b), 'zh-CN'));
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
  return (
    <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-slate-900">多屏排版预览画布</span>
          <span className="text-xs text-slate-500">
            {p.mode === 'tile'
              ? '点击任意启用屏幕上的网格编号，可直接设定该屏「起始位置」（前序槽位留空给主工作区）。'
              : `预览 ${p.previewCount} 个窗口在目标显示器上的斜向阶梯分布。`}
          </span>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
          {p.displays.length} 台显示器 · 预览 {p.previewCount} 窗
        </span>
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
