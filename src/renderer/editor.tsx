import { useEffect, useRef, useState } from 'react';
import {
  CombinationSchema,
  type Combination,
  type Profile,
  type SavedCombination,
  type Step,
} from '../shared/contracts.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import { bluestacksStepSupport } from './active-quick-step-dialogs.js';
import { api } from './api.js';
import {
  newCombination,
  newPostStep,
  normalizeCombinationResources,
} from './modules/module-contracts.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { Btn, Chk, InFld, errMsg } from './modules/shared/module-ui.js';
import { StepConfigFields } from './step-config-fields.js';
import {
  UI_CARD,
  UI_COUNT_CHIP,
  UI_HINT,
  UI_INPUT,
  UI_ROW,
  UI_UNIT_FIELD,
} from './ui/primitives.js';
export { newCombination, normalizeCombinationResources };
const normalizeForEditor = (v: Combination): Combination => normalizeCombinationResources(v);
const FEED_LABELS: Record<string, string> = {
  random_profile: '逛他人时间线',
  random_page: '逛公共专页',
  search_pages: '搜专页逛时间线',
  home: '浏览首页',
};
const stepHeadingLabel = (step: Step) =>
  step.type === 'post'
    ? step.destination === 'story'
      ? '发布快拍'
      : '随机发帖'
    : step.type === 'friends'
      ? step.friendAction === 'add_suggested'
        ? '加推荐好友'
        : '接受好友请求'
      : step.type === 'marketplace'
        ? '浏览商城'
        : step.type === 'video'
          ? '浏览 Reels'
          : (FEED_LABELS[step.feedMode ?? 'home'] ?? '浏览首页');
