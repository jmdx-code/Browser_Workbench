import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskCapabilities, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { taskTestModules, TaskTestRequest, type TestRequest } from '../shared/task-tests.js';
import { api } from './api.js';
import { taskReasonDescription } from './task-alerts.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';

type BrowseModule = TestRequest['module'];
// Home toolbar: sub-task test entries (concurrency unified into WorkbenchTopbar).
export function TaskTestsPanel({
  profiles,
  selected,
  capabilities,
  busy,
  onRefresh,
  onConfigure,
  notify,
}: {
  profiles: Profile[];
  selected: ReadonlySet<string>;
  runtime?: z.infer<typeof TaskRuntimeOverview> | null;
  capabilities: z.infer<typeof TaskCapabilities> | null;
  busy: boolean;
  onRefresh: () => void;
  onConfigure: (destination: 'post' | 'story') => void;
  notify: (message: string) => void;
}) {
  const [module, setModule] = useState<{ id: BrowseModule; ids: string[] } | null>(null);
  return (
    <section className="home-toolbar" aria-label="快速单任务">
      <div className="toolbar-group">
        <span className="toolbar-label">快速单任务</span>
        <div className="chip-row">
          {taskTestModules.map((item) => {
            const configure = item.id === 'post' || item.id === 'story';
            const ready = configure || (!!item.type && !!capabilities?.types.includes(item.type));
            return (
              <button
                key={item.id}
                type="button"
                className={'chip type-' + item.id + (ready ? '' : ' is-pending')}
                disabled={busy}
                title={
                  configure
                    ? item.detail + '（新建一个组合进行配置）'
                    : ready
                      ? item.detail + '（对左侧已选浏览器快速执行一次）'
                      : item.detail + '（尚未就绪）'
                }
                onClick={() => {
                  if (configure) {
                    onConfigure(item.id);
                    return;
                  }
                  if (!ready) {
                    notify(item.detail + ' 当前尚未就绪。');
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
              <ControlledNumberInput
                ariaLabel="好友请求接受数量"
                min={1}
                max={500}
                defaultValue={2}
                value={Number(maxAccepts) || 2}
                disabled={busy}
                onChange={(v) => setMaxAccepts(String(v))}
                onCommit={(v) => setMaxAccepts(String(v))}
              />
            </label>
          )}
          <label>
            最长等待时长（分钟）
            <ControlledNumberInput
              ariaLabel="单项测试时长"
              min={1}
              max={240}
              defaultValue={15}
              value={Number(minutes) || 15}
              disabled={busy}
              onChange={(v) => setMinutes(String(v))}
              onCommit={(v) => setMinutes(String(v))}
            />
          </label>
        </>
      ) : (
        <label>
          浏览时长（分钟）
          <ControlledNumberInput
            ariaLabel="单项测试时长"
            min={1}
            max={240}
            defaultValue={1}
            value={Number(minutes) || 1}
            disabled={busy}
            onChange={(v) => setMinutes(String(v))}
            onCommit={(v) => setMinutes(String(v))}
          />
        </label>
      )}
      {(module === 'feed' || module === 'video') && (
        <>
          <div className="schedule-times">
            <label>
              随机点赞上限（0 为不点赞）
              <ControlledNumberInput
                ariaLabel="随机点赞上限"
                min={0}
                max={100}
                defaultValue={0}
                value={Number(maxLikes) || 0}
                disabled={busy}
                onChange={(v) => setMaxLikes(String(v))}
                onCommit={(v) => setMaxLikes(String(v))}
              />
            </label>
            {Number(maxLikes) > 0 && (
              <label>
                触发概率 (%)
                <ControlledNumberInput
                  ariaLabel="触发概率"
                  min={1}
                  max={100}
                  defaultValue={35}
                  value={Number(likeProbability) || 35}
                  disabled={busy}
                  onChange={(v) => setLikeProbability(String(v))}
                  onCommit={(v) => setLikeProbability(String(v))}
                />
              </label>
            )}
          </div>
          {Number(maxLikes) > 0 && (
            <>
              <label>
                目标最低点赞量（赞）
                <ControlledNumberInput
                  ariaLabel="目标最低点赞量"
                  min={0}
                  max={1_000_000}
                  defaultValue={0}
                  value={Number(minLikeCount) || 0}
                  disabled={busy}
                  onChange={(v) => setMinLikeCount(String(v))}
                  onCommit={(v) => setMinLikeCount(String(v))}
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
