import { useEffect, useState, type ReactNode } from 'react';
import type { FeedTargetPage, Step } from '../shared/contracts.js';
import { parseFeedTargetPagesText } from '../shared/feed-target-pages.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import { marketplaceCategories } from '../shared/marketplace-categories.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { Chk } from './modules/shared/module-ui.js';
import { UI_INPUT_SM, UI_SELECT_SM, UI_TEXTAREA, UI_UNIT_FIELD } from './ui/primitives.js';

export type FeedModeValue = 'home' | 'random_profile' | 'random_page' | 'search_pages';

const FEED_MODE_LABELS: Record<FeedModeValue, string> = {
  home: '浏览首页',
  random_profile: '随机逛他人时间线',
  random_page: '随机逛公共专页',
  search_pages: '指定专页列表',
};
const ALL_FEED_MODES: readonly FeedModeValue[] = [
  'home',
  'random_profile',
  'random_page',
  'search_pages',
];
const sameTargetPage = (a: FeedTargetPage, lp: BumperTarget) =>
  a.id?.toLowerCase() === lp.id.toLowerCase() ||
  a.name.trim().toLowerCase() === (lp.name || lp.id).trim().toLowerCase();
const formatPages = (pages?: readonly FeedTargetPage[]) =>
  (pages ?? []).map((p) => (p.id ? `${p.name}, ${p.id}` : p.name)).join('\n');

const LABEL_CLS = 'flex flex-col gap-1 text-xs font-medium text-[var(--text-2)]';
const GRID_CLS = 'grid grid-cols-2 gap-x-3 gap-y-2.5 max-[600px]:grid-cols-1';

const Num = (p: {
  l: string;
  aria: string;
  u: string;
  min: number;
  max: number;
  val: number;
  dis: boolean;
  set: (n: number) => void;
}) => (
  <label className={LABEL_CLS}>
    <span>{p.l}</span>
    <div className={UI_UNIT_FIELD}>
      <ControlledNumberInput
        ariaLabel={p.aria}
        className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-xs text-[var(--text)] focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
        min={p.min}
        max={p.max}
        defaultValue={p.val}
        value={p.val}
        disabled={p.dis}
        onChange={p.set}
      />
      <span className="border-l border-[var(--line)] bg-slate-50 px-2 text-[11px] leading-8 font-medium text-[var(--text-3)] select-none">
        {p.u}
      </span>
    </div>
  </label>
);

const Fold = (p: { title: string; tags: string[]; children: ReactNode }) => (
  <details className="col-span-full w-full rounded-lg border border-[var(--line)] bg-slate-50/80 px-3 py-2">
    <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs font-semibold text-[var(--text-2)] select-none">
      <span>{p.title}</span>
      {p.tags.length > 0 && (
        <small className="font-normal text-[var(--text-3)]">{p.tags.join(' · ')}</small>
      )}
    </summary>
    <div className={`mt-2.5 ${GRID_CLS}`}>{p.children}</div>
  </details>
);

const Sel = (p: {
  l: string;
  aria?: string;
  val: string;
  dis: boolean;
  set: (v: string) => void;
  children: ReactNode;
}) => (
  <label className={LABEL_CLS}>
    <span>{p.l}</span>
    <select
      aria-label={p.aria}
      className={`${UI_SELECT_SM} w-full`}
      value={p.val}
      disabled={p.dis}
      onChange={(e) => p.set(e.target.value)}
    >
      {p.children}
    </select>
  </label>
);

