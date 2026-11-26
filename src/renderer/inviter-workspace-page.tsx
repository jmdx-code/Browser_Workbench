import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import { bluestacksDisplayTitle, type BluestacksState } from '../shared/bluestacks.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import type { GroupInviterState } from '../shared/group-inviter.js';
import type { TargetFolder } from '../shared/target-list.js';
import { api } from './api.js';
import { FinderTargetList, orderedFinderItems } from './finder-target-list.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import { IconClock, IconPlay, IconStop } from './icons.js';
import {
  ControlledNumberInput,
  type ControlledNumberInputHandle,
} from './modules/shared/controlled-number-input.js';
import { Btn, errMsg } from './modules/shared/module-ui.js';
import { TargetScopeBar, type TargetScopeOption } from './modules/shared/target-scope-bar.js';
import { makeDraftRow, TargetAddModal } from './target-add-modal.js';
import { UI_INPUT_SM, UiSwitch } from './ui/primitives.js';

export interface InviterWorkspaceProps {
  carrier: 'browser' | 'bluestacks';
  state: GroupInviterState | null;
  loaded?: boolean;
  selectedTargetIds: ReadonlySet<string>;
  externalBusy?: boolean;
  bluestacksState?: BluestacksState | null;
  onBluestacksState?: (next: BluestacksState) => void;
  fallbackGroups?: readonly BumperTarget[];
  scopeItems?: readonly TargetScopeOption[] | undefined;
  scopeGroups?: ReadonlyArray<{ id: string; name: string }> | undefined;
  onSelectTargets?: ((next: Set<string>) => void) | undefined;
  onAddGroups?: (
    items: Array<{ groupId: string; groupName: string; folderId?: string | null }>,
  ) => Promise<void>;
  onDeleteGroups?: (groupIds: string[]) => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onSaveInvitesPerGroup?: (invitesPerGroup: number) => Promise<void>;
  onStartBrowser?: (groupIds: string[], invitesPerGroup: number) => Promise<void>;
  onStopBrowser?: () => Promise<void>;
  onQuickSchedule?: ((seed: QuickScheduleSeed) => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  onMessage?: ((msg: string) => void) | undefined;
}

export function InviterWorkspacePage(p: InviterWorkspaceProps) {
  const {
    carrier,
    state,
    loaded = true,
    selectedTargetIds,
    externalBusy = false,
    bluestacksState = null,
    onBluestacksState,
    fallbackGroups = [],
    onRefresh,
    onQuickSchedule,
    onMessage,
  } = p;
  const isBs = carrier === 'bluestacks';
  const defaultInvites = isBs ? 5 : 30;
  const maxInvites = isBs ? 50 : 200;
  const [localBusy, setLocalBusy] = useState(false);
  const busy = externalBusy || localBusy;
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [invitesInput, setInvitesInput] = useState<number>(
    isBs ? 5 : (state?.invitesPerGroup ?? 30),
  );
  const invitesInputRef = useRef<ControlledNumberInputHandle>(null);
  const [addingModalOpen, setAddingModalOpen] = useState(false);
  const [draftRows, setDraftRows] = useState<DraftGroupEntry[]>(() =>
    Array.from({ length: 5 }, () => makeDraftRow()),
  );
  const [formError, setFormError] = useState('');
  const [submittingAdd, setSubmittingAdd] = useState(false);
  const [refreshingAvatars, setRefreshingAvatars] = useState(false);

  useEffect(() => {
    if (!isBs && state?.invitesPerGroup !== undefined) setInvitesInput(state.invitesPerGroup);
  }, [isBs, state?.invitesPerGroup]);

  const finderItems = useMemo(
    () =>
      state?.groups && (!isBs || state.groups.length > 0)
        ? state.groups.map((g) => ({
            id: g.groupId,
            name: g.groupName,
            folderId: g.folderId,
            sortOrder: g.sortOrder,
            avatarUrl: g.avatarUrl,
            count: g.totalInvitedCount,
          }))
        : fallbackGroups.map((g) => ({
            id: g.id,
            name: g.name,
            folderId: g.folderId,
            sortOrder: g.sortOrder,
            avatarUrl: g.avatarUrl,
            count: 0,
          })),
    [state?.groups, fallbackGroups, isBs],
  );

  useEffect(() => {
    if (!state) return;
    const validIds = new Set(finderItems.map((i) => i.id));
    setSelectedGroups((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [state, finderItems]);

  const orderedSelectedGroupIds = useMemo(
    () =>
      orderedFinderItems(finderItems, folders)
        .filter((g) => selectedGroups.has(g.id))
        .map((g) => g.id),
    [finderItems, folders, selectedGroups],
  );
  const selectedIds = useMemo(() => [...selectedTargetIds], [selectedTargetIds]);
  const bsInstances = bluestacksState?.instances ?? [];
  const selectedInstances = useMemo(
    () => bsInstances.filter((i) => selectedTargetIds.has(i.id)),
    [bsInstances, selectedTargetIds],
  );
  const pageIdentitySelected = isBs
    ? selectedInstances.filter((i) => i.identityType === 'page')
    : [];
  const isRunning = isBs ? Boolean(bluestacksState?.inviterRunning) : Boolean(state?.running);
  const idleSelected = isBs ? [] : selectedIds.filter((id) => !state?.profileCounts?.[id]?.running);
  const totalInvited = finderItems.reduce((sum, item) => sum + item.count, 0);
  const normalizeInvites = (v: number) =>
    Number.isFinite(v) ? Math.max(1, Math.min(maxInvites, Math.round(v))) : defaultInvites;

  async function runBsAction(action: string, payload: unknown, okMsg: string, errFallback: string) {
    setLocalBusy(true);
    try {
      onBluestacksState?.(await api.bluestacksAction(action, payload));
      onMessage?.(okMsg);
    } catch (err) {
      onMessage?.(errMsg(err, errFallback));
    } finally {
      setLocalBusy(false);
    }
  }

  async function submitAddGroups(event: React.FormEvent) {
    event.preventDefault();
    const collected: Array<{ groupId: string; groupName: string; folderId?: string | null }> = [];
    for (const row of draftRows) {
      const groupId = extractGroupId(row.groupId);
      const groupName = row.groupName.trim();
      if (!groupId && !groupName) continue;
      if (!groupId) return setFormError('请填写每行的「小组ID或链接」');
      if (!/^[A-Za-z0-9._-]+$/.test(groupId))
        return setFormError(`小组ID「${groupId}」格式不正确，仅支持数字、字母、点、下划线或连字符`);
      collected.push({ groupId, groupName, folderId: addFolder });
    }
    if (!collected.length) return setFormError('请至少输入一行小组数据');
    setFormError('');
    setSubmittingAdd(true);
    try {
      if (p.onAddGroups) await p.onAddGroups(collected);
      else {
        await api.addInviterGroups({ items: collected });
        await onRefresh();
        onMessage?.(`已保存 ${collected.length} 个小组，正在后台获取小组头像`);
      }
      setAddingModalOpen(false);
    } catch (error) {
      setFormError(errMsg(error, '添加小组失败'));
    } finally {
      setSubmittingAdd(false);
    }
  }

  async function startRun(overrideGroupIds?: string[]) {
    const count = normalizeInvites((await invitesInputRef.current?.flush()) ?? invitesInput);
    if (!isBs)
      return void (await p.onStartBrowser?.(overrideGroupIds ?? orderedSelectedGroupIds, count));
    if (!selectedIds.length) return onMessage?.('请先在左侧蓝蝶窗口列表中勾选至少一个个人号模拟器');
    if (!orderedSelectedGroupIds.length) return onMessage?.('请至少勾选 1 个目标小组');
    await runBsAction(
      'inviter/start',
      { instanceIds: selectedIds, groupIds: orderedSelectedGroupIds, invitesPerGroup: count },
      `已启动蓝蝶小组邀请人（${selectedIds.length} 台蓝蝶 × ${orderedSelectedGroupIds.length} 个小组）`,
      '启动蓝蝶小组邀请人失败',
    );
  }

  const stopRun = () =>
    isBs
      ? runBsAction('inviter/stop', {}, '已发送停止蓝蝶小组邀请人指令', '停止失败')
      : Promise.resolve(p.onStopBrowser?.()).then(() => undefined);
  const statusText =
    state?.groupAvatarRefreshing && state.avatarRefreshStatusText
      ? state.avatarRefreshStatusText
      : isBs
        ? bluestacksState?.inviterStatusText
        : state?.statusText;
  const startDisabled = busy || !selectedIds.length || !selectedGroups.size;
  const startTitle = !selectedIds.length
    ? `请先在左侧${isBs ? '蓝蝶窗口列表' : '列表'}勾选账号`
    : !selectedGroups.size
      ? '请先在下方列表勾选小组'
      : isBs
        ? `使用已选的 ${selectedIds.length} 台蓝蝶向 ${orderedSelectedGroupIds.length} 个小组邀人（未启动窗口会自动拉起）`
        : `使用已选的 ${selectedIds.length} 个账号向 ${selectedGroups.size} 个小组随机错峰邀请好友`;

  const runAvatarCmd = (req: Promise<GroupInviterState>, fallback?: string) => {
    void req
      .then((next) => {
        const msg = next.avatarRefreshStatusText || (fallback ? '' : next.statusText) || fallback;
        if (msg) onMessage?.(msg);
        return onRefresh();
      })
      .catch((err) => onMessage?.(errMsg(err, String(err))))
      .finally(() => setRefreshingAvatars(false));
  };

  return (
    <section
      className="records-page bumper-page group-inviter-page flex h-full min-h-0 flex-col gap-2.5"
      aria-label={isBs ? '蓝蝶小组邀请人' : '小组邀请人'}
    >
      {p.scopeItems && p.onSelectTargets && (
        <TargetScopeBar
          carrier={carrier}
          items={p.scopeItems}
          groups={p.scopeGroups}
          selectedIds={selectedTargetIds}
          onSelect={p.onSelectTargets}
        />
      )}
      <div className="bumper-sticky-header sticky top-0 z-20 rounded-xl border border-[var(--line)] bg-white px-3.5 py-2.5 shadow-xs">
        <div className="bumper-heading flex flex-wrap items-center justify-between gap-2.5">
          <div className="bumper-primary-controls flex min-w-0 flex-wrap items-center gap-2">
            <div className="bumper-search-highlight bumper-policy flex flex-wrap items-center gap-2.5 rounded-lg border border-blue-200/80 bg-blue-50/45 px-2.5 py-1.5">
              <label
                className="bumper-policy-field inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]"
                title={
                  isBs
                    ? '每台蓝蝶进入每个小组单次最多邀请的好友人数（默认 5）'
                    : '每个账号进入每个小组单次最多邀请的好友人数（默认 30）'
                }
              >
                <span>每组邀请</span>
                <ControlledNumberInput
                  ref={invitesInputRef}
                  ariaLabel={isBs ? '每个小组邀请人数上限' : '每组邀请'}
                  className={`${UI_INPUT_SM} w-[66px] tabular-nums`}
                  min={1}
                  max={maxInvites}
                  defaultValue={defaultInvites}
                  disabled={busy || isRunning}
                  value={invitesInput}
                  onChange={setInvitesInput}
                  onCommit={(n) => {
                    setInvitesInput(n);
                    if (!isBs && state && n !== state.invitesPerGroup)
                      return p.onSaveInvitesPerGroup?.(n);
                  }}
                />
                <span>人</span>
              </label>
              {!isBs && (
                <span
                  className="bumper-policy-field inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]"
                  title="所有账号邀请完成后播放提示音"
                >
                  <UiSwitch
                    ariaLabel="完成后播放提示音"
                    label="完成后播放提示音"
                    disabled={busy}
                    checked={state?.playSoundOnComplete !== false}
                    onCheckedChange={(checked) =>
                      void api
                        .saveGroupInviterSettings({ playSoundOnComplete: checked })
                        .then(() => onRefresh())
                        .catch((err) => onMessage?.(errMsg(err, '保存提示音设置失败')))
                    }
                  />
                </span>
              )}
              <span className="bumper-policy-field text-xs text-[var(--text-3)]">
                共 {finderItems.length} 个小组 · 累计邀请 {totalInvited} 人
              </span>
            </div>
          </div>

          <div className="bumper-actions flex flex-wrap items-center justify-end gap-2">
            {statusText &&
              (isRunning && p.onOpenLiveRuns ? (
                <button
                  type="button"
                  className="m-0 inline-flex h-[22px] items-center gap-1 rounded-full border-0 bg-[var(--run-soft)] px-2 text-xs font-semibold whitespace-nowrap text-[var(--run)] transition-colors hover:bg-blue-100"
                  role="status"
                  title="点击查看实时任务队列"
                  onClick={p.onOpenLiveRuns}
                >
                  <span>{statusText}</span>
                  <span className="opacity-75">· 查看队列</span>
                </button>
              ) : (
                <span
                  className={`m-0 inline-flex h-[22px] items-center rounded-full px-2 text-xs whitespace-nowrap ${isRunning || state?.groupAvatarRefreshing ? 'bg-[var(--run-soft)] font-semibold text-[var(--run)]' : 'bg-[var(--surface-3)] text-[var(--text-2)]'}`}
                  role="status"
                >
                  {statusText}
                </span>
              ))}
            {isBs && (
              <span className="pill inline-flex h-6 items-center rounded-full bg-[var(--surface-3)] px-2.5 text-xs font-medium text-[var(--text-2)]">
                已选蓝蝶 {selectedIds.length} 台
              </span>
            )}
            {!isBs && isRunning && idleSelected.length > 0 && (
              <Btn
                v="primary"
                sm={false}
                disabled={busy || !idleSelected.length || !selectedGroups.size}
                onClick={() => void startRun()}
              >
                <IconPlay size={12} /> 追加运行已选闲置号 ({idleSelected.length})
              </Btn>
            )}
            {isRunning ? (
              <Btn v="danger" sm={false} disabled={busy} onClick={() => void stopRun()}>
                <IconStop size={13} /> {isBs ? '停止邀人' : '停止运行'}
              </Btn>
            ) : (
              <Btn
                v="primary"
                sm={false}
                disabled={startDisabled}
                title={startTitle}
                onClick={() => void startRun()}
              >
                <IconPlay size={12} />{' '}
                {isBs
                  ? busy
                    ? '启动中…'
                    : `开始蓝蝶邀人 (${selectedIds.length}台 × ${orderedSelectedGroupIds.length}组)`
                  : `开始运行 (${selectedIds.length}号 × ${selectedGroups.size}组)`}
              </Btn>
            )}
            {onQuickSchedule && (
              <Btn
                sm={false}
                disabled={busy || !orderedSelectedGroupIds.length}
                title={
                  isBs
                    ? '将所选小组与邀请人数一键加入蓝蝶定时排班'
                    : '将所选小组与邀请人数一键加入定时排班'
                }
                onClick={() =>
                  void (async () => {
                    const perGroup = normalizeInvites(
                      (await invitesInputRef.current?.flush()) ?? invitesInput,
                    );
                    onQuickSchedule({
                      carrier,
                      name: isBs ? '蓝蝶小组邀人' : '小组邀人',
                      targetIds: selectedIds,
                      steps: [
                        isBs
                          ? {
                              id: crypto.randomUUID(),
                              type: 'bluestacks-group-inviter',
                              groupIds: [...orderedSelectedGroupIds],
                              invitesPerGroup: perGroup,
                            }
                          : {
                              id: crypto.randomUUID(),
                              type: 'group-inviter',
                              groupIds: [...orderedSelectedGroupIds],
                              invitesPerGroup: perGroup,
                              playSoundOnComplete: state?.playSoundOnComplete !== false,
                            },
                      ],
                    } as QuickScheduleSeed);
                  })()
                }
              >
                <IconClock size={13} /> 加入排班
              </Btn>
            )}
          </div>
        </div>
      </div>

      {pageIdentitySelected.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[13px] leading-relaxed text-amber-900 shadow-xs">
          <strong>身份提示：</strong>已选窗口中有 {pageIdentitySelected.length} 台当前为
          <strong>专页身份</strong>（
          {pageIdentitySelected.map((i) => bluestacksDisplayTitle(i)).join('、')}）。Facebook
          仅支持个人号邀请好友进群，专页身份运行时将自动安全跳过；可在左侧栏点击「⋯ → 切换个人 /
          专页身份」先切回个人主号。
        </div>
      )}

      {!loaded ? (
        <p className="rounded-xl border border-dashed border-[var(--line-strong)] bg-white px-4 py-12 text-center text-xs text-[var(--text-3)]">
          正在读取小组库…
        </p>
      ) : (
        <FinderTargetList
          listKind="shared_groups"
          title="小组列表"
          countLabel="累计被邀请人数"
          disabled={busy}
          items={finderItems}
          selected={selectedGroups}
          onSelect={setSelectedGroups}
          onDelete={
            p.onDeleteGroups ??
            (async (ids) => {
              await api.deleteInviterGroups({ groupIds: ids });
              await onRefresh();
              onMessage?.(`已删除 ${ids.length} 个小组`);
            })
          }
          onChanged={onRefresh}
          onFolders={setFolders}
          tools={
            <Btn
              disabled={busy}
              onClick={() => {
                setAddFolder(null);
                setDraftRows(Array.from({ length: 5 }, () => makeDraftRow()));
                setFormError('');
                setAddingModalOpen(true);
              }}
            >
              ＋ 添加小组
            </Btn>
          }
          moreItems={[
            refreshingAvatars || state?.groupAvatarRefreshing
              ? {
                  label: '停止刷新头像',
                  disabled: busy,
                  onSelect: () =>
                    runAvatarCmd(api.stopRefreshGroupInviterGroups(), '已停止读取小组资料'),
                }
              : {
                  label: '刷新头像',
                  disabled: busy || isRunning || finderItems.length === 0,
                  onSelect: () => {
                    setRefreshingAvatars(true);
                    runAvatarCmd(
                      api.refreshGroupInviterGroups(
                        selectedGroups.size ? { ids: [...selectedGroups] } : {},
                      ),
                    );
                  },
                },
          ]}
        />
      )}

      <TargetAddModal
        open={addingModalOpen}
        folders={folders}
        addFolder={addFolder}
        onFolderChange={setAddFolder}
        rows={draftRows}
        onRowsChange={setDraftRows}
        busy={submittingAdd}
        error={formError}
        onError={setFormError}
        normalizeId={extractGroupId}
        onClose={() => setAddingModalOpen(false)}
        onSubmit={(event) => void submitAddGroups(event)}
      />
    </section>
  );
}
