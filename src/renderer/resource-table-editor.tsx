import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type Ref,
} from 'react';
import type { z } from 'zod';
import {
  emptyResourceRow,
  fillResourceMedia,
  formatResourceCellsForClipboard,
  hasResource,
  mediaReference,
  pasteResourceCells,
  resourceCellValue,
  resourceType,
  validateResourceRows,
} from '../domain/resource-table.js';
import { resourceSourceIssueText } from '../domain/resource-material-rules.js';
import type { SavedCombination } from '../shared/contracts.js';
import type { ResourceDownloadProgressValue } from '../shared/resource-download.js';
import type { ResourceCheckProgressValue, ResourceSourceRow } from '../shared/resource-source.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
import { api } from './api.js';
import {
  expandFillDownTsv,
  getSelectedRowIndices,
  isRowInGridBounds,
  MatrixDataCell,
  parseElectronFilePaths,
  useSpreadsheetGrid,
} from './matrix-grid.js';
import { Btn, errMsg, useShowModal } from './modules/shared/module-ui.js';
import { resourceMatches, type ResourceFilter } from './resource-filter.js';
import { FileLocationButton, UI_INPUT_SM, UI_SELECT_SM } from './ui/primitives.js';

export interface ResourceEditorHandle {
  persist(): Promise<boolean>;
}
type ObservationRow = z.infer<typeof ResourceSourceRow>;

const mkOpts = (vals: readonly string[]) => vals.map((v) => ({ value: v, label: v }));
const FILTER_OPTIONS: [ResourceFilter, string][] = [
  ['all', '全部行'],
  ['attention', '需关注/异常'],
  ['unchecked', '未检查'],
  ['verified', '已通过'],
  ['duplicate', '重复内容'],
  ['drive', '含 Drive 链接'],
  ['post', '仅帖子'],
  ['story', '仅快拍'],
];
const COLS = [
  { col: 0, placeholder: '输入发帖文案' },
  { col: 1, placeholder: '拖入本机文件或粘贴 Drive 链接' },
  { col: 2, opts: mkOpts(['彩贴', '普通文字']), placeholder: '彩贴' },
  { col: 3, opts: mkOpts(['帖子', '快拍', '通用']), placeholder: '帖子' },
  { col: 4, opts: mkOpts(['默认', '开启', '关闭']), placeholder: '默认' },
] as const;
const createId = () => globalThis.crypto.randomUUID();
const isSelectCol = (col: number) => col >= 2 && col <= 4;

function rowStatusDisplay(
  row: ResourceRowValue,
  obs: ObservationRow | undefined,
): { text: string; cls: string; title: string } {
  const kind = resourceType(row);
  if (!hasResource(row)) return { text: '空行', cls: 'text-[var(--text-3)]', title: '未填写内容' };
  if (!obs) return { text: kind, cls: 'text-[var(--text-2)]', title: kind };
  if (!obs.sourceVerified && obs.issue) {
    const m = resourceSourceIssueText[obs.issue] ?? obs.issue;
    return {
      text: `${kind} · ${m}`,
      cls: 'is-error bg-rose-50/70 font-medium text-rose-700',
      title: m,
    };
  }
  if (obs.blockers.length > 0) {
    const m = obs.blockers.includes('TEXT_INPUT_LIMIT') ? '正文过长受限' : '背景未验证';
    return {
      text: `${kind} · ${m}`,
      cls: 'is-warn bg-amber-50/70 font-medium text-amber-800',
      title: m,
    };
  }
  if (obs.duplicateOf)
    return {
      text: `${kind} · 内容重复`,
      cls: 'is-warn bg-amber-50/70 font-medium text-amber-800',
      title: '与表格内其他行内容重复',
    };
  return {
    text: `${kind} · 已核验`,
    cls: 'is-ok bg-emerald-50/70 font-medium text-emerald-700',
    title: '来源已核验可用',
  };
}

