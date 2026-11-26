import { useEffect, useRef, useState } from 'react';
import {
  StartBluestacksActiveInput,
  type BluestacksQuickActiveStepType,
} from '../shared/bluestacks.js';
import type { Combination, Step } from '../shared/contracts.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import { taskTestModules, TaskTestRequest, type TestRequest } from '../shared/task-tests.js';
import { api } from './api.js';
import { Btn, Chk, CtrlNum, useBusyTask, useShowModal } from './modules/shared/module-ui.js';
import { StepConfigFields, type FeedModeValue } from './step-config-fields.js';
import {
  UI_COUNT_CHIP,
  UI_DANGER_TEXT,
  UI_DIALOG_CARD,
  UI_INPUT_SM,
  UI_UNIT_FIELD,
} from './ui/primitives.js';

export type BrowseModule = TestRequest['module'];

export const BROWSER_INSTANT_MODULES = taskTestModules.filter(
  (
    item,
  ): item is (typeof taskTestModules)[number] & {
    id: BrowseModule;
    type: NonNullable<(typeof taskTestModules)[number]['type']>;
  } => item.id !== 'post' && item.id !== 'story' && item.type !== null,
);

export const BLUESTACKS_QUICK_ACTIONS: ReadonlyArray<{
  type: BluestacksQuickActiveStepType;
  name: string;
  dot: string;
  detail: string;
  dur?: boolean;
  likes?: boolean;
  accepts?: boolean;
  comp?: boolean;
}> = [
  {
    type: 'feed',
    name: '浏览首页',
    dot: 'bg-emerald-500',
    detail: '按设定时长与点赞上限刷 FB Lite 首页推荐流',
    dur: true,
    likes: true,
  },
  {
    type: 'video',
    name: '浏览 Reels',
    dot: 'bg-violet-500',
    detail: '按设定时长与点赞上限刷 FB Lite Reels 短视频',
    dur: true,
    likes: true,
  },
  {
    type: 'marketplace',
    name: '浏览商城',
    dot: 'bg-amber-500',
    detail: '按设定时长浏览 FB Lite Marketplace 商品（个人号支持）',
    dur: true,
  },
  {
    type: 'friends',
    name: '接受好友',
    dot: 'bg-sky-500',
    detail: '按时长或通过上限确认 FB Lite 好友请求（个人号支持）',
    dur: true,
    accepts: true,
  },
  {
    type: 'post',
    name: '发时间线',
    dot: 'bg-pink-500',
    detail: '向当前 FB Lite 个人或专页时间线发布文案/本地媒体',
    comp: true,
  },
  {
    type: 'story',
    name: '发布快拍',
    dot: 'bg-pink-500',
    detail: '向当前 FB Lite 账号发布本地图片或视频快拍',
    comp: true,
  },
];

type BluestacksStepSupport = 'supported' | 'degraded' | 'unsupported';

export function bluestacksStepSupport(step: Step): BluestacksStepSupport {
  if (step.type === 'post') return 'unsupported';
  if (step.type === 'friends' && step.friendAction === 'add_suggested') return 'unsupported';
  if (step.type === 'feed' && step.feedMode && step.feedMode !== 'home') return 'degraded';
  return 'supported';
}

export function evaluateBluestacksCombination(saved: Combination): {
  enabled: boolean;
  reason: string;
  supportedCount: number;
  totalCount: number;
  hasPartialUnsupported: boolean;
} {
  const totalCount = saved.steps.length;
  const supportedCount = saved.steps.filter(
    (s) => bluestacksStepSupport(s) !== 'unsupported',
  ).length;
  const hasPartialUnsupported =
    supportedCount < totalCount || saved.steps.some((s) => bluestacksStepSupport(s) === 'degraded');
  if (saved.loop.mode === 'until-stopped') {
    return {
      enabled: false,
      reason: '蓝蝶暂不支持无限循环组合',
      supportedCount,
      totalCount,
      hasPartialUnsupported,
    };
  }
  if (totalCount === 0) {
    return {
      enabled: false,
      reason: '该组合尚未添加步骤',
      supportedCount,
      totalCount,
      hasPartialUnsupported,
    };
  }
  if (supportedCount === 0) {
    const hasPost = saved.steps.some((s) => s.type === 'post');
    const hasAddFriend = saved.steps.some(
      (s) => s.type === 'friends' && s.friendAction === 'add_suggested',
    );
    return {
      enabled: false,
      reason:
        hasAddFriend && !hasPost ? '仅浏览器端支持加推荐好友' : '该组合仅含仅浏览器支持的步骤',
      supportedCount,
      totalCount,
      hasPartialUnsupported,
    };
  }
  return { enabled: true, reason: '', supportedCount, totalCount, hasPartialUnsupported };
}

