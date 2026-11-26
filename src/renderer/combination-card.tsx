import type { z } from 'zod';
import {
  CombinationSchema,
  type Combination,
  type SavedCombination,
  type Step,
} from '../shared/contracts.js';
import { marketplaceCategories } from '../shared/marketplace-categories.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import type { TaskCapabilities, TaskRuntimeOverview } from '../shared/task-contracts.js';
import {
  bluestacksStepSupport,
  evaluateBluestacksCombination,
} from './active-quick-step-dialogs.js';
import { cardColorLabels, cardColorNames, type CardColor } from './card-colors.js';
import {
  IconClock,
  IconClose,
  IconCopy,
  IconEdit,
  IconLayers,
  IconMore,
  IconPlay,
} from './icons.js';
import { Btn } from './modules/shared/module-ui.js';
import { PopoverMenu } from './popover-menu.js';
import { UI_CHECKBOX } from './ui/primitives.js';

export const COMBINATION_CLIPBOARD_FORMAT = 'wb-combination-v1';
export const LIVE_COMBINATION_STATES = [
  'QUEUED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'STOPPING',
  'REVIEW',
];
const ACTIVE_OR_QUEUED_STATES = ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING', 'REVIEW'];

const CARD_HEADER_TONE: Record<CardColor, string> = {
  graphite: 'from-[#262b33] to-[#3a424e]',
  blue: 'from-[#2563eb] to-[#1d4ed8]',
  teal: 'from-[#0d9488] to-[#0f766e]',
  green: 'from-[#16a34a] to-[#15803d]',
  amber: 'from-[#d97706] to-[#b45309]',
  orange: 'from-[#ea580c] to-[#c2410c]',
  red: 'from-[#dc2626] to-[#b91c1c]',
  violet: 'from-[#7c3aed] to-[#6d28d9]',
};

const STEP_DOT_COLOR: Record<Step['type'], string> = {
  feed: 'bg-emerald-500',
  video: 'bg-violet-500',
  marketplace: 'bg-amber-500',
  friends: 'bg-sky-500',
  post: 'bg-pink-500',
};

export function formatCombinationForClipboard(row: SavedCombination): string {
  const source = row.saved;
  if (!source) throw Error('该任务组合尚无配置内容可复制');
  return JSON.stringify(
    {
      format: COMBINATION_CLIPBOARD_FORMAT,
      exportedAt: new Date().toISOString(),
      combination: {
        name: source.name,
        note: source.note,
        randomOrder: source.randomOrder,
        loop: { mode: 'finite', rounds: 1 },
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
): { value: Combination } {
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
      const cand = baseName.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
      if (!existingNames.has(cand)) {
        finalName = cand;
        break;
      }
    }
  }
  const full = CombinationSchema.safeParse({
    name: finalName,
    note: typeof rawCombo.note === 'string' ? rawCombo.note.trim().slice(0, 300) : '',
    randomOrder: Boolean(rawCombo.randomOrder),
    loop: { mode: 'finite' as const, rounds: 1 },
    steps: rawCombo.steps.map((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step))
        throw Error('子任务项格式不正确');
      return { ...(step as Record<string, unknown>), id: crypto.randomUUID() };
    }),
  });
  if (full.success) return { value: full.data };
  throw Error('组合数据校验未通过：' + (full.error.issues[0]?.message ?? '字段不符合规范'));
}

const FEED_NAMES: Record<string, string> = {
  random_profile: '逛他人时间线',
  random_page: '逛公共专页',
  search_pages: '搜专页逛时间线',
  home: '浏览首页',
};

