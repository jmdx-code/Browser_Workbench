import { useState } from 'react';

function AvatarImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <WhiteAvatar />;
  return (
    <img
      src={url}
      alt="Facebook顶部头像观察，操作身份未确认"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
function WhiteAvatar() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="10" r="6" />
      <path d="M5 30v-5c0-7 22-7 22 0v5z" />
    </svg>
  );
}
export type StatusTone = 'idle' | 'ok' | 'run' | 'warn' | 'err';
export function ProfileAvatar({
  url,
  online,
  refreshKey = 0,
  tone,
  toneLabel,
}: {
  url: string | null;
  online: boolean;
  refreshKey?: number;
  tone?: StatusTone;
  toneLabel?: string;
}) {
  const showAvatar = Boolean(url && tone !== 'err');
  const label = showAvatar
    ? 'Facebook顶部头像观察；操作身份未确认，加载失败时使用白头'
    : '账号身份待识别';
  return (
    <span className="avatar" aria-label={label} title={label}>
      {showAvatar && url ? <AvatarImage key={url + ':' + refreshKey} url={url} /> : <WhiteAvatar />}
      <i
        className={tone ? 'dot-' + tone : online ? 'online' : ''}
        title={toneLabel}
        aria-label={toneLabel}
      />
    </span>
  );
}
