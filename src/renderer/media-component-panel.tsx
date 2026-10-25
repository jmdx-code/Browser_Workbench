import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { MediaComponentStatus } from '../shared/media-component.js';
import { api } from './api.js';

export function MediaComponentPanel() {
  const [status, setStatus] = useState<z.infer<typeof MediaComponentStatus> | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
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
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  async function act(action: 'install' | 'cancel') {
    setPending(true);
    setError('');
    try {
      setStatus(await api.mediaComponent(action));
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="menu-panel" aria-label="可选组件">
      <h3>
        视频文字组件 <span className="muted">可选</span>
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
      {status && !status.installed && status.supported && !status.busy && (
        <button className="btn" disabled={pending} onClick={() => void act('install')}>
          安装视频文字组件
        </button>
      )}
      {status?.installed && !status.busy && (
        <button className="btn" disabled={pending} onClick={() => void act('install')}>
          校验或修复组件
        </button>
      )}
      {status?.busy && (
        <button className="btn" disabled={pending} onClick={() => void act('cancel')}>
          取消安装
        </button>
      )}
      {(error || status?.error) && (
        <p className="error" role="alert">
          {error || status?.error}
        </p>
      )}
    </section>
  );
}
