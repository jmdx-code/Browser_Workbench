import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { QuickScheduleSeed } from '../../shared/auto-scheduler.js';
import {
  canPosterMaterialUseColorBackground,
  hasPosterMaterialContent,
  type PosterMaterial,
  type PosterMaterialAiLabel,
  type PosterMaterialBackground,
  type PosterMaterialInput,
  type PosterState,
  type PosterTask,
} from '../../shared/group-poster.js';
import type { TargetFolder } from '../../shared/target-list.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { mediaReference } from '../../domain/resource-table.js';
import { api } from '../api.js';
import { orderedFinderItems } from '../finder-target-list.js';
import { extractGroupId, type DraftGroupEntry } from '../group-inviter-grid.js';
import { createEmptyMaterialDraft, toMaterialDraft } from '../poster-material-matrix.js';
import { UI_INPUT, UI_TEXTAREA } from '../ui/primitives.js';
import {
  BackdropModal,
  Btn,
  errMsg,
  Fld,
  ModalFoot,
  ModalHeading,
  SelFld,
} from './shared/module-ui.js';

export const emptyDraftRows = (n = 8): DraftGroupEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `row-${i}-${Date.now()}`,
    groupId: '',
    groupName: '',
  }));

export function mergeServerMaterialsIntoDrafts(
  prev: readonly MaterialDraft[],
  serverMaterials: readonly PosterMaterial[],
): MaterialDraft[] {
  const byId = new Map(serverMaterials.map((m) => [m.id, toMaterialDraft(m)]));
  if (!prev.some(hasPosterMaterialContent) && serverMaterials.length > 0 && prev.length <= 1)
    return serverMaterials.map(toMaterialDraft);
  const merged: MaterialDraft[] = [];
  for (const d of prev) {
    const row = byId.get(d.id);
    if (row) {
      merged.push(row);
      byId.delete(d.id);
    } else if (!hasPosterMaterialContent(d)) merged.push(d);
  }
  merged.push(...byId.values());
  return merged.length > 0 ? merged : [createEmptyMaterialDraft()];
}

export const toMaterialInputs = (rows: readonly MaterialDraft[]): PosterMaterialInput[] =>
  rows.filter(hasPosterMaterialContent).map((d) => ({
    id: d.id,
    caption: d.caption.trim(),
    mediaSource: d.mediaSource.trim(),
    background: d.mediaSource.trim() ? 'plain' : d.background,
    aiLabel: d.aiLabel ?? 'default',
    selected: d.selected,
  }));

export const buildGroupAddItems = (rows: readonly DraftGroupEntry[], folderId: string | null) =>
  rows
    .filter((r) => r.groupId.trim() || r.groupName.trim())
    .map((r) => ({ id: extractGroupId(r.groupId), name: r.groupName.trim(), folderId }));

export function buildMaterialScheduleSeed(
  row: MaterialDraft,
  state: PosterState | null,
  folders: readonly TargetFolder[],
  selectedProfileIds: ReadonlySet<string>,
  settings: PosterState['settings'] | null,
): QuickScheduleSeed {
  const posted = new Set(state?.postedGroupIdsByMaterial?.[row.id] ?? []);
  const all = state?.groups ?? [];
  const cand = orderedFinderItems(all, folders)
    .filter((g) => !posted.has(g.id))
    .map((g) => g.id);
  return {
    carrier: 'browser',
    name: `发帖 · ${row.caption.trim().slice(0, 18) || '小组发帖'}`,
    targetIds: [...selectedProfileIds],
    steps: [
      {
        id: crypto.randomUUID(),
        type: 'group-poster',
        materialIds: [row.id],
        groupIds: cand.length ? cand : all.map((g) => g.id),
        maxGroupsPerProfile: Math.max(1, Math.min(50, settings?.maxPostsPerAccount ?? 3)),
        materialsPerGroup: Math.max(1, Math.min(50, settings?.materialsPerGroup ?? 1)),
      },
    ],
  };
}

export const buildBsPosterScheduleSeed = (
  targetIds: readonly string[],
  materialIds: readonly string[],
  groupIds: readonly string[],
  maxGroups: number,
  postToTimeline: boolean,
): QuickScheduleSeed => ({
  carrier: 'bluestacks',
  name: '蓝蝶小组发帖',
  targetIds: [...targetIds],
  steps: [
    {
      id: crypto.randomUUID(),
      type: 'bluestacks-group-poster',
      materialIds: [...materialIds],
      groupIds: [...groupIds],
      maxGroupsPerProfile: Math.max(1, Math.min(50, maxGroups)),
      materialsPerGroup: 1,
      postToTimeline,
    },
  ],
});

