import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { computeCascadeRects, computeMultiDisplayTilePlan } from '../../domain/window-layout.js';
import {
  bluestacksDisplayTitle,
  type BluestacksInstance,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import type { Profile } from '../../shared/contracts.js';
import {
  defaultWindowLayout,
  WindowLayoutOverview,
  windowLayoutMessage,
  type LayoutSettings,
  type TileDisplayConfig,
  type WindowLayoutPreset,
} from '../../shared/window-layout.js';
import { api } from '../api.js';
import { IconGlobe, IconSmartphone, IconWindow } from '../icons.js';
import {
  PageHeader,
  UI_CARD,
  UI_INPUT,
  UI_INPUT_SM,
  UI_SELECT,
  UI_SELECT_SM,
  UiSwitch,
} from '../ui/primitives.js';
import { Btn, errMsg, Fld, NoticeBanner, SegTabs } from './shared/module-ui.js';
import {
  clampInt,
  computeDisplayBounds,
  getTargetProfileIds,
  normalizeTileConfigs,
  WindowLayoutPreviewCanvas,
  WindowLayoutSettingsPanel,
} from './window-layout-preview-canvas.js';

const CASCADE_KEYS = [
  'cascadeWidth',
  'cascadeHeight',
  'cascadeStepX',
  'cascadeStepY',
  'cascadeStartX',
  'cascadeStartY',
] as const;
const pickCascade = (s: Pick<LayoutSettings, (typeof CASCADE_KEYS)[number]>) =>
  Object.fromEntries(CASCADE_KEYS.map((k) => [k, s[k]])) as Pick<
    LayoutSettings,
    (typeof CASCADE_KEYS)[number]
  >;

type OverviewData = z.infer<typeof WindowLayoutOverview>;
const EMPTY_SET = new Set<string>();

export function WindowLayoutPage(p: {
  profiles: Profile[];
  selectedProfileIds?: Set<string>;
  bluestacks?: BluestacksState | null;
  bluestacksState?: BluestacksState | null;
  selectedBluestacksIds?: ReadonlySet<string>;
  onRefreshBluestacks?: () => Promise<unknown>;
  onBluestacksState?: (next: BluestacksState) => void;
  initialCarrier?: 'browser' | 'bluestacks';
  onNotify?: (message: string) => void;
  onMessage?: (message: string) => void;
}) {
  const {
    profiles,
    selectedProfileIds = EMPTY_SET,
    selectedBluestacksIds,
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
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [settings, setSettings] = useState<LayoutSettings>(defaultWindowLayout);
  const [bsScope, setBsScope] = useState<'selected' | 'all_online'>('selected');
  const [bsColumns, setBsColumns] = useState(4),
    [bsGap, setBsGap] = useState(8);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [presetName, setPresetName] = useState('');

  const bsOnline = useMemo(
    () => (effectiveBsState?.instances ?? []).filter((i) => i.online),
    [effectiveBsState?.instances],
  );
  const bsTargetIds = useMemo(() => {
    const picked =
      bsScope === 'selected' && selectedBluestacksIds?.size
        ? bsOnline.filter((i) => selectedBluestacksIds.has(i.id))
        : [];
    return (picked.length > 0 ? picked : bsOnline).map((i) => i.id);
  }, [bsOnline, selectedBluestacksIds, bsScope]);

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
    () => getTargetProfileIds(profiles, selectedProfileIds, applyScope, applySort),
    [profiles, selectedProfileIds, applyScope, applySort],
  );
  const secondaryDisplay = useMemo(
    () => displays.find((d) => !d.primary) ?? displays[1],
    [displays],
  );
  const displayLabels = useMemo(() => {
    let i = 0;
    return new Map(displays.map((d) => [d.id, d.primary ? '主显示器' : `副显示器 ${++i}`]));
  }, [displays]);
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
  const handleApply = (override?: { mode?: 'tile' | 'cascade'; targetDisplayId?: string }) => {
    if (targetIds.length === 0) return emitMsg('当前没有在线浏览器窗口');
    return runBusy(async () => {
      await api.windowLayout({ action: 'configure', settings: cleanSave(settings) });
      const u = await api.windowLayout({
        action: 'apply',
        profileIds: targetIds,
        mode: override?.mode ?? mode,
        ...(override?.targetDisplayId ? { targetDisplayId: override.targetDisplayId } : {}),
      });
      setOverview(u);
      const c = u.movedCount ?? targetIds.length;
      emitMsg(
        override?.targetDisplayId
          ? `已将 ${c} 个窗口移到副屏并整理`
          : `已按「${(override?.mode ?? mode) === 'tile' ? '平铺' : '堆叠'}」整理 ${c} 个浏览器窗口`,
      );
    });
  };
  const handleFocusAll = () => {
    const ids = onlineProfiles.map((pr) => pr.id);
    if (ids.length === 0) return emitMsg('当前没有在线浏览器窗口');
    return runBusy(async () => {
      setOverview(await api.windowLayout({ action: 'focus_all', profileIds: ids }));
      emitMsg(`已唤醒并置顶 ${ids.length} 个浏览器窗口`);
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

  return (
    <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-4">
      <PageHeader
        title="窗口排版"
        subtitle={
          targetKind === 'bluestacks'
            ? `统一平铺当前在线的蓝蝶模拟器窗口（当前在线 ${bsOnline.length} 台 · 待排版 ${bsTargetIds.length} 台）`
            : `管理所有已安装桥接扩展的 Chrome 窗口位置（当前在线 ${onlineProfiles.length} 个 · 待排版 ${targetIds.length} 个）`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegTabs
              value={targetKind}
              onChange={setTargetKind}
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
                    <IconSmartphone size={13} /> 蓝蝶窗口 ({bsOnline.length})
                  </>,
                ],
              ]}
            />
            {targetKind === 'bluestacks' ? (
              <Btn
                v="primary"
                sm={false}
                disabled={busy || bsTargetIds.length === 0}
                onClick={() =>
                  bsTargetIds.length === 0
                    ? emitMsg('当前没有可排版的在线蓝蝶窗口')
                    : runBs(
                        'instances/arrange',
                        {
                          instanceIds: bsTargetIds,
                          columns: Math.max(1, Math.min(10, bsColumns)),
                          gap: Math.max(0, Math.min(48, bsGap)),
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
                  disabled={busy || onlineProfiles.length === 0}
                  onClick={() => void handleFocusAll()}
                >
                  全部置顶
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
      {error && <NoticeBanner tone="err">{error}</NoticeBanner>}
      {targetKind === 'bluestacks' ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
          <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <IconSmartphone size={15} /> 蓝蝶网格排版参数
            </span>
            <Fld label="作用范围">
              <select
                className={UI_SELECT}
                value={bsScope}
                onChange={(e) =>
                  setBsScope(e.target.value === 'all_online' ? 'all_online' : 'selected')
                }
              >
                <option value="selected">已勾选蓝蝶（未选则全部在线）</option>
                <option value="all_online">全部在线蓝蝶</option>
              </select>
            </Fld>
            <div className="grid grid-cols-2 gap-3">
              <Fld label="每行窗口列数">
                <input
                  type="number"
                  min={1}
                  max={10}
                  className={UI_INPUT}
                  value={bsColumns}
                  onChange={(e) => setBsColumns(clampInt(e.target.value, 1, 10, 4))}
                />
              </Fld>
              <Fld label="窗口间距 (px)">
                <input
                  type="number"
                  min={0}
                  max={48}
                  className={UI_INPUT}
                  value={bsGap}
                  onChange={(e) => setBsGap(clampInt(e.target.value, 0, 48, 8))}
                />
              </Fld>
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-slate-500">
              蓝蝶窗口按当前桌面分辨率自动适配纵横比网格排版（默认每行 {bsColumns} 台，间距 {bsGap}{' '}
              px）。
            </p>
          </section>
          <section className={`${UI_CARD} flex min-w-0 flex-col gap-3 p-4`}>
            <span className="text-sm font-semibold text-slate-900">
              在线蓝蝶窗口列表 ({bsOnline.length})
            </span>
            {bsOnline.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-3 text-xs text-amber-800">
                当前暂无已开机的蓝蝶模拟器窗口。启动任意蓝蝶实例后，可在此一键网格平铺或置前定位。
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {bsOnline.map((inst: BluestacksInstance) => (
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
                    <Btn
                      disabled={busy}
                      onClick={() =>
                        runBs(
                          'instances/show',
                          { instanceId: inst.id },
                          `已前置显示 ${bluestacksDisplayTitle(inst)}`,
                        )
                      }
                    >
                      <IconWindow size={12} /> 置前
                    </Btn>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
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
                  <option value="selected">已勾选浏览器（未选则全部在线）</option>
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
            <div className="flex flex-wrap items-center gap-2">
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
