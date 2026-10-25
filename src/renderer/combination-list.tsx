import { useEffect, useRef, useState } from 'react';
import {
  CombinationDraftSchema,
  CombinationSchema,
  type Combination,
  type Profile,
  type SavedCombination,
  type Step,
} from '../shared/contracts.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import { resourceUsageLabel, resourceUsageTitle } from './resource-usage-label.js';
import { marketplaceCategories } from '../shared/marketplace-categories.js';
import type { z } from 'zod';
import type { TaskCapabilities, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { isErroredPausedPlan } from '../shared/task-issues.js';
import { PopoverMenu } from './popover-menu.js';
import { ConfirmDialog } from './confirm-dialog.js';
import {
  IconClock,
  IconClose,
  IconCopy,
  IconEdit,
  IconLayers,
  IconMore,
  IconPlay,
  IconPlus,
  IconSearch,
} from './icons.js';
import { cardColorLabels, cardColorNames, type CardColor } from './card-colors.js';

export const COMBINATION_CLIPBOARD_FORMAT = 'wb-combination-v1';

export function formatCombinationForClipboard(row: SavedCombination): string {
  const source = row.saved ?? row.draft;
  if (!source) throw Error('该任务组合尚无配置内容可复制');
  return JSON.stringify(
    {
      format: COMBINATION_CLIPBOARD_FORMAT,
      exportedAt: new Date().toISOString(),
      combination: {
        name: source.name,
        note: source.note,
        randomOrder: source.randomOrder,
        loop: source.loop,
        steps: source.steps,
      },
    },
    null,
    2,
  );
}

export function parseImportedCombination(
  rawText: string,
  existingNames: ReadonlySet<string>,
  overrideName?: string,
):
  | { mode: 'published'; value: Combination }
  | { mode: 'draft'; value: z.infer<typeof CombinationDraftSchema> } {
  const trimmed = rawText.trim();
  if (!trimmed) throw Error('请先粘贴任务组合配置数据');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    throw Error('配置数据格式无效（不是合法的 JSON），请检查复制内容是否完整');
  }
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson))
    throw Error('配置数据格式无效，请使用“复制组合”生成的固定格式数据');
  const envelope = parsedJson as Record<string, unknown>;
  if (
    'format' in envelope &&
    envelope.format !== undefined &&
    envelope.format !== COMBINATION_CLIPBOARD_FORMAT
  )
    throw Error(`不支持的组合配置版本：${String(envelope.format)}`);
  const rawCombo =
    envelope.combination &&
    typeof envelope.combination === 'object' &&
    !Array.isArray(envelope.combination)
      ? (envelope.combination as Record<string, unknown>)
      : envelope;
  if (!Array.isArray(rawCombo.steps))
    throw Error('配置数据缺少子任务列表（steps），请确认粘贴了正确的组合数据');
  const baseName = (
    overrideName?.trim() ||
    (typeof rawCombo.name === 'string' && rawCombo.name.trim()
      ? rawCombo.name.trim()
      : '导入的任务组合')
  ).slice(0, 80);
  let finalName = baseName;
  if (!overrideName?.trim() && existingNames.has(finalName)) {
    for (let i = 1; i <= 99; i++) {
      const suffix = i === 1 ? ' 副本' : ` 副本 ${i}`;
      const candidateName = baseName.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
      if (!existingNames.has(candidateName)) {
        finalName = candidateName;
        break;
      }
    }
  }
  const candidate = {
    name: finalName,
    note: typeof rawCombo.note === 'string' ? rawCombo.note.trim().slice(0, 300) : '',
    randomOrder: Boolean(rawCombo.randomOrder),
    loop: rawCombo.loop ?? { mode: 'finite', rounds: 1 },
    steps: rawCombo.steps.map((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step))
        throw Error('子任务项格式不正确');
      return {
        ...(step as Record<string, unknown>),
        id: crypto.randomUUID(),
      };
    }),
  };
  const full = CombinationSchema.safeParse(candidate);
  if (full.success) return { mode: 'published', value: full.data };
  const draft = CombinationDraftSchema.safeParse(candidate);
  if (draft.success) return { mode: 'draft', value: draft.data };
  const firstIssue = full.error.issues[0] ?? draft.error.issues[0];
  throw Error('组合数据校验未通过：' + (firstIssue?.message ?? '字段不符合规范'));
}

