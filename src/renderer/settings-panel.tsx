import type { Profile } from '../shared/contracts.js';

declare const __BRIDGE_EXTENSION_VERSION__: string;

export function ExtensionVersionsPanel({ profiles }: { profiles: Profile[] }) {
  return (
    <div className="menu-panel">
      <div className="extension-versions">
        {!profiles.length && (
          <p className="muted">
            尚未登记浏览器，打开已有 Chrome / Brave 并加载桥接插件后会自动连接。
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
