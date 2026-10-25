import { useEffect, useState } from 'react';
import { api } from './api.js';
import { WorkspacePreferenceValues, type Preferences } from '../shared/workspace-preferences.js';

export function WorkspacePreferencesPanel() {
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [systemZone, setSystemZone] = useState(true);
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [notifications, setNotifications] = useState<Preferences['desktopNotifications']>('off');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api
      .workspacePreferences(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          setSaved(value);
          setSystemZone(value.defaultTimeZone === null);
          setZone(value.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
          setNotifications(value.desktopNotifications);
          setError('');
        },
        () => {
          if (!controller.signal.aborted) {
            setSaved(null);
            setError('默认设置读取失败，请重新读取。');
          }
        },
      );
    return () => controller.abort();
  }, [revision]);
  const values = WorkspacePreferenceValues.safeParse({
    defaultTimeZone: systemZone ? null : zone.trim(),
    desktopNotifications: notifications,
  });
  const changed =
    saved &&
    values.success &&
    (values.data.defaultTimeZone !== saved.defaultTimeZone ||
      values.data.desktopNotifications !== saved.desktopNotifications);
  async function save() {
    if (!saved || !values.success || busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const value = await api.saveWorkspacePreferences(
        { expectedRevision: saved.revision, values: values.data },
        AbortSignal.timeout(10_000),
      );
      setSaved(value);
      setZone(value.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      setNotice('设置已保存；新日程使用默认时区，通知只应用于后续任务状态。');
    } catch {
      setError('保存未确认，请重新读取当前设置；不会自动重试保存。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h3>日程与通知</h3>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={systemZone}
            disabled={!saved || busy}
            onChange={(event) => {
              setSystemZone(event.target.checked);
              setNotice('');
            }}
          />
          使用系统时区
        </label>
        <label>
          默认日程时区
          <input
            value={zone}
            disabled={!saved || busy || systemZone}
            onChange={(event) => {
              setZone(event.target.value);
              setNotice('');
            }}
            aria-invalid={!values.success}
          />
        </label>
        <label>
          桌面通知
          <select
            value={notifications}
            disabled={!saved || busy}
            onChange={(event) => {
              const parsed = WorkspacePreferenceValues.shape.desktopNotifications.safeParse(
                event.target.value,
              );
              if (parsed.success) setNotifications(parsed.data);
              setNotice('');
            }}
          >
            <option value="off">关闭</option>
            <option value="failures">仅失败</option>
            <option value="all">完成与失败</option>
          </select>
        </label>
        <button className="primary" disabled={!changed || busy}>
          {busy ? '保存中…' : '保存默认设置'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setNotice('');
            setRevision((value) => value + 1);
          }}
        >
          重新读取
        </button>
      </form>
      {!values.success && (
        <p className="text-danger" role="alert">
          {values.error.issues[0]?.message ?? '请检查默认设置'}
        </p>
      )}
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