const EXPLORE_MODES: readonly FeedModeValue[] = ['random_profile', 'random_page', 'search_pages'];

function defaultStepForModule(module: BrowseModule): Step {
  const id = '00000000-0000-4000-8000-000000000001';
  if (module === 'friends' || module === 'add_friends')
    return {
      id,
      type: 'friends',
      ...(module === 'add_friends' ? { friendAction: 'add_suggested' as const } : {}),
      durationMinutes: 15,
      acceptMode: 'count',
      maxAccepts: module === 'add_friends' ? 3 : 2,
      maxLikes: 0,
      minLikeCount: 0,
    };
  if (module === 'explore_pages')
    return {
      id,
      type: 'feed',
      feedMode: 'random_profile',
      detourDwellSeconds: 25,
      durationMinutes: 5,
      maxLikes: 0,
      minLikeCount: 0,
    };
  if (module === 'marketplace')
    return {
      id,
      type: 'marketplace',
      durationMinutes: 3,
      keyword: '',
      maxLikes: 0,
      minLikeCount: 0,
    };
  return {
    id,
    type: module === 'video' ? 'video' : 'feed',
    durationMinutes: 3,
    maxLikes: 2,
    minLikeCount: 0,
    likeProbability: 35,
    skipSponsored: true,
  };
}

function stepToTestRequest(
  module: BrowseModule,
  step: Step,
  closeBrowserOnFinish: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    module,
    durationMinutes: 'durationMinutes' in step ? step.durationMinutes : 3,
    ...(closeBrowserOnFinish ? { closeBrowserOnFinish: true } : {}),
  };
  if (step.type === 'friends')
    return {
      ...base,
      acceptMode: module === 'add_friends' ? 'count' : step.acceptMode,
      maxAccepts: module === 'friends' && step.acceptMode === 'all' ? 500 : step.maxAccepts,
    };
  if (step.type === 'marketplace')
    return {
      ...base,
      keyword: step.keyword,
      ...(step.categoryId ? { categoryId: step.categoryId } : {}),
      ...(step.minPrice !== undefined ? { minPrice: step.minPrice } : {}),
      ...(step.maxPrice !== undefined ? { maxPrice: step.maxPrice } : {}),
    };
  if (step.type !== 'feed' && step.type !== 'video') return base;
  const likes = Math.max(0, step.maxLikes);
  return {
    ...base,
    maxLikes: likes,
    minLikeCount: likes > 0 ? Math.max(0, step.minLikeCount) : 0,
    ...(likes > 0
      ? {
          likeProbability: step.likeProbability ?? 35,
          ...(step.includeKeywords ? { includeKeywords: step.includeKeywords } : {}),
          ...(step.excludeKeywords ? { excludeKeywords: step.excludeKeywords } : {}),
          skipSponsored: step.skipSponsored ?? true,
        }
      : {}),
    ...(step.type === 'feed' && module === 'explore_pages'
      ? {
          feedMode: step.feedMode ?? 'random_profile',
          detourDwellSeconds: step.detourDwellSeconds ?? 25,
          ...(step.feedMode === 'search_pages' ? { targetPages: step.targetPages ?? [] } : {}),
        }
      : {}),
    ...(step.type === 'feed' &&
    module === 'feed' &&
    ((step.randomProfileVisitChance ?? 0) > 0 || (step.randomPageVisitChance ?? 0) > 0)
      ? {
          ...(step.randomProfileVisitChance
            ? { randomProfileVisitChance: step.randomProfileVisitChance }
            : {}),
          ...(step.randomPageVisitChance
            ? { randomPageVisitChance: step.randomPageVisitChance }
            : {}),
          detourDwellSeconds: step.detourDwellSeconds ?? 25,
        }
      : {}),
  };
}

