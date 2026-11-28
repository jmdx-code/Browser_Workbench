import { useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { computeCascadeRects, computeMultiDisplayTilePlan } from '../../domain/window-layout.js';
import { bluestacksDisplayTitle, type BluestacksState } from '../../shared/bluestacks.js';
import { profileDisplayName, type Group, type Profile } from '../../shared/contracts.js';
import {
  defaultWindowLayout,
  WindowLayoutOverview,
  windowLayoutMessage,
  type LayoutSettings,
  type TileDisplayConfig,
  type WindowLayoutPreset,
} from '../../shared/window-layout.js';
import { api } from '../api.js';
import { IconAlertTriangle, IconGlobe, IconSmartphone } from '../icons.js';
import { PageHeader, UI_INPUT_SM, UI_ROW, UI_SELECT_SM, UiSwitch } from '../ui/primitives.js';
import { Btn, errMsg, NoticeBanner, SegTabs } from './shared/module-ui.js';
import {
  mapBluestacksToScopeOptions,
  mapProfilesToScopeOptions,
  TargetScopeBar,
} from './shared/target-scope-bar.js';
import {
  BluestacksWindowLayoutSection,
  computeDisplayBounds,
  getTargetProfileIds,
  normalizeTileConfigs,
  readStoredBsLayout,
  saveStoredBsLayout,
  WindowLayoutPreviewCanvas,
  WindowLayoutSettingsPanel,
} from './window-layout-preview-canvas.js';
const pickCascade = (
  s: Pick<
    LayoutSettings,
    | 'cascadeWidth'
    | 'cascadeHeight'
    | 'cascadeStepX'
    | 'cascadeStepY'
    | 'cascadeStartX'
    | 'cascadeStartY'
  >,
) => ({
  cascadeWidth: s.cascadeWidth,
  cascadeHeight: s.cascadeHeight,
  cascadeStepX: s.cascadeStepX,
  cascadeStepY: s.cascadeStepY,
  cascadeStartX: s.cascadeStartX,
  cascadeStartY: s.cascadeStartY,
});
type OverviewData = z.infer<typeof WindowLayoutOverview>;
const EMPTY_SET = new Set<string>();
function EmptyScopeBanner(p: { msg: string; onPick: () => void; onAll: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50/90 px-3.5 py-2.5 text-xs text-amber-900">
      <span>{p.msg}</span>
      <div className={UI_ROW}>
        <Btn onClick={p.onPick}>去勾选</Btn>
        <Btn v="primary" onClick={p.onAll}>
          切为全部在线
        </Btn>
      </div>
    </div>
  );
}
export function WindowLayoutPage(p: {
  profiles: Profile[];
  profileGroups?: readonly Group[];
  selectedProfileIds?: Set<string>;
  onSelectProfiles?: (next: Set<string>) => void;
  bluestacks?: BluestacksState | null;
  bluestacksState?: BluestacksState | null;
  selectedBluestacksIds?: ReadonlySet<string>;
  onSelectBluestacks?: (next: Set<string>) => void;
  onRefreshBluestacks?: () => Promise<unknown>;
  onBluestacksState?: (next: BluestacksState) => void;
  initialCarrier?: 'browser' | 'bluestacks';
  onCarrierChange?: (carrier: 'browser' | 'bluestacks') => void;
  onNotify?: (message: string) => void;
  onMessage?: (message: string) => void;
}) {
  const {
    profiles,
    profileGroups = [],
    selectedProfileIds = EMPTY_SET,
    onSelectProfiles,
    selectedBluestacksIds = EMPTY_SET,
    onSelectBluestacks,
    onRefreshBluestacks,
    onBluestacksState,
  } = p;
  const effectiveBsState = p.bluestacksState ?? p.bluestacks;
  const emitMsg = (m: string) => {
    p.onNotify?.(m);
    p.onMessage?.(m);
  };
  const [targetKind, setTargetKind] = useState<'browser' | 'bluestacks'>(
    p.initialCarrier ?? 'browser',
  );
  useEffect(() => {
    if (p.initialCarrier) setTargetKind(p.initialCarrier);
  }, [p.initialCarrier]);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [settings, setSettings] = useState<LayoutSettings>(defaultWindowLayout);
  const initialBs = useMemo(readStoredBsLayout, []);
  const [bsScope, setBsScope] = useState<'selected' | 'all_online'>(initialBs.scope);
  const [bsColumns, setBsColumns] = useState(initialBs.columns);
  const [bsGap, setBsGap] = useState(initialBs.gap);
  const [bsDisplayId, setBsDisplayId] = useState(initialBs.displayId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [presetName, setPresetName] = useState('');
  const [scopePulse, setScopePulse] = useState(false);
  const scopeBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    saveStoredBsLayout({ scope: bsScope, columns: bsColumns, gap: bsGap, displayId: bsDisplayId });
  }, [bsScope, bsColumns, bsGap, bsDisplayId]);
  const bsOnline = useMemo(
    () => (effectiveBsState?.instances ?? []).filter((i) => i.online),
    [effectiveBsState?.instances],
  );
  const bsTargetIds = useMemo(
    () =>
      (bsScope === 'selected'
        ? bsOnline.filter((i) => selectedBluestacksIds.has(i.id))
        : bsOnline
      ).map((i) => i.id),
    [bsOnline, selectedBluestacksIds, bsScope],
  );
  async function runBusy(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      const m = errMsg(err, String(err));
      setError(m);
      emitMsg(m);
    } finally {
      setBusy(false);
    }
  }
  const loadSnapshot = () =>
    runBusy(async () => {
      const v = await api.windowLayout(),
        effMode = v.settings.mode ?? 'cascade',
        primaryId = v.displays.find((d) => d.primary)?.id ?? v.displays[0]?.id ?? null;
      setOverview(v);
      setSettings({
        ...v.settings,
        displayId:
          effMode === 'tile' ? (v.settings.displayId ?? null) : (v.settings.displayId ?? primaryId),
        mode: effMode,
        tileGap: v.settings.tileGap ?? 8,
        tileOverflow: v.settings.tileOverflow ?? 'wrap',
        applyScope: v.settings.applyScope ?? 'selected',
        applySort: v.settings.applySort ?? 'list',
        tileDisplays: normalizeTileConfigs(v.displays, v.settings.tileDisplays),
      });
      if (v.error) setError(windowLayoutMessage(v.error));
    });
  useEffect(() => {
    void loadSnapshot();
  }, []);
  const displays = overview?.displays ?? [],
    mode = settings.mode ?? 'cascade',
    tileGap = settings.tileGap ?? 8,
    tileOverflow = settings.tileOverflow ?? 'wrap',
    applyScope = settings.applyScope ?? 'selected',
    applySort = settings.applySort ?? 'list';
  const tileConfigs = useMemo(
    () => normalizeTileConfigs(displays, settings.tileDisplays),
    [displays, settings.tileDisplays],
  );
  const onlineProfiles = useMemo(() => profiles.filter((pr) => pr.online), [profiles]);
  const targetIds = useMemo(
    () => getTargetProfileIds(profiles, selectedProfileIds, applyScope, applySort, profileGroups),
    [profiles, selectedProfileIds, applyScope, applySort, profileGroups],
  );
  const secondaryDisplay = useMemo(
    () => displays.find((d) => !d.primary) ?? displays[1],
    [displays],
  );
  const displayLabels = useMemo(() => {
    let i = 0;
    return new Map(displays.map((d) => [d.id, d.primary ? '主显示器' : `副显示器 ${++i}`]));
  }, [displays]);
  const selectedBsDisplay = useMemo(
    () =>
      displays.find((d) => d.id === bsDisplayId) ?? displays.find((d) => d.primary) ?? displays[0],
    [displays, bsDisplayId],
  );
  const bsTileEst = useMemo(() => {
    if (!selectedBsDisplay) return null;
    const cols = Math.max(1, Math.min(10, bsColumns)),
      rows = Math.max(1, Math.ceil(Math.max(1, bsTargetIds.length || cols) / cols));
    return {
      width: Math.floor((selectedBsDisplay.workArea.width - bsGap * (cols + 1)) / cols),
      height: Math.floor((selectedBsDisplay.workArea.height - bsGap * (rows + 1)) / rows),
    };
  }, [selectedBsDisplay, bsColumns, bsGap, bsTargetIds.length]);
  const previewCount = Math.max(1, targetIds.length || 6);
  const previewTilePlan = useMemo(
    () =>
      mode === 'tile' && displays.length > 0
        ? computeMultiDisplayTilePlan(previewCount, displays, tileConfigs, tileGap, tileOverflow)
        : null,
    [mode, previewCount, displays, tileConfigs, tileGap, tileOverflow],
  );
  const activeCascadeDisplay = useMemo(
    () =>
      displays.find((d) => d.id === settings.displayId) ??
      displays.find((d) => d.primary) ??
      displays[0],
    [displays, settings.displayId],
  );
  const previewCascadeRects = useMemo(
    () =>
      mode !== 'cascade' || !activeCascadeDisplay
        ? []
        : computeCascadeRects(previewCount, activeCascadeDisplay, {
            width: settings.cascadeWidth,
            height: settings.cascadeHeight,
            stepX: settings.cascadeStepX,
            stepY: settings.cascadeStepY,
            startX: settings.cascadeStartX,
            startY: settings.cascadeStartY,
            step: settings.step,
          }),
    [mode, previewCount, activeCascadeDisplay, settings],
  );
  const bounds = useMemo(() => computeDisplayBounds(displays), [displays]);
  const updateTileDisplay = (displayId: string, patch: Partial<TileDisplayConfig>) =>
    setSettings((pr) => ({
      ...pr,
      tileDisplays: tileConfigs.map((i) => (i.displayId === displayId ? { ...i, ...patch } : i)),
    }));
  const cleanSave = (next: LayoutSettings): LayoutSettings => ({
    ...next,
    tileDisplays: normalizeTileConfigs(displays, next.tileDisplays),
  });
  const handleSave = (nextOverride?: LayoutSettings, msg = '窗口排版配置已保存') =>
    runBusy(async () => {
      const u = await api.windowLayout({
        action: 'configure',
        settings: cleanSave(nextOverride ?? settings),
      });
      setOverview(u);
      setSettings(u.settings);
      emitMsg(msg);
    });
  const emptySelectionMsg = () =>
    applyScope === 'selected'
      ? selectedProfileIds.size > 0
        ? '已勾选的浏览器当前均未在线'
        : '请先勾选至少一个在线浏览器'
      : '当前没有在线浏览器窗口';
  const handleApply = (override?: { mode?: 'tile' | 'cascade'; targetDisplayId?: string }) => {
    if (targetIds.length === 0) return emitMsg(emptySelectionMsg());
    return runBusy(async () => {
      await api.windowLayout({ action: 'configure', settings: cleanSave(settings) });
      const u = await api.windowLayout({
        action: 'apply',
        profileIds: targetIds,
        mode: override?.mode ?? mode,
        ...(override?.targetDisplayId ? { targetDisplayId: override.targetDisplayId } : {}),
      });
      setOverview(u);
      const c = u.movedCount ?? targetIds.length,
        failCount = u.failedProfiles?.length ?? 0;
      emitMsg(
        (override?.targetDisplayId
          ? `已将 ${c} 个窗口移到副屏并整理`
          : `已按「${(override?.mode ?? mode) === 'tile' ? '平铺' : '堆叠'}」整理 ${c} 个浏览器窗口`) +
          (failCount > 0 ? `（另有 ${failCount} 个窗口移动失败）` : ''),
      );
    });
  };
  const handleFocusAll = () => {
    if (targetIds.length === 0) return emitMsg(emptySelectionMsg());
    return runBusy(async () => {
      setOverview(await api.windowLayout({ action: 'focus_all', profileIds: targetIds }));
      emitMsg(`已唤醒并置顶 ${targetIds.length} 个浏览器窗口`);
    });
  };
  async function handleSavePreset() {
    const trimmed = presetName.trim();
    if (!trimmed) return emitMsg('请先输入方案名称');
    const existing = settings.presets ?? [];
    if (existing.length >= 8) return emitMsg('最多可保存 8 套常用方案，请先删除不需要的方案');
    const next: LayoutSettings = {
      ...settings,
      presets: [
        ...existing,
        {
          id: `preset-${Date.now()}`,
          name: trimmed.slice(0, 40),
          mode,
          tileDisplays: tileConfigs,
          tileGap,
          tileOverflow,
          displayId: settings.displayId,
          ...pickCascade(settings),
        },
      ],
    };
    setSettings(next);
    setPresetName('');
    await handleSave(next);
  }
  async function applyPreset(preset: WindowLayoutPreset) {
    const next: LayoutSettings = {
      ...settings,
      mode: preset.mode,
      displayId:
        preset.displayId !== undefined
          ? preset.displayId
          : preset.mode === 'tile'
            ? null
            : settings.displayId,
      tileDisplays: preset.tileDisplays
        ? normalizeTileConfigs(displays, preset.tileDisplays)
        : settings.tileDisplays,
      tileGap: preset.tileGap ?? settings.tileGap,
      tileOverflow: preset.tileOverflow ?? settings.tileOverflow,
      ...pickCascade(preset),
    };
    setSettings(next);
    await handleSave(next, `已载入并保存方案「${preset.name}」`);
  }
  const runBs = (action: 'instances/arrange' | 'instances/show', payload: unknown, msg: string) =>
    void runBusy(async () => {
      onBluestacksState?.(await api.bluestacksAction(action, payload));
      void onRefreshBluestacks?.();
      emitMsg(msg);
    });
  const focusScopeBar = () => {
    scopeBarRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setScopePulse(true);
    setTimeout(() => setScopePulse(false), 1200);
    scopeBarRef.current?.querySelector<HTMLElement>('button, select')?.focus();
  };
  const isBs = targetKind === 'bluestacks';
  const scopeItems = useMemo(
    () =>
      isBs ? mapBluestacksToScopeOptions(effectiveBsState) : mapProfilesToScopeOptions(profiles),
    [isBs, effectiveBsState, profiles],
  );
  const scopeGroups = useMemo(
    () =>
      isBs
        ? (effectiveBsState?.folders ?? []).map((f) => ({ id: f.id, name: f.name }))
        : profileGroups,
    [isBs, effectiveBsState?.folders, profileGroups],
  );
  const failedProfileLabels = useMemo(() => {
    const failed = overview?.failedProfiles ?? [];
    if (!failed.length) return [];
    const byId = new Map(profiles.map((pr) => [pr.id, profileDisplayName(pr)]));
    return failed.map((id) => byId.get(id) ?? id.slice(0, 8));
  }, [overview?.failedProfiles, profiles]);
  const emptySel = isBs
    ? bsScope === 'selected' && selectedBluestacksIds.size === 0
    : applyScope === 'selected' && selectedProfileIds.size === 0;
  const offlineSel = isBs
    ? bsScope === 'selected' && selectedBluestacksIds.size > 0 && bsTargetIds.length === 0
    : applyScope === 'selected' && selectedProfileIds.size > 0 && targetIds.length === 0;
  const emptyBannerMsg = emptySel
    ? `当前作用范围为「仅已勾选${isBs ? '蓝蝶' : '浏览器'}」，但尚未勾选任何${isBs ? '蓝蝶窗口' : '浏览器'}。`
    : offlineSel
      ? `已勾选 ${isBs ? selectedBluestacksIds.size : selectedProfileIds.size} ${isBs ? '台蓝蝶' : '个浏览器'}，但当前均未${isBs ? '开机在线' : '在线'}。`
      : null;
  return (
    <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-4">
      <PageHeader
        title="窗口排版"
        subtitle={
          isBs
            ? `统一平铺当前在线的蓝蝶模拟器窗口（当前在线 ${bsOnline.length} 台 · 待排版 ${bsTargetIds.length} 台）`
            : applyScope === 'selected'
              ? `仅管理已勾选的 Chrome 窗口位置（已勾选 ${selectedProfileIds.size} 个 · 在线待排版 ${targetIds.length} 个）`
              : `管理所有已安装桥接扩展的 Chrome 窗口位置（当前在线 ${onlineProfiles.length} 个 · 待排版 ${targetIds.length} 个）`
        }
        actions={
          <div className={UI_ROW}>
            <SegTabs
              value={targetKind}
              onChange={(next) => {
                setTargetKind(next);
                p.onCarrierChange?.(next);
              }}
              options={[
                [
                  'browser',
                  <>
                    <IconGlobe size={13} /> Chrome 窗口 ({onlineProfiles.length})
                  </>,
                ],
                [
                  'bluestacks',
                  <>
                    {' '}
                    <IconSmartphone size={13} /> 蓝蝶窗口 ({bsOnline.length}){' '}
                  </>,
                ],
              ]}
            />
            {isBs ? (
              <Btn
                v="primary"
                sm={false}
                disabled={busy || bsTargetIds.length === 0}
                onClick={() =>
                  bsTargetIds.length === 0
                    ? emitMsg(
                        emptySel ? '请先勾选至少一个在线蓝蝶窗口' : '当前没有可排版的在线蓝蝶窗口',
                      )
                    : runBs(
                        'instances/arrange',
                        {
                          instanceIds: bsTargetIds,
                          columns: Math.max(1, Math.min(10, bsColumns)),
                          gap: Math.max(0, Math.min(48, bsGap)),
                          ...(selectedBsDisplay
                            ? {
                                monitorBounds: {
                                  left: selectedBsDisplay.workArea.x,
                                  top: selectedBsDisplay.workArea.y,
                                  width: selectedBsDisplay.workArea.width,
                                  height: selectedBsDisplay.workArea.height,
                                },
                              }
                            : {}),
                        },
                        `已整齐平铺 ${bsTargetIds.length} 个蓝蝶模拟器窗口`,
                      )
                }
              >
                立即平铺蓝蝶 ({bsTargetIds.length})
              </Btn>
            ) : (
              <>
                <Btn
                  v="primary"
                  sm={false}
                  disabled={busy || targetIds.length === 0}
                  onClick={() => void handleApply()}
                >
                  立即排版 ({targetIds.length})
                </Btn>
                <Btn
                  sm={false}
                  disabled={busy || targetIds.length === 0}
                  onClick={() => void handleFocusAll()}
                >
                  {applyScope === 'selected' ? `置顶已选 (${targetIds.length})` : '全部置顶'}
                </Btn>
                {secondaryDisplay && (
                  <Btn
                    sm={false}
                    disabled={busy || targetIds.length === 0}
                    onClick={() => void handleApply({ targetDisplayId: secondaryDisplay.id })}
                  >
                    移到副屏
                  </Btn>
                )}
                <Btn sm={false} disabled={busy} onClick={() => void handleSave()}>
                  保存配置
                </Btn>
              </>
            )}
          </div>
        }
      />
      <div
        ref={scopeBarRef}
        className={
          scopePulse ? 'rounded-lg ring-2 ring-[var(--brand)] ring-offset-2 transition-shadow' : ''
        }
      >
        <TargetScopeBar
          carrier={targetKind}
          items={scopeItems}
          groups={scopeGroups}
          selectedIds={isBs ? selectedBluestacksIds : selectedProfileIds}
          onSelect={isBs ? onSelectBluestacks : onSelectProfiles}
        />
      </div>
      {error && <NoticeBanner tone="err">{error}</NoticeBanner>}
      {!isBs && failedProfileLabels.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          role="alert"
        >
          <IconAlertTriangle size={14} className="shrink-0 text-amber-700" />
          <span>
            部分窗口排版失败（{failedProfileLabels.length} 个）：{failedProfileLabels.join('、')}
            。请确认对应窗口未处于最小化/全屏状态且桥接扩展已在线。
          </span>
        </div>
      )}
      {emptyBannerMsg && (
        <EmptyScopeBanner
          msg={emptyBannerMsg}
          onPick={focusScopeBar}
          onAll={() =>
            isBs
              ? setBsScope('all_online')
              : setSettings((pr) => ({ ...pr, applyScope: 'all_online' }))
          }
        />
      )}
      {isBs ? (
        <BluestacksWindowLayoutSection
          bsScope={bsScope}
          setBsScope={setBsScope}
          bsColumns={bsColumns}
          setBsColumns={setBsColumns}
          bsGap={bsGap}
          setBsGap={setBsGap}
          displays={displays}
          displayLabels={displayLabels}
          selectedBsDisplay={selectedBsDisplay}
          setBsDisplayId={setBsDisplayId}
          bsTileEst={bsTileEst}
          bsOnline={bsOnline}
          busy={busy}
          onShowInstance={(inst) =>
            runBs(
              'instances/show',
              { instanceId: inst.id },
              `已前置显示 ${bluestacksDisplayTitle(inst)}`,
            )
          }
        />
      ) : (
        <>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-white px-4 py-3 shadow-xs">
            <div className="flex flex-wrap items-center gap-3">
              <SegTabs
                value={mode}
                options={[
                  ['tile', '多屏平铺'],
                  ['cascade', '斜向堆叠'],
                ]}
                onChange={(m) => setSettings((pr) => ({ ...pr, mode: m }))}
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                <span>作用范围</span>
                <select
                  className={UI_SELECT_SM}
                  value={applyScope}
                  onChange={(e) =>
                    setSettings((pr) => ({
                      ...pr,
                      applyScope: e.target.value === 'all_online' ? 'all_online' : 'selected',
                    }))
                  }
                >
                  <option value="selected">仅已勾选浏览器</option>
                  <option value="all_online">全部在线浏览器</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600">
                <span>顺序</span>
                <select
                  className={UI_SELECT_SM}
                  value={applySort}
                  onChange={(e) =>
                    setSettings((pr) => ({
                      ...pr,
                      applySort: e.target.value === 'name' ? 'name' : 'list',
                    }))
                  }
                >
                  <option value="list">按账号列表顺序</option>
                  <option value="name">按名称排序</option>
                </select>
              </label>
              <UiSwitch
                checked={settings.enabled}
                label="自动整理新启动窗口"
                onCheckedChange={(checked) => setSettings((pr) => ({ ...pr, enabled: checked }))}
              />
            </div>
            <div className={UI_ROW}>
              {(settings.presets ?? []).map((preset) => (
                <div
                  key={preset.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-1 text-xs"
                >
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 font-medium text-slate-700 hover:text-slate-950"
                    onClick={() => void applyPreset(preset)}
                  >
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-slate-400 hover:text-rose-600"
                    title="删除方案"
                    onClick={() =>
                      void handleSave({
                        ...settings,
                        presets: (settings.presets ?? []).filter((pr) => pr.id !== preset.id),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="inline-flex items-center gap-1.5">
                <input
                  type="text"
                  placeholder="新方案名称"
                  className={`${UI_INPUT_SM} w-28`}
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <Btn v="ghost" disabled={busy} onClick={() => void handleSavePreset()}>
                  + 保存预设
                </Btn>
              </div>
            </div>
          </section>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(360px,430px)_minmax(0,1fr)]">
            <WindowLayoutSettingsPanel
              mode={mode}
              displays={displays}
              displayLabels={displayLabels}
              tileConfigs={tileConfigs}
              tileGap={tileGap}
              tileOverflow={tileOverflow}
              settings={settings}
              setSettings={setSettings}
              busy={busy}
              onReloadDisplays={() => void loadSnapshot()}
              onUpdateTileDisplay={updateTileDisplay}
            />
            <WindowLayoutPreviewCanvas
              mode={mode}
              displays={displays}
              displayLabels={displayLabels}
              tileConfigs={tileConfigs}
              tileGap={tileGap}
              bounds={bounds}
              previewCount={previewCount}
              previewTilePlan={previewTilePlan}
              activeCascadeDisplay={activeCascadeDisplay}
              previewCascadeRects={previewCascadeRects}
              onlineProfilesCount={onlineProfiles.length}
              onUpdateTileDisplay={updateTileDisplay}
            />
          </div>
        </>
      )}
    </div>
  );
}
