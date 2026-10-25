import { useEffect, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { TaskTiming, type Timing } from '../shared/task-timing.js';
import { api } from './api.js';
export function TaskScheduleDialog({
  name,
  version,
  count,
  onSubmit,
  onClose,
}: {
  name: string;
  version: number;
  count: number;
  onSubmit: (timing: Timing) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const zoneEdited = useRef(false);
  const [mode, setMode] = useState<'at' | 'window'>('at'),
    [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [date, setDate] = useState(DateTime.now().plus({ minutes: 5 }).toFormat("yyyy-MM-dd'T'HH:mm")),
    [start, setStart] = useState('09:00'),
    [end, setEnd] = useState('18:00'),
    [days, setDays] = useState([1, 2, 3, 4, 5, 6, 7]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void api
      .workspacePreferences(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))
      .then(
        (value) => {
          if (!controller.signal.aborted && !zoneEdited.current && value.defaultTimeZone) {
            setZone(value.defaultTimeZone);
            setDate(
              DateTime.now()
                .setZone(value.defaultTimeZone)
                .plus({ minutes: 5 })
                .toFormat("yyyy-MM-dd'T'HH:mm"),
            );
          }
        },
        () => {},
      );
    return () => controller.abort();
  }, []);
  async function submit() {
    if (busy) return;
    zoneEdited.current = true;
    setBusy(true);
    setError('');
    try {
      const at = DateTime.fromISO(date, { zone });
      if (mode === 'at' && (!at.isValid || at.toMillis() <= Date.now()))
        throw Error('请选择未来的启动时间，并核对时区');
      const parsed = TaskTiming.safeParse(
        mode === 'at'
          ? { mode, startAt: at.toMillis(), timeZone: zone }
          : { mode, startTime: start, endTime: end, timeZone: zone, weekdays: [...days].sort() },
      );
      if (!parsed.success) throw Error(parsed.error.issues[0]?.message ?? '请检查时间窗和运行日期');
      await onSubmit(parsed.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '定时设置未保存');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="name-dialog schedule-dialog"
      aria-label="安排任务时间"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <h3>安排任务时间</h3>
      <p>
        {count} 份已选资料 · {name} · 保存版本 {version}
      </p>
      <label>
        运行方式
        <select
          aria-label="定时运行方式"
          value={mode}
          disabled={busy}
          onChange={(e) => setMode(e.target.value === 'window' ? 'window' : 'at')}
        >
          <option value="at">指定时间启动一次</option>
          <option value="window">每日允许运行时间窗</option>
        </select>
      </label>
      <label>
        时区
        <input
          aria-label="任务时区"
          value={zone}
          disabled={busy}
          onChange={(e) => {
            zoneEdited.current = true;
            setZone(e.target.value);
          }}
        />
      </label>
      {mode === 'at' ? (
        <label>
          启动时间
          <input
            aria-label="任务启动时间"
            type="datetime-local"
            value={date}
            disabled={busy}
            onChange={(e) => {
              zoneEdited.current = true;
              setDate(e.target.value);
            }}
          />
        </label>
      ) : (
        <>
          <div className="schedule-times">
            <label>
              开始
              <input
                aria-label="时间窗开始"
                type="time"
                value={start}
                disabled={busy}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              结束
              <input
                aria-label="时间窗结束"
                type="time"
                value={end}
                disabled={busy}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <fieldset disabled={busy}>
            <legend>运行日期</legend>
            {['一', '二', '三', '四', '五', '六', '日'].map((name, index) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={days.includes(index + 1)}
                  onChange={(e) =>
                    setDays((d) =>
                      e.target.checked
                        ? [...d, index + 1]
                        : d.filter((value) => value !== index + 1),
                    )
                  }
                />
                周{name}
              </label>
            ))}
          </fieldset>
          <p className="field-hint">
            窗口结束后确认暂停，下个窗口可继续。有限轮次完成后不会每天重跑；持续每天运行请在组合中选择“循环到停止”。
          </p>
        </>
      )}
      <p className="field-hint">
        保存时固定组合及资源版本，按并发数排队。软件关闭或睡眠错过启动超过一分钟，不自动补跑；重启后的已开始任务需手动继续。原资料同一时间只安排一个组合。
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在安排…' : '确认安排'}
        </button>
      </footer>
    </dialog>
  );
}
