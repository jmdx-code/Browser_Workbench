import { useEffect, useState } from 'react';
import { ExtensionUpdateControls } from './software-update-panel.js';
import { taskFeatureDefinitions, type FeatureOverviewV2 } from '../shared/task-features.js';
import { api } from './api.js';
import type { Profile } from '../shared/contracts.js';

declare const __BRIDGE_EXTENSION_VERSION__: string;

// Former settings page pieces, now shown inside the ☰ drawer. The concurrency
// control lives only on the home toolbar.
const verificationLabels = {
  pending: '待验收',
  limited: '仅短样本通过',
  passed: '已验收',
  failed: '最新验收未通过',
};
const implementationLabels = { none: '未接入', partial: '部分接入', complete: '已接入' };
export function FeatureStatusPanel() {
  const [features, setFeatures] = useState<FeatureOverviewV2 | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.taskFeatures(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(
      (value) => {
        if (controller.signal.aborted) return;
        setFeatures(value);
        setError('');
      },
      () => {
        if (controller.signal.aborted) return;
        setFeatures(null);
        setError('功能状态读取失败，请重新读取。');
      },
    );
    return () => controller.abort();
  }, [revision]);
  return (
    <div className="menu-panel">
      <dl className="kv">
        <dt>本机连接</dt>
        <dd>127.0.0.1:18767 · 插件自动连接</dd>
        <dt>执行服务</dt>
        <dd>
          {features ? (features.controllerAvailable ? '已启动' : '当前未开放执行') : '未读取'}
        </dd>
      </dl>
      {error && (
        <p className="text-danger" role="alert">
          {error} <button onClick={() => setRevision((value) => value + 1)}>重新读取</button>
        </p>
      )}
      <div className="feature-list">
        {taskFeatureDefinitions.map((feature) => {
          const state = features?.features.find((value) => value.id === feature.id);
          return (
            <div className="feature-row" key={feature.id}>
              <div>
                <strong>{feature.name}</strong>
                <p>{state?.reason ?? feature.detail}</p>
                {state && (
                  <small>
                    {implementationLabels[state.implementation]} ·{' '}
                    {verificationLabels[state.verification]}
                  </small>
                )}
              </div>
              <span className={'pill ' + (state?.status === 'available' ? 'pill-ok' : 'pill-idle')}>
                <i />
                {state ? (state.enabled ? '已开放测试' : '未开放') : '未读取'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
export function ExtensionVersionsPanel({ profiles }: { profiles: Profile[] }) {
  return (
    <div className="menu-panel">
      <p className="muted">
        本软件附带插件版本 <code>{__BRIDGE_EXTENSION_VERSION__}</code>
        。空闲时自动同步插件版本。
      </p>
      <ExtensionUpdateControls />
      <div className="extension-versions">
        {!profiles.length && (
          <p className="muted">
            尚未登记浏览器，打开已有 Chrome／Brave 并加载桥接插件后会自动连接。
          </p>
        )}
        {profiles.map((profile) => (
          <div className="extension-version-row" key={profile.id}>
            <strong>{profile.browserName ?? profile.alias}</strong>
            <span>{profile.online ? '已连接' : '离线'}</span>
            <code>{profile.extensionVersion ?? '版本未读取'}</code>
            <span
              className={
                'pill ' +
                (profile.online && profile.extensionVersion !== __BRIDGE_EXTENSION_VERSION__
                  ? 'pill-warn'
                  : 'pill-idle')
              }
            >
              <i />
              {!profile.online
                ? '连接后核对'
                : !profile.extensionVersion
                  ? '版本待确认'
                  : profile.extensionVersion === __BRIDGE_EXTENSION_VERSION__
                    ? '版本一致'
                    : '版本不一致'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
