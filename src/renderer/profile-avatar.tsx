import { useState } from 'react';

const DOT_TONE: Record<StatusTone, string> = {
  ok: 'bg-[#1f9d55]',
  idle: 'bg-[#9aa1aa]',
  run: 'bg-[var(--brand)] animate-pulse',
  warn: 'bg-[#e6a417]',
  err: 'bg-[var(--err)]',
};

function AvatarImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <WhiteAvatar />
  ) : (
    <img
      src={url}
      className="h-[30px] w-[30px] rounded-full object-cover"
      alt="Facebook顶部头像观察，操作身份未确认"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

const WhiteAvatar = () => (
  <svg
    viewBox="0 0 32 32"
    className="h-[30px] w-[30px] overflow-hidden rounded-full fill-[#a9b1bb]"
    aria-hidden="true"
  >
    <circle cx="16" cy="10" r="6" />
    <path d="M5 30v-5c0-7 22-7 22 0v5z" />
  </svg>
);

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
    <span
      className="avatar relative inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[#e3e7ec]"
      aria-label={label}
      title={label}
    >
      {showAvatar && url ? <AvatarImage key={`${url}:${refreshKey}`} url={url} /> : <WhiteAvatar />}
      <i
        className={`box-content absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border-2 border-[var(--sidebar-bg)] ${tone ? DOT_TONE[tone] : online ? 'bg-[#1f9d55]' : 'bg-[#9aa1aa]'}`}
        title={toneLabel}
        aria-label={toneLabel}
      />
    </span>
  );
}
