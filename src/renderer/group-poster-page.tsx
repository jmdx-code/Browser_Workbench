import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../shared/contracts.js';
import {
  hasPosterMaterialContent,
  PosterSettings,
  type PosterLog,
  type PosterMaterialInput,
  type PosterState,
} from '../shared/group-poster.js';
import type { TargetFolder } from '../shared/target-list.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { FinderTargetList, orderedFinderItems } from './finder-target-list.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import { GroupDraftGrid } from './group-inviter-page.js';
import {
  ControlledNumberInput,
  type ControlledNumberInputHandle,
} from './modules/shared/controlled-number-input.js';
import { useFeatureModulesPolling } from './modules/shared/use-feature-module-polling.js';
import {
  createEmptyMaterialDraft,
  PosterMaterialMatrix,
  toMaterialDraft,
  type MaterialDraft,
  type PosterMaterialMatrixHandle,
} from './poster-material-matrix.js';

export { useFeatureModulesPolling };

function emptyDraftRows(n = 8): DraftGroupEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `row-${i}-${Date.now()}`,
    groupId: '',
    groupName: '',
  }));
}

export function GroupPosterPage({
  state,
  selected,
  profiles,
  onState,
  onMessage,
}: {
  state: PosterState | null;
  selected: Set<string>;
  profiles?: readonly Profile[] | undefined;
  onState: (next: PosterState) => void;
  onMessage: (text: string) => void;
}) {
  const [settings, setSettings] = useState<PosterSettings | null>(state?.settings ?? null);
  const [chosenGroups, setChosenGroups] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<'groups' | 'logs' | 'materials' | null>(null);
  const [groupRows, setGroupRows] = useState<DraftGroupEntry[]>(() => emptyDraftRows(8));
  const [drafts, setDrafts] = useState<MaterialDraft[]>(() => [createEmptyMaterialDraft()]);
  const [dirtyMaterials, setDirtyMaterials] = useState(false);
  const [logs, setLogs] = useState<PosterLog[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [logSelected, setLogSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matrixRef = useRef<PosterMaterialMatrixHandle>(null);
  const maxConcRef = useRef<ControlledNumberInputHandle>(null);
  const maxPostsRef = useRef<ControlledNumberInputHandle>(null);
  const matPerGroupRef = useRef<ControlledNumberInputHandle>(null);
  const settingsRef = useRef<PosterSettings | null>(state?.settings ?? null);

  useEffect(() => {
    if (state?.settings) {
      settingsRef.current = state.settings;
      setSettings(state.settings);
    }
  }, [state?.settings]);

  useEffect(() => {
    if (!state) return;
    if (!dirtyMaterials) {
      setDrafts(
        state.materials.length > 0
          ? state.materials.map(toMaterialDraft)
          : [createEmptyMaterialDraft()],
      );
    } else {
      const byId = new Map(state.materials.map((m) => [m.id, m]));
      setDrafts((prev) =>
        prev.map((d) => {
          const server = byId.get(d.id);
          return server
            ? {
                ...d,
                localFilePath: server.localFilePath,
                mediaKind: server.mediaKind,
                cacheStatus: server.cacheStatus,
                cacheError: server.cacheError,
                usedCount: server.usedCount,
                updatedAt: server.updatedAt,
                lastUsedAt: server.lastUsedAt ?? null,
                hasThumbnail: Boolean(server.hasThumbnail),
              }
            : d;
        }),
      );
    }
  }, [state, dirtyMaterials]);

  const isRunning = Boolean(state?.running);
  const persistedMaterialIds = new Set((state?.materials ?? []).map((m) => m.id));
  const selectedProfiles = [...selected].sort();
  const idleSelected = selectedProfiles.filter((id) => !state?.profileCounts[id]?.running);
  const selectedGroupIds = orderedFinderItems(state?.groups ?? [], folders)
    .filter((g) => chosenGroups.has(g.id))
    .map((g) => g.id);
  const selectedMaterialIds = drafts
    .filter((m) => m.selected && hasPosterMaterialContent(m))
    .map((m) => m.id);

  async function action(route: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      const next = await api.posterAction(route, body);
      onState(next);
      return next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onMessage(msg);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadLogs(search = logSearch, before?: number, beforeId?: string) {
    try {
      const rows = await api.posterLogs(search, before, beforeId);
      setLogs((prev) => (before ? [...prev, ...rows] : rows));
      if (!before) setLogSelected(new Set());
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function persistMaterials(itemsToSave = drafts) {
    const latest = matrixRef.current?.commitPendingEdit() ?? itemsToSave;
    const valid: PosterMaterialInput[] = latest.filter(hasPosterMaterialContent).map((d) => ({
      id: d.id,
      caption: d.caption.trim(),
      mediaSource: d.mediaSource.trim(),
      background: d.mediaSource.trim() ? 'plain' : d.background,
      selected: d.selected,
    }));
    const next = await action('materials/save', { items: valid, replaceAll: true });
    if (next) {
      setDirtyMaterials(false);
      setDrafts(
        next.materials.length > 0
          ? next.materials.map(toMaterialDraft)
          : [createEmptyMaterialDraft()],
      );
      onMessage(`已保存 ${valid.length} 条发帖素材（含 Google Drive 媒体将在后台自动下载缓存）`);
    }
    return next;
  }

  useEffect(() => {
    if (!dirtyMaterials || busy) return;
    const timer = setTimeout(() => {
      if (matrixRef.current?.isEditing()) return;
      const valid: PosterMaterialInput[] = drafts.filter(hasPosterMaterialContent).map((d) => ({
        id: d.id,
        caption: d.caption.trim(),
        mediaSource: d.mediaSource.trim(),
        background: d.mediaSource.trim() ? 'plain' : d.background,
        selected: d.selected,
      }));
      void api
        .posterAction('materials/save', { items: valid, replaceAll: true })
        .then((next) => {
          onState(next);
          setDirtyMaterials(false);
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [drafts, dirtyMaterials, busy, onState]);

  function updateSettingField<K extends keyof PosterSettings>(key: K, rawValue: number) {
    const base = settingsRef.current ?? settings;
    if (!base) return;
    const parsed = PosterSettings.safeParse({ ...base, [key]: rawValue });
    const next = parsed.success ? parsed.data : base;
    settingsRef.current = next;
    setSettings(next);
    return action('settings', next);
  }

  const startDisabled =
    busy ||
    idleSelected.length === 0 ||
    selectedGroupIds.length === 0 ||
    selectedMaterialIds.length === 0;

  const startRun = () => {
    void (async () => {
      if (settingsRef.current) {
        const nextSettings: PosterSettings = {
          maxConcurrentProfiles:
            (await maxConcRef.current?.flush()) ?? settingsRef.current.maxConcurrentProfiles,
          maxPostsPerAccount:
            (await maxPostsRef.current?.flush()) ?? settingsRef.current.maxPostsPerAccount,
          materialsPerGroup:
            (await matPerGroupRef.current?.flush()) ?? settingsRef.current.materialsPerGroup,
        };
        if (JSON.stringify(nextSettings) !== JSON.stringify(state?.settings)) {
          settingsRef.current = nextSettings;
          setSettings(nextSettings);
          await action('settings', nextSettings);
        }
      }
      const latest = matrixRef.current?.commitPendingEdit() ?? drafts;
      let effectiveMaterialIds = latest
        .filter((m) => m.selected && hasPosterMaterialContent(m))
        .map((m) => m.id);
      if (dirtyMaterials) {
        const saved = await persistMaterials(latest);
        if (!saved) return;
        effectiveMaterialIds = saved.materials.filter((m) => m.selected).map((m) => m.id);
      }
      if (effectiveMaterialIds.length === 0) return;
      await action('start', {
        profileIds: idleSelected,
        groupIds: selectedGroupIds,
        materialIds: effectiveMaterialIds,
      });
    })();
  };

  return (
    <section className="records-page bumper-page poster-page">
      <div className="bumper-sticky-header">
        <div className="bumper-heading">
          <div className="bumper-primary-controls">
            {settings && (
              <div className="bumper-search-highlight bumper-policy">
                <label className="bumper-policy-field">
                  <span>最大并发浏览器</span>
                  <ControlledNumberInput
                    ref={maxConcRef}
                    ariaLabel="最大并发浏览器"
                    min={1}
                    max={50}
                    defaultValue={8}
                    value={settings.maxConcurrentProfiles}
                    onCommit={(val) => updateSettingField('maxConcurrentProfiles', val)}
                  />
                </label>
                <label className="bumper-policy-field">
                  <span>单号本轮上限</span>
                  <ControlledNumberInput
                    ref={maxPostsRef}
                    ariaLabel="单号本轮上限"
                    min={1}
                    max={200}
                    defaultValue={5}
                    value={settings.maxPostsPerAccount}
                    onCommit={(val) => updateSettingField('maxPostsPerAccount', val)}
                  />
                </label>
                <label className="bumper-policy-field">
                  <span>每组发帖条数</span>
                  <ControlledNumberInput
                    ref={matPerGroupRef}
                    ariaLabel="每组发帖条数"
                    min={1}
                    max={50}
                    defaultValue={1}
                    value={settings.materialsPerGroup}
                    onCommit={(val) => updateSettingField('materialsPerGroup', val)}
                  />
                </label>
              </div>
            )}
          </div>
          <div className="bumper-actions">
            {state?.statusText && (
              <span className={'bumper-status' + (isRunning ? ' is-running' : '')} role="status">
                {state.statusText}
              </span>
            )}
            <button
              className="btn btn-sm"
              onClick={() => {
                setModal('logs');
                void loadLogs('');
              }}
            >
              发帖记录 ({state?.total ?? 0} 条)
            </button>
            {isRunning && idleSelected.length > 0 && (
              <button className="btn btn-primary" disabled={startDisabled} onClick={startRun}>
                ▶ 追加运行已选闲置号 ({idleSelected.length})
              </button>
            )}
            {isRunning ? (
              <button className="btn btn-danger" onClick={() => void action('stop')}>
                ■ 停止全部发帖
              </button>
            ) : (
              <button className="btn btn-primary" disabled={startDisabled} onClick={startRun}>
                ▶ 开始发帖 (已选{idleSelected.length}号 × {selectedGroupIds.length}组 ×{' '}
                {selectedMaterialIds.length}素材)
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bumper-columns">
        <FinderTargetList
          title="小组列表"
          countLabel="累计发帖"
          listKind="shared_groups"
          items={(state?.groups ?? []).map((i) => ({ ...i, count: i.totalBumpedCount }))}
          selected={chosenGroups}
          onSelect={setChosenGroups}
          disabled={busy}
          onFolders={setFolders}
          onDelete={async (ids) => {
            if (!(await action('groups/delete', { ids }))) throw Error('删除未完成');
          }}
          onChanged={async () => {
            onState(await api.posterState());
          }}
          tools={
            <button
              className="btn btn-sm"
              onClick={() => {
                setGroupRows(emptyDraftRows(8));
                setModal('groups');
              }}
            >
              ＋ 添加小组
            </button>
          }
          moreItems={[
            state?.groupAvatarRefreshing
              ? {
                  label: '停止刷新头像',
                  disabled: busy,
                  onSelect: () => void action('groups/refresh-stop'),
                }
              : {
                  label: busy ? '读取中…' : '刷新头像',
                  disabled: busy || isRunning,
                  onSelect: () =>
                    void action(
                      'groups/refresh',
                      chosenGroups.size ? { ids: [...chosenGroups] } : {},
                    ),
                },
          ]}
        />

        <div className="finder-card poster-materials-card">
          <div className="finder-header">
            <div className="finder-title-row">
              <strong>
                贴文素材库 ({drafts.filter(hasPosterMaterialContent).length} 条有效素材)
              </strong>
              <span className="version">
                {dirtyMaterials ? '自动保存中…' : '已自动保存'} · 支持类 Excel 批量粘贴 / 拖拽文件
              </span>
            </div>
          </div>
          <PosterMaterialMatrix
            ref={matrixRef}
            rows={drafts}
            persistedIds={persistedMaterialIds}
            pauseThumbnailGeneration={modal === 'materials'}
            onChange={(next) => {
              setDrafts(next);
              setDirtyMaterials(true);
            }}
            onSave={persistMaterials}
            onDeleteSelected={(ids) => {
              const serverIds = new Set((state?.materials ?? []).map((m) => m.id));
              const toRemove = ids.filter((id) => serverIds.has(id));
              if (toRemove.length > 0) {
                void action('materials/delete', { ids: toRemove });
              }
            }}
            dirty={dirtyMaterials}
            busy={busy}
            isFullscreen={false}
            onToggleFullscreen={() => setModal('materials')}
            onThumbnailSaved={(id) =>
              setDrafts((prev) =>
                prev.map((d) =>
                  d.id === id ? { ...d, hasThumbnail: true, updatedAt: Date.now() } : d,
                ),
              )
            }
            onError={(msg) => {
              setError(msg);
              onMessage(msg);
            }}
          />
        </div>
      </div>

      {modal && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={
            modal === 'groups'
              ? '添加小组'
              : modal === 'materials'
                ? '全屏编辑贴文素材库'
                : '发帖记录'
          }
        >
          <div
            className={
              'modal bumper-modal ' +
              (modal === 'logs'
                ? 'bumper-logs-modal'
                : modal === 'materials'
                  ? 'poster-materials-fullscreen-modal'
                  : 'group-inviter-add-modal')
            }
          >
            <div className="bumper-modal-heading">
              <h2>
                {modal === 'groups'
                  ? '添加小组'
                  : modal === 'materials'
                    ? '全屏编辑贴文素材库'
                    : '小组发帖记录'}
              </h2>
              <button className="btn" aria-label="关闭弹窗" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            {modal === 'materials' && (
              <PosterMaterialMatrix
                ref={matrixRef}
                rows={drafts}
                persistedIds={persistedMaterialIds}
                onChange={(next) => {
                  setDrafts(next);
                  setDirtyMaterials(true);
                }}
                onSave={persistMaterials}
                onDeleteSelected={(ids) => {
                  const serverIds = new Set((state?.materials ?? []).map((m) => m.id));
                  const toRemove = ids.filter((id) => serverIds.has(id));
                  if (toRemove.length > 0) {
                    void action('materials/delete', { ids: toRemove });
                  }
                }}
                dirty={dirtyMaterials}
                busy={busy}
                isFullscreen={true}
                onToggleFullscreen={() => setModal(null)}
                onThumbnailSaved={(id) =>
                  setDrafts((prev) =>
                    prev.map((d) =>
                      d.id === id ? { ...d, hasThumbnail: true, updatedAt: Date.now() } : d,
                    ),
                  )
                }
                onError={(msg) => {
                  setError(msg);
                  onMessage(msg);
                }}
              />
            )}
            {modal === 'groups' && (
              <>
                {folders.length > 0 && (
                  <label className="target-folder-select">
                    归入分组{' '}
                    <select
                      aria-label="添加小组归入分组"
                      value={addFolder ?? ''}
                      onChange={(e) => setAddFolder(e.target.value || null)}
                    >
                      <option value="">未分组</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <GroupDraftGrid
                  rows={groupRows}
                  onChange={setGroupRows}
                  disabled={busy}
                  onError={setError}
                  entityLabel="小组"
                  normalizeId={extractGroupId}
                />
                <div className="bumper-modal-footer">
                  <button className="btn" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => {
                      const items = groupRows
                        .filter((r) => r.groupId.trim() || r.groupName.trim())
                        .map((r) => ({
                          id: extractGroupId(r.groupId),
                          name: r.groupName.trim(),
                          folderId: addFolder,
                        }));
                      if (!items.length || items.some((r) => !r.id)) {
                        setError('请至少填写有效的小组 ID 或链接');
                        return;
                      }
                      void action('groups/add', { items }).then((next) => {
                        if (next) setModal(null);
                      });
                    }}
                  >
                    {busy ? '正在保存…' : '保存'}
                  </button>
                </div>
              </>
            )}
            {modal === 'logs' && (
              <>
                <div className="bumper-target-tools">
                  <input
                    aria-label="搜索发帖记录"
                    placeholder="搜索小组、发帖账号/专页、文案或链接"
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
                    disabled={!logSelected.size || busy || isRunning}
                    onClick={() =>
                      void action('logs/delete', { ids: [...logSelected] }).then(() => loadLogs())
                    }
                  >
                    删除已选 ({logSelected.size})
                  </button>
                  <button
                    className="btn"
                    disabled={!state?.total || busy || isRunning}
                    onClick={() => {
                      if (confirm('清空全部发帖记录？清空后小组与素材的历史防重记录也会清除。'))
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
                                aria-label="全选发帖记录"
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
                            <th>发帖时间</th>
                            <th>发帖身份（账号 / 专页）</th>
                            <th>目标小组</th>
                            <th>贴文摘要</th>
                            <th>发帖链接</th>
                          </tr>
                        </thead>
                        <tbody>
                          {logs.map((row) => {
                            const p = profiles?.find((item) => item.id === row.profileId);
                            const profileTitle = p
                              ? p.browserName || p.alias || p.account.name || row.profileId
                              : row.profileId;
                            const effectiveAccountAvatar =
                              (p?.account.id === row.accountId && p?.account.avatar
                                ? p.account.avatar
                                : null) ?? row.accountAvatar;
                            return (
                              <tr key={row.id}>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={logSelected.has(row.id)}
                                    onChange={() => {
                                      const next = new Set(logSelected);
                                      if (next.has(row.id)) next.delete(row.id);
                                      else next.add(row.id);
                                      setLogSelected(next);
                                    }}
                                  />
                                </td>
                                <td>{new Date(row.postedAt).toLocaleString()}</td>
                                <td>
                                  <div className="poster-log-entity">
                                    {effectiveAccountAvatar && (
                                      <img
                                        src={effectiveAccountAvatar}
                                        alt=""
                                        className="poster-log-avatar"
                                        referrerPolicy="no-referrer"
                                      />
                                    )}
                                    <div>
                                      <strong>{row.accountName || profileTitle}</strong>
                                      <span
                                        className={'poster-identity-badge is-' + row.identityType}
                                      >
                                        {row.identityType === 'page' ? '专页' : '个人'}
                                      </span>
                                      <small>{row.accountId}</small>
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <div className="poster-log-entity">
                                    {row.groupAvatar && (
                                      <img
                                        src={row.groupAvatar}
                                        alt=""
                                        className="poster-log-avatar"
                                        referrerPolicy="no-referrer"
                                      />
                                    )}
                                    <div>
                                      <strong>{row.groupName}</strong>
                                      <small>{row.groupId}</small>
                                    </div>
                                  </div>
                                </td>
                                <td className="poster-log-caption">{row.captionPreview}</td>
                                <td>
                                  {row.postId === 'pending_approval' && (
                                    <span className="poster-identity-badge is-page">
                                      已提交待群管审核
                                    </span>
                                  )}
                                  <button
                                    className="btn btn-sm"
                                    title={row.postUrl}
                                    onClick={() =>
                                      void copyTextToClipboard(row.postUrl)
                                        .then(() => onMessage('已复制发帖链接'))
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
                  </div>
                  <aside className="bumper-logs-stats" aria-label="发帖统计">
                    <div className="bumper-logs-stats-title">发帖统计（最近7天）</div>
                    <table className="bumper-stats-table">
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>发帖总数</th>
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
