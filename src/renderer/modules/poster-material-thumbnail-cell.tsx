import { useEffect, useRef, useState } from 'react';
import {
  canPosterMaterialUseColorBackground,
  hasPosterMaterialContent,
} from '../../shared/group-poster.js';
import { mediaReference } from '../../domain/resource-table.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { api } from '../api.js';

export const POSTER_COL_WIDTHS_STORAGE_KEY = 'wb_poster_material_col_widths_v1';

export type PosterResizableColKey =
  'thumb' | 'caption' | 'media' | 'background' | 'aiLabel' | 'status';

export const DEFAULT_POSTER_COL_WIDTHS: Record<PosterResizableColKey, number> = {
  thumb: 136,
  caption: 280,
  media: 220,
  background: 112,
  aiLabel: 100,
  status: 132,
};

export function loadPosterColWidths(): Record<PosterResizableColKey, number> {
  try {
    const raw = globalThis.localStorage?.getItem(POSTER_COL_WIDTHS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_POSTER_COL_WIDTHS };
    const parsed = JSON.parse(raw) as Partial<Record<PosterResizableColKey, unknown>>;
    const next = { ...DEFAULT_POSTER_COL_WIDTHS };
    for (const key of Object.keys(DEFAULT_POSTER_COL_WIDTHS) as PosterResizableColKey[]) {
      const val = Number(parsed[key]);
      if (Number.isFinite(val) && val >= 72 && val <= 900) {
        next[key] = Math.round(val);
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_POSTER_COL_WIDTHS };
  }
}

export function savePosterColWidths(widths: Record<PosterResizableColKey, number>): void {
  try {
    globalThis.localStorage?.setItem(POSTER_COL_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Ignore storage errors
  }
}

export function posterRowBadge(row: MaterialDraft): { text: string; cls: string; title: string } {
  if (!hasPosterMaterialContent(row)) {
    return { text: '空行', cls: 'status-empty', title: '未填写文案或媒体' };
  }
  const src = row.mediaSource.trim();
  if (!src) {
    if (row.background === 'color') {
      if (canPosterMaterialUseColorBackground(row)) {
        return { text: '彩贴', cls: 'status-color', title: '纯文字彩底贴文（≤120字且≤4行）' };
      }
      return {
        text: '彩贴(超长转文字)',
        cls: 'status-plain',
        title: '超过 120 字符或 4 行，Facebook 将自动按普通文字发布',
      };
    }
    return { text: '纯文案', cls: 'status-plain', title: '普通纯文字贴文' };
  }

  let isLocal = false;
  try {
    isLocal = mediaReference(src).kind === 'local';
  } catch {
    isLocal = false;
  }

  if (row.cacheStatus === 'ready') {
    const kindLabel = row.mediaKind === 'image' ? '图片' : '视频';
    return {
      text: isLocal ? `本机${kindLabel}` : `已缓存 (${kindLabel})`,
      cls: 'status-ready',
      title: row.localFilePath ?? '媒体已就绪',
    };
  }
  if (row.cacheStatus === 'expired') {
    return {
      text: '已释空(用时重下)',
      cls: 'status-plain',
      title: '超过 3 天未使用已自动清理缓存文件，下次发帖用到时自动重下',
    };
  }
  if (row.cacheStatus === 'downloading') {
    return {
      text: '下载缓存中…',
      cls: 'status-downloading',
      title: '正在后台下载并缓存网盘媒体',
    };
  }
  return {
    text: isLocal ? '本地文件不存在' : '缓存失败',
    cls: 'status-error',
    title: row.cacheError ?? '媒体下载或校验失败',
  };
}

export function useSerialVideoThumbnailGenerator(
  rows: readonly MaterialDraft[],
  onThumbnailSaved: (id: string) => void,
  options?: {
    persistedIds?: ReadonlySet<string> | undefined;
    paused?: boolean | undefined;
  },
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
    const candidate = rows.find(
      (r) =>
        r.mediaKind === 'video' &&
        r.cacheStatus === 'ready' &&
        Boolean(r.localFilePath) &&
        !r.hasThumbnail &&
        (!persistedIds || persistedIds.has(r.id)) &&
        !attemptedRef.current.has(`${r.id}:${r.mediaSource}`),
    );
    if (!candidate) return;

    const key = `${candidate.id}:${candidate.mediaSource}`;
    attemptedRef.current.add(key);
    runningRef.current = true;

    void (async () => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      const cleanupVideo = () => {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
          video.remove();
        } catch {
          // Ignore cleanup errors
        }
      };
      try {
        const dataUrl = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000);
          video.onerror = () => {
            clearTimeout(timer);
            resolve(null);
          };
          video.onloadeddata = () => {
            try {
              video.currentTime = Math.min(0.1, Math.max(0, (video.duration || 1) * 0.05));
            } catch {
              clearTimeout(timer);
              resolve(null);
            }
          };
          video.onseeked = () => {
            clearTimeout(timer);
            try {
              const w = video.videoWidth;
              const h = video.videoHeight;
              if (!w || !h) {
                resolve(null);
                return;
              }
              const scale = Math.min(1, 480 / Math.max(w, h));
              const targetW = Math.max(1, Math.round(w * scale));
              const targetH = Math.max(1, Math.round(h * scale));
              const canvas = document.createElement('canvas');
              canvas.width = targetW;
              canvas.height = targetH;
              const ctx = canvas.getContext('2d');
              if (!ctx) {
                resolve(null);
                return;
              }
              ctx.drawImage(video, 0, 0, targetW, targetH);
              const out = canvas.toDataURL('image/webp', 0.86);
              resolve(
                out.startsWith('data:image/webp;base64,') && out.length <= 96 * 1024 ? out : null,
              );
            } catch {
              resolve(null);
            }
          };
          video.src = `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(candidate.id)}`;
        });
        if (mountedRef.current && dataUrl) {
          const res = await api.savePosterMaterialThumbnail(candidate.id, dataUrl);
          if (res.saved && mountedRef.current) {
            onSavedRef.current(candidate.id);
          }
        }
      } catch {
        // Ignore capture failure
      } finally {
        cleanupVideo();
        runningRef.current = false;
        if (mountedRef.current) {
          setTick((t) => t + 1);
        }
      }
    })();
  }, [rows, options?.paused, options?.persistedIds, tick]);
}

