import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../shared/contracts.js';
import {
  bridgeHealthDescription,
  type ConnectionHealth,
} from '../shared/bridge-connection-health.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';

export function BridgeConnectionPanel({ profiles }: { profiles: Profile[] }) {
  const [health, setHealth] = useState<ConnectionHealth | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ConnectionHealth['pending'][number] | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
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
      mounted.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [revision]);
  const name = (id: string) => {
    const row = profiles.find((profile) => profile.id === id);
    return row?.browserName || row?.alias || id.slice(0, 8);
  };
  return (
    <div className="connection-health">
      <h3>连接诊断</h3>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button onClick={() => setRevision((value) => value + 1)}>刷新连接诊断</button>
      {health && (
        <>
          {health.pending.map((attempt) => (
            <div className="connection-recovery-row" key={attempt.id}>
              <span>
                {name(attempt.profileId)} · {attempt.profileId.slice(0, 8)} · 等待本机认证恢复
              </span>
              <button
                disabled={
                  attempt.expiresAt <= Date.now() ||
                  profiles.some((row) => row.id === attempt.profileId && row.online)
                }
                onClick={() => setSelected(attempt)}
              >
                恢复此资料连接
              </button>
            </div>
          ))}
          {health.failures.length === 0 && health.pending.length === 0 && (
            <p>本次软件启动后未记录连接拒绝。</p>
          )}
          {health.failures.map((failure) => (
            <p key={failure.profileId ?? 'unidentified'}>
              {failure.profileId
                ? name(failure.profileId) + ' · ' + failure.profileId.slice(0, 8)
                : '未识别资料'}
              {' · ' +
                bridgeHealthDescription(failure.code) +
                ' · 最近记录 ' +
                new Date(failure.at).toLocaleTimeString()}
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
            if (mounted.current) {
              setNotice('恢复请求已确认，等待插件完成认证；不代表浏览任务已通过。');
              setRevision((value) => value + 1);
            }
          }}
        />
      )}
    </div>
  );
}