export function TaskTestDialog(p: {
  module: BrowseModule;
  count: number;
  defaultCloseBrowser: boolean;
  onSubmit: (value: Omit<TestRequest, 'profileIds'>) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef<{ key: string; id: string } | null>(null);
  const [step, setStep] = useState<Step>(() => defaultStepForModule(p.module)),
    [closeBrowserOnFinish, setCloseBrowserOnFinish] = useState(p.defaultCloseBrowser),
    [libraryPages, setLibraryPages] = useState<BumperTarget[]>([]);
  const { busy, error, setError, run } = useBusyTask();
  useShowModal(dialog);
  useEffect(() => {
    if (p.module !== 'explore_pages') return;
    let alive = true;
    void api
      .bumperState()
      .then((s) => alive && setLibraryPages(s.pages ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [p.module]);
  const submit = () => {
    if (busy) return;
    const options = stepToTestRequest(p.module, step, closeBrowserOnFinish),
      key = JSON.stringify(options);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    const parsed = TaskTestRequest.safeParse({
      ...options,
      requestId: pending.current?.id,
      profileIds: ['00000000-0000-4000-8000-000000000001'],
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? '参数不正确');
    const { profileIds: _ids, ...value } = parsed.data;
    void run(() => p.onSubmit(value), '启动失败', p.onClose);
  };
  return (
    <dialog
      ref={dialog}
      className={`${UI_DIALOG_CARD} w-[min(480px,calc(100vw-32px))]`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) p.onClose();
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold text-slate-900">
          {BROWSER_INSTANT_MODULES.find((item) => item.id === p.module)?.name}
        </h3>
        <span className={UI_COUNT_CHIP}>{p.count} 个浏览器</span>
      </div>
      <div className="mb-3">
        <StepConfigFields
          step={step}
          libraryPages={libraryPages}
          disabled={busy}
          showFeedModeSelector={p.module === 'explore_pages'}
          showFriendActionSelector={false}
          feedModeOptions={EXPLORE_MODES}
          onChange={(patch) => setStep((prev) => ({ ...prev, ...patch }) as Step)}
        />
      </div>
      <Chk
        className="mb-3"
        label="完毕后关闭浏览器"
        checked={closeBrowserOnFinish}
        disabled={busy}
        onChange={setCloseBrowserOnFinish}
      />
      {error && (
        <p className={`${UI_DANGER_TEXT} mb-3`} role="alert">
          {error}
        </p>
      )}
      <footer className="flex justify-end gap-2 border-t border-[var(--line)] pt-3">
        <Btn sm={false} disabled={busy} onClick={p.onClose}>
          取消
        </Btn>
        <Btn v="primary" sm={false} disabled={busy} onClick={submit}>
          {busy ? '启动中…' : '开始执行'}
        </Btn>
      </footer>
    </dialog>
  );
}

function NumUnitField(p: {
  label: string;
  aria: string;
  unit: string;
  min: number;
  max: number;
  def: number;
  val: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-2)]">
      <span>{p.label}</span>
      <div className={UI_UNIT_FIELD}>
        <CtrlNum
          aria={p.aria}
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-xs text-[var(--text)] focus:outline-none disabled:bg-slate-50"
          min={p.min}
          max={p.max}
          def={p.def}
          val={p.val}
          disabled={p.disabled}
          onChange={p.onChange}
        />
        <span className="border-l border-[var(--line)] bg-slate-50 px-2 text-[11px] leading-8 font-medium text-[var(--text-3)] select-none">
          {p.unit}
        </span>
      </div>
    </label>
  );
}

export function BluestacksQuickStepDialog(p: {
  stepType: BluestacksQuickActiveStepType;
  instanceIds: string[];
  defaultCloseWindow: boolean;
  onSubmit: (payload: {
    instanceIds: string[];
    quickStep: Record<string, unknown>;
    closeWindowOnFinish?: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const def =
    BLUESTACKS_QUICK_ACTIONS.find((a) => a.type === p.stepType) ?? BLUESTACKS_QUICK_ACTIONS[0];
  const [durationMinutes, setDurationMinutes] = useState(p.stepType === 'friends' ? 15 : 3);
  const [maxLikes, setMaxLikes] = useState(2);
  const [maxAccepts, setMaxAccepts] = useState(3);
  const [caption, setCaption] = useState('');
  const [mediaPath, setMediaPath] = useState('');
  const [closeWindowOnFinish, setCloseWindowOnFinish] = useState(p.defaultCloseWindow);
  const { busy, error, setError, run } = useBusyTask();
  useShowModal(dialog);

  const labelCls = 'flex flex-col gap-1 text-xs font-medium text-[var(--text-2)]';
  const submit = () => {
    if (busy) return;
    if (p.stepType === 'post' && !caption.trim() && !mediaPath.trim())
      return setError('发贴文时请至少填写文案或本地媒体路径');
    if (p.stepType === 'story' && !mediaPath.trim())
      return setError('发快拍请填写本地图片或视频文件路径');
    const quickStep: Record<string, unknown> = {
      type: p.stepType,
      ...(def?.dur ? { durationMinutes } : {}),
      ...(def?.likes ? { maxLikes } : {}),
      ...(def?.accepts ? { maxAccepts } : {}),
      ...(p.stepType === 'post' && caption.trim() ? { caption: caption.trim() } : {}),
      ...(def?.comp && mediaPath.trim() ? { mediaPath: mediaPath.trim() } : {}),
    };
    const payload = {
      instanceIds: p.instanceIds,
      quickStep,
      ...(closeWindowOnFinish ? { closeWindowOnFinish: true } : {}),
    };
    const parsed = StartBluestacksActiveInput.safeParse(payload);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? '参数不正确');
    void run(() => p.onSubmit(payload), '启动蓝蝶快捷活跃失败', p.onClose);
  };

  return (
    <dialog
      ref={dialog}
      className={`${UI_DIALOG_CARD} w-[min(460px,calc(100vw-32px))]`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) p.onClose();
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold text-slate-900">{def?.name}</h3>
        <span className={UI_COUNT_CHIP}>{p.instanceIds.length} 台蓝蝶</span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-2.5 max-[600px]:grid-cols-1">
        {def?.dur && (
          <NumUnitField
            label="浏览时长"
            aria="持续时长"
            unit="分钟"
            min={1}
            max={60}
            def={3}
            val={durationMinutes}
            disabled={busy}
            onChange={setDurationMinutes}
          />
        )}
        {def?.likes && (
          <NumUnitField
            label="点赞上限"
            aria="最多点赞次数"
            unit="次"
            min={0}
            max={50}
            def={2}
            val={maxLikes}
            disabled={busy}
            onChange={setMaxLikes}
          />
        )}
        {def?.accepts && (
          <NumUnitField
            label="通过上限"
            aria="最多通过人数"
            unit="人"
            min={1}
            max={50}
            def={3}
            val={maxAccepts}
            disabled={busy}
            onChange={setMaxAccepts}
          />
        )}
        {def?.comp && p.stepType === 'post' && (
          <label className={`${labelCls} col-span-full`}>
            <span>文案</span>
            <input
              className={`${UI_INPUT_SM} w-full`}
              value={caption}
              disabled={busy}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="发帖文案（与媒体路径至少填一项）"
            />
          </label>
        )}
        {def?.comp && (
          <label className={`${labelCls} col-span-full`}>
            <span>本地媒体路径</span>
            <input
              className={`${UI_INPUT_SM} w-full`}
              value={mediaPath}
              disabled={busy}
              onChange={(e) => setMediaPath(e.target.value)}
              placeholder={
                p.stepType === 'story' ? '本地图片/视频路径（必填）' : '本地图片/视频路径（可选）'
              }
            />
          </label>
        )}
      </div>
      <Chk
        className="mb-3"
        label="完毕后关闭蓝蝶窗口"
        checked={closeWindowOnFinish}
        disabled={busy}
        onChange={setCloseWindowOnFinish}
      />
      {error && (
        <p className={`${UI_DANGER_TEXT} mb-3`} role="alert">
          {error}
        </p>
      )}
      <footer className="flex justify-end gap-2 border-t border-[var(--line)] pt-3">
        <Btn sm={false} disabled={busy} onClick={p.onClose}>
          取消
        </Btn>
        <Btn v="primary" sm={false} disabled={busy} onClick={submit}>
          {busy ? '启动中…' : '开始执行'}
        </Btn>
      </footer>
    </dialog>
  );
}