function ResourceRowPreview({
  combinationId,
  revision,
  row,
  rowNumber,
  onClose,
}: {
  combinationId: string;
  revision: number;
  row: ResourceRowValue;
  rowNumber: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useShowModal(dialog);
  const [index, setIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ index: number; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = row.media[index];

  useEffect(() => {
    const ac = new AbortController();
    let disposed = false;
    let url: string | null = null;
    setLoaded(null);
    setError('');
    setBusy(false);
    if (!file || file.kind !== 'local') return;
    setBusy(true);
    void api
      .resourceMedia(combinationId, revision, row.id, index, ac.signal)
      .then((blob) => {
        if (!disposed) {
          url = URL.createObjectURL(blob);
          setLoaded({ index, url });
        }
      })
      .catch((f: unknown) => !disposed && setError(errMsg(f, '媒体预览未完成')))
      .finally(() => !disposed && setBusy(false));
    return () => {
      disposed = true;
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [combinationId, revision, row, index, file, attempt]);

  return (
    <dialog
      ref={dialog}
      className="max-h-[84vh] w-[min(740px,92vw)] rounded-[var(--r-lg)] border border-[var(--line)] bg-[#f8f9fa] p-0 text-[var(--text)] shadow-[var(--shadow-3)] backdrop:bg-[rgba(20,24,31,0.4)] backdrop:backdrop-blur-[2px]"
      aria-label={`预览资源第${rowNumber}行`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="flex items-center justify-between border-b border-[var(--line)] bg-white px-4 py-3">
        <div>
          <strong className="text-sm font-semibold text-slate-900">
            第 {rowNumber} 行 · {resourceType(row)}
          </strong>
          <small className="mt-0.5 block text-xs text-[var(--text-3)]">已保存资源预览</small>
        </div>
        <Btn v="ghost" onClick={onClose} aria-label="关闭资源预览">
          关闭
        </Btn>
      </header>
      <div className="max-h-[68vh] overflow-auto p-4">
        <div className="mb-3.5 max-h-[200px] overflow-auto rounded-lg border border-[var(--line)] bg-white p-3 text-sm leading-[1.6] whitespace-pre-wrap wrap-anywhere">
          {row.text || <span className="text-[var(--text-3)]">无文案 · 纯媒体发布</span>}
        </div>
        {file && (
          <section
            className="my-3 min-w-0 rounded-xl border border-[var(--line)] bg-white p-3 [&_img]:mt-2 [&_img]:block [&_img]:max-h-[260px] [&_img]:w-full [&_img]:rounded-lg [&_img]:bg-[#15191e] [&_img]:object-contain [&_video]:mt-2 [&_video]:block [&_video]:max-h-[260px] [&_video]:w-full [&_video]:rounded-lg [&_video]:bg-[#15191e] [&_video]:object-contain"
            aria-label="资源媒体预览"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <strong className="font-semibold text-slate-800">
                媒体 {index + 1} / {row.media.length}
              </strong>
              <div className="flex gap-1.5">
                <Btn disabled={index === 0} onClick={() => setIndex(index - 1)}>
                  上一份
                </Btn>
                <Btn disabled={index + 1 >= row.media.length} onClick={() => setIndex(index + 1)}>
                  下一份
                </Btn>
              </div>
            </div>
            <small className="my-1.5 block text-xs wrap-anywhere text-[var(--text-2)]">
              {file.name}
            </small>
            {file.kind === 'local' && (
              <FileLocationButton source={file.source} label="查看原文件位置" />
            )}
            {file.kind === 'drive' && (
              <p className="mt-2 text-xs text-[var(--text-2)]" role="status">
                这是公开网盘引用，需先下载才能预览；本次未自动下载。
              </p>
            )}
            {busy && (
              <p className="mt-2 text-xs text-[var(--text-2)]" role="status">
                正在读取媒体…
              </p>
            )}
            {error && (
              <div
                className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
                role="alert"
              >
                <p className="m-0">{error}</p>
                <Btn onClick={() => setAttempt(attempt + 1)}>重试预览</Btn>
              </div>
            )}
            {!error &&
              loaded?.index === index &&
              (file.mediaType === 'video' ? (
                <video
                  src={loaded.url}
                  controls
                  preload="metadata"
                  playsInline
                  aria-label="资源视频播放器"
                  onError={() => setError('浏览器无法解码这份视频，请检查视频编码；原文件保留')}
                />
              ) : (
                <img
                  src={loaded.url}
                  alt={`资源图片 ${index + 1}`}
                  onError={() => setError('浏览器无法显示这份图片，请检查文件；原文件保留')}
                />
              ))}
          </section>
        )}
        {!row.media.length && row.background === 'color' && (
          <p className="mt-2 block text-xs text-[var(--text-3)]">
            彩贴背景需在实际发布窗口核对；这里显示文案，未模拟平台背景。
          </p>
        )}
      </div>
    </dialog>
  );
}

export function ResourceTableEditor({
  combination,
  onClose,
  onSaved,
  ref,
}: {
  combination: SavedCombination;
  onClose: () => void;
  onSaved: () => void;
  ref?: Ref<ResourceEditorHandle>;
}) {
  const [rows, setRows] = useState<ResourceRowValue[]>([emptyResourceRow(createId())]);
  const [savedJson, setSavedJson] = useState('');
  const [revision, setRevision] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<ResourceFilter>('all');
  const [query, setQuery] = useState('');
  const [observations, setObservations] = useState<ReadonlyMap<string, ObservationRow>>(
    () => new Map(),
  );
  const [checkProgress, setCheckProgress] = useState<ResourceCheckProgressValue | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ResourceDownloadProgressValue | null>(
    null,
  );
  const [previewRowIdx, setPreviewRowIdx] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [filePickRow, setFilePickRow] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const dirty = useMemo(
    () => !loading && JSON.stringify(rows) !== savedJson,
    [loading, rows, savedJson],
  );
  const busy = loading || saving || checking || downloading;

  const loadTable = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const table = await api.resourceTable(combination.id);
      const loaded = table.rows.length ? table.rows : [emptyResourceRow(createId())];
      setRows(loaded);
      setSavedJson(JSON.stringify(loaded));
      setRevision(table.revision);
      setObservations(new Map());
      setConfirmDiscard(false);
    } catch (e) {
      setError(errMsg(e, '加载资源表失败'));
    } finally {
      setLoading(false);
    }
  }, [combination.id]);

  useEffect(() => {
    void loadTable();
    return () => streamAbortRef.current?.abort();
  }, [loadTable]);

  const applyCell = useCallback(
    (
      current: ResourceRowValue[],
      rowIdx: number,
      col: number,
      value: string,
    ): ResourceRowValue[] => {
      try {
        setError('');
        return pasteResourceCells(current, rowIdx, col, value, createId, rowIdx, col);
      } catch (e) {
        setError(errMsg(e, '单元格格式无效'));
        return current;
      }
    },
    [],
  );

  const grid = useSpreadsheetGrid<ResourceRowValue>({
    rows,
    colCount: 5,
    disabled: busy,
    onRowsChange: setRows,
    getCellValue: resourceCellValue,
    applyCellEdit: applyCell,
    isSelectCol,
    isEditableCell: (r, c) => !(c === 2 && (rows[r]?.media.length ?? 0) > 0),
    copyRangeText: (cur, b) =>
      formatResourceCellsForClipboard(cur, b.minRow, b.maxRow, b.minCol, b.maxCol),
    fillDown: (cur, b, endRow) =>
      pasteResourceCells(
        cur,
        b.maxRow + 1,
        b.minCol,
        expandFillDownTsv(cur, b, endRow, resourceCellValue),
        createId,
        endRow,
        b.maxCol,
      ),
    pasteTsv: (cur, b, text) =>
      pasteResourceCells(cur, b.minRow, b.minCol, text, createId, b.maxRow, b.maxCol),
    onError: setError,
    createEmptyRow: () => emptyResourceRow(createId()),
  });

  const persist = useCallback(async (): Promise<boolean> => {
    const latest = grid.commitEdit();
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveResourceTable(
        combination.id,
        revision,
        validateResourceRows(latest),
      );
      const nextRows = saved.rows.length ? saved.rows : [emptyResourceRow(createId())];
      setRows(nextRows);
      setSavedJson(JSON.stringify(nextRows));
      setRevision(saved.revision);
      setNotice('资源表已保存');
      onSaved();
      return true;
    } catch (e) {
      setError(errMsg(e, '保存资源表失败'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [combination.id, grid, onSaved, revision]);

  useImperativeHandle(ref, () => ({ persist }), [persist]);

  const fillMediaFiles = (startRow: number, files: FileList | null) => {
    const paths = parseElectronFilePaths(files);
    if (!paths.length) return setError('浏览器环境无法读取本地绝对路径，请手动粘贴或拖动链接');
    try {
      grid.commitRows(fillResourceMedia(rows, startRow, paths.map(mediaReference), createId), true);
    } catch (e) {
      setError(errMsg(e, '填充本机文件失败'));
    }
  };

  const mergeSelectedImages = () => {
    const indices = getSelectedRowIndices(grid.bounds, rows.length);
    if (indices.length < 2) return setError('请先选中至少两行再合并图片');
    const targetIdx = indices[0];
    if (targetIdx === undefined) return;
    const collected = indices.flatMap((idx) => rows[idx]?.media ?? []);
    const imagesOnly = collected.filter((m) => m.mediaType === 'image');
    if (!imagesOnly.length || imagesOnly.length !== collected.length)
      return setError('只能将多行纯图片合并为一组多图，视频不可合并');
    if (imagesOnly.length > 20) return setError('单行最多合并 20 张图片');
    const set = new Set(indices);
    grid.commitRows(
      rows.map((r, i) =>
        i === targetIdx
          ? { ...r, media: imagesOnly, background: 'plain' as const }
          : set.has(i)
            ? { ...r, media: [] }
            : r,
      ),
      true,
    );
    setNotice(`已合并 ${imagesOnly.length} 张图片到第 ${targetIdx + 1} 行`);
  };

  async function runStreamOp(kind: 'check' | 'download') {
    if (dirty && !(await persist())) return;
    streamAbortRef.current?.abort();
    const ac = new AbortController();
    streamAbortRef.current = ac;
    (kind === 'check' ? setChecking : setDownloading)(true);
    setError('');
    setNotice('');
    setCheckProgress(null);
    setDownloadProgress(null);
    try {
      if (kind === 'check') {
        const report = await api.checkResourceSources(
          combination.id,
          revision,
          ac.signal,
          undefined,
          setCheckProgress,
        );
        setObservations(new Map(report.rows.map((item) => [item.rowId, item])));
        setNotice(`来源检查完成：共 ${report.rows.length} 条`);
      } else {
        const report = await api.downloadResourceSources(
          combination.id,
          revision,
          ac.signal,
          undefined,
          setDownloadProgress,
        );
        const nextRows = report.table.rows.length
          ? report.table.rows
          : [emptyResourceRow(createId())];
        setRows(nextRows);
        setSavedJson(JSON.stringify(nextRows));
        setRevision(report.table.revision);
        setNotice(
          `网盘下载完成：成功 ${report.progress.downloaded}，失败 ${report.progress.failed}`,
        );
        onSaved();
      }
    } catch (e) {
      if (!ac.signal.aborted)
        setError(errMsg(e, kind === 'check' ? '来源检查失败' : '下载网盘媒体失败'));
    } finally {
      setChecking(false);
      setDownloading(false);
      setCheckProgress(null);
      setDownloadProgress(null);
    }
  }

  const visibleEntries = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .filter(({ row, index }) => resourceMatches(row, index, query, filter, observations)),
    [filter, observations, query, rows],
  );
  const previewRow = previewRowIdx !== null ? (rows[previewRowIdx] ?? null) : null;
  const toolbarButtons: ReadonlyArray<[string, () => void, boolean?, 'danger'?]> = [
    ['+1 行', () => grid.commitRows([...rows, emptyResourceRow(createId())], true)],
    [
      '+5 行',
      () =>
        grid.commitRows(
          [...rows, ...Array.from({ length: 5 }, () => emptyResourceRow(createId()))],
          true,
        ),
    ],
    [
      '选择本机文件',
      () => {
        setFilePickRow(grid.bounds?.minRow ?? 0);
        fileInputRef.current?.click();
      },
    ],
    ['合并选中行图片', mergeSelectedImages],
    [
      '删除选中行',
      () => {
        const set = new Set(getSelectedRowIndices(grid.bounds, rows.length));
        if (!set.size) return;
        const next = rows.filter((_, i) => !set.has(i));
        grid.commitRows(next.length ? next : [emptyResourceRow(createId())], true);
      },
      busy || !grid.bounds,
      'danger',
    ],
    ['撤销', grid.handleUndo, busy || !grid.canUndo],
    ['重做', grid.handleRedo, busy || !grid.canRedo],
  ];

  return (
    <div className="resource-editor-shell fixed inset-0 z-75 flex flex-col bg-slate-950/40 p-4 backdrop-blur-[2px]">
      <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-2xl border border-[var(--line)] bg-white p-4 shadow-2xl">
        <div className="resource-editor-header flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
          <div>
            <h2 className="m-0 text-base font-semibold text-slate-900">
              资源表 · {combination.saved?.name ?? '未命名'}
            </h2>
            <p className="mt-0.5 mb-0 text-xs text-[var(--text-3)]">
              版本号 r{revision} · 共 {rows.filter(hasResource).length} 条有效资源（{rows.length}{' '}
              行）
            </p>
          </div>
          <div className="resource-editor-header-actions flex flex-wrap items-center gap-2">
            {dirty && (
              <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
                有未保存修改
              </span>
            )}
            <Btn onClick={() => setShowHelp((v) => !v)}>快捷键</Btn>
            {dirty && <Btn onClick={() => setConfirmDiscard(true)}>放弃修改</Btn>}
            <Btn v="primary" disabled={busy} onClick={() => void persist()}>
              {saving ? '保存中…' : '保存'}
            </Btn>
            <Btn onClick={() => (dirty ? setConfirmDiscard(true) : onClose())}>关闭</Btn>
          </div>
        </div>

        {confirmDiscard && (
          <div className="notice-banner is-warn flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span>当前有未保存修改，确定放弃修改吗？</span>
            <div className="inline-actions flex flex-wrap items-center gap-1.5">
              <Btn
                v="danger"
                onClick={() => {
                  setConfirmDiscard(false);
                  onClose();
                }}
              >
                放弃并关闭
              </Btn>
              <Btn onClick={() => void loadTable()}>还原为已保存版本</Btn>
              <Btn onClick={() => setConfirmDiscard(false)}>继续编辑</Btn>
            </div>
          </div>
        )}
        {showHelp && (
          <div className="rounded-lg border border-[var(--line)] bg-slate-50 px-3 py-2 text-xs text-[var(--text-2)]">
            双击或直接键入进入编辑 · Enter 向下 · Tab 向右 · Shift+Enter 换行 · Ctrl+C/V/X
            复制粘贴剪切 · Ctrl+Z/Y 撤销重做 · 拖拽右下角绿点向下填充 · 点击行号预览该行媒体
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="resource-toolbar-group flex flex-wrap items-center gap-1.5">
            {toolbarButtons.map(([label, onClick, dis, v]) => (
              <Btn key={label} v={v ?? 'default'} disabled={dis ?? busy} onClick={onClick}>
                {label}
              </Btn>
            ))}
          </div>
          <div className="resource-toolbar-group flex flex-wrap items-center gap-1.5">
            <input
              type="search"
              className={`${UI_INPUT_SM} w-44`}
              placeholder="筛选文案/路径…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className={UI_SELECT_SM}
              aria-label="筛选资源行"
              value={filter}
              onChange={(e) => setFilter(e.target.value as ResourceFilter)}
            >
              {FILTER_OPTIONS.map(([val, label]) => (
                <option key={val} value={val}>
                  {label}
                </option>
              ))}
            </select>
            <Btn
              disabled={loading || saving || downloading}
              onClick={() =>
                checking ? streamAbortRef.current?.abort() : void runStreamOp('check')
              }
            >
              {checking
                ? `取消检查 (${checkProgress?.completed ?? 0}/${checkProgress?.total ?? rows.length})`
                : '检查来源'}
            </Btn>
            <Btn
              disabled={loading || saving || checking}
              onClick={() =>
                downloading ? streamAbortRef.current?.abort() : void runStreamOp('download')
              }
            >
              {downloading
                ? `取消下载 (${downloadProgress?.completed ?? 0}/${downloadProgress?.total ?? 0})`
                : '下载网盘媒体'}
            </Btn>
          </div>
        </div>

        {error && (
          <div
            className="alert-banner is-error rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700"
            role="alert"
          >
            {error}
          </div>
        )}
        {notice && (
          <div className="alert-banner is-ok rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-800">
            {notice}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            fillMediaFiles(filePickRow, e.target.files);
            e.target.value = '';
          }}
        />

        <div
          ref={grid.wrapRef}
          className="resource-matrix-scroll relative min-h-0 flex-1 overflow-auto rounded-xl border border-[#e0e5ec] bg-white focus:outline-none"
          tabIndex={0}
          onKeyDown={grid.handleGridKeyDown}
          onPaste={grid.handlePaste}
        >
          <table className="resource-matrix w-full border-collapse text-xs">
            <thead>
              <tr>
                {['#', 'A 文案', 'B 媒体路径/链接', 'C 背景', 'D 用途', 'E AI 声明', '状态'].map(
                  (h) => (
                    <th
                      key={h}
                      className="sticky top-0 z-[2] border border-[#e0e5ec] bg-slate-50 px-2.5 py-2 text-left text-[11px] font-semibold text-[var(--text-2)] select-none"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map(({ row, index: rIdx }) => {
                const status = rowStatusDisplay(row, observations.get(row.id));
                return (
                  <tr
                    key={row.id}
                    className={
                      isRowInGridBounds(grid.bounds, rIdx, 5)
                        ? 'row-selected bg-[#f3f7ff]'
                        : 'hover:bg-slate-50/50'
                    }
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
                    }}
                    onDrop={(e: ReactDragEvent) => {
                      if (e.dataTransfer.files.length) {
                        e.preventDefault();
                        fillMediaFiles(rIdx, e.dataTransfer.files);
                      }
                    }}
                  >
                    <td
                      className="resource-row-number w-12 cursor-cell border border-[#e0e5ec] bg-[var(--surface-2)] px-2 py-1.5 text-center align-middle font-mono text-[11px] text-[var(--text-3)] select-none"
                      title="点击预览该行媒体，拖拽选择整行"
                      onMouseDown={(e) => grid.beginRowMouseDown(e, rIdx)}
                      onMouseEnter={() => grid.handleCellMouseEnter(rIdx, 0)}
                      onClick={() => row.media.length && setPreviewRowIdx(rIdx)}
                    >
                      {rIdx + 1}
                    </td>
                    {COLS.map((c) => {
                      const mediaLocked = c.col === 2 && row.media.length > 0;
                      const opts = 'opts' in c ? c.opts : undefined;
                      return (
                        <MatrixDataCell
                          key={c.col}
                          {...grid.getCellProps(rIdx, c.col)}
                          showArrow={Boolean(opts) && !mediaLocked}
                          displayClassName={
                            mediaLocked
                              ? 'resource-cell-value flex min-h-[20px] cursor-default items-center justify-between gap-1.5 text-[#919aa7] whitespace-pre-wrap break-words'
                              : 'resource-cell-value flex min-h-[20px] items-center justify-between gap-1.5 whitespace-pre-wrap break-words'
                          }
                          valueText={resourceCellValue(row, c.col)}
                          placeholder={c.placeholder}
                          selectOptions={opts}
                        />
                      );
                    })}
                    <td
                      className={`resource-status border border-[#e0e5ec] px-2.5 py-1.5 align-middle text-xs ${status.cls}`.trim()}
                      title={status.title}
                    >
                      {status.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {previewRow && previewRowIdx !== null && (
          <ResourceRowPreview
            combinationId={combination.id}
            revision={revision}
            row={previewRow}
            rowNumber={previewRowIdx + 1}
            onClose={() => setPreviewRowIdx(null)}
          />
        )}
      </div>
    </div>
  );
}
export { mediaReference };