export function applyBatchMaterialPatch(
  drafts: readonly MaterialDraft[],
  ids: readonly string[],
  patch: Partial<MaterialDraft>,
) {
  const idSet = new Set(ids);
  const updated: MaterialDraft[] = [];
  const next = drafts.map((d) => {
    if (!idSet.has(d.id)) return d;
    const merged: MaterialDraft = {
      ...d,
      ...patch,
      ...(d.mediaSource.trim() || patch.mediaSource?.trim()
        ? { background: 'plain' as const }
        : {}),
    };
    updated.push(merged);
    return merged;
  });
  return { next, updated };
}

export function formatCreatedDate(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '刚刚创建';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const taskStatusBadge = (status: PosterTask['status']): { label: string; cls: string } =>
  ({
    scheduled: {
      label: '⏰ 定时待启动',
      cls: 'border border-amber-200 bg-amber-50 text-amber-800',
    },
    running: { label: '▶ 正在发送', cls: 'border border-blue-200 bg-blue-50 text-blue-700' },
    completed: {
      label: '✓ 已完成',
      cls: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
    },
    partial: { label: '◑ 部分成功', cls: 'border border-amber-200 bg-amber-50 text-amber-800' },
    failed: { label: '✕ 失败', cls: 'border border-rose-200 bg-rose-50 text-rose-700' },
    cancelled: { label: '■ 已停止', cls: 'border border-slate-200 bg-slate-100 text-slate-600' },
  })[status];

export function posterRowBadge(row: MaterialDraft): { text: string; cls: string; title: string } {
  if (!hasPosterMaterialContent(row))
    return {
      text: '空行',
      cls: 'border border-slate-200 bg-slate-100 text-slate-500',
      title: '未填写文案或媒体',
    };
  const src = row.mediaSource.trim();
  if (!src) {
    if (row.background === 'color') {
      return canPosterMaterialUseColorBackground(row)
        ? {
            text: '彩贴',
            cls: 'border border-violet-200 bg-violet-50 text-violet-700',
            title: '纯文字彩底贴文（≤120字且≤4行）',
          }
        : {
            text: '彩贴(超长转文字)',
            cls: 'border border-slate-200 bg-slate-100 text-slate-700',
            title: '超过 120 字符或 4 行，Facebook 将自动按普通文字发布',
          };
    }
    return {
      text: '纯文案',
      cls: 'border border-slate-200 bg-slate-100 text-slate-700',
      title: '普通纯文字贴文',
    };
  }
  let isLocal = false;
  try {
    isLocal = mediaReference(src).kind === 'local';
  } catch {
    isLocal = false;
  }
  if (row.cacheStatus === 'ready') {
    const k = row.mediaKind === 'image' ? '图片' : '视频';
    return {
      text: isLocal ? `本机${k}` : `已缓存 (${k})`,
      cls: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
      title: row.localFilePath ?? '媒体已就绪',
    };
  }
  if (row.cacheStatus === 'expired')
    return {
      text: '已释空(用时重下)',
      cls: 'border border-slate-200 bg-slate-100 text-slate-700',
      title: '超过 3 天未使用已自动清理缓存文件，下次发帖用到时自动重下',
    };
  if (row.cacheStatus === 'downloading')
    return {
      text: '下载缓存中…',
      cls: 'border border-blue-200 bg-blue-50 text-blue-700',
      title: '正在后台下载并缓存网盘媒体',
    };
  return {
    text: isLocal ? '本地文件不存在' : '缓存失败',
    cls: 'border border-rose-200 bg-rose-50 text-rose-700',
    title: row.cacheError ?? '媒体下载或校验失败',
  };
}

const mediaEndpoint = (kind: 'media' | 'thumbnail', row: MaterialDraft) =>
  `/api/workspace/group-poster/materials/${kind}?id=${encodeURIComponent(row.id)}&v=${row.updatedAt ?? 0}`;

export function useSerialVideoThumbnailGenerator(
  rows: readonly MaterialDraft[],
  onThumbnailSaved: (id: string) => void,
  options?: { persistedIds?: ReadonlySet<string> | undefined; paused?: boolean | undefined },
) {
  const attemptedRef = useRef(new Set<string>());
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const onSavedRef = useRef(onThumbnailSaved);
  onSavedRef.current = onThumbnailSaved;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (runningRef.current || options?.paused || typeof document === 'undefined') return;
    const persistedIds = options?.persistedIds;
    const cand = rows.find(
      (r) =>
        r.mediaKind === 'video' &&
        r.cacheStatus === 'ready' &&
        Boolean(r.localFilePath) &&
        !r.hasThumbnail &&
        (!persistedIds || persistedIds.has(r.id)) &&
        !attemptedRef.current.has(`${r.id}:${r.mediaSource}`),
    );
    if (!cand) return;
    attemptedRef.current.add(`${cand.id}:${cand.mediaSource}`);
    runningRef.current = true;

    void (async () => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      try {
        const dataUrl = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000);
          let seeked = false;
          const seek = () => {
            if (seeked) return;
            seeked = true;
            try {
              video.currentTime = Math.min(0.1, Math.max(0, (video.duration || 1) * 0.05));
            } catch {
              clearTimeout(timer);
              resolve(null);
            }
          };
          video.onerror = () => {
            clearTimeout(timer);
            resolve(null);
          };
          video.onloadedmetadata = seek;
          video.onloadeddata = seek;
          video.onseeked = () => {
            clearTimeout(timer);
            try {
              const { videoWidth: w, videoHeight: h } = video;
              if (!w || !h) return resolve(null);
              const scale = Math.min(1, 480 / Math.max(w, h));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(w * scale));
              canvas.height = Math.max(1, Math.round(h * scale));
              const ctx = canvas.getContext('2d');
              if (!ctx) return resolve(null);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const out = canvas.toDataURL('image/webp', 0.86);
              resolve(
                out.startsWith('data:image/webp;base64,') && out.length <= 96 * 1024 ? out : null,
              );
            } catch {
              resolve(null);
            }
          };
          video.src = mediaEndpoint('media', cand);
        });
        if (
          mountedRef.current &&
          dataUrl &&
          (await api.savePosterMaterialThumbnail(cand.id, dataUrl)).saved &&
          mountedRef.current
        )
          onSavedRef.current(cand.id);
      } catch {
        /* ignore */
      } finally {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
          video.remove();
        } catch {
          /* ignore */
        }
        runningRef.current = false;
        if (mountedRef.current) setTick((t) => t + 1);
      }
    })();
  }, [rows, options?.paused, options?.persistedIds, tick]);
}

