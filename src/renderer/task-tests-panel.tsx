import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskCapabilities, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { taskTestModules, TaskTestRequest, type TestRequest } from '../shared/task-tests.js';
import { api } from './api.js';
import { taskReasonDescription } from './task-alerts.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { IconMinus, IconPlus } from './icons.js';
import { MAX_CONCURRENT_PROFILES } from '../shared/task-capacity.js';

type BrowseModule = TestRequest['module'];
const concurrencyLimit = MAX_CONCURRENT_PROFILES;
// Home toolbar: sub-task test entries and the single global concurrency control.
export function TaskTestsPanel({
  profiles,
  selected,
  runtime,
  capabilities,
  busy,
  onRefresh,
  onConfigure,
  notify,
}: {
  profiles: Profile[];
  selected: ReadonlySet<string>;
  runtime: z.infer<typeof TaskRuntimeOverview> | null;
  capabilities: z.infer<typeof TaskCapabilities> | null;
  busy: boolean;
  onRefresh: () => void;
  onConfigure: (destination: 'post' | 'story') => void;
  notify: (message: string) => void;
}) {
  const [module, setModule] = useState<{ id: BrowseModule; ids: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingLimit, setPendingLimit] = useState<number | null>(null);
  const [limitText, setLimitText] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);
  const savingLimit = useRef(false);
  const cancelLimitEdit = useRef(false);
  const current = runtime?.settings.maxConcurrentProfiles ?? null;
  const shown = pendingLimit ?? current;
  const enteredLimit = Number(limitText);
  const controlLimit =
    editingLimit && /^\d+$/.test(limitText) && enteredLimit >= 1 && enteredLimit <= concurrencyLimit
      ? enteredLimit
      : shown;
  function adjustLimit(delta: number) {
    if (controlLimit === null) return;
    setEditingLimit(false);
    setLimitText(String(controlLimit + delta));
    void saveLimit(controlLimit + delta);
  }
  useEffect(() => {
    if (!editingLimit) setLimitText(shown === null ? '' : String(shown));
  }, [shown, editingLimit]);
  useEffect(() => {
    if (pendingLimit === current) setPendingLimit(null);
  }, [current, pendingLimit]);
  async function saveLimit(value: number) {
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > concurrencyLimit ||
      savingLimit.current ||
      busy
    )
      return;
    if (value === current && pendingLimit === null) return;
    savingLimit.current = true;
    setPendingLimit(value);
    setSaving(true);
    try {
      const saved = await api.saveTaskSettings(
        { maxConcurrentProfiles: value },
        AbortSignal.timeout(10000),
      );
      setPendingLimit(saved.maxConcurrentProfiles);
      onRefresh();
    } catch (error) {
      setPendingLimit(null);
      setLimitText(current === null ? '' : String(current));
      notify(error instanceof Error ? error.message : '并发设置保存失败');
    } finally {
      setSaving(false);
      savingLimit.current = false;
    }
  }
  function commitLimit() {
    setEditingLimit(false);
    if (cancelLimitEdit.current) {
      cancelLimitEdit.current = false;
      setLimitText(shown === null ? '' : String(shown));
      return;
    }
    const value = Number(limitText);
    if (
      !/^\d+$/.test(limitText) ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > concurrencyLimit
    ) {
      setLimitText(shown === null ? '' : String(shown));
      notify(`请输入1–${concurrencyLimit}之间的整数`);
      return;
    }
    setLimitText(String(value));
    void saveLimit(value);
  }
  return (
    <section className="home-toolbar" aria-label="子任务测试与并发">
      <div className="toolbar-group">
        <span className="toolbar-label">子任务测试</span>
        <div className="chip-row">
          {taskTestModules.map((item) => {
            const configure = item.id === 'post' || item.id === 'story';
            const ready = configure || (!!item.type && !!capabilities?.types.includes(item.type));
            return (
              <button
                key={item.id}
                className={'chip type-' + item.id + (ready ? '' : ' is-pending')}
                disabled={busy || saving}
                title={
                  configure
                    ? item.detail + '（新建一个组合进行配置）'
                    : ready
                      ? item.detail + '（对左侧已选浏览器执行一次）'
                      : item.detail + '（尚未接通）'
                }
                onClick={() => {
                  if (configure) {
                    onConfigure(item.id);
                    return;
                  }
                  if (!ready) {
                    notify(item.detail + ' 该入口尚不能执行；浏览任务可独立测试。');
                    return;
                  }
                  if (!selected.size) {
                    notify('请先在左侧勾选至少一个浏览器。');
                    return;
                  }
                  setModule({ id: item.id, ids: [...selected].sort() });
                }}
              >
                <i className={'type-dot type-' + (item.type ?? 'post')} />
                {item.name}
              </button>
            );
          })}
        </div>
      </div>
      <div
        className="toolbar-group stepper-group"
        title="同时执行任务的浏览器数量，其余排队等待；调低不会强停正在执行的任务"
      >
        <span className="toolbar-label">同时运行</span>
        <div className="stepper" aria-label="并发数">
          <button
            className="btn btn-icon"
            aria-label="减少并发"
            disabled={busy || saving || !controlLimit || controlLimit <= 1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => adjustLimit(-1)}
          >
            <IconMinus size={14} />
          </button>
          <input
            aria-label="同时运行数量"
            title={`可直接输入1–${concurrencyLimit}；回车或离开输入框保存`}
            type="number"
            inputMode="numeric"
            min={1}
            max={concurrencyLimit}
            step={1}
            value={limitText}
            placeholder="–"
            disabled={busy || saving || current === null}
            onFocus={() => setEditingLimit(true)}
            onChange={(event) => setLimitText(event.currentTarget.value)}
            onBlur={commitLimit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelLimitEdit.current = true;
                event.currentTarget.blur();
              }
            }}
          />
          <button
            className="btn btn-icon"
            aria-label="增加并发"
            disabled={busy || saving || !controlLimit || controlLimit >= concurrencyLimit}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => adjustLimit(1)}
          >
            <IconPlus size={14} />
          </button>
        </div>
        <span className="toolbar-unit">个浏览器</span>
      </div>
      {module && (
        <TaskTestDialog
          key={module.id}
          module={module.id}
          count={module.ids.length}
          onClose={() => setModule(null)}
          onSubmit={async (options) => {
            const result = await api.testTask({ ...options, profileIds: module.ids });
            const rejected = result.rejected
              .map(
                (row) =>
                  (profiles.find((p) => p.id === row.profileId)?.browserName ??
                    profiles.find((p) => p.id === row.profileId)?.alias ??
                    '浏览器') +
                  '：' +
                  (taskReasonDescription(row.reason)?.summary ?? row.reason),
              )
              .join('；');
            notify(
              `已分配 ${result.plans.length} 份，${result.rejected.length} 份未开始。` +
                (rejected ? rejected + '。' : '') +
                '进度见任务记录。',
            );
            onRefresh();
          }}
        />
      )}
    </section>
  );
}
// Moved from the old test panel into the ☰ maintenance section; logic unchanged.
export function ReleaseIdlePanel({
  profiles,
  selected,
  runtime,
  busy,
  onRefresh,
}: {
  profiles: Profile[];
  selected: ReadonlySet<string>;
  runtime: z.infer<typeof TaskRuntimeOverview> | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const [releaseIds, setReleaseIds] = useState<string[] | null>(null);
  const [notice, setNotice] = useState('');
  const live =
    runtime?.plans.filter(
      (plan) =>
        selected.has(plan.profileId) && !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state),
    ) ?? [];
  return (
    <div className="menu-panel">
      <p className="muted">
        对左侧已选的 {selected.size}{' '}
        个浏览器：确认控制停止后，结束没有关联软件任务的历史测试尝试，并解除检查页占用。
      </p>
      <button
        className="btn"
        disabled={busy || !selected.size}
        onClick={() => {
          if (live.length) {
            setNotice('请先停止所选浏览器的任务，再结束遗留占用。');
            return;
          }
          setNotice('');
          setReleaseIds([...selected]);
        }}
      >
        结束遗留占用
      </button>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {releaseIds && (
        <ConfirmDialog
          title="结束遗留占用"
          description="确认控制停止后，结束没有关联软件任务的历史测试尝试，并解除检查页占用。旧记录和未知结果保留，不重发内容，不关闭你的其他页面；有关联任务的操作仍从原任务记录处理。"
          label="确认结束占用"
          onClose={() => setReleaseIds(null)}
          onConfirm={async () => {
            const results = await Promise.all(
              releaseIds.map(async (id) => {
                try {
                  const result = await api.releaseIdlePages(id);
                  return {
                    id,
                    ok: true,
                    count: result.released,
                    ended: result.endedOperations,
                    reason: '',
                  };
                } catch (error) {
                  return {
                    id,
                    ok: false,
                    count: 0,
                    ended: 0,
                    reason: error instanceof Error ? error.message : '处理失败',
                  };
                }
              }),
            );
            const failures = results.filter((r) => !r.ok);
            setNotice(
              `已恢复 ${results.filter((r) => r.ok).length} 份，结束 ${results.reduce((n, r) => n + r.ended, 0)} 条历史尝试，解除 ${results.reduce((n, r) => n + r.count, 0)} 个页面占用。` +
                failures
                  .map(
                    (r) => `${profiles.find((p) => p.id === r.id)?.alias ?? '浏览器'}：${r.reason}`,
                  )
                  .join('；'),
            );
            onRefresh();
          }}
        />
      )}
    </div>
  );
}
function TaskTestDialog({
  module,
  count,
  onSubmit,
  onClose,
}: {
  module: BrowseModule;
  count: number;
  onSubmit: (value: Omit<TestRequest, 'profileIds'>) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const [minutes, setMinutes] = useState(module === 'friends' ? '15' : '1'),
    [maxLikes, setMaxLikes] = useState('0'),
    [minLikeCount, setMinLikeCount] = useState('0'),
    [likeProbability, setLikeProbability] = useState('35'),
    [includeKeywords, setIncludeKeywords] = useState(''),
    [excludeKeywords, setExcludeKeywords] = useState(''),
    [skipSponsored, setSkipSponsored] = useState(true),
    [acceptMode, setAcceptMode] = useState<'count' | 'all'>('count'),
    [maxAccepts, setMaxAccepts] = useState('2'),
    [keyword, setKeyword] = useState(''),
    [category, setCategory] = useState(''),
    [minimum, setMinimum] = useState(''),
    [maximum, setMaximum] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit() {
    if (busy) return;
    const likesNum =
      module === 'feed' || module === 'video' ? Math.max(0, Number(maxLikes) || 0) : 0;
    const options = {
      module,
      durationMinutes: Number(minutes),
      ...(module === 'feed' || module === 'video'
        ? {
            maxLikes: likesNum,
            minLikeCount: likesNum > 0 ? Math.max(0, Number(minLikeCount) || 0) : 0,
            ...(likesNum > 0
              ? {
                  likeProbability: Math.max(
                    1,
                    Math.min(100, Math.round(Number(likeProbability) || 35)),
                  ),
                  ...(includeKeywords.trim() ? { includeKeywords: includeKeywords.trim() } : {}),
                  ...(excludeKeywords.trim() ? { excludeKeywords: excludeKeywords.trim() } : {}),
                  skipSponsored,
                }
              : {}),
          }
        : {}),
      ...(module === 'friends'
        ? {
            acceptMode,
            maxAccepts: acceptMode === 'count' ? Number(maxAccepts) : 500,
          }
        : {}),
      keyword,
      ...(category.trim() ? { categoryId: category.trim() } : {}),
      ...(minimum !== '' ? { minPrice: Number(minimum) } : {}),
      ...(maximum !== '' ? { maxPrice: Number(maximum) } : {}),
    };
    const key = JSON.stringify(options);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    const parsed = TaskTestRequest.safeParse({
      ...options,
      requestId: pending.current?.id,
      profileIds: ['00000000-0000-4000-8000-000000000001'],
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '参数不正确');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { profileIds: _ids, ...value } = parsed.data;
      await onSubmit(value);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '测试未启动，请重试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="name-dialog test-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h3>{taskTestModules.find((item) => item.id === module)?.name}</h3>
      <p>本次固定选择 {count} 份浏览器；每份执行一次。</p>
      {module === 'friends' ? (
        <>
          <label>
            接受方式
            <select
              aria-label="好友请求接受方式"
              value={acceptMode}
              disabled={busy}
              onChange={(e) => setAcceptMode(e.target.value === 'all' ? 'all' : 'count')}
            >
              <option value="count">指定数量</option>
              <option value="all">全部接受</option>
            </select>
          </label>
          {acceptMode === 'count' && (
            <label>
              接受数量（个）
              <input
                aria-label="好友请求接受数量"
                type="number"
                min="1"
                max="500"
                value={maxAccepts}
                disabled={busy}
                onChange={(e) => setMaxAccepts(e.target.value)}
              />
            </label>
          )}
          <label>
            最长等待时长（分钟）
            <input
              aria-label="单项测试时长"
              type="number"
              min="1"
              max="240"
              value={minutes}
              disabled={busy}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
        </>
      ) : (
        <label>
          浏览时长（分钟）
          <input
            aria-label="单项测试时长"
            type="number"
            min="1"
            max="240"
            value={minutes}
            disabled={busy}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
      )}
      {(module === 'feed' || module === 'video') && (
        <>
          <div className="schedule-times">
            <label>
              随机点赞上限（0 为不点赞）
              <input
                type="number"
                min="0"
                max="100"
                value={maxLikes}
                disabled={busy}
                onChange={(e) => setMaxLikes(e.target.value)}
              />
            </label>
            {Number(maxLikes) > 0 && (
              <label>
                触发概率 (%)
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={likeProbability}
                  disabled={busy}
                  onChange={(e) => setLikeProbability(e.target.value)}
                />
              </label>
            )}
          </div>
          {Number(maxLikes) > 0 && (
            <>
              <label>
                目标最低点赞量（赞）
                <input
                  type="number"
                  min="0"
                  value={minLikeCount}
                  disabled={busy}
                  onChange={(e) => setMinLikeCount(e.target.value)}
                />
              </label>
              <label>
                包含关键词（可选，逗号分隔）
                <input
                  value={includeKeywords}
                  disabled={busy}
                  placeholder="留空不限"
                  onChange={(e) => setIncludeKeywords(e.target.value)}
                />
              </label>
              <label>
                排除关键词（可选，逗号分隔）
                <input
                  value={excludeKeywords}
                  disabled={busy}
                  placeholder="遇到含这些词的内容不点赞"
                  onChange={(e) => setExcludeKeywords(e.target.value)}
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={skipSponsored}
                  disabled={busy}
                  onChange={(e) => setSkipSponsored(e.target.checked)}
                />
                自动跳过赞助 / 广告内容
              </label>
            </>
          )}
        </>
      )}
      {module === 'marketplace' && (
        <>
          <label>
            关键词（可选）
            <input value={keyword} disabled={busy} onChange={(e) => setKeyword(e.target.value)} />
          </label>
          <label>
            分类 ID（可选）
            <input value={category} disabled={busy} onChange={(e) => setCategory(e.target.value)} />
          </label>
          <div className="schedule-times">
            <label>
              最低价
              <input
                type="number"
                min="0"
                step="0.01"
                value={minimum}
                disabled={busy}
                onChange={(e) => setMinimum(e.target.value)}
              />
            </label>
            <label>
              最高价
              <input
                type="number"
                min="0"
                step="0.01"
                value={maximum}
                disabled={busy}
                onChange={(e) => setMaximum(e.target.value)}
              />
            </label>
          </div>
        </>
      )}
      <p className="field-hint">
        {module === 'friends'
          ? '请保持浏览器窗口可见。系统将进入 /friends/requests 页面并按随机间隔确认好友申请；当达到数量或无待处理请求时自动结束。'
          : Number(maxLikes) > 0 && (module === 'feed' || module === 'video')
            ? '请保持浏览器窗口可见。浏览期间将按筛选条件与概率自动随机点赞；页面加载和视频缓冲不计入有效时间。'
            : '请保持浏览器窗口可见。页面加载和视频缓冲不计入有效时间。'}
      </p>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在启动…' : '开始测试'}
        </button>
      </footer>
    </dialog>
  );
}
