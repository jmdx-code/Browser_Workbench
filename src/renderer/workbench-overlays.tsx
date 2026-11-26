import { lazy, Suspense, useEffect, useState, type RefObject } from 'react';
import type { z } from 'zod';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import { profileDisplayName, type Profile, type SavedCombination } from '../shared/contracts.js';
import type { SoftwareUpdateStatus } from '../shared/software-update.js';
import type { TaskRuntimeOverview } from '../shared/task-contracts.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { IconClose } from './icons.js';
import type { LiveRunCard } from './modules/live-run-cards.js';
import {
  BackdropModal,
  Btn,
  errMsg,
  ModalHeading,
  useBusyTask,
} from './modules/shared/module-ui.js';
import { NameDialog } from './name-dialog.js';
import type { ResourceEditorHandle } from './resource-table-editor.js';
import type { ShellCtx } from './workbench-view-router.js';

const AppMenu = lazy(() => import('./app-menu.js').then((m) => ({ default: m.AppMenu })));
const RecordDetailDrawer = lazy(() =>
  import('./record-detail.js').then((m) => ({ default: m.RecordDetailDrawer })),
);
const ResourceTableEditor = lazy(() =>
  import('./resource-table-editor.js').then((m) => ({ default: m.ResourceTableEditor })),
);
const AutoSchedulerEditorModal = lazy(() =>
  import('./auto-scheduler-editor-modal.js').then((m) => ({ default: m.AutoSchedulerEditorModal })),
);
const LiveRunsDrawer = lazy(() =>
  import('./modules/live-runs-drawer.js').then((m) => ({ default: m.LiveRunsDrawer })),
);

type UpdateStatus = z.infer<typeof SoftwareUpdateStatus>;
const FEEDBACK_DIR_KEY = 'workbench.feedbackTargetDir';

function DiagnosticFeedbackModal({
  uiContext,
  onClose,
  onNotify,
}: {
  uiContext: string;
  onClose: () => void;
  onNotify: (msg: string) => void;
}) {
  const [note, setNote] = useState(''),
    [targetDir, setTargetDir] = useState(() => {
      try {
        return localStorage.getItem(FEEDBACK_DIR_KEY) ?? '';
      } catch {
        return '';
      }
    }),
    [result, setResult] = useState<{
      filePath: string;
      fileName: string;
      sizeBytes: number;
    } | null>(null);
  const { busy: gen, error, setError, run } = useBusyTask();

  useEffect(() => {
    setError('');
    setResult(null);
    setNote('');
  }, [setError]);
  const updateDir = (dir: string) => {
    setTargetDir(dir);
    try {
      if (dir) localStorage.setItem(FEEDBACK_DIR_KEY, dir);
      else localStorage.removeItem(FEEDBACK_DIR_KEY);
    } catch {}
  };

  return (
    <BackdropModal
      label="记录并导出问题反馈包"
      modalClass="w-[min(460px,92vw)]"
      busy={gen}
      onClose={onClose}
    >
      <ModalHeading
        title="记录并导出问题反馈包"
        className="px-0 pt-0 pb-2.5"
        disabled={gen}
        onClose={onClose}
      />
      <p className="m-0 text-xs leading-relaxed text-[var(--text-3)]">
        一键打包当前所有浏览器状态、任务账本、顶贴/邀请日志与内核黑匣子记录（自动保存在本地并弹出文件夹，可直接拖入微信/TG发送排查）。
      </p>
      <label className="mb-1 block text-xs font-medium text-[var(--text-2)]">
        问题简述（选填）
      </label>
      <textarea
        autoFocus
        className="min-h-[120px] w-full resize-y rounded-md border border-[var(--line-strong)] bg-white px-2.5 py-2 font-mono text-xs leading-normal text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
        aria-label="问题简述（选填）"
        rows={4}
        placeholder="例如：哪个浏览器、在执行什么步骤时卡住或报错（不填也可直接生成）"
        value={note}
        disabled={gen}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-2 text-xs">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 font-semibold text-[var(--text)]">保存目录</div>
          <div className="leading-[1.4] break-all text-[var(--text-3)]">
            {targetDir || '默认目录（点击右侧可自定义保存位置）'}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {targetDir && (
            <Btn v="ghost" disabled={gen} onClick={() => updateDir('')}>
              恢复默认
            </Btn>
          )}
          <Btn
            disabled={gen}
            onClick={() => {
              if (typeof window.workbenchDesktop?.chooseFeedbackDirectory !== 'function')
                return onNotify('当前环境不支持选择本地文件夹，将使用默认目录保存');
              void window.workbenchDesktop
                .chooseFeedbackDirectory()
                .then((c) => c && updateDir(c))
                .catch((e) => onNotify(errMsg(e, '选择保存目录失败')));
            }}
          >
            选择目录…
          </Btn>
        </div>
      </div>
      {error && (
        <p
          className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
          role="alert"
        >
          {error}
        </p>
      )}
      {result && (
        <div
          className="mt-1 flex flex-col items-start gap-1.5 rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-2 text-xs text-[var(--text-2)]"
          role="status"
        >
          <strong>
            已生成反馈包：{result.fileName}（
            {result.sizeBytes >= 1048576
              ? `${(result.sizeBytes / 1048576).toFixed(2)} MB`
              : `${Math.max(1, Math.round(result.sizeBytes / 1024))} KB`}
            ）
          </strong>
          <small className="leading-[1.4] break-all text-[var(--text-3)] select-all">
            路径：{result.filePath}
          </small>
          <div className="mt-1 flex gap-2">
            <Btn
              onClick={() =>
                void api
                  .revealDiagnosticPackage(result.filePath, targetDir || undefined)
                  .then(() => onNotify('已在资源管理器中定位反馈包文件'))
                  .catch((e) => onNotify(errMsg(e, '打开所在文件夹失败')))
              }
            >
              打开所在文件夹
            </Btn>
            <Btn
              onClick={() =>
                void copyTextToClipboard(result.filePath)
                  .then(() => onNotify(`已复制反馈包路径：${result.filePath}`))
                  .catch((e) => onNotify(errMsg(e, '复制路径失败')))
              }
            >
              复制文件路径
            </Btn>
          </div>
        </div>
      )}
      <div className="mt-1 flex shrink-0 justify-end gap-2">
        <Btn sm={false} disabled={gen} onClick={onClose}>
          {result ? '关闭' : '取消'}
        </Btn>
        <Btn
          v="primary"
          sm={false}
          disabled={gen}
          onClick={() =>
            void run(async () => {
              const res = await api.recordDiagnosticSnapshot({
                note: note.trim() || undefined,
                uiContext,
                targetDir: targetDir.trim() || undefined,
              });
              setResult(res);
              onNotify(`已生成问题反馈包：${res.fileName}`);
            }, '生成问题反馈包失败')
          }
        >
          {gen ? '正在打包反馈包…' : '生成反馈包并打开文件夹'}
        </Btn>
      </div>
    </BackdropModal>
  );
}

