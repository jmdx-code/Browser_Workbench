import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { isUuidLike, type AccountActivityRow } from '../../shared/activity-stats.js';
import type { InviterRecord } from '../../shared/group-inviter.js';
import { isPendingApprovalPostId } from '../../shared/group-poster.js';
import { formatTimestampLocal } from '../../shared/log-table-copy.js';
import type { PostBumpRecord } from '../../shared/post-bump-records.js';
import { copyTextToClipboard } from '../clipboard.js';
import type { TableColumnDef } from './configurable-data-table.js';
import { TonePill } from './shared/module-ui.js';
const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDate = (ms: number | null, mode: 'd' | 't') => {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return mode === 'd'
    ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
export const formatDateYmd = (ms: number | null) => fmtDate(ms, 'd');
export const formatTimeHms = (ms: number | null) => fmtDate(ms, 't');
export const formatDurationHuman = (ms: number) => {
  if (!ms || ms < 1000) return '0s';
  const totalSec = Math.floor(ms / 1000),
    h = Math.floor(totalSec / 3600),
    m = Math.floor((totalSec % 3600) / 60),
    s = totalSec % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};
const carrierLabel = (c: 'browser' | 'bluestacks' | 'mixed') =>
  c === 'bluestacks' ? '蓝蝶' : c === 'mixed' ? '混合' : '浏览器';
const dash = <span className="text-slate-300">-</span>;
function AvatarCell({ url, fallback }: { url: string; fallback: string }) {
  const [failedUrl, setFailedUrl] = useState('');
  const clean = fallback.trim();
  if (!url && !clean) return dash;
  if (!url || failedUrl === url)
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">
        {(clean[0] ?? '-').toUpperCase()}
      </span>
    );
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailedUrl(url)}
      className="h-6 w-6 rounded-full border border-slate-200 object-cover"
    />
  );
}
const TextCell = ({ text }: { text: string }) =>
  text ? (
    <span className="block truncate text-[var(--text)]" title={text}>
      {text}
    </span>
  ) : (
    dash
  );
const MonoIdCell = ({ id }: { id: string }) =>
  id ? (
    <span className="block truncate font-mono text-[11px] text-[var(--text-2)]" title={id}>
      {id}
    </span>
  ) : (
    dash
  );
const WindowNameCell = ({ text }: { text: string }) =>
  !text ? (
    dash
  ) : isUuidLike(text) ? (
    <span className="block truncate text-[var(--text-3)]" title={`已移除窗口 (${text})`}>
      已移除窗口 · {text.slice(0, 8)}
    </span>
  ) : (
    <TextCell text={text} />
  );
function PostUrlCell({ url, onNotify }: { url: string; onNotify: (msg: string) => void }) {
  if (!url) return dash;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={url}
        className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-[var(--brand)] hover:underline"
      >
        <ExternalLink size={12} className="shrink-0" />
        <span className="truncate">{url}</span>
      </a>
      <button
        type="button"
        title="复制贴文链接"
        aria-label="复制贴文链接"
        className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        onClick={() => void copyTextToClipboard(url).then(() => onNotify('已复制贴文链接'))}
      >
        <Copy size={12} />
      </button>
    </div>
  );
}
const postStatusMeta = (r: PostBumpRecord) =>
  r.status === 'failed'
    ? { label: '失败', color: '#c53030', bg: '#fff5f5' }
    : r.recordType === 'post' && isPendingApprovalPostId(r.postId)
      ? { label: '待群管审核', color: '#b45309', bg: '#fef3c7' }
      : { label: '成功', color: '#1f9d55', bg: '#e5f5ec' };
const mk = <T,>(
  key: string,
  label: string,
  defaultWidth: number,
  renderCell: TableColumnDef<T>['renderCell'],
  exportValue: TableColumnDef<T>['exportValue'],
  opts?: Partial<TableColumnDef<T>>,
): TableColumnDef<T> => ({ key, label, defaultWidth, renderCell, exportValue, ...opts });
const tc = <T,>(k: string, l: string, w: number, g: (r: T) => string, hid?: 0) =>
  mk<T>(k, l, w, (r) => <TextCell text={g(r)} />, g, hid === 0 ? { defaultVisible: false } : {});