function renderMediaContent(row: MaterialDraft) {
  const isReadyVideo = row.mediaKind === 'video' && row.cacheStatus === 'ready';
  const mediaUrl = mediaEndpoint('media', row);
  const imgSrc =
    row.mediaKind === 'image' && row.cacheStatus === 'ready'
      ? mediaUrl
      : !isReadyVideo && row.hasThumbnail
        ? mediaEndpoint('thumbnail', row)
        : null;
  if (isReadyVideo)
    return (
      <video
        src={`${mediaUrl}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        className="h-full w-full object-cover"
      />
    );
  if (imgSrc)
    return (
      <img
        loading="lazy"
        decoding="async"
        src={imgSrc}
        alt=""
        className="h-full w-full object-cover"
      />
    );
  return null;
}

export function PosterMaterialThumbnailCell({
  row,
  onPreview,
}: {
  row: MaterialDraft;
  onPreview: (row: MaterialDraft) => void;
}) {
  const mediaNode = renderMediaContent(row);
  if (mediaNode) {
    return (
      <button
        type="button"
        className="relative inline-flex h-11 w-14 items-center justify-center overflow-hidden rounded border border-[var(--line)] bg-slate-100 p-0"
        aria-label={`预览素材媒体 ${row.id}`}
        title="点击放大预览原图/原视频"
        onClick={(e) => {
          e.stopPropagation();
          onPreview(row);
        }}
      >
        {mediaNode}
        {row.mediaKind === 'video' && (
          <span
            className="absolute right-0.5 bottom-0.5 rounded bg-black/70 px-1 text-[9px] text-white"
            aria-hidden="true"
          >
            ▶
          </span>
        )}
      </button>
    );
  }
  return (
    <span className="text-xs text-[var(--text-3)]">
      {row.mediaSource.trim() ? (row.mediaKind === 'video' ? '🎬 视频' : '🖼️ 图片') : '—'}
    </span>
  );
}

export function PosterMaterialSummaryBox(p: {
  row: MaterialDraft;
  badge: { text: string; cls: string };
  extraBadges?: ReactNode;
  metaRow?: ReactNode;
  className?: string;
  onPreview: () => void;
}) {
  return (
    <div
      className={
        p.className ?? 'flex gap-3 rounded-xl border border-[var(--line)] bg-slate-50/70 p-2.5'
      }
    >
      <div className="h-20 w-24 shrink-0 overflow-hidden rounded-lg border border-[var(--line)] bg-white">
        <PosterMaterialCardPreview row={p.row} onPreview={p.onPreview} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`poster-status-badge inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${p.badge.cls}`}
          >
            {p.badge.text}
          </span>
          {p.extraBadges}
          <span className="text-[11px] text-[var(--text-3)]">
            {formatCreatedDate(p.row.createdAt)}
          </span>
        </div>
        {p.metaRow}
        <div className="line-clamp-2 text-slate-800">
          {p.row.caption.trim() || '（无文字文案，仅发送图片/视频媒体）'}
        </div>
      </div>
    </div>
  );
}

export function PosterMaterialCardPreview({
  row,
  onPreview,
}: {
  row: MaterialDraft;
  onPreview: (row: MaterialDraft) => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPreview(row);
    }
  };
  if (!row.mediaSource.trim()) {
    const cls = canPosterMaterialUseColorBackground(row)
      ? 'bg-gradient-to-br from-violet-600 to-indigo-600 font-semibold text-white'
      : 'bg-slate-50 text-slate-700';
    return (
      <div
        className={`flex h-full w-full cursor-pointer items-center justify-center p-3 text-center ${cls}`}
        onClick={() => onPreview(row)}
        role="button"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="line-clamp-4 text-xs leading-relaxed">
          {row.caption.trim() || '（未填写发帖文案）'}
        </div>
      </div>
    );
  }
  const mediaNode = renderMediaContent(row);
  const fallbackTxt =
    row.cacheStatus === 'downloading'
      ? '正在下载缓存媒体…'
      : row.cacheStatus === 'error'
        ? (row.cacheError ?? '媒体加载失败')
        : row.mediaKind === 'video'
          ? '视频素材'
          : '图片素材';
  return (
    <div
      className="relative flex h-full w-full cursor-pointer items-center justify-center overflow-hidden bg-slate-900"
      role="button"
      tabIndex={0}
      title="点击放大预览画面"
      onClick={() => onPreview(row)}
      onKeyDown={onKeyDown}
    >
      {mediaNode ?? (
        <div className="flex flex-col items-center gap-1 p-2 text-center text-[11px] text-slate-300">
          <span className="text-xl">{row.mediaKind === 'video' ? '🎬' : '🖼️'}</span>
          <span>{fallbackTxt}</span>
        </div>
      )}
      {row.mediaKind === 'video' && (
        <span
          className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white"
          aria-hidden="true"
        >
          ▶ 视频
        </span>
      )}
    </div>
  );
}

export function PosterMediaPreviewModal({
  row,
  onClose,
}: {
  row: MaterialDraft | null;
  onClose: () => void;
}) {
  if (!row) return null;
  const hasMedia = row.mediaSource.trim().length > 0;
  const mediaUrl = mediaEndpoint('media', row);
  const thumbUrl = mediaEndpoint('thumbnail', row);
  const canStream = hasMedia && row.cacheStatus === 'ready' && Boolean(row.localFilePath);
  return (
    <BackdropModal
      label={hasMedia ? '预览贴文素材媒体' : '预览贴文文案'}
      modalClass="!gap-0 !p-0 flex max-h-[88vh] w-[min(720px,92vw)] flex-col overflow-hidden"
      onClose={onClose}
    >
      <ModalHeading title={hasMedia ? '预览素材媒体' : '预览贴文文案'} onClose={onClose} />
      <div className="flex flex-col items-center gap-2.5 overflow-auto p-4">
        {!hasMedia ? (
          <div className="w-full rounded-xl border border-[var(--line)] bg-slate-50 p-4 text-sm leading-relaxed whitespace-pre-wrap">
            {row.caption.trim() || '（未填写发帖文案）'}
          </div>
        ) : canStream ? (
          row.mediaKind === 'video' ? (
            <video controls autoPlay src={mediaUrl} className="max-h-[68vh] rounded-lg" />
          ) : (
            <img
              src={mediaUrl}
              alt={row.caption || row.mediaSource}
              className="max-h-[68vh] rounded-lg object-contain"
            />
          )
        ) : row.hasThumbnail ? (
          <img
            src={thumbUrl}
            alt={row.caption || row.mediaSource}
            className="max-h-[68vh] rounded-lg object-contain"
          />
        ) : (
          <p className="text-xs text-[var(--text-3)]">
            当前媒体尚未缓存就绪，保存或发帖时会自动准备。
          </p>
        )}
        {hasMedia && (
          <small className="text-xs break-all text-[var(--text-3)]">{row.mediaSource}</small>
        )}
      </div>
    </BackdropModal>
  );
}

export function PosterMaterialEditModal({
  initial,
  isNew,
  busy,
  onClose,
  onSaveItem,
}: {
  initial: MaterialDraft;
  isNew: boolean;
  busy: boolean;
  onClose: () => void;
  onSaveItem: (updated: MaterialDraft) => Promise<boolean>;
}) {
  const [caption, setCaption] = useState(initial.caption);
  const [mediaSource, setMediaSource] = useState(initial.mediaSource);
  const [background, setBackground] = useState<PosterMaterialBackground>(initial.background);
  const [aiLabel, setAiLabel] = useState<PosterMaterialAiLabel>(initial.aiLabel ?? 'default');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    setError('');
    const trimmedCaption = caption.trim();
    const trimmedMedia = mediaSource.trim();
    if (!trimmedCaption && !trimmedMedia) return setError('请至少填写发帖文案或选择图片/视频媒体');
    let normalizedSource = trimmedMedia;
    if (trimmedMedia) {
      try {
        normalizedSource = mediaReference(trimmedMedia).source;
      } catch (err) {
        return setError(errMsg(err, '媒体路径或链接格式无效'));
      }
    }
    if (
      await onSaveItem({
        ...initial,
        caption: trimmedCaption,
        mediaSource: normalizedSource,
        background: normalizedSource ? 'plain' : background,
        aiLabel,
        createdAt: initial.createdAt || Date.now(),
      })
    )
      onClose();
  };

  return (
    <BackdropModal
      label={isNew ? '新建贴文素材' : '编辑贴文素材'}
      modalClass="!gap-0 !p-0 flex w-[min(620px,94vw)] flex-col overflow-hidden"
      busy={busy}
      onClose={onClose}
    >
      <ModalHeading
        title={isNew ? '新建贴文素材' : '编辑贴文素材'}
        disabled={busy}
        closeText="×"
        onClose={onClose}
      />
      <div className="flex flex-col gap-3 p-4">
        <Fld label="发帖文案">
          <textarea
            rows={5}
            className={UI_TEXTAREA}
            placeholder="输入发帖文案（支持多行文本与表情）…"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </Fld>
        <Fld label="画面媒体（本机图片/视频路径 或 Google Drive 分享链接，留空则为纯文字贴）">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              className={`${UI_INPUT} min-w-0 flex-1`}
              placeholder="例如 D:\videos\post1.mp4 或 https://drive.google.com/file/d/..."
              value={mediaSource}
              onChange={(e) => {
                setMediaSource(e.target.value);
                if (e.target.value.trim()) setBackground('plain');
              }}
            />
            <Btn onClick={() => fileInputRef.current?.click()}>浏览本机图片/视频…</Btn>
            {mediaSource && <Btn onClick={() => setMediaSource('')}>清除媒体</Btn>}
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,image/*,video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const localPath = (
                  window.workbenchDesktop?.materialFilePath?.(file) ||
                  ((file as File & { path?: string }).path ?? '')
                ).trim();
                if (!localPath)
                  return setError('当前环境未能读取本地文件路径，请直接在下方粘贴文件完整路径');
                setMediaSource(localPath);
                setBackground('plain');
                setError('');
              }}
            />
          </div>
        </Fld>
        {!mediaSource.trim() && (
          <SelFld
            label="文字背景样式（无媒体时生效）"
            value={background}
            onVal={(v) => setBackground(v === 'color' ? 'color' : 'plain')}
          >
            <option value="plain">普通文字</option>
            <option value="color">Facebook 彩色背景（≤120字且≤4行）</option>
          </SelFld>
        )}
        <SelFld
          label="AI 内容声明标签"
          aria-label="AI 内容声明标签"
          value={aiLabel}
          onVal={(v) => setAiLabel(v === 'on' ? 'on' : v === 'off' ? 'off' : 'default')}
        >
          <option value="default">默认（保持页面原状态）</option>
          <option value="on">开启 AI 声明标签</option>
          <option value="off">关闭 AI 声明标签</option>
        </SelFld>
        {error && (
          <p className="m-0 text-xs font-medium text-rose-600" role="alert">
            {error}
          </p>
        )}
      </div>
      <ModalFoot
        busy={busy}
        okText={busy ? '正在保存…' : '保存贴文'}
        onCancel={onClose}
        onOk={() => void handleSubmit()}
      />
    </BackdropModal>
  );
}