export function WorkbenchOverlays(p: {
  shell: ShellCtx | null;
  message: string;
  detail: { profileId: string; planId: string; round?: number } | null;
  onCloseDetail: () => void;
  plans: z.infer<typeof TaskRuntimeOverview>['plans'];
  onRename: (profile: Profile) => void;
  onOpenResource: (row: SavedCombination | null) => void;
  menuOpen: boolean;
  updateMenu: boolean;
  menuSection?: 'update' | 'google-sheets' | 'logs' | undefined;
  onCloseMenu: () => void;
  updates: { status: UpdateStatus | null; setStatus: (next: UpdateStatus) => void; error: string };
  onApplyUpdate: () => Promise<void>;
  restartDisabled: boolean;
  resourceRow: SavedCombination | null;
  resourceEditorRef: RefObject<ResourceEditorHandle | null>;
  onSavedResource: () => Promise<void>;
  aliasing: Profile | null;
  onCloseAliasing: () => void;
  diagModalOpen: boolean;
  onOpenDiagModal?: () => void;
  onCloseDiagModal: () => void;
  onOpenWindowLayout?: () => void;
  quickScheduleSeed: QuickScheduleSeed | null;
  onCloseQuickSchedule: () => void;
  liveQueueOpen: boolean;
  onCloseLiveQueue: () => void;
  liveRunCards: readonly LiveRunCard[];
}) {
  const s = p.shell,
    ws = s?.workspace ?? null,
    setMsg = s?.setMessage ?? (() => {}),
    detailProf = p.detail ? ws?.profiles.find((r) => r.id === p.detail?.profileId) : undefined,
    failed = /失败|错误|未完成|不能|无法|请先|未确认/.test(
      p.message.replace(/\b0\s*份未完成/g, ''),
    );

  return (
    <>
      {p.message && (
        <div
          className={`fixed right-5 bottom-5 z-300 flex max-w-[min(480px,calc(100vw-40px))] items-start gap-2.5 rounded-xl border-l-[3px] bg-[var(--graphite)] py-2.5 pr-2 pl-4 leading-relaxed wrap-anywhere text-[#f1f3f6] shadow-xl ${
            failed ? 'border-l-[var(--warn-dot)]' : 'border-l-[var(--ok)]'
          }`}
          role="status"
        >
          <span className="flex-1 text-xs">{p.message}</span>
          <Btn
            v="icon"
            className="h-6 w-6 text-slate-300 hover:bg-white/10 hover:text-white"
            onClick={() => setMsg('')}
            aria-label="关闭提示"
          >
            <IconClose size={14} />
          </Btn>
        </div>
      )}
      <Suspense fallback={null}>
        {p.quickScheduleSeed && s && ws && (
          <AutoSchedulerEditorModal
            initial={null}
            seed={p.quickScheduleSeed}
            browserConcurrency={s.mods.autoScheduler?.settings.browserConcurrency ?? 15}
            bluestacksConcurrency={s.mods.autoScheduler?.settings.bluestacksConcurrency ?? 5}
            profiles={ws.profiles}
            profileGroups={ws.groups}
            selectedProfileIds={s.selected}
            combinations={ws.combinations}
            sharedGroups={s.mods.groupBumper?.groups ?? []}
            sharedPages={s.mods.groupBumper?.pages ?? []}
            inviterGroups={s.mods.groupInviter?.groups ?? []}
            posterMaterials={s.mods.groupPoster?.materials ?? []}
            bluestacksState={s.mods.bluestacks}
            onClose={p.onCloseQuickSchedule}
            onSave={async (payload) => {
              s.mods.setAutoScheduler(await api.autoSchedulerAction('schedules/save', payload));
              p.onCloseQuickSchedule();
              setMsg('已加入定时排班');
            }}
          />
        )}
        {p.liveQueueOpen && s && (
          <LiveRunsDrawer
            open={p.liveQueueOpen}
            onClose={p.onCloseLiveQueue}
            cards={p.liveRunCards}
            busy={s.busy}
            onShowBrowser={(id) =>
              void s.mutate(() => api.showBrowser(id).then(() => '已定位显示对应浏览器窗口'))
            }
            onShowBluestacks={(instanceId) =>
              void s.mutate(() =>
                api.bluestacksAction('instances/show', { instanceId }).then((next) => {
                  s.mods.setBluestacks(next);
                  return '已定位显示对应蓝蝶窗口';
                }),
              )
            }
            onStopCard={s.actions.handleStopCard}
            onStopAll={s.actions.handleStopAllCards}
          />
        )}
        {p.detail && s && ws && (
          <RecordDetailDrawer
            profile={detailProf}
            planId={p.detail.planId}
            round={p.detail.round}
            plan={p.plans.find((pl) => pl.id === p.detail?.planId)}
            workspace={ws}
            inspection={s.inspections.rows.find((r) => r.profileId === p.detail?.profileId)}
            inspectionAvailable={s.inspections.available}
            inspectionError={s.inspections.error}
            busy={s.busy}
            onClose={p.onCloseDetail}
            onCommand={s.actions.commandPlans}
            onRename={p.onRename}
            onReadInspections={() => void s.inspections.refresh()}
            onCheck={s.actions.checkProfiles}
            onResources={(id) => {
              const row = ws.combinations.find((v) => v.id === id);
              if (row) p.onOpenResource(row);
              else setMsg('原任务组合已不在当前列表，请查看原任务记录。');
            }}
          />
        )}
        {p.menuOpen && s && ws && (
          <AppMenu
            initialSection={p.menuSection ?? (p.updateMenu ? 'update' : undefined)}
            onGoogleSheetsChanged={s.mods.refreshGoogleSheets}
            onNotify={setMsg}
            onOpenDiagnosticModal={p.onOpenDiagModal}
            onOpenWindowLayout={p.onOpenWindowLayout}
            updateStatus={p.updates.status}
            onUpdateStatus={p.updates.setStatus}
            onApplyUpdate={p.onApplyUpdate}
            updateError={p.updates.error}
            profiles={ws.profiles}
            selected={s.selected}
            runtime={s.tasks.runtime}
            busy={s.busy}
            restartDisabled={p.restartDisabled}
            onClose={p.onCloseMenu}
            onRefresh={() => {
              s.tasks.refresh();
              void s.forceRefreshWorkspace();
            }}
            onRestart={() =>
              void s.mutate(() => api.restartSoftware().then(() => '软件正在重启，请稍候'))
            }
          />
        )}
        {p.resourceRow && (
          <ResourceTableEditor
            ref={p.resourceEditorRef}
            key={p.resourceRow.id}
            combination={p.resourceRow}
            onClose={() => p.onOpenResource(null)}
            onSaved={p.onSavedResource}
          />
        )}
        {p.diagModalOpen && (
          <DiagnosticFeedbackModal
            uiContext={s?.projection.diagUiContext ?? ''}
            onClose={p.onCloseDiagModal}
            onNotify={setMsg}
          />
        )}
      </Suspense>
      {p.aliasing && s && (
        <NameDialog
          title="浏览器别名"
          initial={profileDisplayName(p.aliasing)}
          onClose={p.onCloseAliasing}
          onSubmit={async (alias) => {
            await api.rename(p.aliasing?.id ?? '', alias);
            await s.forceRefreshWorkspace();
          }}
        />
      )}
    </>
  );
}