export function stepSummary(step: Step) {
  if (step.type === 'marketplace')
    return (
      '商城 ' +
      step.durationMinutes +
      ' 分钟 · ' +
      (step.keyword ? '搜索「' + step.keyword + '」' : step.categoryId ? '分类商品' : '推荐商品') +
      (step.categoryId
        ? ' · ' + (marketplaceCategories.find(([id]) => id === step.categoryId)?.[1] ?? '指定分类')
        : '') +
      (step.minPrice !== undefined || step.maxPrice !== undefined
        ? ' · 价格 ' + (step.minPrice ?? '不限') + '～' + (step.maxPrice ?? '不限')
        : '')
    );
  if (step.type === 'friends')
    return (
      '接受好友请求 · ' +
      (step.acceptMode === 'all' ? '全部接受' : '指定 ' + step.maxAccepts + ' 个') +
      ' · 最长 ' +
      step.durationMinutes +
      ' 分钟'
    );
  if (step.type === 'post')
    return (
      (step.destination === 'story' ? '发布快拍 ' : '随机发帖 ') +
      step.count +
      ' 条 · ' +
      (step.allowRepeat ? '允许重复使用' : '跳过已用素材')
    );
  return (
    (step.type === 'video' ? 'Reels' : '首页') +
    ' ' +
    step.durationMinutes +
    ' 分钟 · ' +
    (step.maxLikes
      ? `最多${step.maxLikes}赞（概率${step.likeProbability ?? 35}% · ≥${step.minLikeCount}赞${step.includeKeywords ? ` · 含「${step.includeKeywords}」` : ''}）`
      : '不点赞')
  );
}
// Short single-line label for cards; the full summary stays in the tooltip.
function stepShort(step: Step) {
  if (step.type === 'post')
    return [step.destination === 'story' ? '发布快拍' : '发布帖子', step.count + ' 条'];
  if (step.type === 'friends')
    return ['接受好友', step.acceptMode === 'all' ? '全部' : step.maxAccepts + ' 个'];
  const name =
    step.type === 'video' ? '浏览 Reels' : step.type === 'feed' ? '浏览首页' : '浏览商城';
  const detail =
    step.type !== 'marketplace' && step.maxLikes > 0
      ? `${step.durationMinutes} 分钟 · ≤${step.maxLikes}赞`
      : `${step.durationMinutes} 分钟`;
  return [name, detail];
}
const liveStates = ['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'REVIEW'];
export function CombinationList({
  rows,
  selectedCount,
  selectedIds,
  profiles,
  groupInviterRunningIds,
  onEdit,
  onNew,
  onCopy,
  onImport,
  onDelete,
  onDeleteMany,
  onResources,
  resourceSummaries,
  capabilities,
  runtime,
  busy,
  onStart,
  onSchedule,
  colorOf,
  colorSupported,
  onColor,
}: {
  rows: SavedCombination[];
  selectedCount: number;
  selectedIds?: ReadonlySet<string>;
  profiles?: readonly Profile[];
  groupInviterRunningIds?: readonly string[];
  onEdit: (row: SavedCombination) => void;
  onNew: () => void;
  onCopy: (row: SavedCombination) => void;
  onImport?: (
    parsed:
      | { mode: 'published'; value: Combination }
      | { mode: 'draft'; value: z.infer<typeof CombinationDraftSchema> },
  ) => Promise<void>;
  onDelete?: (row: SavedCombination) => void;
  onDeleteMany?: (rows: SavedCombination[]) => Promise<string[]>;
  onResources: (row: SavedCombination) => void;
  resourceSummaries: ResourceUsageSummaryValue[] | null;
  capabilities?: z.infer<typeof TaskCapabilities> | null;
  runtime?: z.infer<typeof TaskRuntimeOverview> | null;
  busy?: boolean;
  onStart?: (row: SavedCombination) => void;
  onSchedule?: (row: SavedCombination) => void;
  colorOf?: (id: string) => CardColor;
  colorSupported?: boolean;
  onColor?: (row: SavedCombination, color: CardColor) => void;
}) {
  const [search, setSearch] = useState('');
  const [managing, setManaging] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  useEffect(() => {
    const existing = new Set(rows.map((row) => row.id));
    setChecked((previous) => {
      const remaining = new Set([...previous].filter((id) => existing.has(id)));
      return remaining.size === previous.size ? previous : remaining;
    });
  }, [rows]);
  const inUse = new Set(
    runtime?.plans.filter((p) => liveStates.includes(p.state)).map((p) => p.combinationId),
  );
  const selectedRows = rows.filter((row) => checked.has(row.id) && !inUse.has(row.id));
  function toggleRow(id: string) {
    if (busy || inUse.has(id)) return;
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function leaveManagement() {
    setManaging(false);
    setChecked(new Set());
  }

  const [deletingRow, setDeletingRow] = useState<SavedCombination | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const query = search.trim().toLocaleLowerCase();
  const matching = rows.filter((row) => {
    const value = row.saved ?? row.draft;
    return (
      value && (!query || (value.name + '\n' + value.note).toLocaleLowerCase().includes(query))
    );
  });
  const busyProfileSet = new Set<string>([
    ...(runtime?.plans
      .filter(
        (plan) =>
          selectedIds?.has(plan.profileId) &&
          !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) &&
          !isErroredPausedPlan(plan),
      )
      .map((plan) => plan.profileId) ?? []),
    ...(groupInviterRunningIds?.filter((id) => selectedIds?.has(id)) ?? []),
  ]);
  const busySelected = busyProfileSet.size;
  const offlineSelected =
    selectedIds && profiles
      ? [...selectedIds].filter(
          (id) => !busyProfileSet.has(id) && !profiles.find((p) => p.id === id)?.online,
        ).length
      : 0;
  const eligibleImmediateCount = Math.max(0, selectedCount - busySelected - offlineSelected);
  const eligibleScheduleCount = Math.max(0, selectedCount - busySelected);
  return (
    <section className="combos" aria-label="任务组合">
      <div className="section-head">
        <h2>
          任务组合 <span className="count-chip">{rows.length}</span>
        </h2>
        <div className="section-tools">
          <label className="search-field">
            <IconSearch />
            <input
              type="search"
              aria-label="搜索任务组合"
              placeholder="搜索组合"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {onDeleteMany && rows.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => (managing ? leaveManagement() : setManaging(true))}
            >
              {managing ? '退出批量管理' : '批量管理'}
            </button>
          )}
          {!managing && onImport && (
            <button
              className="btn"
              disabled={busy}
              title="粘贴通过“复制组合”获取的配置数据，导入他人分享的组合或创建副本"
              onClick={() => setImportOpen(true)}
            >
              导入组合
            </button>
          )}
          {!managing && (
            <button className="btn btn-primary" onClick={onNew}>
              <IconPlus /> 新建组合
            </button>
          )}
        </div>
      </div>
      {managing && (
        <div className="combo-batch-tools" aria-label="批量管理任务组合">
          <label>
            <input
              type="checkbox"
              aria-label="全选当前搜索结果"
              disabled={busy || !matching.some((row) => !inUse.has(row.id))}
              checked={
                matching.some((row) => !inUse.has(row.id)) &&
                matching.filter((row) => !inUse.has(row.id)).every((row) => checked.has(row.id))
              }
              onChange={(event) => {
                const select = event.target.checked;
                setChecked((previous) => {
                  const next = new Set(previous);
                  for (const row of matching)
                    if (!inUse.has(row.id)) {
                      if (select) next.add(row.id);
                      else next.delete(row.id);
                    }
                  return next;
                });
              }}
            />{' '}
            全选当前搜索结果
          </label>
          <span>已选 {selectedRows.length} 项</span>
          <span className="muted">使用中的组合需先停止任务</span>
          <button
            className="btn danger"
            disabled={busy || selectedRows.length === 0}
            onClick={() => setConfirmBatchDelete(true)}
          >
            删除所选
          </button>
          <button className="btn" disabled={busy} onClick={() => setChecked(new Set())}>
            取消选择
          </button>
        </div>
      )}
      {rows.length > 0 && !matching.length && <p className="muted">没有匹配的任务组合。</p>}
      <div className="combo-grid">
        {matching.map((row) => {
          const saved = row.saved ?? row.draft;
          if (!saved) return null;
          const name = saved.name || '未命名组合';
          const capability = capabilities?.combinations.find(
            (value) => value.id === row.id && value.version === row.version,
          );
          const usesTable = saved.steps.some(
            (step) => step.type === 'post' && step.resourceMode === 'table',
          );
          const summary = resourceSummaries?.find((item) => item.combinationId === row.id) ?? null;
          const remaining = !usesTable
            ? '—'
            : resourceSummaries === null
              ? '…'
              : String(summary?.remaining ?? 0);
          const using = new Set(
            runtime?.plans
              .filter((plan) => plan.combinationId === row.id && liveStates.includes(plan.state))
              .map((plan) => plan.profileId) ?? [],
          ).size;
          const startDisabled =
            managing || busy || !onStart || !capability?.enabled || eligibleImmediateCount === 0;
          const scheduleDisabled =
            busy || !onSchedule || !capability?.enabled || eligibleScheduleCount === 0;
          const skipSummary = [
            busySelected ? `${busySelected} 个任务运行中` : '',
            offlineSelected ? `${offlineSelected} 个未连接` : '',
          ]
            .filter(Boolean)
            .join('、');
          const startTitle =
            capability?.reason ||
            (!capability
              ? '任务执行能力尚未读取'
              : selectedCount === 0
                ? '请先在左侧勾选浏览器'
                : eligibleImmediateCount === 0
                  ? busySelected > 0 && offlineSelected === 0
                    ? `${busySelected} 份资料已有任务，可继续或先停止原任务`
                    : busySelected === 0 && offlineSelected > 0
                      ? `所选 ${offlineSelected} 个浏览器未连接，请先打开对应资料`
                      : `所选浏览器不可启动（${skipSummary}）`
                  : skipSummary
                    ? `给 ${eligibleImmediateCount} 个可用浏览器启动（自动跳过 ${skipSummary}）`
                    : `给左侧选中的 ${eligibleImmediateCount} 个浏览器启动`);
          const scheduleTitle =
            capability?.reason ||
            (!capability
              ? '任务执行能力尚未读取'
              : selectedCount === 0
                ? '请先在左侧勾选浏览器'
                : eligibleScheduleCount === 0
                  ? `${busySelected} 份资料已有任务，可继续或先停止原任务`
                  : busySelected > 0
                    ? `给 ${eligibleScheduleCount} 个浏览器定时启动（自动跳过 ${busySelected} 个已有任务）`
                    : `给左侧选中的 ${eligibleScheduleCount} 个浏览器定时启动`);
          const color = colorOf?.(row.id) ?? 'graphite';
          const extra = saved.steps.length - 5;
          return (
            <article
              className={
                'combo-card tone-' +
                color +
                (managing && checked.has(row.id) ? ' combo-selected' : '')
              }
              key={row.id}
            >
              {managing && (
                <label
                  className="combo-select"
                  title={using > 0 ? '请先停止此组合的相关任务' : '选择此组合'}
                >
                  <input
                    type="checkbox"
                    aria-label={'选择组合 ' + name}
                    checked={checked.has(row.id) && using === 0}
                    disabled={busy || using > 0}
                    onChange={() => toggleRow(row.id)}
                  />
                </label>
              )}
              <div
                className="combo-body"
                role="button"
                tabIndex={0}
                title={
                  managing ? (using > 0 ? '请先停止相关任务' : '点击选择组合') : '点击编辑组合'
                }
                aria-pressed={managing ? checked.has(row.id) : undefined}
                onClick={() => (managing ? toggleRow(row.id) : onEdit(row))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (managing) toggleRow(row.id);
                    else onEdit(row);
                  }
                }}
              >
                <header className="combo-head">
                  {row.draft && <span className="combo-ribbon">草稿</span>}
                  <h3 title={name}>{name}</h3>
                  <span className="combo-meta">
                    {row.version ? 'v' + row.version : '未发布'} ·{' '}
                    {saved.randomOrder ? '随机顺序' : '按顺序'} ·{' '}
                    {saved.loop.mode === 'finite' ? saved.loop.rounds + ' 轮' : '循环'}
                  </span>
                </header>
                <ol className="combo-steps">
                  {saved.steps.slice(0, 5).map((step) => {
                    const [label, value] = stepShort(step);
                    return (
                      <li key={step.id} title={stepSummary(step)}>
                        <i className={'type-dot type-' + step.type} />
                        <span>{label}</span>
                        <em>{value}</em>
                      </li>
                    );
                  })}
                  {extra > 0 && <li className="combo-more">还有 {extra} 项</li>}
                  {!saved.steps.length && <li className="combo-more">尚未添加子任务</li>}
                </ol>
              </div>
              <div className="combo-stats">
                <div
                  className="combo-stat resource-count"
                  title={
                    usesTable
                      ? resourceUsageLabel(summary, resourceSummaries !== null) +
                        '\n' +
                        resourceUsageTitle
                      : '此组合没有使用发帖资源表'
                  }
                >
                  <strong>{remaining}</strong>
                  <span>剩余资源</span>
                </div>
                <div className="combo-stat" title="正在执行或排队此组合的浏览器数量">
                  <strong className={using ? 'is-live' : ''}>{using}</strong>
                  <span>使用中浏览器</span>
                </div>
              </div>
              {capability?.reason && (
                <p className="combo-warn" title={capability.reason}>
                  {capability.reason}
                </p>
              )}
              <footer className="combo-foot">
                <button
                  className="btn btn-primary combo-start"
                  disabled={startDisabled}
                  title={startTitle}
                  onClick={() => onStart?.(row)}
                >
                  <IconPlay size={14} />
                  启动
                  {selectedCount > 0 && (
                    <span className="btn-count">
                      {eligibleImmediateCount > 0 ? eligibleImmediateCount : selectedCount}
                    </span>
                  )}
                </button>
                {!managing && (
                  <PopoverMenu
                    label="更多操作"
                    trigger={<IconMore />}
                    items={[
                      { label: '编辑组合', icon: <IconEdit />, onSelect: () => onEdit(row) },
                      { label: '发帖资源', icon: <IconLayers />, onSelect: () => onResources(row) },
                      { label: '复制组合', icon: <IconCopy />, onSelect: () => onCopy(row) },
                      ...(onSchedule
                        ? [
                            {
                              label: '定时启动…',
                              icon: <IconClock />,
                              disabled: scheduleDisabled,
                              title: scheduleTitle,
                              onSelect: () => onSchedule(row),
                            },
                          ]
                        : []),
                      ...(onDelete
                        ? [
                            {
                              label: '删除组合',
                              icon: <IconClose />,
                              danger: true,
                              disabled: busy || using > 0,
                              title:
                                using > 0
                                  ? `有 ${using} 个浏览器正在执行或排队此组合，请先停止对应任务`
                                  : '删除此任务组合',
                              onSelect: () => setDeletingRow(row),
                            },
                          ]
                        : []),
                    ]}
                  >
                    {(close) =>
                      onColor && (
                        <div className="swatch-block">
                          <span className="popover-separator">卡片颜色</span>
                          <div className="swatches">
                            {cardColorNames.map((name) => (
                              <button
                                type="button"
                                key={name}
                                className={
                                  'swatch tone-' + name + (name === color ? ' is-current' : '')
                                }
                                title={
                                  colorSupported
                                    ? cardColorLabels[name]
                                    : '需升级软件后可设置卡片颜色'
                                }
                                aria-label={'卡片颜色 ' + cardColorLabels[name]}
                                disabled={!colorSupported}
                                onClick={() => {
                                  close();
                                  onColor(row, name);
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      )
                    }
                  </PopoverMenu>
                )}
              </footer>
            </article>
          );
        })}
        {rows.length > 0 && !query && !managing && (
          <button className="combo-card combo-new" onClick={onNew}>
            <IconPlus size={26} />
            <span>新建组合</span>
          </button>
        )}
      </div>
      {rows.length === 0 && (
        <div className="empty-state">
          <div className="empty-symbol">
            <IconLayers size={26} />
          </div>
          <h3>创建第一个任务组合</h3>
          <p>把浏览首页、看 Reels、发帖等子任务组合起来，勾选浏览器后一键启动。</p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
            {onImport && (
              <button className="btn" onClick={() => setImportOpen(true)}>
                导入组合
              </button>
            )}
            <button className="btn btn-primary" onClick={onNew}>
              <IconPlus /> 新建组合
            </button>
          </div>
        </div>
      )}
      {importOpen && onImport && (
        <ImportCombinationDialog
          existingNames={
            new Set(
              rows
                .map((r) => (r.saved ?? r.draft)?.name?.trim())
                .filter((n): n is string => Boolean(n)),
            )
          }
          onClose={() => setImportOpen(false)}
          onSubmit={async (parsed) => {
            await onImport(parsed);
            setImportOpen(false);
          }}
        />
      )}
      {confirmBatchDelete && onDeleteMany && (
        <ConfirmDialog
          title="批量删除任务组合"
          label={`确认删除 ${selectedRows.length} 项`}
          description={`确定删除以下 ${selectedRows.length} 个任务组合？历史运行记录、原素材和素材使用状态保留。\n\n${selectedRows.map((row) => '· ' + ((row.saved ?? row.draft)?.name || '未命名组合')).join('\n')}`}
          onClose={() => setConfirmBatchDelete(false)}
          onConfirm={async () => {
            const deleted = new Set(await onDeleteMany(selectedRows));
            setChecked((previous) => new Set([...previous].filter((id) => !deleted.has(id))));
            if (selectedRows.every((row) => deleted.has(row.id))) setManaging(false);
          }}
        />
      )}
      {deletingRow && onDelete && (
        <ConfirmDialog
          title="删除任务组合"
          description={`确定删除任务组合「${(deletingRow.saved ?? deletingRow.draft)?.name || '未命名组合'}」吗？该组合将从列表中移除，历史任务运行记录仍会保留。`}
          label="确认删除"
          onClose={() => setDeletingRow(null)}
          onConfirm={async () => {
            const target = deletingRow;
            setDeletingRow(null);
            await onDelete(target);
          }}
        />
      )}
    </section>
  );
}

function ImportCombinationDialog({
  existingNames,
  onClose,
  onSubmit,
}: {
  existingNames: ReadonlySet<string>;
  onClose: () => void;
  onSubmit: (
    parsed:
      | { mode: 'published'; value: Combination }
      | { mode: 'draft'; value: z.infer<typeof CombinationDraftSchema> },
  ) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rawText, setRawText] = useState('');
  const [customName, setCustomName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRawText(text);
        setError('');
      } else {
        setError('剪贴板为空，请先点击任务组合上的“复制组合”');
      }
    } catch {
      setError('无法直接读取剪贴板，请在下方输入框中使用 Ctrl+V 粘贴');
    }
  }

  async function handleImport() {
    if (busy) return;
    setError('');
    let parsed;
    try {
      parsed = parseImportedCombination(rawText, existingNames, customName);
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据解析失败');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="name-dialog test-dialog"
      style={{ width: 'min(560px, 92vw)' }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h3>导入任务组合</h3>
      <p>
        粘贴通过「复制组合」获取的固定格式数据（<code>{COMBINATION_CLIPBOARD_FORMAT}</code>
        ），既可导入他人分享的组合，也可在本地二次导入作为副本。
      </p>
      <label>
        新组合名称（可选，留空则沿用原名并自动区分副本）
        <input
          maxLength={80}
          value={customName}
          disabled={busy}
          placeholder="留空自动命名"
          onChange={(e) => setCustomName(e.target.value)}
        />
      </label>
      <label>
        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>组合配置数据</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void pasteFromClipboard()}
          >
            从剪贴板粘贴
          </button>
        </span>
        <textarea
          rows={9}
          value={rawText}
          disabled={busy}
          placeholder={'请在此处粘贴复制的任务组合 JSON 数据 (Ctrl+V)…'}
          style={{
            width: '100%',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '12px',
            lineHeight: '1.45',
            padding: '8px 10px',
            borderRadius: '6px',
            border: '1px solid var(--line, #2e323b)',
            background: 'var(--bg-subtle, #15181e)',
            color: ' inherit',
            resize: 'vertical',
          }}
          onChange={(e) => {
            setRawText(e.target.value);
            if (error) setError('');
          }}
        />
      </label>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy} onClick={() => void handleImport()}>
          {busy ? '正在导入…' : '确认导入'}
        </button>
      </footer>
    </dialog>
  );
}
