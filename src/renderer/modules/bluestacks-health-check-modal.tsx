import { useMemo, useState } from 'react';
import {
  formatBluestacksHealthReportText,
  healthCategoryLabel,
  isBluestacksPortraitResolution,
  type BluestacksHealthCategory,
  type BluestacksHealthCheckItem,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { UI_CARD, UI_ROW } from '../ui/primitives.js';
import {
  BatchStatusPill,
  BluestacksBatchResultList,
  type BatchTone,
} from './bluestacks-batch-result-list.js';
import { Btn, Chk, CtrlNum, NativeModalShell, SegTabs, useBusyTask } from './shared/module-ui.js';
type CategoryFilter =
  'all' | 'healthy' | 'logged-out' | 'verification' | 'restricted' | 'missing-app' | 'other';
const CATEGORY_TONE: Record<BluestacksHealthCategory, BatchTone> = {
  healthy: 'green',
  'logged-out': 'amber',
  verification: 'orange',
  restricted: 'red',
  'missing-app': 'purple',
  landscape: 'slate',
  'launch-failed': 'red',
  skipped: 'muted',
  stopped: 'muted',
};
function renderItemBadge(item: BluestacksHealthCheckItem) {
  if (item.status === 'queued') return <BatchStatusPill label="排队中" tone="slate" />;
  if (item.status === 'running') return <BatchStatusPill label="体检中" tone="blue" />;
  const cat = item.category ?? 'launch-failed';
  return <BatchStatusPill label={healthCategoryLabel(cat)} tone={CATEGORY_TONE[cat]} />;
}
export function BluestacksHealthCheckModal({
  state,
  selected,
  onSelect,
  onChange,
  onOpenBatchLogin,
  onClose,
}: {
  state: BluestacksState;
  selected: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void;
  onChange: (next: BluestacksState) => void;
  onOpenBatchLogin: (instanceIds: string[]) => void;
  onClose: () => void;
}) {
  const hc = state.healthCheck ?? null;
  const portraitInstances = useMemo(
    () => state.instances.filter((i) => isBluestacksPortraitResolution(i.fbWidth, i.fbHeight)),
    [state.instances],
  );
  const [scope, setScope] = useState<'selected' | 'portrait' | 'all'>(() =>
    selected.size > 0 ? 'selected' : 'portrait',
  );
  const [opts, setOpts] = useState(() => ({
    maxConcurrency: Math.max(1, Math.min(5, state.bumperSettings.maxConcurrentProfiles || 3)),
    autoLaunch: true,
    autoInstallApk: false,
    closeOnFinish: true,
  }));
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const { busy, error, notice, setError, setNotice, run } = useBusyTask();
  const targetIds = useMemo(
    () =>
      (scope === 'selected'
        ? state.instances.filter((i) => selected.has(i.id))
        : scope === 'portrait'
          ? portraitInstances
          : state.instances
      ).map((i) => i.id),
    [scope, state.instances, selected, portraitInstances],
  );
  const filteredItems = useMemo(() => {
    if (!hc) return [];
    if (catFilter === 'all') return hc.items;
    if (catFilter === 'other')
      return hc.items.filter(
        (it) =>
          it.category && ['landscape', 'launch-failed', 'skipped', 'stopped'].includes(it.category),
      );
    return hc.items.filter((it) => it.category === catFilter);
  }, [hc, catFilter]);
  const healthyIds = useMemo(
    () => (hc ? hc.items.filter((i) => i.category === 'healthy').map((i) => i.instanceId) : []),
    [hc],
  );
  const needLoginIds = useMemo(
    () =>
      hc
        ? hc.items
            .filter((i) => i.category === 'logged-out' || i.category === 'missing-app')
            .map((i) => i.instanceId)
        : [],
    [hc],
  );
  const handleStart = () => {
    if (targetIds.length === 0) return setError('当前范围内没有可体检的蓝蝶实例');
    setNotice('');
    setCatFilter('all');
    void run(
      async () =>
        onChange(
          await api.bluestacksAction('health-check/start', { instanceIds: targetIds, ...opts }),
        ),
      '启动批量体检失败',
    );
  };
  const handleStop = () =>
    void run(
      async () => onChange(await api.bluestacksAction('health-check/stop', {})),
      '停止体检失败',
    );
  const isRunning = Boolean(hc?.running);
  const otherCount = hc ? hc.landscape + hc.launchFailed + hc.skipped + hc.stopped : 0;
  return (
    <NativeModalShell
      width="min(820px, 94vw)"
      error={error}
      notice={notice}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2.5">
          <span>蓝蝶批量健康体检</span>
          {hc && (
            <span
              className={`truncate text-xs font-normal ${isRunning ? 'text-blue-700' : 'text-[var(--text-2)]'}`}
            >
              {hc.statusText}
            </span>
          )}
        </span>
      }
      footer={
        <>
          <div className="flex flex-wrap gap-1.5">
            {healthyIds.length > 0 && (
              <Btn
                onClick={() => (
                  onSelect(new Set(healthyIds)),
                  setNotice(`已勾选全部 ${healthyIds.length} 台健康蓝蝶窗口`)
                )}
              >
                勾选健康实例 ({healthyIds.length})
              </Btn>
            )}
            {needLoginIds.length > 0 && !isRunning && (
              <Btn v="primary" onClick={() => onOpenBatchLogin(needLoginIds)}>
                未登录/缺包去批量登录 ({needLoginIds.length})
              </Btn>
            )}
            {hc && (
              <Btn
                onClick={() =>
                  void copyTextToClipboard(formatBluestacksHealthReportText(hc)).then(
                    () => setNotice('已复制体检报表到剪贴板'),
                    () => setNotice('复制失败，请重试'),
                  )
                }
              >
                复制体检报表
              </Btn>
            )}
          </div>
          <Btn sm={false} onClick={onClose}>
            完成
          </Btn>
        </>
      }
    >
      <div className={`${UI_CARD} flex flex-col gap-2.5 bg-[var(--surface-2)] px-3.5 py-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className={UI_ROW}>
            <span className="text-xs font-semibold text-[var(--text-2)]">体检范围</span>
            <SegTabs
              value={scope}
              disabled={isRunning}
              options={[
                ['selected', `已选 (${selected.size})`],
                ['portrait', `全部竖屏 (${portraitInstances.length})`],
                ['all', `全部 (${state.instances.length})`],
              ]}
              onChange={setScope}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-2)]">并发台数</span>
            <CtrlNum
              val={opts.maxConcurrency}
              min={1}
              max={10}
              def={3}
              disabled={isRunning}
              aria="体检并发台数"
              style={{ width: 56 }}
              onChange={(maxConcurrency) => setOpts((p) => ({ ...p, maxConcurrency }))}
            />
            {isRunning ? (
              <Btn v="danger" disabled={busy} onClick={handleStop}>
                停止体检
              </Btn>
            ) : (
              <Btn v="primary" disabled={busy || targetIds.length === 0} onClick={handleStart}>
                开始批量体检 ({targetIds.length})
              </Btn>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-2)]">
          {(
            [
              ['自动拉起离线窗口', 'autoLaunch'],
              ['缺 FB Lite 时自动装包修复', 'autoInstallApk'],
              ['体检完自动关窗释放内存', 'closeOnFinish'],
            ] as const
          ).map(([label, key]) => (
            <Chk
              key={key}
              label={label}
              checked={opts[key]}
              disabled={isRunning}
              onChange={(v) => setOpts((p) => ({ ...p, [key]: v }))}
            />
          ))}
        </div>
      </div>
      {hc ? (
        <BluestacksBatchResultList
          showSummaryHeader
          statusText={hc.statusText}
          total={hc.total}
          completed={hc.completed}
          running={isRunning}
          onCancel={handleStop}
          canceling={busy}
          cancelLabel="中止执行"
          filters={[
            ['all', `全部 ${hc.total}`],
            ['healthy', `健康 ${hc.healthy}`],
            ['logged-out', `未登录 ${hc.loggedOut}`],
            ['verification', `需验证 ${hc.verification}`],
            ['restricted', `受限 ${hc.restricted}`],
            ['missing-app', `缺App ${hc.missingApp}`],
            ['other', `横屏/失败/跳过 ${otherCount}`],
          ]}
          activeFilter={catFilter}
          onFilterChange={setCatFilter}
          headers={['蓝蝶窗口', '体检结论', '识别账号 / ID', '环境', '详情']}
          rows={filteredItems}
          empty="当前筛选分类下暂无实例"
          renderRow={(item) => (
            <tr key={item.instanceId}>
              <td className="px-2.5 py-2 font-semibold">{item.instanceName}</td>
              <td className="px-2.5 py-2">
                <div className="flex items-center gap-1">
                  {renderItemBadge(item)}
                  {item.autoRepaired && <BatchStatusPill label="已自装" tone="sky" />}
                </div>
              </td>
              <td className="px-2.5 py-2">
                {item.accountName ? (
                  <div>
                    <div>
                      {item.accountName}
                      {item.identityType === 'page'
                        ? ' · 专页'
                        : item.identityType === 'personal'
                          ? ' · 个人'
                          : ''}
                    </div>
                    {item.numericAccountId && (
                      <div className="text-[11px] text-[var(--text-2)]">
                        ID: {item.numericAccountId}
                        {item.managedPageCount && item.managedPageCount > 0
                          ? ` · ${item.managedPageCount} 专页`
                          : ''}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-[var(--text-2)]">—</span>
                )}
              </td>
              <td className="px-2.5 py-2 whitespace-nowrap text-[var(--text-2)]">
                <div>{item.resolution}</div>
                <div className="text-[11px]">
                  {item.fbLiteVersion ? `v${item.fbLiteVersion}` : '未检出版本'}
                  {item.androidSdk ? ` · SDK ${item.androidSdk}` : ''}
                </div>
              </td>
              <td className="px-2.5 py-2 text-[var(--text-2)]">{item.stepText}</td>
            </tr>
          )}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-7 text-center text-[13px] text-[var(--text-2)]">
          选择体检范围并点击「开始批量体检」，系统将按并发槽位自动拉起蓝蝶、检查 FB Lite
          安装与账号健康状态（健康 / 未登录 / 需验证 / 受限 / 横屏），并可联动定时排班无人值守巡检。
        </div>
      )}
    </NativeModalShell>
  );
}