export function StepConfigFields(p: {
  carrier?: 'browser' | 'bluestacks' | undefined;
  step: Step;
  onChange: (patch: Partial<Step>) => void;
  libraryPages?: readonly BumperTarget[];
  disabled?: boolean;
  showFeedModeSelector?: boolean;
  showFriendActionSelector?: boolean;
  feedModeOptions?: readonly FeedModeValue[];
}) {
  const {
    carrier = 'browser',
    step,
    onChange,
    libraryPages = [],
    disabled = false,
    showFeedModeSelector = true,
    showFriendActionSelector = true,
    feedModeOptions = ALL_FEED_MODES,
  } = p;
  const isBs = carrier === 'bluestacks';
  const [pagesDraft, setPagesDraft] = useState<string | null>(null);
  const stepFeedMode = step.type === 'feed' ? (step.feedMode ?? 'home') : 'home';
  useEffect(() => setPagesDraft(null), [step.id, stepFeedMode]);

  if (step.type === 'post') {
    if (isBs) {
      return (
        <p className="m-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          该步骤（{step.destination === 'story' ? '发布快拍' : '随机发帖'}）仅支持在 Chrome
          浏览器端执行；蓝蝶端运行此组合时会自动跳过。如需蓝蝶发帖/快拍请使用活跃页上方快捷单步或「蓝蝶小组发帖」。
        </p>
      );
    }
    const isStory = step.destination === 'story';
    return (
      <div className={GRID_CLS}>
        <Num
          l={isStory ? '单号快拍数' : '单号发帖数'}
          aria={isStory ? '每个账号快拍数' : '每个账号发帖数'}
          u="条"
          min={1}
          max={20}
          val={step.count}
          dis={disabled}
          set={(count) => onChange({ count })}
        />
        <Sel
          l="分享范围"
          val={step.audience ?? 'preserve-current'}
          dis={disabled}
          set={(v) =>
            onChange({ audience: v === 'self' || v === 'friends' ? v : 'preserve-current' })
          }
        >
          <option value="preserve-current">保持当前范围</option>
          <option value="self" disabled={isStory}>
            {isStory ? '仅自己（快拍不支持）' : '仅自己'}
          </option>
          <option value="friends" disabled={!isStory}>
            {isStory ? '好友' : '好友（仅快拍）'}
          </option>
        </Sel>
        <Chk
          className="col-span-full"
          label="重复使用素材"
          checked={step.allowRepeat}
          disabled={disabled}
          onChange={(allowRepeat) => onChange({ allowRepeat })}
        />
      </div>
    );
  }

  if (step.type === 'friends') {
    const isAdd = step.friendAction === 'add_suggested';
    if (isBs && isAdd) {
      return (
        <p className="m-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          「加推荐好友」仅支持在 Chrome 浏览器端执行；蓝蝶端运行此组合时会自动跳过。
        </p>
      );
    }
    return (
      <div className={GRID_CLS}>
        {showFriendActionSelector && !isBs && (
          <Sel
            l="动作"
            val={isAdd ? 'add_suggested' : 'accept'}
            dis={disabled}
            set={(v) => {
              const nextAdd = v === 'add_suggested';
              onChange({
                friendAction: nextAdd ? 'add_suggested' : undefined,
                acceptMode: nextAdd ? 'count' : step.acceptMode,
                maxAccepts: nextAdd
                  ? Math.min(100, Math.max(1, step.maxAccepts || 3))
                  : step.maxAccepts,
              });
            }}
          >
            <option value="accept">接受好友请求</option>
            <option value="add_suggested">加推荐好友</option>
          </Sel>
        )}
        {!isAdd && (
          <Sel
            l="接受方式"
            aria="好友请求接受方式"
            val={step.acceptMode}
            dis={disabled}
            set={(v) => onChange({ acceptMode: v === 'all' ? 'all' : 'count' })}
          >
            <option value="count">指定数量</option>
            <option value="all">全部接受</option>
          </Sel>
        )}
        {(isAdd || step.acceptMode === 'count') && (
          <Num
            l={isAdd ? '添加人数' : '接受数量'}
            aria={isAdd ? '添加推荐好友人数' : '接受数量'}
            u={isAdd ? '人' : '个'}
            min={1}
            max={isAdd ? 100 : 500}
            val={step.maxAccepts}
            dis={disabled}
            set={(maxAccepts) => onChange({ maxAccepts })}
          />
        )}
        <Num
          l="最长时长"
          aria="最长执行时间"
          u="分钟"
          min={1}
          max={240}
          val={step.durationMinutes}
          dis={disabled}
          set={(durationMinutes) => onChange({ durationMinutes })}
        />
      </div>
    );
  }

  const detourTags =
    step.type === 'feed'
      ? [
          (step.randomProfileVisitChance ?? 0) > 0
            ? `时间线 ${step.randomProfileVisitChance}%`
            : '',
          (step.randomPageVisitChance ?? 0) > 0 ? `专页 ${step.randomPageVisitChance}%` : '',
        ].filter(Boolean)
      : [];
  const likeFilterTags =
    step.type !== 'marketplace'
      ? [
          step.minLikeCount > 0 ? `≥${step.minLikeCount}赞` : '',
          step.includeKeywords ? `含「${step.includeKeywords}」` : '',
          step.excludeKeywords ? `排「${step.excludeKeywords}」` : '',
          step.skipSponsored === false ? '含广告' : '',
        ].filter(Boolean)
      : [];
  const marketFilterTags =
    step.type === 'marketplace'
      ? [
          step.keyword ? `「${step.keyword}」` : '',
          step.categoryId
            ? (marketplaceCategories.find(([id]) => id === step.categoryId)?.[1] ?? '分类')
            : '',
          step.minPrice !== undefined || step.maxPrice !== undefined
            ? `${step.minPrice ?? 0}~${step.maxPrice ?? '不限'}`
            : '',
        ].filter(Boolean)
      : [];

  return (
    <div className={GRID_CLS}>
      {step.type === 'feed' && showFeedModeSelector && !isBs && (
        <Sel
          l="模式"
          aria="浏览模式"
          val={stepFeedMode}
          dis={disabled}
          set={(v) => {
            const mode = v as FeedModeValue;
            setPagesDraft(null);
            onChange({
              feedMode: mode === 'home' ? undefined : mode,
              ...(mode !== 'home'
                ? { randomProfileVisitChance: undefined, randomPageVisitChance: undefined }
                : {}),
              ...(mode !== 'search_pages' ? { targetPages: undefined } : {}),
              ...(mode !== 'home' && !step.detourDwellSeconds ? { detourDwellSeconds: 25 } : {}),
            });
          }}
        >
          {feedModeOptions.map((m) => (
            <option key={m} value={m}>
              {FEED_MODE_LABELS[m]}
            </option>
          ))}
        </Sel>
      )}
      <Num
        l="浏览时长"
        aria="浏览时间"
        u="分钟"
        min={1}
        max={240}
        val={step.durationMinutes}
        dis={disabled}
        set={(durationMinutes) => onChange({ durationMinutes })}
      />
      {step.type === 'feed' && stepFeedMode !== 'home' && (
        <Num
          l="单页停留"
          aria="单次主页停留秒数"
          u="秒"
          min={10}
          max={120}
          val={step.detourDwellSeconds ?? 25}
          dis={disabled}
          set={(detourDwellSeconds) => onChange({ detourDwellSeconds })}
        />
      )}
      {step.type !== 'marketplace' && (
        <>
          <Chk
            className="col-span-full"
            label="随机点赞"
            checked={step.maxLikes > 0}
            disabled={disabled}
            onChange={(checked) => onChange({ maxLikes: checked ? step.maxLikes || 2 : 0 })}
          />
          {step.maxLikes > 0 && (
            <>
              <Num
                l="点赞上限"
                aria="随机点赞上限"
                u="个"
                min={1}
                max={100}
                val={step.maxLikes}
                dis={disabled}
                set={(maxLikes) => onChange({ maxLikes })}
              />
              {!isBs && (
                <Num
                  l="触发概率"
                  aria="单帖触发概率"
                  u="%"
                  min={1}
                  max={100}
                  val={step.likeProbability ?? 35}
                  dis={disabled}
                  set={(likeProbability) => onChange({ likeProbability })}
                />
              )}
            </>
          )}
        </>
      )}

      {step.type === 'feed' && stepFeedMode === 'search_pages' && (
        <div className="col-span-full flex w-full flex-col gap-2">
          {libraryPages.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-2)]">专页库点选</span>
              <div className="flex max-h-[112px] flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-[var(--line)] bg-slate-50 p-1.5">
                {libraryPages.map((lp) => {
                  const cur = step.targetPages ?? [],
                    active = cur.some((pg) => sameTargetPage(pg, lp));
                  return (
                    <button
                      key={lp.id}
                      type="button"
                      disabled={disabled}
                      className={
                        'cursor-pointer rounded-full border px-2.5 py-0.5 text-xs leading-snug transition-colors ' +
                        (active
                          ? 'border-[var(--brand)] bg-[var(--brand-soft)] font-medium text-[var(--brand)]'
                          : 'border-[var(--line-strong)] bg-white text-[var(--text-2)] hover:border-slate-400')
                      }
                      onClick={() => {
                        const nextList: FeedTargetPage[] = active
                          ? cur.filter((pg) => !sameTargetPage(pg, lp))
                          : [...cur, { id: lp.id, name: lp.name || lp.id }].slice(0, 100);
                        setPagesDraft(formatPages(nextList));
                        onChange({ targetPages: nextList });
                      }}
                    >
                      {active ? '✓ ' : '＋ '}
                      {lp.name || lp.id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <label className={LABEL_CLS}>
            <span>目标专页</span>
            <textarea
              rows={3}
              className={UI_TEXTAREA}
              disabled={disabled}
              value={pagesDraft ?? formatPages(step.targetPages)}
              placeholder="每行一个专页名、名称,ID 或链接"
              onChange={(e) => {
                setPagesDraft(e.target.value);
                onChange({ targetPages: parseFeedTargetPagesText(e.target.value) });
              }}
            />
          </label>
        </div>
      )}

      {step.type === 'marketplace' && !isBs && (
        <Fold title="商品筛选" tags={marketFilterTags}>
          <label className={LABEL_CLS}>
            <span>关键词</span>
            <input
              maxLength={120}
              className={`${UI_INPUT_SM} w-full`}
              value={step.keyword}
              disabled={disabled}
              placeholder="留空浏览推荐"
              onChange={(e) => onChange({ keyword: e.target.value })}
            />
          </label>
          <Sel
            l="分类"
            val={step.categoryId ?? ''}
            dis={disabled}
            set={(v) => onChange({ categoryId: v || undefined })}
          >
            <option value="">不限</option>
            {marketplaceCategories.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Sel>
          {(['minPrice', 'maxPrice'] as const).map((k) => (
            <label key={k} className={LABEL_CLS}>
              <span>{k === 'minPrice' ? '最低价' : '最高价'}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                className={`${UI_INPUT_SM} w-full`}
                value={step[k] ?? ''}
                disabled={disabled}
                placeholder="不限"
                onChange={(e) =>
                  onChange({ [k]: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
            </label>
          ))}
        </Fold>
      )}

      {step.type === 'feed' && stepFeedMode === 'home' && !isBs && (
        <Fold title="顺路串门" tags={detourTags}>
          <Num
            l="点开时间线"
            aria="顺路逛别人时间线概率"
            u="%"
            min={0}
            max={100}
            val={step.randomProfileVisitChance ?? 0}
            dis={disabled}
            set={(v) => onChange({ randomProfileVisitChance: v > 0 ? v : undefined })}
          />
          <Num
            l="打开专页"
            aria="顺路打开别人专页概率"
            u="%"
            min={0}
            max={100}
            val={step.randomPageVisitChance ?? 0}
            dis={disabled}
            set={(v) => onChange({ randomPageVisitChance: v > 0 ? v : undefined })}
          />
          {detourTags.length > 0 && (
            <Num
              l="单次停留"
              aria="单次主页停留秒数"
              u="秒"
              min={10}
              max={120}
              val={step.detourDwellSeconds ?? 25}
              dis={disabled}
              set={(detourDwellSeconds) => onChange({ detourDwellSeconds })}
            />
          )}
        </Fold>
      )}

      {step.type !== 'marketplace' && step.maxLikes > 0 && !isBs && (
        <Fold title="点赞筛选" tags={likeFilterTags}>
          <Num
            l="最低赞数"
            aria="目标点赞量至少"
            u="赞"
            min={0}
            max={1_000_000}
            val={step.minLikeCount}
            dis={disabled}
            set={(minLikeCount) => onChange({ minLikeCount })}
          />
          {(
            [
              ['包含词', 'includeKeywords', '逗号分隔，留空不限'],
              ['排除词', 'excludeKeywords', '命中则不点赞'],
            ] as const
          ).map(([lbl, key, ph]) => (
            <label key={key} className={LABEL_CLS}>
              <span>{lbl}</span>
              <input
                maxLength={300}
                className={`${UI_INPUT_SM} w-full`}
                value={step[key] ?? ''}
                disabled={disabled}
                placeholder={ph}
                onChange={(e) => onChange({ [key]: e.target.value || undefined })}
              />
            </label>
          ))}
          <Chk
            className="col-span-full"
            label="跳过广告内容"
            checked={step.skipSponsored ?? true}
            disabled={disabled}
            onChange={(skipSponsored) => onChange({ skipSponsored })}
          />
        </Fold>
      )}
    </div>
  );
}