export function stepSummary(step: Step) {
  if (step.type === 'marketplace') {
    return (
      `商城 ${step.durationMinutes} 分钟 · ` +
      (step.keyword ? `搜索「${step.keyword}」` : step.categoryId ? '分类商品' : '推荐商品') +
      (step.categoryId
        ? ' · ' + (marketplaceCategories.find(([id]) => id === step.categoryId)?.[1] ?? '指定分类')
        : '') +
      (step.minPrice !== undefined || step.maxPrice !== undefined
        ? ` · 价格 ${step.minPrice ?? '不限'}～${step.maxPrice ?? '不限'}`
        : '')
    );
  }
  if (step.type === 'friends') {
    return step.friendAction === 'add_suggested'
      ? `加推荐好友 · 最多 ${step.maxAccepts} 人 · 最长 ${step.durationMinutes} 分钟`
      : `接受好友请求 · ${step.acceptMode === 'all' ? '全部接受' : `指定 ${step.maxAccepts} 个`} · 最长 ${step.durationMinutes} 分钟`;
  }
  if (step.type === 'post')
    return `${step.destination === 'story' ? '发布快拍' : '随机发帖'} ${step.count} 条 · ${step.allowRepeat ? '允许重复使用' : '跳过已用素材'}`;
  const likeTag = step.maxLikes
    ? `最多${step.maxLikes}赞（概率${step.likeProbability ?? 35}% · ≥${step.minLikeCount}赞${step.includeKeywords ? ` · 含「${step.includeKeywords}」` : ''}）`
    : '不点赞';
  if (step.type === 'feed') {
    const mode = step.feedMode ?? 'home';
    if (mode === 'random_profile')
      return `逛他人时间线 ${step.durationMinutes} 分钟 · 单次约 ${step.detourDwellSeconds ?? 25}s · ${likeTag}`;
    if (mode === 'random_page')
      return `逛公共专页 ${step.durationMinutes} 分钟 · 单次约 ${step.detourDwellSeconds ?? 25}s · ${likeTag}`;
    if (mode === 'search_pages')
      return `搜专页逛时间线 ${step.durationMinutes} 分钟 · ${step.targetPages?.length ?? 0} 个专页 · ${likeTag}`;
    const detours = [
      (step.randomProfileVisitChance ?? 0) > 0
        ? `串门时间线 ${step.randomProfileVisitChance}%`
        : '',
      (step.randomPageVisitChance ?? 0) > 0 ? `串门专页 ${step.randomPageVisitChance}%` : '',
    ]
      .filter(Boolean)
      .join('/');
    return `首页 ${step.durationMinutes} 分钟 · ${likeTag}${detours ? ` · ${detours}` : ''}`;
  }
  return `Reels ${step.durationMinutes} 分钟 · ${likeTag}`;
}

function stepShort(step: Step) {
  if (step.type === 'post')
    return [step.destination === 'story' ? '发布快拍' : '发布帖子', step.count + ' 条'];
  if (step.type === 'friends')
    return step.friendAction === 'add_suggested'
      ? ['加推荐好友', step.maxAccepts + ' 人']
      : ['接受好友', step.acceptMode === 'all' ? '全部' : step.maxAccepts + ' 个'];
  const name =
    step.type === 'video'
      ? '浏览 Reels'
      : step.type === 'feed'
        ? (FEED_NAMES[step.feedMode ?? 'home'] ?? '浏览首页')
        : '浏览商城';
  const detail =
    step.type === 'feed' && step.feedMode === 'search_pages'
      ? `${step.durationMinutes} 分钟 · ${step.targetPages?.length ?? 0}专页`
      : step.type !== 'marketplace' && step.maxLikes > 0
        ? `${step.durationMinutes} 分钟 · ≤${step.maxLikes}赞`
        : `${step.durationMinutes} 分钟`;
  return [name, detail];
}

const RESOURCE_USAGE_TITLE =
  '剩余是当前保存表中尚未标记已使用的行数，包含执行中及待核对项；原文件位置不变。任务允许重复，或手动清空使用记录后，可再次取用已使用资源。不同资源行不会因内容相同被强制拦截。';
const resourceUsageLabel = (s: ResourceUsageSummaryValue | null, loaded: boolean) =>
  !loaded
    ? '资源记录未读取'
    : !s
      ? '剩余 0 条 · 尚未设置资源'
      : [
          `剩余 ${s.remaining} 条`,
          s.published && `已发 ${s.published} 条`,
          s.pendingAttempts && `${s.pendingAttempts} 个执行中`,
          s.reviewAttempts && `${s.reviewAttempts} 个待核对`,
          s.previousVersionPending && `其中旧资源 ${s.previousVersionPending} 个`,
          '待核验',
        ]
          .filter(Boolean)
          .join(' · ');

