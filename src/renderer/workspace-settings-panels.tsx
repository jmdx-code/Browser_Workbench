import { useEffect, useState } from 'react';
import type { z } from 'zod';
import {
  bridgeHealthDescription,
  type ConnectionHealth,
} from '../shared/bridge-connection-health.js';
import type { Profile } from '../shared/contracts.js';
import type { MediaComponentStatus } from '../shared/media-component.js';
import { WorkspacePreferenceValues, type Preferences } from '../shared/workspace-preferences.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { Btn, Chk, errMsg, useAbortQuery, useBusyTask } from './modules/shared/module-ui.js';
import { UI_DANGER_TEXT, UI_INPUT, UI_MUTED, UI_SELECT } from './ui/primitives.js';

const LBL_ROW = 'inline-flex items-center gap-2 whitespace-nowrap text-xs text-[var(--text-2)]';
const SETTINGS_ROW = 'flex flex-wrap items-center gap-2.5 text-xs';

export function WorkspacePreferencesPanel() {
  const {
    data: saved,
    setData: setSaved,
    error: loadErr,
  } = useAbortQuery<Preferences>(api.workspacePreferences, 0, '默认设置读取失败。');
  const sysTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [systemZone, setSystemZone] = useState(true),
    [zone, setZone] = useState(sysTz),
    [notifications, setNotifications] = useState<Preferences['desktopNotifications']>('off'),
    [notice, setNotice] = useState(''),
    [autoLaunch, setAutoLaunch] = useState<{ supported: boolean; enabled: boolean } | null>(null),
    [autoBusy, setAutoBusy] = useState(false),
    [autoNotice, setAutoNotice] = useState('');
  const { busy, error: err, run } = useBusyTask();

  useEffect(() => {
    const desktop = window.workbenchDesktop;
    if (typeof desktop?.getAutoLaunch !== 'function') return;
    let active = true;
    void desktop.getAutoLaunch().then(
      (res) => active && setAutoLaunch(res),
      () => active && setAutoLaunch({ supported: false, enabled: false }),
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!saved) return;
    setSystemZone(saved.defaultTimeZone === null);
    setZone(saved.defaultTimeZone ?? sysTz());
    setNotifications(saved.desktopNotifications);
  }, [saved]);

  const values = WorkspacePreferenceValues.safeParse({
    defaultTimeZone: systemZone ? null : zone.trim(),
    desktopNotifications: notifications,
  });
  const changed =
    saved &&
    values.success &&
    (values.data.defaultTimeZone !== saved.defaultTimeZone ||
      values.data.desktopNotifications !== saved.desktopNotifications);

  return (
    <>
      <h3>日程与通知</h3>
      <form
        className={SETTINGS_ROW}
        onSubmit={(e) => {
          e.preventDefault();
          if (!saved || !values.success) return;
          setNotice('');
          void run(async () => {
            const val = await api.saveWorkspacePreferences(
              { expectedRevision: saved.revision, values: values.data },
              AbortSignal.timeout(10_000),
            );
            setSaved(val);
            setZone(val.defaultTimeZone ?? sysTz());
            setNotice('设置已保存；新日程使用默认时区，通知只应用于后续任务状态。');
          }, '保存未确认，请重新读取当前设置；不会自动重试保存。');
        }}
      >
        <Chk
          label="使用系统时区"
          checked={systemZone}
          disabled={!saved || busy}
          onChange={(v) => {
            setSystemZone(v);
            setNotice('');
          }}
        />
        <label className={LBL_ROW}>
          默认日程时区
          <input
            className={`${UI_INPUT} w-[132px]`}
            value={zone}
            disabled={!saved || busy || systemZone}
            onChange={(e) => {
              setZone(e.target.value);
              setNotice('');
            }}
            aria-invalid={!values.success}
          />
        </label>
        <label className={LBL_ROW}>
          桌面通知
          <select
            className={UI_SELECT}
            value={notifications}
            disabled={!saved || busy}
            onChange={(e) => {
              const p = WorkspacePreferenceValues.shape.desktopNotifications.safeParse(
                e.target.value,
              );
              if (p.success) setNotifications(p.data);
              setNotice('');
            }}
          >
            <option value="off">关闭</option>
            <option value="failures">仅失败</option>
            <option value="all">完成与失败</option>
          </select>
        </label>
        <Btn type="submit" v="primary" disabled={!changed || busy}>
          {busy ? '保存中…' : '保存偏好设置'}
        </Btn>
      </form>
      {!values.success && (
        <p className={UI_DANGER_TEXT} role="alert">
          {values.error.issues[0]?.message ?? '请检查默认设置'}
        </p>
      )}
      {(err || loadErr) && (
        <p className={UI_DANGER_TEXT} role="alert">
          {err || loadErr}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {autoLaunch?.supported && (
        <div className={`${SETTINGS_ROW} mt-[18px]`}>
          <h3>桌面开机自启</h3>
          <Chk
            label="开机自动启动并最小化到系统托盘（适合 7×24 无人值守排贴 / 顶贴 / 排班）"
            checked={autoLaunch.enabled}
            disabled={autoBusy}
            onChange={(checked) => {
              const desktop = window.workbenchDesktop;
              if (typeof desktop?.setAutoLaunch !== 'function' || autoBusy) return;
              setAutoBusy(true);
              setAutoNotice('');
              void desktop
                .setAutoLaunch(checked)
                .then(
                  (res) => {
                    setAutoLaunch(res);
                    setAutoNotice(
                      res.enabled
                        ? '已开启开机自动启动（开机后静默驻留系统托盘，适合 7×24 无人值守）。'
                        : '已关闭开机自动启动。',
                    );
                  },
                  () => setAutoNotice('修改开机自启失败，请检查系统权限。'),
                )
                .finally(() => setAutoBusy(false));
            }}
          />
          {autoNotice && <p role="status">{autoNotice}</p>}
        </div>
      )}
    </>
  );
}

export function MediaComponentPanel() {
  const [status, setStatus] = useState<z.infer<typeof MediaComponentStatus> | null>(null);
  const { busy: pending, error, setError, run } = useBusyTask();
  const isInstalling = Boolean(status?.busy);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await api.mediaComponent(undefined, controller.signal);
        if (!controller.signal.aborted) {
          setStatus(value);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(errMsg(e, '读取失败'));
      } finally {
        loading = false;
      }
    };
    void load();
    if (!isInstalling) return () => controller.abort();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [isInstalling, setError]);

  const act = (action: 'install' | 'cancel') =>
    void run(async () => setStatus(await api.mediaComponent(action)), '操作失败');

  return (
    <section className="grid justify-items-start gap-2.5" aria-label="可选组件">
      <h3>
        视频文字组件 <span className={UI_MUTED}>可选</span>
      </h3>
      <p>仅用于把文案叠加到视频快拍中。浏览任务、普通视频帖子、无文案视频快拍均不需要安装。</p>
      <p>
        {status?.installed
          ? '已安装，可以自动处理视频快拍文案。'
          : status && !status.supported
            ? '此平台的组件尚未提供，其他功能可正常使用。'
            : '未安装。需要时再安装，视频原文件不会被修改。'}
      </p>
      {status?.busy && (
        <p role="status">
          {status.phase === 'downloading'
            ? `下载中 · ${(status.receivedBytes / 1048576).toFixed(1)} / ${(status.totalBytes / 1048576).toFixed(1)} MB`
            : status.phase === 'verifying'
              ? '正在校验组件…'
              : '正在安装…'}
        </p>
      )}
      {status && (status.installed || status.supported) && !status.busy && (
        <Btn sm={false} disabled={pending} onClick={() => act('install')}>
          {status.installed ? '校验或修复组件' : '安装视频文字组件'}
        </Btn>
      )}
      {status?.busy && (
        <Btn sm={false} disabled={pending} onClick={() => act('cancel')}>
          取消安装
        </Btn>
      )}
      {(error || status?.error) && (
        <p className={UI_DANGER_TEXT} role="alert">
          {error || status?.error}
        </p>
      )}
    </section>
  );
}

