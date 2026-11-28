import { useEffect, useState, type ReactNode } from 'react';
import type { FeedTargetPage, Step } from '../shared/contracts.js';
import { parseFeedTargetPagesText } from '../shared/feed-target-pages.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { Chk, Fld, InFld, SelFld } from './modules/shared/module-ui.js';
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
const GRID_CLS = 'grid grid-cols-2 gap-x-3 gap-y-2.5 max-[600px]:grid-cols-1';
const WARN_CLS =
  'm-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800';
export const Num = (p: {
  l: string;
  aria: string;
  u: string;
  min: number;
  max: number;
  val: number;
  dis: boolean;
  set: (n: number) => void;
}) => (
  <Fld label={p.l}>
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
  </Fld>
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
  <SelFld
    label={p.l}
    aria-label={p.aria}
    className={`${UI_SELECT_SM} w-full`}
    value={p.val}
    disabled={p.dis}
    onVal={p.set}
  >
    {p.children}
  </SelFld>
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
  const num = (
    l: string,
    aria: string,
    u: string,
    min: number,
    max: number,
    val: number,
    set: (n: number) => void,
  ) => <Num l={l} aria={aria} u={u} min={min} max={max} val={val} dis={disabled} set={set} />;
  if (step.type === 'post') {
    if (isBs)
      return (
        <p className={WARN_CLS}>
          该步骤（{step.destination === 'story' ? '发布快拍' : '随机发帖'}）仅支持在 Chrome
          浏览器端执行；蓝蝶端运行此组合时会自动跳过。如需蓝蝶发帖/快拍请使用活跃页上方快捷单步或「蓝蝶小组发帖」。
        </p>
      );
    const isStory = step.destination === 'story';
    return (
      <div className={GRID_CLS}>
        {num(
          isStory ? '单号快拍数' : '单号发帖数',
          isStory ? '每个账号快拍数' : '每个账号发帖数',
          '条',
          1,
          20,
          step.count,
          (count) => onChange({ count }),
        )}
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
    if (isBs && isAdd)
      return (
        <p className={WARN_CLS}>
          「加推荐好友」仅支持在 Chrome 浏览器端执行；蓝蝶端运行此组合时会自动跳过。
        </p>
      );
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
        {(isAdd || step.acceptMode === 'count') &&
          num(
            isAdd ? '添加人数' : '接受数量',
            isAdd ? '添加推荐好友人数' : '接受数量',
            isAdd ? '人' : '个',
            1,
            isAdd ? 100 : 500,
            step.maxAccepts,
            (maxAccepts) => onChange({ maxAccepts }),
          )}
        {num('最长时长', '最长执行时间', '分钟', 1, 240, step.durationMinutes, (durationMinutes) =>
          onChange({ durationMinutes }),
        )}
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
      {num('浏览时长', '浏览时间', '分钟', 1, 240, step.durationMinutes, (durationMinutes) =>
        onChange({ durationMinutes }),
      )}
      {step.type === 'feed' &&
        stepFeedMode !== 'home' &&
        !isBs &&
        num(
          '单页停留',
          '单次主页停留秒数',
          '秒',
          10,
          120,
          step.detourDwellSeconds ?? 25,
          (detourDwellSeconds) => onChange({ detourDwellSeconds }),
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
              {num('点赞上限', '随机点赞上限', '个', 1, 100, step.maxLikes, (maxLikes) =>
                onChange({ maxLikes }),
              )}
              {!isBs &&
                num(
                  '触发概率',
                  '单帖触发概率',
                  '%',
                  1,
                  100,
                  step.likeProbability ?? 35,
                  (likeProbability) => onChange({ likeProbability }),
                )}
            </>
          )}
        </>
      )}
      {step.type === 'feed' && stepFeedMode === 'search_pages' && !isBs && (
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
          <Fld label="目标专页">
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
          </Fld>
        </div>
      )}
      {step.type === 'feed' && stepFeedMode === 'home' && !isBs && (
        <Fold title="顺路串门" tags={detourTags}>
          {num(
            '点开时间线',
            '顺路逛别人时间线概率',
            '%',
            0,
            100,
            step.randomProfileVisitChance ?? 0,
            (v) => onChange({ randomProfileVisitChance: v > 0 ? v : undefined }),
          )}
          {num(
            '打开专页',
            '顺路打开别人专页概率',
            '%',
            0,
            100,
            step.randomPageVisitChance ?? 0,
            (v) => onChange({ randomPageVisitChance: v > 0 ? v : undefined }),
          )}
          {detourTags.length > 0 &&
            num(
              '单次停留',
              '单次主页停留秒数',
              '秒',
              10,
              120,
              step.detourDwellSeconds ?? 25,
              (detourDwellSeconds) => onChange({ detourDwellSeconds }),
            )}
        </Fold>
      )}
      {step.type !== 'marketplace' && step.maxLikes > 0 && !isBs && (
        <Fold title="点赞筛选" tags={likeFilterTags}>
          {num(
            '最低赞数',
            '目标点赞量至少',
            '赞',
            0,
            1_000_000,
            step.minLikeCount,
            (minLikeCount) => onChange({ minLikeCount }),
          )}
          {(
            [
              ['包含词', 'includeKeywords', '逗号分隔，留空不限'],
              ['排除词', 'excludeKeywords', '命中则不点赞'],
            ] as const
          ).map(([lbl, key, ph]) => (
            <InFld
              key={key}
              label={lbl}
              maxLength={300}
              className={`${UI_INPUT_SM} w-full`}
              value={step[key] ?? ''}
              disabled={disabled}
              placeholder={ph}
              onVal={(v) => onChange({ [key]: v || undefined })}
            />
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
