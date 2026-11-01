import { FinderTargetList, orderedFinderItems } from './finder-target-list.js';
import { PopoverMenu } from './popover-menu.js';
import type { TargetFolder } from '../shared/target-list.js';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { GroupDraftGrid } from './group-inviter-page.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import {
  extractBumperPageId,
  type BumperSettings,
  type BumperState,
  type BumperTarget,
  type BumperLog,
} from '../shared/group-bumper.js';

const blank = (): DraftGroupEntry => ({ key: crypto.randomUUID(), groupId: '', groupName: '' });
export function GroupBumperPage({
  state,
  selected,
  profiles,
  onState,
  onMessage,
}: {
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
}) {
  const [chosenGroups, setGroups] = useState<Set<string>>(new Set()),
    [chosenPages, setPages] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<{ groups: TargetFolder[]; pages: TargetFolder[] }>({
    groups: [],
    pages: [],
  });
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<'groups' | 'pages' | 'comments' | 'logs' | null>(null);
  const [rows, setRows] = useState<DraftGroupEntry[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<BumperSettings | null>(state?.settings ?? null);
  const settingsJSON = JSON.stringify(state?.settings);
  useEffect(() => {
    if (settingsJSON) setSettings(JSON.parse(settingsJSON) as BumperSettings);
  }, [settingsJSON]);
  const [commentText, setCommentText] = useState(''),
    [consume, setConsume] = useState(false);
  const [logs, setLogs] = useState<BumperLog[]>([]),
    [logSearch, setLogSearch] = useState(''),
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
  async function loadLogs(search = logSearch, before?: number, beforeId?: string) {
    try {
      const values = await api.bumperLogs(search, before, beforeId);
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
      setCommentText((state?.comments ?? []).map((c) => c.text).join('\n'));
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
  const update = (
    key: keyof BumperSettings,
    value: number | boolean | BumperSettings['searchMode'],
  ) => {
    if (settings) setSettings({ ...settings, [key]: value });
  };
  function renderSettingInput(
    key:
      | 'maxPostAgeHours'
      | 'maxPostsPerGroupPage'
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
      : key === 'maxPostsPerGroupPage'
        ? 50
        : key === 'maxPostAgeHours'
          ? 720
          : 500;
    return (
      <label key={key} className="bumper-policy-field">
        <span>{label}</span>
        <input
          type="number"
          aria-label={key}
          value={Number.isFinite(settings[key]) ? settings[key] : ''}
          min={min}
          max={max}
          onChange={(e) => update(key, e.target.value === '' ? Number.NaN : Number(e.target.value))}
          onBlur={(e) => {
            const fromDom =
              e.currentTarget.value === '' ? Number.NaN : Number(e.currentTarget.value);
            const raw = Number.isFinite(fromDom) ? fromDom : settings[key];
            const fallback = state?.settings[key] ?? min;
            const normalized = Number.isFinite(raw)
              ? Math.min(max, Math.max(min, Math.round(raw)))
              : fallback;
            const next = { ...settings, [key]: normalized };
            setSettings(next);
            void action('settings', next);
          }}
        />
      </label>
    );
  }
  function targets(kind: 'groups' | 'pages', items: BumperTarget[]) {
    const label = kind === 'groups' ? '小组' : '主页',
      chosen = kind === 'groups' ? chosenGroups : chosenPages,
      set = kind === 'groups' ? setGroups : setPages;
    return (
      <FinderTargetList
        title={kind === 'groups' ? '目标小组列表' : '目标主页 / 专页列表'}
        countLabel={kind === 'groups' ? '累计顶贴' : '累计获顶'}
        listKind={kind === 'groups' ? 'bumper_groups' : 'bumper_pages'}
        items={items.map((i) => ({ ...i, count: i.totalBumpedCount }))}
        selected={chosen}
        onSelect={set}
        disabled={busy || !!state?.running}
        onFolders={(next) => setFolders((prev) => ({ ...prev, [kind]: next }))}
        onDelete={async (ids) => {
          if (!(await action(kind + '/delete', { ids }))) throw Error('删除未完成');
        }}
        onChanged={async () => {
          onState(await api.bumperState());
        }}
        tools={
          <>
            <button className="btn btn-sm" onClick={() => void open(kind)}>
              ＋ 添加{label}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy || !!state?.running}
              onClick={() =>
                void action(kind + '/refresh', chosen.size ? { ids: [...chosen] } : {})
              }
            >
              {busy ? '读取中…' : '读取资料'}
            </button>
          </>
        }
        moreItems={
          kind === 'groups'
            ? [
                {
                  label: '从邀请人导入小组',
                  disabled: busy || !!state?.running,
                  onSelect: () => void action('groups/import'),
                },
              ]
            : undefined
        }
      />
    );
  }

  const showStatusBadge = Boolean(
    state?.running ||
    (state?.statusText &&
      !['请选择账号、小组和目标主页', '本轮已结束', '正在读取…'].includes(state.statusText)),
  );

  return (
    <section className="records-page bumper-page">
      <div className="bumper-sticky-header">
        <div className="bumper-heading">
          <div className="bumper-primary-controls">
            {settings && (
              <div className="bumper-search-highlight bumper-policy">
                <label className="bumper-policy-field">
                  <span>查找方式</span>
                  <select
                    aria-label="查找方式"
                    value={settings.searchMode}
                    onChange={(e) => {
                      const searchMode = e.target.value as BumperSettings['searchMode'];
                      const next = {
                        ...settings,
                        searchMode,
                        maxPostsPerGroupPage: searchMode === 'page_group_feed' ? 5 : 15,
                      };
                      setSettings(next);
                      void action('settings', next);
                    }}
                  >
                    <option value="time_sort">1. 时间排序查找</option>
                    <option value="page_group_feed">2. 直接打开专页的小组贴</option>
                    <option value="random_browse">3. 随机浏览</option>
                  </select>
                </label>
                {settings.searchMode !== 'random_browse' &&
                  renderSettingInput('maxPostAgeHours', '最近几小时内')}
              </div>
            )}
          </div>
          <div className="bumper-actions">
            {settings && settings.commentProbability > 0 && (state?.comments.length ?? 0) === 0 && (
              <span
                className="bumper-warning-banner"
                role="note"
                title="留言列表为空，当前仅会执行点赞（如需评论请点击右侧「留言列表」添加话术）"
              >
                ⚠️ 留言列表为空仅点赞
              </span>
            )}
            {showStatusBadge && state?.statusText && (
              <span
                className={'bumper-status' + (state?.running ? ' is-running' : '')}
                role="status"
              >
                {state.statusText}
              </span>
            )}
            <button className="btn btn-sm" onClick={() => void open('comments')}>
              留言列表 ({state?.comments.length ?? 0} 条)
            </button>
            <button className="btn btn-sm" onClick={() => void open('logs')}>
              顶贴记录 ({state?.total ?? 0} 条)
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
                      {renderSettingInput('maxPostsPerGroupPage', '每组每主页最多扫帖')}
                    </div>
                  </div>
                )}
              </PopoverMenu>
            )}
            {state?.running ? (
              <button className="btn btn-danger" onClick={() => void action('stop')}>
                ■ 停止运行
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy || !selected.size || !selectedGroups.length || !selectedPages.length}
                onClick={() =>
                  void action('start', {
                    profileIds: [...selected],
                    groupIds: selectedGroups,
                    pageIds: selectedPages,
                  })
                }
              >
                ▶ 开始运行 (已选{selected.size}号 × {selectedGroups.length}组 ×{' '}
                {selectedPages.length}主页)
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="bumper-columns">
        {targets('groups', state?.groups ?? [])}
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
              <button
                className="btn"
                aria-label="关闭弹窗"
                disabled={busy}
                onClick={() => setModal(null)}
              >
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
                    保存
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
                  onChange={(e) => setCommentText(e.target.value)}
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
                  <button className="btn" onClick={() => setCommentText('')}>
                    清空列表
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void action('comments', {
                        texts: commentText
                          .split(/\r?\n/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                        consumeCommentOnUse: consume,
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
                    disabled={!logSelected.size || busy || state?.running}
                    onClick={() =>
                      void action('logs/delete', { ids: [...logSelected] }).then(() => loadLogs())
                    }
                  >
                    删除已选 ({logSelected.size})
                  </button>
                  <button
                    className="btn"
                    disabled={!state?.total || busy || state?.running}
                    onClick={() => {
                      if (confirm('清空全部顶贴记录？清空后对应的历史防重和次数统计也会清除。'))
                        void action('logs/delete', { all: true }).then(() => loadLogs());
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
                        {(state?.dailyStats ?? []).map((row) => (
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
