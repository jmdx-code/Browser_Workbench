import type { BluestacksState } from '../../../shared/bluestacks.js';
import type { Group, Profile } from '../../../shared/contracts.js';
import type {
  GoogleSheetKind,
  GoogleSheetLink,
  PostRecordsSheetConfig,
  PostScheduleSheetConfig,
  ScheduleExecutionCarrier,
  SheetGridSnapshot,
} from '../../../shared/google-sheets.js';
import { api } from '../../api.js';
import { IconRefresh } from '../../icons.js';
import { UI_INPUT_SM, UI_SELECT_SM } from '../../ui/primitives.js';
import { Btn, Chk } from '../shared/module-ui.js';
import { RecordsAccountGroupDropdown, ScheduleBluestacksDropdown } from './sheet-config-modal.js';

export function GoogleSheetsTopbar(p: {
  kind: GoogleSheetKind;
  title: string;
  addLabel: string;
  activeLink: GoogleSheetLink | null;
  activeGrid: SheetGridSnapshot | null;
  allRecordLinks: readonly GoogleSheetLink[];
  profileGroups: readonly Group[];
  profiles: readonly Profile[];
  bluestacksState?: BluestacksState | null;
  isAuthorized: boolean;
  isMinimalGridKind: boolean;
  isRunning: boolean;
  isAutoEnabled: boolean;
  gridLoading: boolean;
  busyAction: string | null;
  stoppingLink: boolean;
  patchingConfig: boolean;
  machineNameDraft: string;
  onRefreshGrid: (id: string) => void;
  onOpenConnect: () => void;
  onOpenConnectRecordForSchedule: (id: string) => void;
  onOpenImportModal: () => void;
  onOpenBumpModal: () => void;
  onOpenFreqModal: () => void;
  onConfirmDisconnect: (l: GoogleSheetLink) => void;
  onRunAction: (label: string, work: () => Promise<string | void>) => void;
  onStopActiveLink: (id: string) => void;
  onPatchScheduleConfig: (
    id: string,
    patch: Partial<PostScheduleSheetConfig>,
    toast?: string,
  ) => void;
  onPatchRecordsConfig: (
    id: string,
    patch: Partial<PostRecordsSheetConfig>,
    toast?: string,
  ) => void;
  onMachineNameChange: (id: string, val: string) => void;
  onMachineNameBlur: () => void;
}) {
  const {
    activeLink,
    busyAction,
    isAuthorized,
    isAutoEnabled,
    isRunning,
    patchingConfig,
    stoppingLink,
  } = p;
  const ctrlCls = `${UI_SELECT_SM} max-w-[175px]`,
    busy = Boolean(busyAction);

  const autoRunPair = (
    onLbl: string,
    offLbl: string,
    stopLbl: string,
    runLbl: string,
    busyLbl: string,
    tip: string,
    onToggle: () => void,
    onRun: () => Promise<string | void>,
  ) =>
    activeLink && (
      <>
        <span className="h-[18px] w-px bg-[var(--line)]" aria-hidden="true" />
        <Btn
          className={`inline-flex items-center gap-1.5 font-semibold ${isAutoEnabled ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'text-[var(--muted)]'}`}
          disabled={busy || patchingConfig || !isAuthorized}
          onClick={onToggle}
        >
          <i
            className={`inline-block h-[7px] w-[7px] rounded-full ${isAutoEnabled ? 'bg-emerald-600' : 'bg-slate-400'}`}
          />
          {isAutoEnabled ? onLbl : offLbl}
        </Btn>
        {isRunning ? (
          <Btn v="danger" disabled={stoppingLink} onClick={() => p.onStopActiveLink(activeLink.id)}>
            {stoppingLink ? '停止中…' : stopLbl}
          </Btn>
        ) : (
          <Btn
            disabled={busy || !isAuthorized}
            title={tip}
            onClick={() => p.onRunAction(runLbl, onRun)}
          >
            {busyAction === runLbl ? busyLbl : runLbl}
          </Btn>
        )}
      </>
    );

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-white px-3 py-2 shadow-xs">
      <div className="flex items-center gap-1.5">
        <h2 className="m-0 text-[15px] font-bold">{p.title}</h2>
        {activeLink && (
          <a
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[var(--line)] bg-white text-xs text-[var(--text-2)] no-underline hover:bg-slate-100"
            href={activeLink.spreadsheetUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="在浏览器中打开原 Google 表格"
            title={`在浏览器中打开：${activeLink.spreadsheetTitle} / ${activeLink.sheetName}`}
          >
            ↗
          </a>
        )}
        {p.isMinimalGridKind && activeLink && isAuthorized && (
          <Btn
            v="icon"
            disabled={p.gridLoading}
            aria-label="刷新表格"
            title={
              p.activeGrid
                ? `刷新表格（同步于 ${new Date(p.activeGrid.fetchedAt).toLocaleTimeString()}）`
                : '刷新表格'
            }
            onClick={() => p.onRefreshGrid(activeLink.id)}
          >
            <IconRefresh size={13} className={p.gridLoading ? 'animate-spin' : undefined} />
          </Btn>
        )}
        {activeLink && isRunning && (
          <span className="inline-flex items-center rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-[var(--brand)]">
            {activeLink.runtime.activeJobText || '执行中…'}
          </span>
        )}
        {activeLink?.runtime.lastError && (
          <span
            className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-rose-700"
            title={activeLink.runtime.lastError}
          >
            异常
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {!activeLink ? (
          <Btn v="primary" disabled={!isAuthorized} onClick={p.onOpenConnect}>
            + {p.addLabel}
          </Btn>
        ) : (
          <>
            {(p.kind === 'group_library' || p.kind === 'page_library') && (
              <>
                <Btn disabled={busy || !isAuthorized} onClick={p.onOpenImportModal}>
                  从表格导入
                </Btn>
                <Btn
                  v="primary"
                  disabled={busy || !isAuthorized}
                  onClick={() =>
                    p.onRunAction(
                      '同步至表格',
                      async () => (await api.googleSheetsSyncLibrary(activeLink.id)).summary,
                    )
                  }
                >
                  {busyAction === '同步至表格' ? '同步中…' : '同步至表格'}
                </Btn>
                <Btn disabled={busy || !isAuthorized} onClick={p.onOpenConnect}>
                  换表
                </Btn>
                <Btn v="danger" disabled={busy} onClick={() => p.onConfirmDisconnect(activeLink)}>
                  断开
                </Btn>
              </>
            )}
            {p.kind === 'post_schedule' && (
              <>
                <select
                  className={ctrlCls}
                  aria-label="选择要登记的发帖记录表"
                  title="选择发帖后登记的发帖记录表"
                  disabled={busy || patchingConfig}
                  value={activeLink.scheduleConfig?.targetRecordLinkId ?? ''}
                  onChange={(e) => {
                    const nid = e.target.value || null,
                      rt = p.allRecordLinks.find((r) => r.id === nid)?.title ?? '不登记记录表';
                    p.onPatchScheduleConfig(
                      activeLink.id,
                      { targetRecordLinkId: nid },
                      nid ? `已绑定记录表「${rt}」` : '已取消登记记录表',
                    );
                  }}
                >
                  <option value="">不登记记录表</option>
                  {p.allRecordLinks.map((rec) => (
                    <option key={rec.id} value={rec.id}>
                      记录表：{rec.title}
                    </option>
                  ))}
                </select>
                {isAuthorized && (
                  <Btn
                    title="连接新的发帖记录表并绑定"
                    aria-label="连接新发帖记录表"
                    disabled={busy}
                    onClick={() => p.onOpenConnectRecordForSchedule(activeLink.id)}
                  >
                    ＋记录表
                  </Btn>
                )}
                <select
                  className={ctrlCls}
                  aria-label="选择发帖执行方式"
                  title="选择发帖执行方式"
                  disabled={busy || patchingConfig}
                  value={activeLink.scheduleConfig?.executionCarrier ?? 'browser'}
                  onChange={(e) =>
                    p.onPatchScheduleConfig(activeLink.id, {
                      executionCarrier: e.target.value as ScheduleExecutionCarrier,
                    })
                  }
                >
                  <option value="browser">仅浏览器</option>
                  <option value="bluestacks">仅蓝蝶模拟器</option>
                  <option value="auto">双引擎自动</option>
                </select>
                {(activeLink.scheduleConfig?.executionCarrier ?? 'browser') !== 'browser' && (
                  <ScheduleBluestacksDropdown
                    link={activeLink}
                    bluestacksState={p.bluestacksState}
                    disabled={busy}
                    onChange={(patch) => p.onPatchScheduleConfig(activeLink.id, patch)}
                  />
                )}
                {autoRunPair(
                  '自动发帖：已开启',
                  '开启自动发帖',
                  '停止发帖',
                  '立即发一次',
                  '执行中…',
                  '不等定时轮询，现在立刻执行一次到期排贴',
                  () =>
                    p.onPatchScheduleConfig(
                      activeLink.id,
                      { enabled: !isAutoEnabled },
                      !isAutoEnabled ? '已开启自动发帖' : '已关闭自动发帖',
                    ),
                  async () => (await api.googleSheetsPollSchedule(activeLink.id)).summary,
                )}
              </>
            )}
            {p.kind === 'post_records' && (
              <>
                <RecordsAccountGroupDropdown
                  link={activeLink}
                  profileGroups={p.profileGroups}
                  profiles={p.profiles}
                  bluestacksState={p.bluestacksState}
                  disabled={busy}
                  onChange={(patch) => p.onPatchRecordsConfig(activeLink.id, patch)}
                />
                <input
                  type="text"
                  maxLength={60}
                  className={`${UI_INPUT_SM} w-[92px]`}
                  aria-label="本机名字"
                  title="本机名字（右侧顶贴计数列名，修改后自动保存）"
                  placeholder="本机名字"
                  disabled={busy}
                  value={p.machineNameDraft}
                  onChange={(e) => p.onMachineNameChange(activeLink.id, e.target.value)}
                  onBlur={p.onMachineNameBlur}
                />
                <Btn disabled={busy} onClick={p.onOpenBumpModal}>
                  顶贴配置
                </Btn>
                <Chk
                  className="gs-bar-check h-7 rounded-md border border-[var(--line-strong)] bg-white px-2 whitespace-nowrap hover:border-slate-400"
                  label="本机采赞评"
                  title="由本机采集满 24h / 72h 贴文的点赞与评论数"
                  disabled={busy}
                  checked={Boolean(activeLink.recordsConfig?.collectMetricsOnThisPc)}
                  onChange={(c) =>
                    p.onPatchRecordsConfig(activeLink.id, { collectMetricsOnThisPc: c })
                  }
                />
                <Btn
                  disabled={busy || !isAuthorized}
                  title="立刻采集已满 24h / 72h 贴文的点赞和评论数"
                  onClick={() =>
                    p.onRunAction(
                      '采集赞/评',
                      async () => (await api.googleSheetsRefreshMetrics(activeLink.id)).summary,
                    )
                  }
                >
                  {busyAction === '采集赞/评' ? '采集中…' : '采集赞/评'}
                </Btn>
                <Btn disabled={busy} onClick={p.onOpenFreqModal}>
                  频率限制
                </Btn>
                {autoRunPair(
                  '自动顶贴：已开启',
                  '开启自动顶贴',
                  '停止顶贴',
                  '立即顶一次',
                  '顶贴中…',
                  '立刻扫描记录表并顶贴一次',
                  () =>
                    p.onPatchRecordsConfig(
                      activeLink.id,
                      { enabled: !isAutoEnabled },
                      !isAutoEnabled ? '已开启自动顶贴' : '已关闭自动顶贴',
                    ),
                  async () => (await api.googleSheetsPollRecords(activeLink.id)).summary,
                )}
              </>
            )}
          </>
        )}
      </div>
    </header>
  );
}
