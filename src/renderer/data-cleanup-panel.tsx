import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import {
  CleanupPreview,
  cleanupDateEnd,
  type CleanupConfiguration,
  type CleanupSelection,
} from '../shared/data-cleanup.js';
import { api } from './api.js';
import { Btn, Chk, errMsg, NativeFormDialog, useBusyTask } from './modules/shared/module-ui.js';
import { UI_DANGER_TEXT, UI_INPUT_SM, UI_MUTED } from './ui/primitives.js';

type Selection = z.infer<typeof CleanupSelection>;
const SETTINGS_ROW = 'flex flex-wrap items-center gap-2 text-xs';
const isIntInRange = (v: string, min: number, max: number) =>
  Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

export function CleanupDialog({
  selection,
  onClose,
  onDone,
  initialPreview,
}: {
  initialPreview?: z.infer<typeof CleanupPreview>;
  selection: Selection;
  onClose(): void;
  onDone(deletedStepIds?: Iterable<string>): void;
}) {
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const selectionKey = JSON.stringify(selection);
  const [preview, setPreview] = useState<z.infer<typeof CleanupPreview> | null>(
    initialPreview ?? null,
  );
  const { busy, error, setError, run } = useBusyTask();
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!busy) return;
    let disposed = false,
      inFlight = false,
      activeCtrl: AbortController | null = null;
    const timer = setInterval(() => {
      if (disposed || inFlight) return;
      inFlight = true;
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      void api
        .cleanupProgress(ctrl.signal)
        .then((next) => !disposed && !ctrl.signal.aborted && setProgress(next))
        .catch(() => {})
        .finally(() => {
          if (activeCtrl === ctrl) activeCtrl = null;
          inFlight = false;
        });
    }, 500);
    return () => {
      disposed = true;
      clearInterval(timer);
      activeCtrl?.abort();
    };
  }, [busy]);

  useEffect(() => {
    if (initialPreview) return;
    const ctrl = new AbortController();
    void api
      .cleanupPreview(selection, ctrl.signal)
      .then(setPreview, (e: unknown) => !ctrl.signal.aborted && setError(errMsg(e, '预览失败')));
    return () => ctrl.abort();
  }, [selectionKey]);

  const handleConfirm = () => {
    if (submittingRef.current || busy) return;
    submittingRef.current = true;
    const doneSteps = selection.kind === 'records' ? selection.scope.stepIds : undefined;
    void run(async () => {
      if (!preview) {
        try {
          setPreview(await api.cleanupPreview(selection));
        } catch (err) {
          throw Error(`无法预览：${errMsg(err, '请稍后重试')}`);
        }
        return;
      }
      try {
        const result = await api.cleanupExecute(preview.token);
        if (result.deleted > 0) {
          if (selection.kind === 'records')
            window.dispatchEvent(
              new CustomEvent('task-records-deleted', {
                detail: { stepIds: selection.scope.stepIds },
              }),
            );
          onDone(doneSteps);
        }
        if (result.protected > preview.protected || result.deleted < preview.eligible) {
          setPreview(null);
          throw Error(
            `已清理 ${result.deleted} 条记录，其余记录状态已变化或仍在使用，已为你保留。请重新预览。`,
          );
        }
        if (result.deleted === 0) onDone(doneSteps);
        onClose();
      } catch (e) {
        setPreview(null);
        throw Error(`清理未完成：${errMsg(e, '请稍后重新预览再试')}`);
      }
    }, '清理失败').finally(() => {
      submittingRef.current = false;
    });
  };

  return (
    <NativeFormDialog
      ariaLabel="确认清理数据"
      title={selection.kind === 'records' ? '删除任务记录' : '清理日志'}
      busy={busy}
      error={error}
      danger
      submitDisabled={preview !== null ? !preview.eligible : !error}
      submitLabel={
        busy
          ? `清理中 ${progress.current} / ${progress.total || preview?.eligible || 0}…`
          : error && !preview
            ? '重新预览'
            : '确认清理'
      }
      onClose={onClose}
      onSubmit={handleConfirm}
    >
      <p>
        {preview
          ? selection.kind === 'records'
            ? `即将清理 ${preview.eligible} 条已结束的任务记录（正在运行或待核对的任务会自动保留，不受影响）。`
            : `即将清理 ${preview.eligible} 个日志文件，预计释放 ${(preview.bytes / 1024 / 1024).toFixed(2)} MB。`
          : error
            ? '清理未完成。你可以重新预览后再试，或关闭此窗口。'
            : '正在检查可清理的记录…'}
      </p>
    </NativeFormDialog>
  );
}