const mc = <T,>(k: string, l: string, w: number, g: (r: T) => string, hid?: 0) =>
  mk<T>(k, l, w, (r) => <MonoIdCell id={g(r)} />, g, hid === 0 ? { defaultVisible: false } : {});
const ac = <T,>(k: string, l: string, w: number, get: (r: T) => [string, string], hid?: 0) =>
  mk<T>(
    k,
    l,
    w,
    (r) => {
      const [u, f] = get(r);
      return <AvatarCell url={u} fallback={f} />;
    },
    (r) => get(r)[0] || '',
    { align: 'center', ...(hid === 0 ? { defaultVisible: false } : {}) },
  );
const dt = <T,>(dw: number, tw: number, g: (r: T) => number | null): TableColumnDef<T>[] => [
  mk(
    'date',
    '日期',
    dw,
    (r) => <span className="tabular-nums">{formatDateYmd(g(r))}</span>,
    (r) => formatDateYmd(g(r)),
  ),
  mk(
    'time',
    '时间',
    tw,
    (r) => <span className="tabular-nums">{formatTimeHms(g(r))}</span>,
    (r) => formatTimeHms(g(r)),
  ),
];
const cc = <T extends { carrier: 'browser' | 'bluestacks' | 'mixed' }>(w: number) =>
  mk<T>(
    'carrier',
    '载体',
    w,
    (r) => (
      <TonePill
        label={carrierLabel(r.carrier)}
        color={
          r.carrier === 'bluestacks' ? '#255fd6' : r.carrier === 'mixed' ? '#7c3aed' : '#334155'
        }
        bg={r.carrier === 'bluestacks' ? '#e9f0fe' : r.carrier === 'mixed' ? '#f3e8ff' : '#f1f5f9'}
      />
    ),
    (r) => carrierLabel(r.carrier),
  );
const wc = <T extends { windowName: string }>(w: number, opts?: Partial<TableColumnDef<T>>) =>
  mk<T>(
    'windowName',
    '窗口名',
    w,
    (r) => <WindowNameCell text={r.windowName} />,
    (r) => r.windowName,
    opts,
  );
const urlCol = (onNotify: (m: string) => void) =>
  mk<PostBumpRecord>(
    'postUrl',
    '贴文链接',
    210,
    (r) => <PostUrlCell url={r.postUrl} onNotify={onNotify} />,
    (r) => r.postUrl,
  );
const stCol = (w: number) =>
  mk<PostBumpRecord>(
    'status',
    '状态',
    w,
    (r) => {
      const s = postStatusMeta(r);
      return <TonePill label={s.label} color={s.color} bg={s.bg} />;
    },
    (r) => postStatusMeta(r).label,
  );
