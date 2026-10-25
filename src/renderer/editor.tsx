import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  CombinationDraftSchema,
  CombinationSchema,
  type Combination,
  type SavedCombination,
  type Step,
  type Profile,
} from '../shared/contracts.js';
import { api } from './api.js';
import { DraftSession } from './draft-session.js';
import { MaterialPreflight } from './material-preflight.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';

import { marketplaceCategories } from '../shared/marketplace-categories.js';
const stepNames = {
  video: '浏览 Reels',
  feed: '浏览首页',
  post: '随机发帖',
  marketplace: '浏览商城',
  friends: '接受好友请求',
};
export interface EditorHandle {
  persist(): Promise<boolean>;
}
function newPostStep(id: string, destination: 'post' | 'story' = 'post'): Step {
  return {
    id,
    type: 'post',
    destination,
    ...(destination === 'story' ? { audience: 'friends' as const } : {}),
    count: 1,
    resourceDirectory: '',
    resourceMode: 'table',
    allowRepeat: false,
    forbidSameAccountRepeat: true,
    archivePublished: false,
  };
}
export function newCombination(destination?: 'post' | 'story'): Combination {
  return {
    name:
      destination === 'story' ? '新快拍组合' : destination === 'post' ? '新发帖组合' : '新任务组合',
    note: '',
    steps: destination
      ? [newPostStep(crypto.randomUUID(), destination)]
      : [
          {
            id: crypto.randomUUID(),
            type: 'video',
            durationMinutes: 15,
            maxLikes: 0,
            minLikeCount: 500,
          },
        ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  };
}
export function Editor({
  initial,
  onSaved,
  onClose,
  notify,
  ref,
  selectedProfiles,
  onResources,
  resourceUsage,
  resourceUsageLoaded,
}: {
  initial: SavedCombination;
  onSaved: () => Promise<void>;
  onClose: () => void;
  notify: (message: string) => void;
  ref?: Ref<EditorHandle>;
  selectedProfiles: Profile[];
  onResources: () => void;
  resourceUsage: ResourceUsageSummaryValue | null;
  resourceUsageLoaded: boolean;
}) {
  const [value, setValue] = useState<Combination>(
    initial?.draft ?? initial?.saved ?? newCombination(),
  );
  const [revision, setRevision] = useState(initial.revision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoSaveFailed, setAutoSaveFailed] = useState(false);
  const [manualSaveRequired, setManualSaveRequired] = useState(false);
  const [recoveryConflict, setRecoveryConflict] = useState<SavedCombination | null>(null);
  const generation = useRef(0);
  const dirtyRef = useRef(false);
  const saving = useRef(false);
  const session = useRef(
    new DraftSession(
      initial.id,
      initial.revision,
      api.draft,
      initial.draft ?? initial.saved ?? undefined,
      async () => {
        const row = (await api.snapshot()).combinations.find((item) => item.id === initial.id);
        if (!row) throw Error('组合已不存在，当前编辑仍保留');
        return row;
      },
    ),
  );
  async function recoverDraft(choice?: 'local' | 'remote') {
    if (saving.current) return;
    saving.current = true;
    const recoveringGeneration = generation.current;
    setBusy(true);
    try {
      const row = (await api.snapshot()).combinations.find((item) => item.id === initial.id);
      if (!row) throw Error('组合已不存在，当前编辑仍保留');
      if (choice === 'remote' && generation.current !== recoveringGeneration)
        throw Error('读取期间编辑内容已变化，当前编辑保留，请重新选择');
      if (choice && recoveryConflict?.revision !== row.revision) {
        setRecoveryConflict(row);
        throw Error('已保存内容再次变化，请重新选择');
      }
      if (!(await session.current.recover(row, !!choice))) {
        setRecoveryConflict(row);
        notify('已保存内容与本地版本不同，当前编辑仍保留，请选择如何恢复');
        return;
      }
      setRevision(row.revision);
      setRecoveryConflict(null);
      setAutoSaveFailed(false);
      setManualSaveRequired(choice !== 'remote');
      if (choice === 'remote') {
        generation.current++;
        setValue(row.draft ?? row.saved ?? newCombination());
        dirtyRef.current = false;
        setDirty(false);
      }
      // Recovery reads and rebases only; the user's next save remains an explicit CAS write.
      notify(choice === 'remote' ? '已载入保存内容' : '已核对保存状态，当前编辑保留，可以再次保存');
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存状态读取失败，当前编辑保留');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function change(next: Combination) {
    generation.current++;
    setValue(next);
    setAutoSaveFailed(false);
    setDirty(true);
    dirtyRef.current = true;
  }
  function stepChange(id: string, patch: Partial<Step>) {
    change({
      ...value,
      steps: value.steps.map((step) => (step.id === id ? ({ ...step, ...patch } as Step) : step)),
    });
  }
  function add(type: Step['type'], destination?: 'post' | 'story') {
    const id = crypto.randomUUID();
    const step: Step =
      type === 'post'
        ? newPostStep(id, destination)
        : type === 'friends'
          ? {
              id,
              type: 'friends',
              durationMinutes: 15,
              acceptMode: 'count',
              maxAccepts: 5,
              maxLikes: 0,
              minLikeCount: 0,
            }
          : type === 'marketplace'
            ? {
                id,
                type,
                durationMinutes: 4,
                keyword: '',
                maxLikes: 0,
                minLikeCount: 0,
              }
            : {
                id,
                type,
                durationMinutes: type === 'video' ? 15 : 4,
                maxLikes: 0,
                minLikeCount: type === 'video' ? 500 : 200,
              };
    change({ ...value, steps: [...value.steps, step] });
  }
  function move(index: number, offset: number) {
    const steps = [...value.steps];
    const source = steps[index],
      target = steps[index + offset];
    if (!source || !target) return;
    steps[index + offset] = source;
    steps[index] = target;
    change({ ...value, steps });
  }
  async function save(publish: boolean) {
    if (saving.current) return;
    saving.current = true;
    const savingGeneration = generation.current;
    setBusy(true);
    try {
      const parsed = (publish ? CombinationSchema : CombinationDraftSchema).safeParse(value);
      if (!parsed.success)
        throw Error(parsed.error.issues.map((issue) => issue.message).join('；'));
      const draft = dirtyRef.current ? await session.current.write(parsed.data) : { revision };
      const saved = publish ? await api.publish(initial.id, draft.revision) : draft;
      if (publish) session.current.acceptPublishedRevision(saved.revision);
      setRevision(saved.revision);
      if (generation.current === savingGeneration) {
        setDirty(false);
        dirtyRef.current = false;
      }
      setAutoSaveFailed(false);
      setManualSaveRequired(false);
      await onSaved();
      notify(publish ? '组合已保存为新版本' : '草稿已保存，启动仍使用已保存版本');
      if (publish) onClose();
    } catch (error) {
      setAutoSaveFailed(true);
      notify(error instanceof Error ? error.message : '保存失败');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function persist() {
    if (!dirtyRef.current) return true;
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    const savingGeneration = generation.current;
    try {
      const draft = CombinationDraftSchema.parse(value);
      const saved = await session.current.write(draft);
      setRevision(saved.revision);
      if (generation.current === savingGeneration) {
        setDirty(false);
        dirtyRef.current = false;
      }
      await onSaved();
      return generation.current === savingGeneration;
    } catch (error) {
      setAutoSaveFailed(true);
      notify(
        '草稿未保存，请保留当前编辑：' + (error instanceof Error ? error.message : '保存失败'),
      );
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({ persist }));
  useEffect(() => {
    if (!dirty || busy || autoSaveFailed || manualSaveRequired) return;
    const timer = setTimeout(() => void save(false), 800);
    return () => clearTimeout(timer);
  }, [value, dirty, busy, autoSaveFailed, manualSaveRequired]);
  return (
    <section className="editor">
      <div className="page-heading">
        <div>
          <button className="back" onClick={onClose}>
            ← 任务组合
          </button>
          <h2>{initial.saved ? '编辑任务组合' : '新建任务组合'}</h2>
        </div>
        <span className="version">
          {initial.saved ? '已保存 v' + initial.version : '新组合草稿'}
          {dirty ? ' · 未保存' : ''}
        </span>
      </div>
      {autoSaveFailed && (
        <div className="error-note draft-recovery" role="alert">
          <span>保存尚未确认，当前编辑保留。</span>
          <button disabled={busy} onClick={() => void recoverDraft()}>
            核对保存状态
          </button>
          {recoveryConflict && (
            <>
              <span>
                已保存：{(recoveryConflict.draft ?? recoveryConflict.saved)?.name || '未命名组合'}
                ，版本 {recoveryConflict.revision}
              </span>
              <button disabled={busy} onClick={() => void recoverDraft('local')}>
                保留当前编辑
              </button>
              <button disabled={busy} onClick={() => void recoverDraft('remote')}>
                载入已保存内容
              </button>
            </>
          )}
        </div>
      )}
      <div className="combination-fields">
        <label>
          名称
          <input
            maxLength={80}
            value={value.name}
            onChange={(event) => change({ ...value, name: event.target.value })}
          />
        </label>
        <label className="wide">
          备注
          <input
            maxLength={300}
            value={value.note}
            onChange={(event) => change({ ...value, note: event.target.value })}
            placeholder="说明这个组合的用途"
          />
        </label>
      </div>
      <div className="step-toolbar">
        <strong>
          子任务 <span>{value.steps.length}</span>
        </strong>
        <div>
          <button onClick={() => add('video')}>＋ 浏览 Reels</button>
          <button onClick={() => add('feed')}>＋ 浏览首页</button>
          <button onClick={() => add('marketplace')}>＋ 浏览商城</button>
          <button onClick={() => add('friends')}>＋ 接受好友请求</button>
          <button onClick={() => add('post', 'story')}>＋ 发布快拍</button>
          <button onClick={() => add('post')}>＋ 随机发帖</button>
        </div>
      </div>
      <div className="step-list">
        {value.steps.map((step, index) => (
          <article className={'step step-' + step.type} key={step.id}>
            <div className="step-heading">
              <span className="step-number">{index + 1}</span>
              <strong>
                {step.type === 'post' && step.destination === 'story'
                  ? '发布快拍'
                  : stepNames[step.type]}
              </strong>
              <div className="step-actions">
                <button disabled={index === 0} onClick={() => move(index, -1)} title="上移">
                  ↑
                </button>
                <button
                  disabled={index === value.steps.length - 1}
                  onClick={() => move(index, 1)}
                  title="下移"
                >
                  ↓
                </button>
                <button
                  onClick={() =>
                    change({
                      ...value,
                      steps: [
                        ...value.steps.slice(0, index + 1),
                        { ...step, id: crypto.randomUUID() },
                        ...value.steps.slice(index + 1),
                      ],
                    })
                  }
                >
                  复制
                </button>
                <button
                  className="text-danger"
                  onClick={() =>
                    change({ ...value, steps: value.steps.filter((item) => item.id !== step.id) })
                  }
                >
                  删除
                </button>
              </div>
            </div>
            {step.type === 'friends' ? (
              <div className="step-fields">
                <label>
                  接受方式
                  <select
                    value={step.acceptMode}
                    onChange={(event) =>
                      stepChange(step.id, {
                        acceptMode: event.target.value === 'all' ? 'all' : 'count',
                      })
                    }
                  >
                    <option value="count">指定数量</option>
                    <option value="all">全部接受</option>
                  </select>
                </label>
                {step.acceptMode === 'count' && (
                  <label>
                    接受数量
                    <div className="unit-field">
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={step.maxAccepts}
                        onChange={(event) =>
                          stepChange(step.id, { maxAccepts: Number(event.target.value) })
                        }
                      />
                      <span>个</span>
                    </div>
                  </label>
                )}
                <label>
                  最长执行时间
                  <div className="unit-field">
                    <input
                      type="number"
                      min={1}
                      max={240}
                      value={step.durationMinutes}
                      onChange={(event) =>
                        stepChange(step.id, { durationMinutes: Number(event.target.value) })
                      }
                    />
                    <span>分钟</span>
                  </div>
                </label>
                <small className="wide">
                  自动进入好友请求页面（/friends/requests），模仿人工随机间隔确认通过好友申请；达到指定数量或当前无待处理请求时自动完成。
                </small>
              </div>
            ) : step.type !== 'post' ? (
              <div className="step-fields">
                <label>
                  浏览时间
                  <div className="unit-field">
                    <input
                      type="number"
                      min={1}
                      max={240}
                      value={step.durationMinutes}
                      onChange={(event) =>
                        stepChange(step.id, { durationMinutes: Number(event.target.value) })
                      }
                    />
                    <span>分钟</span>
                  </div>
                </label>
                {step.type === 'marketplace' ? (
                  <>
                    <label>
                      搜索关键词
                      <input
                        maxLength={120}
                        value={step.keyword}
                        placeholder="留空浏览推荐商品"
                        onChange={(event) => stepChange(step.id, { keyword: event.target.value })}
                      />
                    </label>
                    <label>
                      商品分类
                      <select
                        value={step.categoryId ?? ''}
                        onChange={(event) =>
                          stepChange(step.id, { categoryId: event.target.value || undefined })
                        }
                      >
                        <option value="">全部分类</option>
                        {marketplaceCategories.map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(['minPrice', 'maxPrice'] as const).map((field) => (
                      <label key={field}>
                        {field === 'minPrice' ? '最低价格' : '最高价格'}
                        <input
                          type="number"
                          min={0}
                          max={1_000_000_000}
                          step="0.01"
                          placeholder="不限"
                          value={step[field] ?? ''}
                          onChange={(event) =>
                            stepChange(step.id, {
                              [field]:
                                event.target.value === '' ? undefined : Number(event.target.value),
                            })
                          }
                        />
                      </label>
                    ))}
                    <small className="wide">
                      浏览列表和商品详情；价格使用账号商城地区的货币。设置价格需选择分类或填写关键词。关键词、分类及价格筛选需要插件0.3.20，地区沿用账号当前设置。
                    </small>
                  </>
                ) : (
                  <>
                    <label className="check-label browse-like-toggle">
                      <input
                        type="checkbox"
                        checked={step.maxLikes > 0}
                        onChange={(e) =>
                          stepChange(step.id, {
                            maxLikes: e.target.checked ? step.maxLikes || 3 : 0,
                          })
                        }
                      />
                      开启随机点赞（浏览期间按条件自动点赞）
                    </label>
                    {step.maxLikes > 0 && (
                      <>
                        <label>
                          随机点赞上限
                          <div className="unit-field">
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={step.maxLikes}
                              onChange={(event) =>
                                stepChange(step.id, {
                                  maxLikes: Math.max(
                                    0,
                                    Math.min(100, Number(event.target.value) || 0),
                                  ),
                                })
                              }
                            />
                            <span>个</span>
                          </div>
                        </label>
                        <label>
                          目标点赞量至少
                          <div className="unit-field">
                            <input
                              type="number"
                              min={0}
                              value={step.minLikeCount}
                              disabled={step.maxLikes === 0}
                              onChange={(event) =>
                                stepChange(step.id, {
                                  minLikeCount: Math.max(0, Number(event.target.value) || 0),
                                })
                              }
                            />
                            <span>赞</span>
                          </div>
                        </label>

                        <label>
                          单帖触发概率
                          <div className="unit-field">
                            <input
                              type="number"
                              min={1}
                              max={100}
                              value={step.likeProbability ?? 35}
                              onChange={(event) =>
                                stepChange(step.id, {
                                  likeProbability: Math.max(
                                    1,
                                    Math.min(100, Math.round(Number(event.target.value) || 35)),
                                  ),
                                })
                              }
                            />
                            <span>%</span>
                          </div>
                        </label>
                        <label>
                          包含关键词（可选）
                          <input
                            maxLength={300}
                            value={step.includeKeywords ?? ''}
                            placeholder="多个词用逗号分隔，留空不限"
                            onChange={(event) =>
                              stepChange(step.id, {
                                includeKeywords: event.target.value || undefined,
                              })
                            }
                          />
                        </label>
                        <label>
                          排除关键词（可选）
                          <input
                            maxLength={300}
                            value={step.excludeKeywords ?? ''}
                            placeholder="遇到含这些词的内容不点赞"
                            onChange={(event) =>
                              stepChange(step.id, {
                                excludeKeywords: event.target.value || undefined,
                              })
                            }
                          />
                        </label>
                        <label className="check-label wide">
                          <input
                            type="checkbox"
                            checked={step.skipSponsored ?? true}
                            onChange={(event) =>
                              stepChange(step.id, { skipSponsored: event.target.checked })
                            }
                          />
                          自动跳过赞助 / 广告内容（Sponsored）
                        </label>
                      </>
                    )}
                    {step.maxLikes > 0 && (
                      <small className="wide">
                        浏览停留期间按点赞条件执行，达到上限后继续浏览至时间结束。
                      </small>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="post-fields">
                <div className="post-resource-field">
                  <label>
                    发帖素材
                    <select
                      aria-label="素材来源"
                      value={step.resourceMode ?? 'directory'}
                      onChange={(e) =>
                        stepChange(step.id, {
                          resourceMode: e.target.value === 'table' ? 'table' : 'directory',
                          resourceDirectory: '',
                        })
                      }
                    >
                      <option value="table">组合资源表</option>
                      <option value="directory">原素材目录</option>
                    </select>
                  </label>
                  {step.resourceMode === 'table' ? (
                    <button className="resource-settings-button" onClick={onResources}>
                      📋 设置发帖资源…（可用{' '}
                      {resourceUsageLoaded ? (resourceUsage?.remaining ?? 0) : '…'} 条）
                    </button>
                  ) : (
                    <label>
                      资源目录
                      <input
                        value={step.resourceDirectory}
                        placeholder="选择素材目录"
                        onChange={(e) => stepChange(step.id, { resourceDirectory: e.target.value })}
                      />
                      {window.workbenchDesktop && (
                        <button
                          onClick={() =>
                            void window.workbenchDesktop
                              ?.chooseMaterialDirectory()
                              .then((directory) => {
                                if (directory)
                                  stepChange(step.id, { resourceDirectory: directory });
                              })
                              .catch((error: unknown) =>
                                notify(error instanceof Error ? error.message : '目录选择失败'),
                              )
                          }
                        >
                          选择目录…
                        </button>
                      )}
                    </label>
                  )}
                </div>
                <label>
                  {step.destination === 'story' ? '每个账号快拍数' : '每个账号发帖数'}
                  <div className="unit-field">
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={step.count}
                      onChange={(e) => stepChange(step.id, { count: Number(e.target.value) })}
                    />
                    <span>条</span>
                  </div>
                </label>
                <label>
                  分享范围
                  <select
                    value={step.audience ?? 'preserve-current'}
                    onChange={(event) =>
                      stepChange(step.id, {
                        audience:
                          event.target.value === 'self'
                            ? 'self'
                            : event.target.value === 'friends'
                              ? 'friends'
                              : 'preserve-current',
                      })
                    }
                  >
                    <option value="preserve-current">保持 Facebook 当前范围</option>
                    <option value="self" disabled={step.destination === 'story'}>
                      {step.destination === 'story' ? '仅自己（快拍不支持）' : '仅自己'}
                    </option>
                    <option value="friends" disabled={step.destination !== 'story'}>
                      {step.destination === 'story' ? '好友' : '好友（仅快拍）'}
                    </option>
                  </select>
                </label>
                {step.destination !== 'story' && step.resourceMode !== 'table' && (
                  <label>
                    AI 声明
                    <select
                      aria-label="AI 声明"
                      value={step.aiLabel ?? 'preserve-current'}
                      onChange={(event) =>
                        stepChange(step.id, {
                          aiLabel:
                            event.target.value === 'on'
                              ? 'on'
                              : event.target.value === 'off'
                                ? 'off'
                                : 'preserve-current',
                        })
                      }
                    >
                      <option value="preserve-current">保持 Facebook 当前设置</option>
                      <option value="on">开启</option>
                      <option value="off">关闭</option>
                    </select>
                  </label>
                )}
                <p className="field-hint">
                  默认跳过已使用资源 ·
                  原文件位置不变。勾选允许重复，或在设置中清空使用记录后可再次使用。
                </p>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={step.allowRepeat}
                    onChange={(event) => stepChange(step.id, { allowRepeat: event.target.checked })}
                  />
                  允许重复使用素材（包括同一账号）
                </label>
                <p className="field-hint">
                  {step.destination === 'story'
                    ? '仅领取用途为快拍或两者通用的资源。每行一条快拍；多张图片请分行。'
                    : '仅领取用途为帖子或两者通用的资源。'}
                </p>
                {step.resourceMode !== 'table' && (
                  <MaterialPreflight
                    directory={step.resourceDirectory}
                    selectedProfiles={selectedProfiles}
                    count={step.count}
                    allowRepeat={step.allowRepeat}
                  />
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="loop-fields">
        <label className="check-label">
          <input
            type="checkbox"
            checked={value.randomOrder}
            onChange={(event) => change({ ...value, randomOrder: event.target.checked })}
          />
          每轮随机子任务顺序
        </label>
        <label>
          循环
          <select
            value={value.loop.mode}
            onChange={(event) =>
              change({
                ...value,
                loop:
                  event.target.value === 'finite'
                    ? { mode: 'finite', rounds: 1 }
                    : { mode: 'until-stopped' },
              })
            }
          >
            <option value="finite">指定总轮数</option>
            <option value="until-stopped">直到手动停止</option>
          </select>
        </label>
        {value.loop.mode === 'finite' && (
          <label>
            总轮数
            <input
              type="number"
              min={1}
              max={10000}
              value={value.loop.rounds}
              onChange={(event) =>
                change({ ...value, loop: { mode: 'finite', rounds: Number(event.target.value) } })
              }
            />
          </label>
        )}
      </div>
      <footer className="editor-footer">
        <span>返回自动保存草稿；运行任务使用保存版本。</span>
        <div>
          <button disabled={busy} onClick={onClose}>
            返回
          </button>
          <button
            className="primary"
            disabled={busy || !!recoveryConflict}
            onClick={() => void save(true)}
          >
            {busy ? '保存中…' : '保存组合'}
          </button>
        </div>
      </footer>
    </section>
  );
}