export function RecordCleanupActions({
  stepIds = [],
  selectedCount,
  profileId,
  onDone,
  showRetention = true,
  filters,
}: {
  showRetention?: boolean;
  filters?: ReactNode;
  stepIds?: string[];
  selectedCount?: number;
  profileId?: string;
  onDone(deletedStepIds?: Iterable<string>): void;
}) {
  const [date, setDate] = useState(''),
    [days, setDays] = useState(''),
    [count, setCount] = useState(''),
    [config, setConfig] = useState<CleanupConfiguration | null>(null),
    [selection, setSelection] = useState<Selection | null>(null),
    [prepared, setPrepared] = useState<z.infer<typeof CleanupPreview> | undefined>(undefined);
  const { busy, error: notice, setError: setNotice, run } = useBusyTask();

  useEffect(() => {
    if (!showRetention) return;
    const ctrl = new AbortController();
    void api.cleanupSettings(ctrl.signal).then(
      (v) => {
        if (ctrl.signal.aborted) return;
        setConfig(v);
        setDays(v.historyRetentionDays === null ? '' : String(v.historyRetentionDays));
        setCount(v.historyMaxCount == null ? '' : String(v.historyMaxCount));
      },
      () => !ctrl.signal.aborted && setNotice('保留规则读取失败，请重新打开页面'),
    );
    return () => ctrl.abort();
  }, [showRetention, setNotice]);

  const valid = (v: string, max: number) => v.trim() === '' || isIntInRange(v, 1, max);
  const scopeProfile = profileId ? { profileId } : {};
  const open = (next: Selection) => {
    setPrepared(undefined);
    setSelection(next);
  };
  const save = () =>
    void run(async () => {
      if (!config) return;
      const current = await api.cleanupSettings();
      const next = await api.saveCleanupSettings({
        expectedRevision: current.revision,
        historyRetentionDays: days.trim() ? Number(days) : null,
        historyMaxCount: count.trim() ? Number(count) : null,
        automaticLogs: current.automaticLogs,
      });
      setConfig(next);
      if (next.historyRetentionDays === null && next.historyMaxCount === null)
        return setNotice('已保存保留规则，不限制天数和条数');
      const sel: Selection = {
        kind: 'records',
        scope: {
          ...scopeProfile,
          ...(next.historyRetentionDays !== null
            ? { before: Math.max(0, Date.now() - next.historyRetentionDays * 86400000) }
            : {}),
          ...(next.historyMaxCount != null ? { keepLatestRuns: next.historyMaxCount } : {}),
        },
      };
      const preview = await api.cleanupPreview(sel);
      if (!preview.eligible) return setNotice('已保存保留规则，当前无超额记录');
      setPrepared(preview);
      setSelection(sel);
    }, '保存失败');

  return (
    <div className="py-[10px]">
      <div className="flex flex-wrap items-center justify-between gap-3 [&_[role=tablist]]:m-0 [&_[role=tablist]]:gap-[5px]">
        {filters}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {!!stepIds.length && (
            <Btn
              v="danger"
              className="bg-[var(--err-soft)]"
              onClick={() => open({ kind: 'records', scope: { stepIds, ...scopeProfile } })}
            >
              删除所选（{selectedCount ?? stepIds.length}）
            </Btn>
          )}
          <Btn
            onClick={() =>
              open({ kind: 'records', scope: { before: Date.now() + 1, ...scopeProfile } })
            }
          >
            一键清理已结束
          </Btn>
          <input
            aria-label="任务记录清理截止日期"
            type="date"
            className={`${UI_INPUT_SM} w-[132px] text-[11px]`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Btn
            disabled={!date}
            onClick={() =>
              open({ kind: 'records', scope: { before: cleanupDateEnd(date), ...scopeProfile } })
            }
          >
            按日期清理
          </Btn>
        </div>
      </div>
      {showRetention && (
        <div
          className="mt-2 flex flex-wrap items-center gap-[7px] border-t border-[var(--line)] py-[7px] text-[11px] text-[var(--text-3)] [&_input]:w-[72px] [&_input]:rounded-[5px] [&_input]:border [&_input]:border-[var(--line-strong)] [&_input]:bg-white [&_input]:px-1.5 [&_input]:py-1 [&_input]:text-[11px] [&_input]:text-[var(--text)] [&_label]:flex [&_label]:items-center [&_label]:gap-1.5"
          aria-label="任务记录保留规则"
        >
          <span>自动保留：</span>
          <label>
            最近{' '}
            <input
              type="number"
              min="1"
              max="3650"
              placeholder="不限"
              aria-label="保留天数"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />{' '}
            天
          </label>
          <label>
            · 最多{' '}
            <input
              type="number"
              min="1"
              max="100000"
              placeholder="不限"
              aria-label="最大条数"
              title="按已结束的任务运行次数计数"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />{' '}
            条
          </label>
          <Btn
            disabled={busy || !config || !valid(days, 3650) || !valid(count, 100000)}
            onClick={save}
          >
            {busy ? '保存中…' : '保存并清理'}
          </Btn>
        </div>
      )}
      {notice && (
        <p role="status" className={UI_MUTED + ' mt-1'}>
          {notice}
        </p>
      )}
      {selection && (
        <CleanupDialog
          selection={selection}
          {...(prepared ? { initialPreview: prepared } : {})}
          onClose={() => {
            setSelection(null);
            setPrepared(undefined);
          }}
          onDone={(ids) => {
            onDone(ids);
            setNotice('已清理超额或选中的已结束记录');
          }}
        />
      )}
    </div>
  );
}

export function DataCleanupPanel() {
  const [selection, setSelection] = useState<Selection | null>(null),
    [settings, setSettings] = useState<CleanupConfiguration | null>(null),
    [form, setForm] = useState({
      autoLogs: false,
      maxCount: '',
      bumperMaxCount: '300000',
      posterMaxCount: '100000',
      detailMaxCount: '1000',
      days: '30',
      automatic: false,
      logDate: '',
    }),
    [status, setStatus] = useState<{
      available: boolean;
      reason: string;
      dataDirectory: string;
    } | null>(null),
    [notice, setNotice] = useState(''),
    [resetOpen, setResetOpen] = useState(false);
  const { busy, error, setError, run } = useBusyTask();
  const setField = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    const ctrl = new AbortController();
    void Promise.all([api.cleanupSettings(ctrl.signal), api.resetStatus(ctrl.signal)]).then(
      ([c, reset]) => {
        if (ctrl.signal.aborted) return;
        setSettings(c);
        setForm((prev) => ({
          ...prev,
          autoLogs: c.automaticLogs,
          bumperMaxCount: String(c.bumperMaxCount),
          posterMaxCount: String(c.posterMaxCount),
          detailMaxCount: String(c.detailMaxCount),
          maxCount: c.historyMaxCount == null ? '' : String(c.historyMaxCount),
          automatic: c.historyRetentionDays !== null,
          days: String(c.historyRetentionDays ?? 30),
        }));
        setStatus(reset);
      },
      (e: unknown) => !ctrl.signal.aborted && setError(errMsg(e, '清理设置读取失败')),
    );
    return () => ctrl.abort();
  }, [setError]);

  const act = (work: () => Promise<string>) => {
    setNotice('');
    void run(async () => setNotice(await work()), '操作未确认');
  };
  const saveDisabled =
    busy ||
    !settings ||
    !isIntInRange(form.bumperMaxCount, 1, 1000000) ||
    !isIntInRange(form.posterMaxCount, 1, 1000000) ||
    !isIntInRange(form.detailMaxCount, 1, 100000) ||
    (form.maxCount.trim() !== '' && !isIntInRange(form.maxCount, 1, 100000)) ||
    (form.automatic && !isIntInRange(form.days, 1, 3650));

  return (
    <section aria-label="数据清理">
      <h3>数据清理</h3>
      <p>
        超额自动回收最早的已结束记录。详细流水按全软件合计保留；防重复、素材使用和必要的未确认结果独立保存。
      </p>
      <div className={SETTINGS_ROW}>
        <Btn disabled={busy} onClick={() => setSelection({ kind: 'logs' })}>
          预览清空运行与诊断日志
        </Btn>
        <input
          type="date"
          className={`${UI_INPUT_SM} min-w-[148px]`}
          aria-label="日志清理截止日期"
          value={form.logDate}
          onChange={(e) => setField('logDate', e.target.value)}
        />
        <Btn
          disabled={!form.logDate || busy}
          onClick={() => setSelection({ kind: 'logs', before: cleanupDateEnd(form.logDate) })}
        >
          预览按日期清理日志
        </Btn>
      </div>
      <RecordCleanupActions
        showRetention={false}
        onDone={() => setNotice('已删除符合条件的记录，必要的未确认结果和素材使用数据保留。')}
      />
      <div
        className={`${SETTINGS_ROW} [&_input[type=number]]:w-[84px] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5`}
      >
        <Chk
          label="同时按天数清理活动记录"
          checked={form.automatic}
          onChange={(v) => setField('automatic', v)}
        />
        <label>
          保留天数{' '}
          <input
            type="number"
            className={UI_INPUT_SM}
            min="1"
            max="3650"
            value={form.days}
            disabled={!form.automatic}
            onChange={(e) => setField('days', e.target.value)}
          />
        </label>
        {(
          [
            ['maxCount', '活动任务最终记录（次）', '自动保留最大条数', '不限', 100000],
            ['bumperMaxCount', '顶贴最终记录（条）', '顶贴最终记录（条）', undefined, 1000000],
            ['posterMaxCount', '发帖最终记录（条）', '发帖最终记录（条）', undefined, 1000000],
            [
              'detailMaxCount',
              '详细执行流水（条，全软件合计）',
              '详细执行流水（条，全软件合计）',
              undefined,
              100000,
            ],
          ] as const
        ).map(([key, label, aria, placeholder, max]) => (
          <label key={key}>
            {label}{' '}
            <input
              type="number"
              className={UI_INPUT_SM}
              min="1"
              max={max}
              aria-label={aria}
              placeholder={placeholder}
              value={form[key]}
              onChange={(e) => setField(key, e.target.value)}
            />
          </label>
        ))}
        <Chk
          className="w-full"
          label="同时自动清理诊断日志（使用上方日志保留天数）"
          checked={form.autoLogs}
          onChange={(v) => setField('autoLogs', v)}
        />
        <Btn
          v="primary"
          disabled={saveDisabled}
          onClick={() =>
            act(async () => {
              if (!settings) return '';
              setSettings(
                await api.saveCleanupSettings({
                  expectedRevision: settings.revision,
                  historyRetentionDays: form.automatic ? Number(form.days) : null,
                  historyMaxCount: form.maxCount.trim() ? Number(form.maxCount) : null,
                  automaticLogs: form.autoLogs,
                  bumperMaxCount: Number(form.bumperMaxCount),
                  posterMaxCount: Number(form.posterMaxCount),
                  detailMaxCount: Number(form.detailMaxCount),
                }),
              );
              return '自动清理设置已保存';
            })
          }
        >
          保存自动清理设置
        </Btn>
        <Btn
          disabled={busy}
          onClick={() =>
            act(() =>
              api
                .compactData()
                .then(() => '数据库空间已整理；必要的未确认结果和素材使用数据保留。'),
            )
          }
        >
          整理数据库空间
        </Btn>
      </div>
      <h3>重置工作台</h3>
      {status?.dataDirectory && (
        <p className="break-all">将清空的数据目录：{status.dataDirectory}</p>
      )}
      <p>
        清空本工作台的数据库、连接信息、组合、分组、设置、使用记录、日志和缓存，并重新打开软件。原素材、浏览器资料、浏览器登录状态及工作台数据目录以外的备份/导出文件保留。浏览器可能自动重新连接。
      </p>
      <p>
        重置会同时丢弃未保存编辑和未确认结果的防重复记录；重置后不要直接重跑可能已提交的旧内容。
      </p>
      <div className={SETTINGS_ROW}>
        <Btn v="danger" disabled={busy || !status?.available} onClick={() => setResetOpen(true)}>
          彻底重置工作台…
        </Btn>
      </div>
      {status && !status.available && <p className={UI_MUTED}>{status.reason}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className={UI_DANGER_TEXT}>
          {error}
        </p>
      )}
      {selection && (
        <CleanupDialog
          selection={selection}
          onClose={() => setSelection(null)}
          onDone={() => setNotice('清理操作已完成。')}
        />
      )}
      {resetOpen && <ResetDialog onClose={() => setResetOpen(false)} />}
    </section>
  );
}

