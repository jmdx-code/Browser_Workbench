import type { ComponentProps, RefObject } from 'react';
import type { z } from 'zod';
import type { Profile, SavedCombination, Workspace } from '../shared/contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import type { SoftwareUpdateStatus } from '../shared/software-update.js';
import type { TaskCommand, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { api } from './api.js';
import { AppMenu } from './app-menu.js';
import { DiagnosticFeedbackModal } from './diagnostic-feedback-modal.js';
import { IconClose } from './icons.js';
import { NameDialog } from './name-dialog.js';
import { RecordDetailDrawer } from './record-detail.js';
import { ResourceTableEditor, type ResourceEditorHandle } from './resource-table-editor.js';

type RuntimeOverview = z.infer<typeof TaskRuntimeOverview>;
type UpdateStatus = z.infer<typeof SoftwareUpdateStatus>;
type DiagUiContext = ComponentProps<typeof DiagnosticFeedbackModal>['uiContext'];

export function WorkbenchOverlays({
  workspace,
  message,
  onMessage,
  detail,
  onCloseDetail,
  plans,
  inspections,
  busy,
  onCommand,
  onRename,
  onCheck,
  onOpenResource,
  menuOpen,
  updateMenu,
  onCloseMenu,
  updates,
  onApplyUpdate,
  selected,
  runtime,
  restartDisabled,
  onRefreshTasks,
  mutate,
  resourceRow,
  resourceEditorRef,
  onSavedResource,
  aliasing,
  onCloseAliasing,
  onRefreshWorkspace,
  diagModalOpen,
  diagUiContext,
  onCloseDiagModal,
}: {
  workspace: Workspace | null;
  message: string;
  onMessage: (msg: string) => void;
  detail: { profileId: string; planId: string; round?: number } | null;
  onCloseDetail: () => void;
  plans: RuntimeOverview['plans'];
  inspections: {
    rows: Inspection[];
    available: boolean;
    error: string;
    refresh: () => Promise<unknown>;
  };
  busy: boolean;
  onCommand: (command: TaskCommand['command'], plans: TaskCommand['plans']) => void;
  onRename: (profile: Profile) => void;
  onCheck: (ids: string[]) => void;
  onOpenResource: (row: SavedCombination | null) => void;
  menuOpen: boolean;
  updateMenu: boolean;
  onCloseMenu: () => void;
  updates: {
    status: UpdateStatus | null;
    setStatus: (next: UpdateStatus) => void;
    error: string;
  };
  onApplyUpdate: () => Promise<void>;
  selected: Set<string>;
  runtime: RuntimeOverview | null;
  restartDisabled: boolean;
  onRefreshTasks: () => void;
  mutate: (work: () => Promise<unknown>) => Promise<void>;
  resourceRow: SavedCombination | null;
  resourceEditorRef: RefObject<ResourceEditorHandle | null>;
  onSavedResource: () => Promise<void>;
  aliasing: Profile | null;
  onCloseAliasing: () => void;
  onRefreshWorkspace: () => Promise<unknown>;
  diagModalOpen: boolean;
  diagUiContext: DiagUiContext;
  onCloseDiagModal: () => void;
}) {
  const detailProfile = detail
    ? workspace?.profiles.find((row) => row.id === detail.profileId)
    : undefined;
  const failedMessage = /失败|错误|未完成|不能|无法|请先|未确认/.test(message);
  return (
    <>
      {message && (
        <div className={'toast' + (failedMessage ? ' toast-warn' : '')} role="status">
          <span>{message}</span>
          <button
            className="btn btn-icon btn-ghost"
            onClick={() => onMessage('')}
            aria-label="关闭提示"
          >
            <IconClose size={14} />
          </button>
        </div>
      )}
      {detail && workspace && (
        <RecordDetailDrawer
          profile={detailProfile}
          planId={detail.planId}
          round={detail.round}
          plan={plans.find((plan) => plan.id === detail.planId)}
          workspace={workspace}
          inspection={inspections.rows.find((row) => row.profileId === detail.profileId)}
          inspectionAvailable={inspections.available}
          inspectionError={inspections.error}
          busy={busy}
          onClose={onCloseDetail}
          onCommand={onCommand}
          onRename={onRename}
          onReadInspections={() => void inspections.refresh()}
          onCheck={onCheck}
          onResources={(combinationId) => {
            const row = workspace.combinations.find((value) => value.id === combinationId);
            if (row) onOpenResource(row);
            else onMessage('原任务组合已不在当前列表，请查看原任务记录。');
          }}
        />
      )}
      {menuOpen && workspace && (
        <AppMenu
          initialSection={updateMenu ? 'update' : undefined}
          updateStatus={updates.status}
          onUpdateStatus={updates.setStatus}
          onApplyUpdate={onApplyUpdate}
          updateError={updates.error}
          profiles={workspace.profiles}
          selected={selected}
          runtime={runtime}
          busy={busy}
          restartDisabled={restartDisabled}
          onClose={onCloseMenu}
          onRefresh={() => {
            onRefreshTasks();
            void onRefreshWorkspace();
          }}
          onRestart={() =>
            void mutate(async () => {
              await api.restartSoftware();
              return '软件正在重启，请稍候';
            })
          }
        />
      )}
      {resourceRow && (
        <ResourceTableEditor
          ref={resourceEditorRef}
          key={resourceRow.id}
          combination={resourceRow}
          onClose={() => onOpenResource(null)}
          onSaved={onSavedResource}
        />
      )}
      {aliasing && (
        <NameDialog
          title="浏览器别名"
          initial={aliasing.alias}
          onClose={onCloseAliasing}
          onSubmit={async (alias) => {
            await api.rename(aliasing.id, alias);
            await onRefreshWorkspace();
          }}
        />
      )}
      <DiagnosticFeedbackModal
        open={diagModalOpen}
        uiContext={diagUiContext}
        onClose={onCloseDiagModal}
        onNotify={onMessage}
      />
    </>
  );
}
