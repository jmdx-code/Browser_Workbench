import type { Profile } from '../shared/contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import {
  inspectionPresentation,
  inspectionAvatarURL,
  inspectionDisplayName,
} from './inspection-presentation.js';

export function ProfileInspectionPanel({
  profile,
  inspection,
  available,
  error,
  busy,
  onRead,
  onCheck,
}: {
  profile: Profile;
  inspection: Inspection | undefined;
  available: boolean;
  error: string;
  busy: boolean;
  onRead: () => void;
  onCheck: () => void;
}) {
  const status = inspectionPresentation(profile, inspection, available);
  return (
    <section className="inspection-panel" aria-label="Facebook检查详情">
      <div className="inspection-heading">
        <h3>Facebook 状态</h3>
        <span className="badge gray">{status.title}</span>
      </div>
      <p>{status.detail}</p>
      <dl>
        <dt>上次检查</dt>
        <dd>
          {available && inspection?.checkedAt !== null && inspection?.checkedAt !== undefined
            ? new Date(inspection.checkedAt).toLocaleString()
            : '暂无可用结果'}
        </dd>
        <dt>账号身份</dt>
        <dd>
          {profile.account.state === 'logged-in' && profile.account.id
            ? `${profile.account.id}（最近只读检查；执行前重新核验）`
            : '当前身份未确认'}
        </dd>
        <dt>显示名称</dt>
        <dd>{inspectionDisplayName(profile, inspection, available) ?? '暂无有效的名称观察'}</dd>
        <dt>名称来源</dt>
        <dd>
          {inspectionDisplayName(profile, inspection, available)
            ? profile.account.state === 'logged-in'
              ? 'Facebook当前原生账号与首页创建入口一致'
              : '最近只读检查；仅供显示'
            : '尚未取得支持的来源'}
        </dd>
        <dt>头像来源</dt>
        <dd>
          {inspectionAvatarURL(profile, inspection, available)
            ? 'Facebook首页顶部个人主页入口；仅供显示'
            : '暂无有效的头像观察'}
        </dd>
        <dt>浏览器插件</dt>
        <dd>{profile.extensionVersion ?? '离线'}</dd>
      </dl>
      {error && (
        <p className="text-danger" role="status">
          {error}
        </p>
      )}
      <div className="inspection-actions">
        <button onClick={onRead} disabled={busy}>
          重新读取结果
        </button>
        <button onClick={onCheck} disabled={busy || !status.canCheck}>
          检查这份 FB 状态
        </button>
      </div>
      <small>
        连接就绪后自动检查一次；手动检查会创建专用 Facebook 页，读取后关闭。重新读取结果不打开页面。
      </small>
    </section>
  );
}