export function PosterMaterialThumbnailCell({
  row,
  onPreview,
}: {
  row: MaterialDraft;
  onPreview: (row: MaterialDraft) => void;
}) {
  const mediaUrl = `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(row.id)}&v=${row.updatedAt ?? 0}`;
  const thumbUrl = `/api/workspace/group-poster/materials/thumbnail?id=${encodeURIComponent(row.id)}&v=${row.updatedAt ?? 0}`;
  const isReadyVideo = row.mediaKind === 'video' && row.cacheStatus === 'ready';
  const isReadyImage = row.mediaKind === 'image' && row.cacheStatus === 'ready';

  if (isReadyVideo || isReadyImage || row.hasThumbnail) {
    return (
      <button
        type="button"
        className="poster-thumb-btn"
        aria-label={`预览素材媒体 ${row.id}`}
        title="点击放大预览原图/原视频"
        onClick={(e) => {
          e.stopPropagation();
          onPreview(row);
        }}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        {isReadyVideo ? (
          <video
            src={`${mediaUrl}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            style={{
              width: '56px',
              height: '56px',
              maxWidth: '56px',
              maxHeight: '56px',
              objectFit: 'cover',
              borderRadius: '4px',
              display: 'block',
            }}
          />
        ) : (
          <img
            loading="lazy"
            decoding="async"
            src={isReadyImage ? mediaUrl : thumbUrl}
            alt=""
            style={{
              width: '56px',
              height: '56px',
              maxWidth: '56px',
              maxHeight: '56px',
              objectFit: 'cover',
              borderRadius: '4px',
              display: 'block',
            }}
          />
        )}
        {row.mediaKind === 'video' && (
          <span
            className="poster-thumb-video-badge"
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: '4px',
              bottom: '4px',
              padding: '1px 5px',
              fontSize: '10px',
              lineHeight: 1.2,
              borderRadius: '3px',
              background: 'rgba(0,0,0,0.72)',
              color: '#fff',
            }}
          >
            ▶
          </span>
        )}
      </button>
    );
  }
  if (row.mediaSource.trim()) {
    return (
      <span className="poster-thumb-placeholder muted">
        {row.mediaKind === 'video' ? '🎬 视频' : '🖼️ 图片'}
      </span>
    );
  }
  return <span className="poster-thumb-empty muted">—</span>;
}