const STEP_BORDER_TONE: Record<Step['type'], string> = {
  feed: 'border-l-emerald-500',
  video: 'border-l-violet-500',
  marketplace: 'border-l-amber-500',
  friends: 'border-l-sky-500',
  post: 'border-l-pink-500',
};
const STEP_PRESETS: ReadonlyArray<[string, (id: string) => Step]> = [
  [
    '浏览 Reels',
    (id) => ({ id, type: 'video', durationMinutes: 15, maxLikes: 0, minLikeCount: 500 }),
  ],
  ['浏览首页', (id) => ({ id, type: 'feed', durationMinutes: 4, maxLikes: 0, minLikeCount: 200 })],
  [
    '逛时间线 / 专页',
    (id) => ({
      id,
      type: 'feed',
      feedMode: 'random_profile',
      detourDwellSeconds: 25,
      durationMinutes: 5,
      maxLikes: 0,
      minLikeCount: 0,
    }),
  ],
  [
    '浏览商城',
    (id) => ({
      id,
      type: 'marketplace',
      durationMinutes: 4,
      keyword: '',
      maxLikes: 0,
      minLikeCount: 0,
    }),
  ],
  [
    '接受好友',
    (id) => ({
      id,
      type: 'friends',
      durationMinutes: 15,
      acceptMode: 'count',
      maxAccepts: 5,
      maxLikes: 0,
      minLikeCount: 0,
    }),
  ],
  [
    '加推荐好友',
    (id) => ({
      id,
      type: 'friends',
      friendAction: 'add_suggested',
      durationMinutes: 15,
      acceptMode: 'count',
      maxAccepts: 3,
      maxLikes: 0,
      minLikeCount: 0,
    }),
  ],
  ['发布快拍', (id) => newPostStep(id, 'story')],
  ['随机发帖', (id) => newPostStep(id, 'post')],
];
const BS_SUPPORTED_PRESETS = new Set(['浏览 Reels', '浏览首页', '浏览商城', '接受好友']);
export function Editor(p: {
  carrier?: 'browser' | 'bluestacks' | undefined;
  initial: SavedCombination | null;
  initialValue?: Combination | undefined;
  onCreated?: (created: SavedCombination) => void;
  onSaved: () => Promise<void>;
  onSavedAndStart?: (saved: SavedCombination) => Promise<void>;
  onClose: () => void;
  notify: (message: string) => void;
  selectedProfiles: Profile[];
  selectedTargetCount?: number | undefined;
  onResources: (row: SavedCombination) => void;
  resourceUsage: ResourceUsageSummaryValue | null;
  resourceUsageLoaded: boolean;
}) {
  const isBs = p.carrier === 'bluestacks';
  const rawInitial = p.initial?.saved ?? p.initialValue;
  const hadLegacyDirectoryMode = Boolean(
    rawInitial?.steps.some(
      (s) =>
        s.type === 'post' &&
        (s.resourceMode === 'directory' || Boolean(s.resourceDirectory.trim())),
    ),
  );
  const startTargetCount = isBs
    ? (p.selectedTargetCount ?? 0)
    : (p.selectedTargetCount ?? p.selectedProfiles.length);
  const [currentRow, setCurrentRow] = useState<SavedCombination | null>(p.initial);
  const currentRowRef = useRef<SavedCombination | null>(p.initial);
  currentRowRef.current = currentRow;
  const [value, setValue] = useState<Combination>(() =>
    normalizeForEditor(rawInitial ?? newCombination()),
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const [dirty, setDirty] = useState(hadLegacyDirectoryMode),
    [busy, setBusy] = useState(false),
    [libraryPages, setLibraryPages] = useState<BumperTarget[]>([]);
  const hasSearchPagesStep = value.steps.some(
    (s) => s.type === 'feed' && s.feedMode === 'search_pages',
  );
  useEffect(() => {
    if (!hasSearchPagesStep || libraryPages.length > 0) return;
    let alive = true;
    void api
      .bumperState()
      .then((s) => alive && setLibraryPages(s.pages ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hasSearchPagesStep, libraryPages.length]);
  const generation = useRef(0),
    saving = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || busy || saving.current) return;
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, p.onClose]);
  const change = (next: Combination | ((prev: Combination) => Combination)) => {
    generation.current++;
    setValue((prev) => {
      const resolved = normalizeForEditor(typeof next === 'function' ? next(prev) : next);
      valueRef.current = resolved;
      return resolved;
    });
    setDirty(true);
  };
  const move = (index: number, offset: number) =>
    change((prev) => {
      const steps = [...prev.steps],
        src = steps[index],
        dst = steps[index + offset];
      if (!src || !dst) return prev;
      steps[index + offset] = src;
      steps[index] = dst;
      return { ...prev, steps };
    });
  async function save(mode: 'save' | 'start' | 'resources') {
    if (mode === 'resources' && currentRowRef.current) return p.onResources(currentRowRef.current);
    if (saving.current) return;
    saving.current = true;
    const gen = generation.current;
    setBusy(true);
    let savedRow: SavedCombination | null = null;
    try {
      const parsed = CombinationSchema.safeParse(normalizeForEditor(valueRef.current));
      if (!parsed.success) throw Error(parsed.error.issues.map((i) => i.message).join('；'));
      const existing = currentRowRef.current;
      savedRow = existing
        ? await api.saveCombination(existing.id, existing.revision, parsed.data)
        : await api.create(parsed.data);
      if (!existing) p.onCreated?.(savedRow);
      currentRowRef.current = savedRow;
      setCurrentRow(savedRow);
      if (generation.current === gen) setDirty(false);
      await p.onSaved();
      if (mode === 'save') p.notify('已保存');
    } catch (err) {
      p.notify(errMsg(err, '保存失败'));
      savedRow = null;
    } finally {
      saving.current = false;
      setBusy(false);
    }
    if (!savedRow) return;
    if (mode === 'resources') return p.onResources(savedRow);
    if (mode === 'start' && p.onSavedAndStart) await p.onSavedAndStart(savedRow);
    p.onClose();
  }
  return (
    <section className="mx-auto flex max-w-[920px] flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col items-start gap-1">
          <Btn v="ghost" className="back -ml-2" onClick={p.onClose}>
            ← 任务组合
          </Btn>
          <h2 className="m-0 text-lg font-semibold text-slate-900">
            {currentRow ? '编辑组合' : '新建组合'}
          </h2>
        </div>
        {dirty && (
          <span className="inline-flex h-6 items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-800">
            未保存
          </span>
        )}
      </div>
      <div className="combination-fields mb-4 grid grid-cols-[minmax(180px,1fr)_minmax(220px,2fr)] gap-3 max-[640px]:grid-cols-1">
        <InFld
          label="名称"
          maxLength={80}
          className={`${UI_INPUT} w-full`}
          value={value.name}
          onVal={(name) => change((c) => ({ ...c, name }))}
        />
        <InFld
          label="备注"
          maxLength={300}
          className={`${UI_INPUT} w-full`}
          value={value.note}
          placeholder="可选"
          onVal={(note) => change((c) => ({ ...c, note }))}
        />
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 shadow-2xs">
        <div className={UI_ROW}>
          <strong className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
            <span>步骤</span>
            <span className={UI_COUNT_CHIP}>{value.steps.length}</span>
          </strong>
          {isBs && (
            <span className={UI_HINT}>
              与浏览器端共用组合库 · 蓝蝶支持首页 / Reels / 商城 / 接受好友
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STEP_PRESETS.filter(([label]) => !isBs || BS_SUPPORTED_PRESETS.has(label)).map(
            ([label, create]) => (
              <Btn
                key={label}
                onClick={() =>
                  change((prev) => ({
                    ...prev,
                    steps: [...prev.steps, create(crypto.randomUUID())],
                  }))
                }
              >
                ＋ {label}
              </Btn>
            ),
          )}
        </div>
      </div>
      {hadLegacyDirectoryMode && (
        <div
          role="status"
          className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900"
        >
          旧版「本地目录」发帖资源模式已下线，系统已自动切换为「组合资源表」模式；保存此组合后将完成迁移，请点击下方「管理资源」检查或导入发帖素材。
        </div>
      )}
      {!isBs && value.steps.some((s) => s.type === 'post') && (
        <div
          className={`${UI_CARD} mb-3 flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5`}
        >
          <strong className="text-[13px] font-semibold text-[var(--text)]">
            发帖 / 快拍资源表
          </strong>
          <Btn
            className="border-blue-200 bg-[var(--brand-soft)] font-semibold text-[var(--brand)] hover:not-disabled:bg-blue-100"
            disabled={busy}
            onClick={() => void save('resources')}
          >
            管理资源（可用 {p.resourceUsageLoaded ? (p.resourceUsage?.remaining ?? 0) : '…'} 条）
          </Btn>
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {value.steps.map((step, index) => (
          <article
            className={`rounded-xl border border-[var(--line)] border-l-[3px] ${STEP_BORDER_TONE[step.type]} bg-white p-3.5 shadow-2xs`}
            key={step.id}
          >
            <div className="mb-2.5 flex items-center gap-2">
              <span className="inline-grid h-[22px] min-w-[22px] place-content-center rounded-md bg-[var(--surface-3)] px-1.5 text-[11px] font-bold text-[var(--text-2)] tabular-nums">
                {index + 1}
              </span>
              <strong className="text-[13px] font-semibold text-[var(--text)]">
                {stepHeadingLabel(step)}
              </strong>
              {isBs && bluestacksStepSupport(step) !== 'supported' && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    bluestacksStepSupport(step) === 'unsupported'
                      ? 'bg-slate-100 text-slate-500'
                      : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  {bluestacksStepSupport(step) === 'unsupported'
                    ? '仅浏览器执行，蓝蝶将跳过'
                    : '蓝蝶按首页执行'}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <Btn
                  v="ghost"
                  className="px-2"
                  disabled={index === 0}
                  title="上移"
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Btn>
                <Btn
                  v="ghost"
                  className="px-2"
                  disabled={index === value.steps.length - 1}
                  title="下移"
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Btn>
                <Btn
                  v="ghost"
                  className="px-2"
                  onClick={() =>
                    change((prev) => {
                      const idx = prev.steps.findIndex((i) => i.id === step.id),
                        cur = prev.steps[idx];
                      return idx < 0 || !cur
                        ? prev
                        : {
                            ...prev,
                            steps: [
                              ...prev.steps.slice(0, idx + 1),
                              { ...structuredClone(cur), id: crypto.randomUUID() },
                              ...prev.steps.slice(idx + 1),
                            ],
                          };
                    })
                  }
                >
                  复制
                </Btn>
                <Btn
                  v="ghost"
                  className="px-2 text-rose-600 hover:not-disabled:bg-rose-50 hover:not-disabled:text-rose-700"
                  onClick={() =>
                    change((prev) => ({
                      ...prev,
                      steps: prev.steps.filter((i) => i.id !== step.id),
                    }))
                  }
                >
                  删除
                </Btn>
              </div>
            </div>
            <StepConfigFields
              carrier={p.carrier}
              step={step}
              libraryPages={libraryPages}
              disabled={busy}
              onChange={(patch) =>
                change((prev) => ({
                  ...prev,
                  steps: prev.steps.map((s) =>
                    s.id === step.id ? ({ ...s, ...patch } as Step) : s,
                  ),
                }))
              }
            />
          </article>
        ))}
      </div>
      <footer className="editor-footer sticky -bottom-8 -mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] bg-[#eef0f3]/90 px-6 py-3 backdrop-blur-sm max-[1080px]:-mx-3.5 max-[1080px]:px-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Chk
            label="随机执行顺序"
            checked={value.randomOrder}
            onChange={(randomOrder) => change((c) => ({ ...c, randomOrder }))}
          />
          <div
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--line)] bg-white p-0.5 text-xs"
            role="radiogroup"
            aria-label="循环模式"
          >
            {(
              [
                ['single', '单轮 (1次)', false],
                ['multi', '指定轮数', false],
                ['until-stopped', '持续循环', isBs],
              ] as const
            ).map(([modeKey, label, modeDisabled]) => {
              const activeMode =
                value.loop.mode === 'until-stopped'
                  ? 'until-stopped'
                  : value.loop.rounds > 1
                    ? 'multi'
                    : 'single';
              const active = activeMode === modeKey;
              return (
                <button
                  key={modeKey}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy || modeDisabled}
                  title={
                    modeDisabled
                      ? '蓝蝶模拟器暂不支持持续循环模式'
                      : modeKey === 'until-stopped'
                        ? '持续循环（直到手动停止）'
                        : undefined
                  }
                  className={`h-6 cursor-pointer rounded-md border-0 px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    active
                      ? 'bg-[var(--brand)] font-semibold text-white'
                      : 'bg-transparent text-[var(--text-2)] hover:bg-slate-100 hover:text-[var(--text)]'
                  }`}
                  onClick={() => {
                    if (modeKey === 'single')
                      change((c) => ({ ...c, loop: { mode: 'finite', rounds: 1 } }));
                    else if (modeKey === 'multi')
                      change((c) => ({
                        ...c,
                        loop: {
                          mode: 'finite',
                          rounds:
                            c.loop.mode === 'finite' && c.loop.rounds >= 2 ? c.loop.rounds : 2,
                        },
                      }));
                    else change((c) => ({ ...c, loop: { mode: 'until-stopped' } }));
                  }}
                >
                  {label}
                </button>
              );
            })}
            {value.loop.mode === 'finite' && value.loop.rounds > 1 && (
              <div className={`${UI_UNIT_FIELD} ml-0.5 h-6`}>
                <ControlledNumberInput
                  ariaLabel="循环轮数"
                  className="h-full w-11 border-0 bg-transparent px-1.5 text-center text-xs font-semibold tabular-nums text-[var(--text)] focus:outline-none"
                  min={2}
                  max={20}
                  debounceMs={0}
                  defaultValue={2}
                  value={value.loop.rounds}
                  disabled={busy}
                  onChange={(rounds) => change((c) => ({ ...c, loop: { mode: 'finite', rounds } }))}
                />
                <span className="border-l border-[var(--line)] bg-slate-50 px-1.5 text-[11px] leading-6 font-medium text-[var(--text-3)] select-none">
                  轮
                </span>
              </div>
            )}
          </div>
          {value.loop.mode === 'until-stopped' && <span className={UI_HINT}>直到手动停止</span>}
        </div>
        <div className="flex items-center gap-2">
          <Btn sm={false} disabled={busy} onClick={p.onClose}>
            返回
          </Btn>
          <Btn v="primary" sm={false} disabled={busy} onClick={() => void save('save')}>
            {busy ? '保存中…' : '保存组合'}
          </Btn>
          {p.onSavedAndStart && startTargetCount > 0 && (
            <Btn v="primary" sm={false} disabled={busy} onClick={() => void save('start')}>
              {busy ? '处理中…' : `保存并启动 (${startTargetCount})`}
            </Btn>
          )}
        </div>
      </footer>
    </section>
  );
}