interface CombinationCardProps {
  carrier?: 'browser' | 'bluestacks' | undefined;
  row: SavedCombination;
  managing: boolean;
  isChecked: boolean;
  busy?: boolean;
  selectedCount: number;
  busySelected: number;
  offlineSelected: number;
  eligibleImmediateCount: number;
  resourceSummaries: ResourceUsageSummaryValue[] | null;
  capabilities?: z.infer<typeof TaskCapabilities> | null;
  runtime?: z.infer<typeof TaskRuntimeOverview> | null;
  color: CardColor;
  colorSupported?: boolean;
  onToggleRow: (id: string) => void;
  onEdit: (row: SavedCombination) => void;
  onCopy: (row: SavedCombination) => void;
  onDelete?: (row: SavedCombination) => void;
  onRequestDelete: (row: SavedCombination) => void;
  onResources: (row: SavedCombination) => void;
  onQuickSchedule?: (row: SavedCombination) => void;
  onStart?: (row: SavedCombination) => void;
  onColor?: (row: SavedCombination, color: CardColor) => void;
}

export function CombinationCard(p: CombinationCardProps) {
  const {
    carrier = 'browser',
    row,
    managing,
    isChecked,
    busy,
    selectedCount,
    busySelected,
    offlineSelected,
    eligibleImmediateCount,
    resourceSummaries,
    capabilities,
    runtime,
    color,
    colorSupported,
    onToggleRow,
    onEdit,
    onCopy,
    onDelete,
    onRequestDelete,
    onResources,
    onQuickSchedule,
    onStart,
    onColor,
  } = p;
  const saved = row.saved;
  if (!saved) return null;
  const isBs = carrier === 'bluestacks';
  const unitLabel = isBs ? '蓝蝶窗口' : '浏览器';
  const name = saved.name || '未命名组合';
  const capability = capabilities?.combinations.find(
    (v) => v.id === row.id && v.version === row.version,
  );
  const bsEval = isBs ? evaluateBluestacksCombination(saved) : null;
  const effectiveEnabled = isBs ? Boolean(bsEval?.enabled) : Boolean(capability?.enabled);
  const effectiveReason = isBs ? (bsEval?.reason ?? '') : (capability?.reason ?? '');
  const usesTable =
    !isBs && saved.steps.some((step) => step.type === 'post' && step.resourceMode === 'table');
  const summary = resourceSummaries?.find((item) => item.combinationId === row.id) ?? null;
  const remaining = !usesTable
    ? '—'
    : resourceSummaries === null
      ? '…'
      : String(summary?.remaining ?? 0);
  const comboPlans =
    runtime?.plans.filter(
      (pl) => pl.combinationId === row.id && LIVE_COMBINATION_STATES.includes(pl.state),
    ) ?? [];
  const using = isBs ? 0 : new Set(comboPlans.map((pl) => pl.profileId)).size;
  const activeUsing = isBs
    ? 0
    : new Set(
        comboPlans
          .filter((pl) => ACTIVE_OR_QUEUED_STATES.includes(pl.state))
          .map((pl) => pl.profileId),
      ).size;
  const startDisabled =
    managing || busy || !onStart || !effectiveEnabled || eligibleImmediateCount === 0;
  const offlineHint = offlineSelected > 0 ? `（含 ${offlineSelected} 个离线将自动启动）` : '';
  const startTitle =
    effectiveReason ||
    (!isBs && !capability
      ? '任务能力读取中'
      : selectedCount === 0
        ? `请先在左侧勾选${unitLabel}`
        : eligibleImmediateCount === 0
          ? isBs
            ? `${busySelected} 台正在运行任务`
            : `${busySelected} 份资料已有任务`
          : busySelected > 0
            ? `启动 ${eligibleImmediateCount} 个${offlineHint}，跳过 ${busySelected} 个运行中`
            : `启动 ${eligibleImmediateCount} 个${unitLabel}${offlineHint}`);
  const extra = saved.steps.length - 5;

  return (
    <article
      className={
        'relative flex min-h-[340px] w-[240px] flex-col rounded-xl border border-[var(--line)] bg-white shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md focus-within:shadow-md has-[.popover-panel]:z-[6]' +
        (managing && isChecked ? ' ring-2 ring-[var(--brand)] ring-offset-2' : '')
      }
    >
      {managing && (
        <label
          className="absolute top-2.5 left-2.5 z-[2] flex cursor-pointer rounded-md bg-white/95 p-1 shadow-xs"
          title={using > 0 ? '请先停止此组合的相关任务' : '选择此组合'}
        >
          <input
            type="checkbox"
            className={UI_CHECKBOX}
            aria-label={'选择组合 ' + name}
            checked={isChecked && using === 0}
            disabled={busy || using > 0}
            onChange={() => onToggleRow(row.id)}
          />
        </label>
      )}
      <div
        className="group flex min-h-0 flex-1 cursor-pointer flex-col overflow-hidden rounded-t-xl outline-none"
        role="button"
        tabIndex={0}
        title={managing ? (using > 0 ? '请先停止相关任务' : '点击选择组合') : '点击编辑组合'}
        aria-pressed={managing ? isChecked : undefined}
        onClick={() => (managing ? onToggleRow(row.id) : onEdit(row))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            managing ? onToggleRow(row.id) : onEdit(row);
          }
        }}
      >
        <header
          className={`bg-gradient-to-br ${CARD_HEADER_TONE[color]} px-4 py-3 text-white group-focus-visible:ring-2 group-focus-visible:ring-white/75 group-focus-visible:ring-inset ${managing ? 'pl-10' : ''}`}
        >
          <h3 className="m-0 truncate text-sm leading-snug font-semibold text-white" title={name}>
            {name}
          </h3>
          <span className="combo-meta mt-0.5 inline-block text-[11px] font-medium text-white/80">
            {saved.randomOrder ? '随机顺序' : '按顺序'}
          </span>
        </header>
        <ol className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 px-3.5 pt-3.5 pb-2">
          {saved.steps.slice(0, 5).map((step) => {
            const [label, value] = stepShort(step);
            const bsSup = isBs ? bluestacksStepSupport(step) : 'supported';
            return (
              <li
                key={step.id}
                title={stepSummary(step)}
                className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text)]"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${STEP_DOT_COLOR[step.type]}`}
                  aria-hidden="true"
                />
                <span
                  className={`min-w-0 flex-1 truncate ${bsSup === 'unsupported' ? 'text-slate-400 line-through' : ''}`}
                >
                  {label}
                </span>
                {bsSup !== 'supported' && (
                  <span
                    className={`shrink-0 rounded px-1 py-px text-[10px] font-medium ${
                      bsSup === 'unsupported'
                        ? 'bg-slate-100 text-slate-500'
                        : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {bsSup === 'unsupported' ? '仅浏览器' : '按首页'}
                  </span>
                )}
                <em className="shrink-0 text-[11px] text-[var(--text-3)] not-italic tabular-nums">
                  {value}
                </em>
              </li>
            );
          })}
          {extra > 0 && <li className="pl-4 text-xs text-[var(--text-3)]">还有 {extra} 项</li>}
          {!saved.steps.length && (
            <li className="pl-4 text-xs text-[var(--text-3)]">尚未添加子任务</li>
          )}
        </ol>
      </div>
      <div className="mx-3 grid grid-cols-2 divide-x divide-[var(--line)] rounded-lg border border-[var(--line)] bg-[var(--surface-2)] [&:has(>_.combo-stat:only-child)]:grid-cols-1">
        {usesTable && (
          <div
            className="combo-stat resource-count flex flex-col items-center justify-center gap-0.5 px-2 py-2 text-center"
            title={
              resourceUsageLabel(summary, resourceSummaries !== null) + '\n' + RESOURCE_USAGE_TITLE
            }
          >
            <strong className="text-sm font-bold text-[var(--text)] tabular-nums">
              {remaining}
            </strong>
            <span className="text-[11px] text-[var(--text-3)]">剩余资源</span>
          </div>
        )}
        <div
          className="combo-stat flex flex-col items-center justify-center gap-0.5 px-2 py-2 text-center"
          title={
            isBs
              ? '此组合中可在蓝蝶端执行的步骤数量（其余仅浏览器步骤将自动跳过）'
              : '正在执行或排队此组合的浏览器数量'
          }
        >
          <strong
            className={`text-sm font-bold tabular-nums ${
              isBs
                ? effectiveEnabled
                  ? 'text-[var(--text)]'
                  : 'text-slate-400'
                : activeUsing
                  ? 'text-[var(--run)]'
                  : 'text-[var(--text)]'
            }`}
          >
            {isBs ? `${bsEval?.supportedCount ?? 0}/${bsEval?.totalCount ?? 0}` : activeUsing}
          </strong>
          <span className="text-[11px] text-[var(--text-3)]">
            {isBs ? '可执行步骤' : '使用中浏览器'}
          </span>
        </div>
      </div>
      {effectiveReason && (
        <p
          className="mx-3 mt-1.5 mb-0 truncate text-[11px] font-medium text-[var(--warn)]"
          title={effectiveReason}
        >
          {effectiveReason}
        </p>
      )}
      <footer className="combo-foot mt-auto flex flex-wrap items-center gap-1.5 px-3 py-2.5">
        <Btn
          v="primary"
          sm={false}
          className="combo-start min-w-[92px] flex-1"
          disabled={startDisabled}
          title={startTitle}
          onClick={() => onStart?.(row)}
        >
          <IconPlay size={14} />
          启动
          {eligibleImmediateCount > 0 && (
            <span className="h-[18px] min-w-[18px] rounded-full bg-white/22 px-[5px] text-[11px] leading-[18px] tabular-nums">
              {eligibleImmediateCount}
            </span>
          )}
        </Btn>
        {usesTable && !managing && (
          <Btn
            className={
              summary?.remaining === 0
                ? 'border-[var(--brand)] bg-[var(--brand-soft)] font-semibold text-[var(--brand)] hover:not-disabled:bg-blue-100'
                : undefined
            }
            disabled={busy}
            title="配置或补充此组合的养号发帖/快拍素材表"
            onClick={() => onResources(row)}
          >
            <IconLayers size={13} /> 素材 ({remaining})
          </Btn>
        )}
        {onQuickSchedule &&
          !managing &&
          saved.loop.mode !== 'until-stopped' &&
          (!isBs || effectiveEnabled) && (
            <Btn
              disabled={busy}
              title="将此活跃组合一键加入定时排班"
              onClick={() => onQuickSchedule(row)}
            >
              <IconClock size={13} /> 加入排班
            </Btn>
          )}
        {!managing && (
          <PopoverMenu
            label="更多操作"
            trigger={<IconMore />}
            items={[
              { label: '编辑', icon: <IconEdit />, onSelect: () => onEdit(row) },
              ...(!isBs
                ? [{ label: '发帖资源', icon: <IconLayers />, onSelect: () => onResources(row) }]
                : []),
              { label: '复制', icon: <IconCopy />, onSelect: () => onCopy(row) },
              ...(onDelete
                ? [
                    {
                      label: '删除',
                      icon: <IconClose />,
                      danger: true,
                      disabled: busy || using > 0,
                      title: using > 0 ? '运行中无法删除' : '删除此任务组合',
                      onSelect: () => onRequestDelete(row),
                    },
                  ]
                : []),
            ]}
          >
            {(close) =>
              onColor && (
                <div className="pb-1">
                  <span className="block px-2 pt-1 text-[11px] font-bold tracking-wide text-[var(--text-3)]">
                    卡片颜色
                  </span>
                  <div className="grid grid-cols-4 gap-1.5 px-2 pt-1.5 pb-0.5">
                    {cardColorNames.map((swatchName) => (
                      <button
                        type="button"
                        key={swatchName}
                        className={`h-[26px] w-full rounded-[7px] border-2 bg-gradient-to-br p-0 transition-transform ${CARD_HEADER_TONE[swatchName]} ${swatchName === color ? 'border-[var(--text)] ring-2 ring-white ring-inset' : 'border-transparent hover:scale-[1.06] hover:border-black/15'}`}
                        title={
                          colorSupported
                            ? cardColorLabels[swatchName]
                            : '需升级软件后可设置卡片颜色'
                        }
                        aria-label={'卡片颜色 ' + cardColorLabels[swatchName]}
                        disabled={!colorSupported}
                        onClick={() => {
                          close();
                          onColor(row, swatchName);
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
}