const grpCols = <T extends { groupAvatarUrl: string; groupName: string; groupId: string }>(
  nw = 134,
  iw = 120,
  aw = 74,
): TableColumnDef<T>[] => [
  ac<T>('groupAvatar', '小组头像', aw, (r) => [r.groupAvatarUrl, r.groupName || r.groupId]),
  tc<T>('groupName', '小组名', nw, (r) => r.groupName),
  mc<T>('groupId', '小组 ID', iw, (r) => r.groupId),
];
export function buildPostColumns(
  onNotify: (msg: string) => void,
): TableColumnDef<PostBumpRecord>[] {
  const t = tc<PostBumpRecord>,
    m = mc<PostBumpRecord>,
    a = ac<PostBumpRecord>;
  return [
    ...dt<PostBumpRecord>(84, 68, (r) => r.createdAt),
    cc(56),
    wc(108, { defaultVisible: false }),
    a('accountAvatar', '账号/专页头像', 88, (r) => [
      r.accountAvatarUrl || r.pageAvatarUrl,
      r.accountName || r.pageName || r.accountId,
    ]),
    t('accountName', '账号/专页名', 116, (r) => r.accountName || r.pageName),
    m('accountId', '账号/专页 ID', 120, (r) => r.accountId || r.pageId),
    ...grpCols(),
    urlCol(onNotify),
    m('postId', '贴文 ID', 120, (r) => r.postId, 0),
    stCol(76),
    t('captionPreview', '文案摘要', 190, (r) => r.captionPreview, 0),
    t('errorReason', '失败原因', 180, (r) => r.errorReason, 0),
  ];
}
export function buildBumpColumns(
  onNotify: (msg: string) => void,
): TableColumnDef<PostBumpRecord>[] {
  const t = tc<PostBumpRecord>,
    m = mc<PostBumpRecord>,
    a = ac<PostBumpRecord>,
    b = (k: string, l: string, w: number, g: (r: PostBumpRecord) => boolean, y: string, hid?: 0) =>
      mk<PostBumpRecord>(
        k,
        l,
        w,
        (r) => <span>{g(r) ? y : '-'}</span>,
        (r) => (g(r) ? '是' : '否'),
        { align: 'center', ...(hid === 0 ? { defaultVisible: false } : {}) },
      );
  return [
    ...dt<PostBumpRecord>(84, 68, (r) => r.createdAt),
    cc(56),
    mk(
      'bumpType',
      '类型',
      74,
      (r) => <span>{r.recordType === 'page_bump' ? '专页顶贴' : '小组顶贴'}</span>,
      (r) => (r.recordType === 'page_bump' ? '专页顶贴' : '小组顶贴'),
    ),
    wc(108, { defaultVisible: false }),
    a(
      'accountAvatar',
      '顶贴账号头像',
      68,
      (r) => [r.accountAvatarUrl, r.accountName || r.accountId],
      0,
    ),
    t('accountName', '顶贴账号名', 116, (r) => r.accountName),
    m('accountId', '顶贴账号 ID', 120, (r) => r.accountId),
    a('pageAvatar', '专页头像', 68, (r) => [r.pageAvatarUrl, r.pageName || r.pageId]),
    t('pageName', '专页名', 116, (r) => r.pageName),
    m('pageId', '专页 ID', 120, (r) => r.pageId),
    ...grpCols(),
    urlCol(onNotify),
    m('postId', '贴文 ID', 130, (r) => r.postId, 0),
    b('liked', '点赞', 56, (r) => r.liked, '已赞'),
    t('commentText', '评论内容', 170, (r) => r.commentText ?? ''),
    b('storyShared', '快拍转发', 72, (r) => r.storyShared, '已转', 0),
    stCol(72),
    t('errorReason', '失败原因', 180, (r) => r.errorReason, 0),
  ];
}
export function buildInviteColumns(): TableColumnDef<InviterRecord>[] {
  const t = tc<InviterRecord>,
    m = mc<InviterRecord>,
    a = ac<InviterRecord>;
  return [
    ...dt<InviterRecord>(80, 64, (r) => r.invitedAt),
    cc(52),
    wc(108, { defaultVisible: false }),
    a(
      'accountAvatar',
      '邀请账号头像',
      68,
      (r) => [r.accountAvatarUrl, r.accountName || r.accountId],
      0,
    ),
    t('accountName', '邀请账号名', 102, (r) => r.accountName),
    m('accountId', '邀请账号 ID', 108, (r) => r.accountId),
    ...grpCols(118, 108, 74),
    t('friendName', '好友名', 100, (r) => r.friendName),
    m('friendId', '好友 ID', 108, (r) => r.friendId),
    mk(
      'confirmation',
      '状态',
      66,
      (r) => (
        <TonePill
          label={r.confirmation === 'CONFIRMED' ? '已确认' : '待确认'}
          color={r.confirmation === 'CONFIRMED' ? '#1f9d55' : '#b45309'}
          bg={r.confirmation === 'CONFIRMED' ? '#e5f5ec' : '#fef3c7'}
        />
      ),
      (r) => (r.confirmation === 'CONFIRMED' ? '已确认' : '待确认'),
    ),
  ];
}
export function buildStatsColumns(
  onDrillDown?: (req: { tab: 'posts' | 'bumps' | 'invites'; row: AccountActivityRow }) => void,
): TableColumnDef<AccountActivityRow>[] {
  const num = (
    k: keyof AccountActivityRow & string,
    l: string,
    w: number,
    opts?: { hid?: 0; drill?: 'posts' | 'bumps' | 'invites'; bold?: 1; err?: 1 },
  ) =>
    mk<AccountActivityRow>(
      k,
      l,
      w,
      (r) => {
        const v = Number(r[k]);
        if (opts?.drill && onDrillDown && v > 0)
          return (
            <button
              type="button"
              className="cursor-pointer font-medium tabular-nums text-[var(--brand)] hover:underline"
              title="点击查看明细记录"
              onClick={() =>
                onDrillDown({ tab: opts.drill as 'posts' | 'bumps' | 'invites', row: r })
              }
            >
              {v}
            </button>
          );
        const cls = opts?.bold
          ? 'font-bold tabular-nums text-[var(--text)]'
          : opts?.err && v > 0
            ? 'font-semibold tabular-nums text-rose-600'
            : 'tabular-nums';
        return <span className={cls}>{v}</span>;
      },
      (r) => r[k],
      { align: 'right', sortKey: k, ...(opts?.hid === 0 ? { defaultVisible: false } : {}) },
    );
  return [
    cc(50),
    mk<AccountActivityRow>(
      'windowName',
      '窗口名',
      96,
      (r) => {
        if ((r.windowCount ?? 1) <= 1) return <WindowNameCell text={r.windowName} />;
        const names = r.mergedWindowNames?.length
          ? r.mergedWindowNames
          : r.windowName.split(' / ').filter(Boolean);
        const fullTip = names.length
          ? `已合并 ${r.windowCount} 个窗口：${names.join('、')}`
          : `已合并 ${r.windowCount} 个窗口`;
        return (
          <div className="flex min-w-0 items-center gap-1.5" title={fullTip}>
            <span className="inline-flex shrink-0 items-center rounded-full bg-violet-50 px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap text-violet-700">
              已合并 {r.windowCount} 窗口
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">{r.windowName}</span>
          </div>
        );
      },
      (r) => r.windowName,
      { sortKey: 'windowName' },
    ),
    ac('accountAvatar', '账号头像', 64, (r) => [r.accountAvatarUrl, r.accountName || r.windowName]),
    tc('accountName', '账号名', 76, (r) => r.accountName),
    mc('accountId', '账号 ID', 118, (r) => r.accountId),
    num('posts', '发帖', 46, { drill: 'posts' }),
    num('pendingPosts', '待审核', 64, { hid: 0 }),
    num('groupBumps', '小组顶贴', 74, { hid: 0 }),
    num('pageBumps', '专页顶贴', 74, { hid: 0 }),
    num('bumps', '顶贴合计', 62, { drill: 'bumps' }),
    num('invites', '邀人', 46, { drill: 'invites' }),
    mk(
      'activeDurationMs',
      '活跃时长',
      62,
      (r) => <span className="tabular-nums">{formatDurationHuman(r.activeDurationMs)}</span>,
      (r) => formatDurationHuman(r.activeDurationMs),
      { align: 'right', sortKey: 'activeDurationMs' },
    ),
    num('activeLikes', '活跃点赞', 62),
    num('activeFriends', '加好友', 52),
    num('failures', '失败', 46, { err: 1 }),
    num('totalActions', '总动作', 56, { bold: 1 }),
    mk(
      'lastActiveAt',
      '最后活跃时间',
      122,
      (r) => (
        <span className="tabular-nums text-[var(--text-2)]">
          {r.lastActiveAt ? formatTimestampLocal(r.lastActiveAt) : '-'}
        </span>
      ),
      (r) => (r.lastActiveAt ? formatTimestampLocal(r.lastActiveAt) : ''),
      { sortKey: 'lastActiveAt' },
    ),
    mk(
      'dailyLimit',
      '今日限额状态',
      84,
      (r) =>
        r.dailyLimitReached ? (
          <TonePill
            label="已达上限"
            color="#c53030"
            bg="#fff5f5"
            title={r.dailyLimitReason ?? undefined}
          />
        ) : (
          <TonePill label="正常" color="#1f9d55" bg="#e5f5ec" />
        ),
      (r) => (r.dailyLimitReached ? r.dailyLimitReason || '已达上限' : '正常'),
    ),
  ];
}
