import { FinderTargetList, orderedFinderItems } from './finder-target-list.js';
import { PopoverMenu } from './popover-menu.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import type { TargetFolder } from '../shared/target-list.js';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { GroupDraftGrid } from './group-inviter-page.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import {
  extractBumperPageId,
  type BumperReactionType,
  type BumperSettings,
  type BumperState,
  type BumperTarget,
  type BumperLog,
} from '../shared/group-bumper.js';

const REACTION_OPTIONS: ReadonlyArray<{ type: BumperReactionType; label: string }> = [
  { type: 'like', label: '👍 赞' },
  { type: 'love', label: '❤️ 大心' },
  { type: 'care', label: '🤗 抱抱' },
  { type: 'haha', label: '😆 哈' },
  { type: 'wow', label: '😮 哇' },
  { type: 'sad', label: '😢 呜' },
  { type: 'angry', label: '😡 怒' },
];

const blank = (): DraftGroupEntry => ({ key: crypto.randomUUID(), groupId: '', groupName: '' });

export function normalizeBumperSettings(
  draft: BumperSettings,
  fallback: BumperSettings,
): BumperSettings {
  const clampInt = (raw: number | undefined, min: number, max: number, fb: number) => {
    const val = typeof raw === 'number' && Number.isFinite(raw) ? raw : fb;
    return Math.min(max, Math.max(min, Math.round(val)));
  };
  const validReactions: BumperReactionType[] = (
    draft.reactionTypes ??
    fallback.reactionTypes ?? ['care', 'love', 'like']
  ).filter((r): r is BumperReactionType => REACTION_OPTIONS.some((o) => o.type === r));
  return {
    searchMode: draft.searchMode ?? fallback.searchMode ?? 'time_sort',
    maxPostAgeHours: clampInt(draft.maxPostAgeHours, 1, 720, fallback.maxPostAgeHours ?? 24),
    maxPostsPerGroupPage: clampInt(
      draft.maxPostsPerGroupPage,
      1,
      50,
      fallback.maxPostsPerGroupPage ?? 5,
    ),
    maxPostsPerPage: clampInt(draft.maxPostsPerPage, 1, 50, fallback.maxPostsPerPage ?? 3),
    maxConcurrentProfiles: clampInt(
      draft.maxConcurrentProfiles,
      1,
      50,
      fallback.maxConcurrentProfiles ?? 8,
    ),
    dailyMaxLikesPerAccount: clampInt(
      draft.dailyMaxLikesPerAccount,
      1,
      500,
      fallback.dailyMaxLikesPerAccount ?? 20,
    ),
    maxLikesPerPost: clampInt(draft.maxLikesPerPost, 1, 500, fallback.maxLikesPerPost ?? 50),
    likeProbability: clampInt(draft.likeProbability, 0, 100, fallback.likeProbability ?? 100),
    commentProbability: clampInt(
      draft.commentProbability,
      0,
      100,
      fallback.commentProbability ?? 30,
    ),
    consumeCommentOnUse: Boolean(draft.consumeCommentOnUse ?? fallback.consumeCommentOnUse),
    enableSound: Boolean(draft.enableSound ?? fallback.enableSound),
    useLongPressReaction: Boolean(draft.useLongPressReaction ?? fallback.useLongPressReaction),
    reactionTypes: validReactions.length > 0 ? validReactions : ['care', 'love', 'like'],
  };
}
type BumperPageProps = {
  state: BumperState | null;
  selected: ReadonlySet<string>;
  profiles?: ReadonlyArray<{
    id: string;
    name?: string | null;
    browserName?: string | null;
    alias?: string | null;
  }>;
  onState: (s: BumperState) => void;
  onMessage: (s: string) => void;
  mode?: 'group-bumper' | 'page-bumper';
};
/** 专页顶贴：复用顶贴页面与执行器，直接进入专页主页按时间线顶贴。 */
export function PageBumperPage(props: Omit<BumperPageProps, 'mode'>) {
  return <GroupBumperPage {...props} mode="page-bumper" />;
}
export function GroupBumperPage({
  state,
  selected,
  profiles,
  onState,
  onMessage,
  mode = 'group-bumper',
}: BumperPageProps) {
  const pageMode = mode === 'page-bumper';
  const isRunning = pageMode ? !!state?.pageBumperRunning : !!state?.running;
  const statusText = pageMode ? state?.pageBumperStatusText : state?.statusText;
  const effectiveStateSettings = pageMode
    ? (state?.pageSettings ?? state?.settings ?? null)
    : (state?.settings ?? null);
  const settingsActionName = pageMode ? 'page-settings' : 'settings';
  const commentsActionName = pageMode ? 'page-comments' : 'comments';
  const effectiveComments = pageMode
    ? (state?.pageComments ?? state?.comments ?? [])
    : (state?.comments ?? []);
  const effectiveTotal = pageMode ? (state?.pageTotal ?? state?.total ?? 0) : (state?.total ?? 0);
  const effectiveDailyStats = pageMode
    ? (state?.pageDailyStats ?? state?.dailyStats ?? [])
    : (state?.dailyStats ?? []);
  const runningIds = new Set(
    [
      ...Object.entries(state?.profileCounts ?? {}),
      ...Object.entries(state?.pageBumperProfileCounts ?? {}),
    ]
      .filter(([, stat]) => stat.running)
      .map(([id]) => id),
  );
  const idleSelected = [...selected].filter((id) => !runningIds.has(id));
  const [chosenGroups, setGroups] = useState<Set<string>>(new Set()),
    [chosenPages, setPages] = useState<Set<string>>(new Set());
  useEffect(() => {
    setGroups(new Set());
    setPages(new Set());
  }, [mode]);
  const [folders, setFolders] = useState<{ groups: TargetFolder[]; pages: TargetFolder[] }>({
    groups: [],
    pages: [],
  });
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<'groups' | 'pages' | 'comments' | 'logs' | null>(null);
  const [rows, setRows] = useState<DraftGroupEntry[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<BumperSettings | null>(effectiveStateSettings);
  const latestSettingsRef = useRef<BumperSettings | null>(effectiveStateSettings);
  const dirtySettingsRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsJSON = JSON.stringify(effectiveStateSettings);
  useEffect(() => {
    if (settingsJSON && !dirtySettingsRef.current) {
      const parsed = JSON.parse(settingsJSON) as BumperSettings;
      latestSettingsRef.current = parsed;
      setSettings(parsed);
    }
  }, [settingsJSON]);
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );
  const [commentText, setCommentText] = useState(''),
    [consume, setConsume] = useState(false);
  const commentBaseRef = useRef<Array<{ id: string; text: string }>>([]);
  const commentDirtyRef = useRef(false);
  useEffect(() => {
    if (modal !== 'comments' || commentDirtyRef.current) return;
    commentBaseRef.current = effectiveComments.map(({ id, text }) => ({ id, text }));
    setCommentText(effectiveComments.map((c) => c.text).join('\n'));
  }, [modal, effectiveComments]);
  const [logs, setLogs] = useState<BumperLog[]>([]),
    [logSearch, setLogSearch] = useState(''),
    [logScopeFilter, setLogScopeFilter] = useState<'current' | 'all'>('current'),
    [logSelected, setLogSelected] = useState<Set<string>>(new Set());
  async function action(name: string, input: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      const next = await api.bumperAction(name, input);
      onState(next);
      return next;
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作失败';
      setError(message);
      onMessage(message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const toggle = (current: Set<string>, id: string) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  async function loadLogs(
    search = logSearch,
    before?: number,
    beforeId?: string,
    scope = logScopeFilter,
  ) {
    try {
      const sourceMode = scope === 'current' ? (pageMode ? 'page' : 'group') : undefined;
      const values = await api.bumperLogs(search, before, beforeId, sourceMode);
      setLogs((old) => (before ? [...old, ...values] : values));
      if (!before) setLogSelected(new Set());
    } catch (e) {
      onMessage(e instanceof Error ? e.message : '记录读取失败');
    }
  }
  async function open(kind: NonNullable<typeof modal>) {
    setError('');
    setModal(kind);
    setAddFolder(null);
    if (kind === 'groups' || kind === 'pages') setRows(Array.from({ length: 5 }, blank));
    if (kind === 'comments') {
      commentBaseRef.current = effectiveComments.map(({ id, text }) => ({ id, text }));
      commentDirtyRef.current = false;
      setCommentText(effectiveComments.map((c) => c.text).join('\n'));
      setConsume(settings?.consumeCommentOnUse ?? false);
    }
    if (kind === 'logs') await loadLogs();
  }
  const selectedGroups = orderedFinderItems(state?.groups ?? [], folders.groups)
      .filter((g) => chosenGroups.has(g.id))
      .map((g) => g.id),
    selectedPages = orderedFinderItems(state?.pages ?? [], folders.pages)
      .filter((p) => chosenPages.has(p.id))
      .map((p) => p.id);
  function renderSettingInput(
    key:
      | 'maxPostAgeHours'
      | 'maxPostsPerGroupPage'
      | 'maxPostsPerPage'
      | 'maxConcurrentProfiles'
      | 'dailyMaxLikesPerAccount'
      | 'maxLikesPerPost'
      | 'likeProbability'
      | 'commentProbability',
    label: string,
  ) {
    if (!settings) return null;
    const min = key.includes('Probability') ? 0 : 1;
    const max = key.includes('Probability')
      ? 100
      : key === 'maxPostsPerGroupPage' ||
          key === 'maxPostsPerPage' ||
          key === 'maxConcurrentProfiles'
        ? 50
        : key === 'maxPostAgeHours'
          ? 720
          : 500;
    const value = settings[key] ?? (key === 'maxPostsPerPage' ? 3 : 8);
    return (
      <label key={key} className="bumper-policy-field">
        <span>{label}</span>
        <ControlledNumberInput
          ariaLabel={key}
          value={value}
          min={min}
          max={max}
          defaultValue={value}
          onChange={(clamped) => {
            const base = latestSettingsRef.current ?? settings;
            const next = normalizeBumperSettings(
              { ...base, [key]: clamped },
              effectiveStateSettings ?? base,
            );
            latestSettingsRef.current = next;
            dirtySettingsRef.current = true;
            setSettings(next);
          }}
          onCommit={(clamped) => {
            if (saveTimerRef.current) {
              clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
            }
            const base = latestSettingsRef.current ?? settings;
            const next = normalizeBumperSettings(
              { ...base, [key]: clamped },
              effectiveStateSettings ?? base,
            );
            latestSettingsRef.current = next;
            dirtySettingsRef.current = false;
            setSettings(next);
            return api
              .bumperAction(settingsActionName, next)
              .then((s) => {
                onState(s);
              })
              .catch(() => {});
          }}
        />
      </label>
    );
  }
  function renderSoundToggle() {
    if (!settings) return null;
    const activeReactions = settings.reactionTypes ?? ['care', 'love', 'like'];
    return (
      <>
        <label className="bumper-policy-field bumper-sound-toggle">
          <input
            type="checkbox"
            aria-label="开启声音"
            checked={Boolean(settings.enableSound)}
            onChange={(e) => {
              const base = latestSettingsRef.current ?? settings;
              const next = normalizeBumperSettings(
                { ...base, enableSound: e.target.checked },
                effectiveStateSettings ?? base,
              );
              latestSettingsRef.current = next;
              dirtySettingsRef.current = false;
              setSettings(next);
              void action(settingsActionName, next);
            }}
          />
          <span>开启声音</span>
        </label>
        <label className="bumper-policy-field bumper-sound-toggle">
          <input
            type="checkbox"
            aria-label="长按选表情"
            checked={Boolean(settings.useLongPressReaction)}
            onChange={(e) => {
              const base = latestSettingsRef.current ?? settings;
              const next = normalizeBumperSettings(
                { ...base, useLongPressReaction: e.target.checked },
                effectiveStateSettings ?? base,
              );
              latestSettingsRef.current = next;
              dirtySettingsRef.current = false;
              setSettings(next);
              void action(settingsActionName, next);
            }}
          />
          <span>长按选表情</span>
        </label>
        {settings.useLongPressReaction && (
          <div className="bumper-reaction-badges" role="group" aria-label="表情类型选择">
            {REACTION_OPTIONS.map((opt) => {
              const checked = activeReactions.includes(opt.type);
              return (
                <button
                  key={opt.type}
                  type="button"
                  className={'bumper-reaction-badge' + (checked ? ' is-active' : '')}
                  aria-pressed={checked}
                  onClick={() => {
                    const base = latestSettingsRef.current ?? settings;
                    const current = base.reactionTypes ?? ['care', 'love', 'like'];
                    const nextTypes = checked
                      ? current.length > 1
                        ? current.filter((t) => t !== opt.type)
                        : current
                      : [...current, opt.type];
                    const next = normalizeBumperSettings(
                      { ...base, reactionTypes: nextTypes },
                      effectiveStateSettings ?? base,
                    );
                    latestSettingsRef.current = next;
                    dirtySettingsRef.current = false;
                    setSettings(next);
                    void action(settingsActionName, next);
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}
      </>
    );
  }
  function targets(kind: 'groups' | 'pages', items: BumperTarget[]) {
    const label = kind === 'groups' ? '小组' : '主页',
      chosen = kind === 'groups' ? chosenGroups : chosenPages,
      set = kind === 'groups' ? setGroups : setPages;
    return (
      <FinderTargetList
        title={kind === 'groups' ? '小组列表' : '专页列表'}
        countLabel={kind === 'groups' ? '累计顶贴' : '累计获顶'}
        listKind={kind === 'groups' ? 'shared_groups' : 'bumper_pages'}
        items={items.map((i) => ({ ...i, count: i.totalBumpedCount }))}
        selected={chosen}
        onSelect={set}
        disabled={busy}
        onFolders={(next) => setFolders((prev) => ({ ...prev, [kind]: next }))}
        onDelete={async (ids) => {
          if (!(await action(kind + '/delete', { ids }))) throw Error('删除未完成');
        }}
        onChanged={async () => {
          onState(await api.bumperState());
        }}
        tools={
          <button className="btn btn-sm" onClick={() => void open(kind)}>
            ＋ 添加{label}
          </button>
        }
        moreItems={[
          (kind === 'groups' ? state?.groupAvatarRefreshing : state?.pageAvatarRefreshing)
            ? {
                label: '停止刷新头像',
                disabled: busy,
                onSelect: () => void action(kind + '/refresh-stop'),
              }
            : {
                label: busy ? '读取中…' : '刷新头像',
                disabled: busy || !!state?.running || !!state?.pageBumperRunning,
                onSelect: () =>
                  void action(kind + '/refresh', chosen.size ? { ids: [...chosen] } : {}),
              },
        ]}
      />
    );
  }

  const showStatusBadge = Boolean(
    isRunning ||
    (statusText &&
      !['请选择账号、小组和目标主页', '请选择账号和目标专页', '本轮已结束', '正在读取…'].includes(
        statusText,
      )),
  );
  const startDisabled =
    busy || !idleSelected.length || (!pageMode && !selectedGroups.length) || !selectedPages.length;
  const startRun = () => {
    void (async () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const currentCandidate = latestSettingsRef.current ?? settings;
      if (currentCandidate) {
        const normalized = normalizeBumperSettings(
          currentCandidate,
          effectiveStateSettings ?? currentCandidate,
        );
        if (
          dirtySettingsRef.current ||
          JSON.stringify(normalized) !== JSON.stringify(effectiveStateSettings)
        ) {
          dirtySettingsRef.current = false;
          latestSettingsRef.current = normalized;
          setSettings(normalized);
          await action(settingsActionName, normalized);
        }
      }
      await action(
        pageMode ? 'start-page' : 'start',
        pageMode
          ? { profileIds: idleSelected, pageIds: selectedPages }
          : { profileIds: idleSelected, groupIds: selectedGroups, pageIds: selectedPages },
      );
    })();
  };

  return (
    <section className="records-page bumper-page">
      <div className="bumper-sticky-header">
        <div className="bumper-heading">
          <div className="bumper-primary-controls">
            {settings && pageMode && (
              <div className="bumper-search-highlight bumper-policy">
                {renderSettingInput('maxPostsPerPage', '最大扫描贴文数量')}
                {renderSettingInput('maxConcurrentProfiles', '最大并发浏览器数')}
                {renderSoundToggle()}
              </div>
            )}
            {settings && !pageMode && (
              <div className="bumper-search-highlight bumper-policy">
                <label className="bumper-policy-field">
                  <span>查找方式</span>
                  <select
                    aria-label="查找方式"
                    value={settings.searchMode}
                    onChange={(e) => {
                      const searchMode = e.target.value as BumperSettings['searchMode'];
                      const base = latestSettingsRef.current ?? settings;
                      const next = normalizeBumperSettings(
                        {
                          ...base,
                          searchMode,
                          maxPostsPerGroupPage: searchMode === 'page_group_feed' ? 5 : 15,
                        },
                        effectiveStateSettings ?? base,
                      );
                      latestSettingsRef.current = next;
                      dirtySettingsRef.current = false;
                      setSettings(next);
                      void action(settingsActionName, next);
                    }}
                  >
                    <option value="time_sort">1. 时间排序查找</option>
                    <option value="page_group_feed">2. 直接打开专页的小组贴</option>
                    <option value="random_browse">3. 随机浏览</option>
                  </select>
                </label>
                {settings.searchMode !== 'random_browse' &&
                  renderSettingInput('maxPostAgeHours', '最近几小时内')}
                {renderSoundToggle()}
              </div>
            )}
          </div>
          <div className="bumper-actions">
            {settings && settings.commentProbability > 0 && effectiveComments.length === 0 && (
              <span
                className="bumper-warning-banner"
                role="note"
                title="留言列表为空，当前仅会执行点赞（如需评论请点击右侧「留言列表」添加话术）"
              >
                ⚠️ 留言列表为空仅点赞
              </span>
            )}
            {showStatusBadge && statusText && (
              <span className={'bumper-status' + (isRunning ? ' is-running' : '')} role="status">
                {statusText}
              </span>
            )}
            <button className="btn btn-sm" onClick={() => void open('comments')}>
              留言列表 ({effectiveComments.length} 条)
            </button>
            <button className="btn btn-sm" onClick={() => void open('logs')}>
              顶贴记录 ({effectiveTotal} 条)
            </button>
            {settings && (
              <PopoverMenu
                className="bumper-advanced-popover"
                label="高级参数"
                trigger={<>⚙ 高级参数</>}
              >
                {() => (
                  <div className="bumper-advanced-panel">
                    <div className="bumper-advanced-group">
                      {renderSettingInput('dailyMaxLikesPerAccount', '单号每日上限')}
                      {renderSettingInput('maxLikesPerPost', '单帖最高上限')}
                      {renderSettingInput('likeProbability', '点赞概率 %')}
                      {renderSettingInput('commentProbability', '留言概率 %')}
                    </div>
                    <div className="bumper-advanced-group">
                      {pageMode
                        ? renderSettingInput('maxPostsPerPage', '最大扫描贴文数量')
                        : renderSettingInput('maxPostsPerGroupPage', '每组每主页最多扫帖')}
                      {renderSettingInput('maxConcurrentProfiles', '最大并发浏览器数')}
                    </div>
                  </div>
                )}
              </PopoverMenu>
            )}
            {isRunning ? (
              <>
                {idleSelected.length > 0 && (
                  <button className="btn btn-primary" disabled={startDisabled} onClick={startRun}>
                    ▶ 追加运行已选闲置号 ({idleSelected.length}号)
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  onClick={() => void action(pageMode ? 'stop-page' : 'stop')}
                >
                  ■ 停止全部运行
                </button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={startDisabled} onClick={startRun}>
                {pageMode
                  ? `▶ 开始运行 (已选${idleSelected.length}号 × ${selectedPages.length}专页)`
                  : `▶ 开始运行 (已选${idleSelected.length}号 × ${selectedGroups.length}组 × ${selectedPages.length}主页)`}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className={'bumper-columns' + (pageMode ? ' is-single' : '')}>
        {!pageMode && targets('groups', state?.groups ?? [])}
        {targets('pages', state?.pages ?? [])}
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={
            modal === 'groups'
              ? '添加小组'
              : modal === 'pages'
                ? '添加主页'
                : modal === 'comments'
                  ? '留言列表'
                  : '顶贴记录'
          }
        >
          <div
            className={
              'modal bumper-modal ' +
              (modal === 'logs' ? 'bumper-logs-modal' : 'group-inviter-add-modal')
            }
          >
            <div className="bumper-modal-heading">
              <h2>
                {modal === 'groups'
                  ? '添加小组'
                  : modal === 'pages'
                    ? '添加主页'
                    : modal === 'comments'
                      ? '留言列表'
                      : '顶贴记录'}
              </h2>
              <button className="btn" aria-label="关闭弹窗" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            {(modal === 'groups' || modal === 'pages') && (
              <>
                {folders[modal].length > 0 && (
                  <label className="target-folder-select">
                    归入分组{' '}
                    <select
                      aria-label={modal === 'pages' ? '添加主页归入分组' : '添加小组归入分组'}
                      value={addFolder ?? ''}
                      onChange={(e) => setAddFolder(e.target.value || null)}
                    >
                      <option value="">未分组</option>
                      {folders[modal].map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <GroupDraftGrid
                  rows={rows}
                  onChange={setRows}
                  disabled={busy}
                  onError={setError}
                  entityLabel={modal === 'pages' ? '主页' : '小组'}
                  normalizeId={modal === 'pages' ? extractBumperPageId : extractGroupId}
                />
                <div className="bumper-modal-footer">
                  <button className="btn" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => {
                      const items = rows
                        .filter((r) => r.groupId.trim() || r.groupName.trim())
                        .map((r) => ({
                          id: (modal === 'pages' ? extractBumperPageId : extractGroupId)(r.groupId),
                          name: r.groupName.trim(),
                          folderId: addFolder,
                        }));
                      if (!items.length || items.some((r) => !r.id)) {
                        setError('请至少填写有效的 ID 或链接');
                        return;
                      }
                      void action(`${modal}/add`, { items }).then((next) => {
                        if (next) setModal(null);
                      });
                    }}
                  >
                    {busy ? '正在保存…' : '保存'}
                  </button>
                </div>
              </>
            )}
            {modal === 'comments' && (
              <>
                <p>每行一条留言；会优先选择同一帖子尚未使用的话术。</p>
                <textarea
                  className="bumper-comments"
                  aria-label="留言话术"
                  value={commentText}
                  onChange={(e) => {
                    commentDirtyRef.current = true;
                    setCommentText(e.target.value);
                  }}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={consume}
                    onChange={(e) => setConsume(e.target.checked)}
                  />{' '}
                  留言使用后自动从列表移除
                </label>
                <div className="bumper-modal-footer">
                  <button
                    className="btn"
                    onClick={() => {
                      commentDirtyRef.current = true;
                      setCommentText('');
                    }}
                  >
                    清空列表
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void action(commentsActionName, {
                        texts: commentText
                          .split(/\r?\n/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                        consumeCommentOnUse: consume,
                        baseComments: commentBaseRef.current,
                      }).then((next) => {
                        if (next) setModal(null);
                      })
                    }
                  >
                    保存
                  </button>
                </div>
              </>
            )}
            {modal === 'logs' && (
              <>
                <div className="bumper-target-tools">
                  <select
                    aria-label="顶贴记录范围"
                    value={logScopeFilter}
                    onChange={(e) => {
                      const nextScope = e.target.value as 'current' | 'all';
                      setLogScopeFilter(nextScope);
                      void loadLogs(logSearch, undefined, undefined, nextScope);
                    }}
                  >
                    <option value="current">当前模块 ({pageMode ? '专页顶贴' : '小组顶贴'})</option>
                    <option value="all">全部顶贴</option>
                  </select>
                  <input
                    aria-label="搜索顶贴记录"
                    placeholder="搜索小组、账号、主页、留言"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void loadLogs();
                    }}
                  />
                  <button className="btn" onClick={() => void loadLogs()}>
                    搜索
                  </button>
                  <button
                    className="btn"
                    disabled={
                      !logSelected.size ||
                      busy ||
                      (logScopeFilter === 'all'
                        ? Boolean(state?.running || state?.pageBumperRunning)
                        : isRunning)
                    }
                    onClick={() =>
                      void action('logs/delete', { ids: [...logSelected] }).then(() => loadLogs())
                    }
                  >
                    删除已选 ({logSelected.size})
                  </button>
                  <button
                    className="btn"
                    disabled={
                      (logScopeFilter === 'all'
                        ? (state?.total ?? 0) + (state?.pageTotal ?? 0) === 0
                        : !effectiveTotal) ||
                      busy ||
                      (logScopeFilter === 'all'
                        ? Boolean(state?.running || state?.pageBumperRunning)
                        : isRunning)
                    }
                    onClick={() => {
                      const sourceMode =
                        logScopeFilter === 'current' ? (pageMode ? 'page' : 'group') : undefined;
                      if (confirm('清空全部顶贴记录？清空后对应的历史防重和次数统计也会清除。'))
                        void action('logs/delete', { all: true, sourceMode }).then(() =>
                          loadLogs(),
                        );
                    }}
                  >
                    清空历史记录
                  </button>
                </div>
                <div className="bumper-logs-body">
                  <div className="bumper-logs-main">
                    <div className="bumper-table-scroll">
                      <table className="bumper-table">
                        <thead>
                          <tr>
                            <th>
                              <input
                                type="checkbox"
                                aria-label="全选顶贴记录"
                                checked={
                                  logs.length > 0 && logs.every((l) => logSelected.has(l.id))
                                }
                                onChange={(e) =>
                                  setLogSelected(
                                    e.target.checked ? new Set(logs.map((l) => l.id)) : new Set(),
                                  )
                                }
                              />
                            </th>
                            <th>顶贴时间</th>
                            <th>顶贴账号</th>
                            <th>所属小组</th>
                            <th>发帖主页 (ID)</th>
                            <th>顶贴动作</th>
                            <th>帖子链接</th>
                          </tr>
                        </thead>
                        <tbody>
                          {logs.map((row) => {
                            const p = profiles?.find((item) => item.id === row.profileId);
                            const profileTitle = p
                              ? p.browserName || p.alias || p.name || row.profileId
                              : row.profileId;
                            return (
                              <tr key={row.id}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={logSelected.has(row.id)}
                                    onChange={() => setLogSelected(toggle(logSelected, row.id))}
                                  />
                                </td>
                                <td>{new Date(row.bumpedAt).toLocaleString()}</td>
                                <td>
                                  <strong>{profileTitle}</strong>
                                  <small>{row.accountId}</small>
                                </td>
                                <td>
                                  {row.groupName}
                                  {row.groupName !== row.groupId && <small>{row.groupId}</small>}
                                </td>
                                <td>
                                  {row.pageName}
                                  <small>{row.pageId}</small>
                                </td>
                                <td>
                                  {row.liked ? '👍 点赞 ' : ''}
                                  {row.commentText ? '💬 ' + row.commentText : ''}
                                </td>
                                <td>
                                  <button
                                    className="btn btn-sm"
                                    title={row.postUrl}
                                    onClick={() =>
                                      void copyTextToClipboard(row.postUrl)
                                        .then(() => onMessage('已复制帖子链接'))
                                        .catch((e) => onMessage(String(e)))
                                    }
                                  >
                                    复制链接
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {logs.length >= 200 && (
                      <button
                        className="btn"
                        onClick={() =>
                          void loadLogs(logSearch, logs.at(-1)?.bumpedAt, logs.at(-1)?.id)
                        }
                      >
                        加载更多
                      </button>
                    )}
                  </div>
                  <aside className="bumper-logs-stats" aria-label="顶贴统计">
                    <div className="bumper-logs-stats-title">顶贴统计（最近7天）</div>
                    <table className="bumper-stats-table">
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>顶贴总数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {effectiveDailyStats.map((row) => (
                          <tr key={row.date}>
                            <td>{row.date}</td>
                            <td>{row.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </aside>
                </div>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