export function BridgeConnectionPanel({ profiles }: { profiles: Profile[] }) {
  const [health, setHealth] = useState<ConnectionHealth | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<ConnectionHealth['pending'][number] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await api.bridgeConnectionHealth(
          AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        );
        if (!controller.signal.aborted) {
          setHealth(next);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) {
          setHealth(null);
          setError('连接诊断读取失败。');
        }
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [revision]);

  const name = (id: string) => {
    const row = profiles.find((p) => p.id === id);
    return row?.browserName || row?.alias || id.slice(0, 8);
  };

  return (
    <div className="grid gap-1.5">
      <h3>连接状态</h3>
      {error && (
        <p className={UI_DANGER_TEXT} role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {health && (
        <>
          {health.pending.map((attempt) => (
            <div className="flex flex-wrap items-center justify-between gap-2.5" key={attempt.id}>
              <span>
                {name(attempt.profileId)} · {attempt.profileId.slice(0, 8)} · 等待本机认证恢复
              </span>
              <Btn
                disabled={
                  attempt.expiresAt <= Date.now() ||
                  profiles.some((r) => r.id === attempt.profileId && r.online)
                }
                onClick={() => setSelected(attempt)}
              >
                恢复此资料连接
              </Btn>
            </div>
          ))}
          {health.failures.length === 0 && health.pending.length === 0 && (
            <p className={UI_MUTED}>本地桥接连接正常，本次启动后无连接拒绝记录。</p>
          )}
          {health.failures.map((f) => (
            <p key={f.profileId ?? 'unidentified'}>
              {f.profileId ? `${name(f.profileId)} · ${f.profileId.slice(0, 8)}` : '未识别资料'} ·{' '}
              {bridgeHealthDescription(f.code)} · 最近记录 {new Date(f.at).toLocaleTimeString()}
            </p>
          ))}
        </>
      )}
      {selected && (
        <ConfirmDialog
          title="恢复本机连接"
          label="恢复此资料连接"
          description={`${name(selected.profileId)} · ${selected.profileId.slice(0, 8)}。请核对插件中的资料编号。恢复只处理当前等待连接，先备份本机日志；保留资料与历史任务，不自动继续任务。`}
          onClose={() => setSelected(null)}
          onConfirm={async () => {
            try {
              await api.recoverBridgeConnection({ id: selected.id, profileId: selected.profileId });
            } catch {
              throw Error('恢复未确认或等待连接已过期，请刷新诊断；不会自动重试。');
            }
            setNotice('恢复请求已确认，等待插件完成认证；不代表浏览任务已通过。');
            setRevision((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