function ResetDialog({ onClose }: { onClose(): void }) {
  const submittingRef = useRef(false);
  const [phrase, setPhrase] = useState(''),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <NativeFormDialog
      ariaLabel="彻底重置工作台"
      title="彻底重置工作台"
      busy={busy}
      error={error}
      danger
      submitDisabled={!ack || phrase !== '确认重置'}
      submitLabel={busy ? '正在退出并重置…' : '删除全部工作台数据并重启'}
      onClose={onClose}
      onSubmit={() => {
        if (submittingRef.current || busy) return;
        submittingRef.current = true;
        setBusy(true);
        setError('');
        void api
          .resetWorkspace({ confirmation: phrase, acknowledgeUnknownResults: ack })
          .catch((e: unknown) => {
            submittingRef.current = false;
            setBusy(false);
            setError(errMsg(e, '重置请求未确认，请重新检查状态'));
          });
      }}
    >
      <p>
        这会删除工作台数据目录内的所有内容，无法撤销。请先自行保留所需备份；浏览器和原始素材不删除。
      </p>
      <Chk
        label="我理解未保存编辑、历史记录和未确认结果的防重复数据也将丢失。"
        checked={ack}
        disabled={busy}
        onChange={setAck}
      />
      <label className="grid gap-1">
        请输入“确认重置”{' '}
        <input
          autoFocus
          className={UI_INPUT_SM}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          disabled={busy}
        />
      </label>
    </NativeFormDialog>
  );
}
