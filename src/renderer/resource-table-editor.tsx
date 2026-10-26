import { copyTextToClipboard } from './clipboard.js';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { ResourceRowValue, ResourceTableValue } from '../shared/resource-table.js';
import {
  emptyResourceRow,
  fillResourceMedia,
  pasteResourceCells,
  mediaReference,
  validateResourceRows,
  hasResource,
  resourceType,
  resourceCellValue,
  formatResourceCellsForClipboard,
} from '../domain/resource-table.js';
import type { SavedCombination } from '../shared/contracts.js';
import { api } from './api.js';
import type {
  ResourceSourceReportValue,
  ResourceCheckProgressValue,
} from '../shared/resource-source.js';
import { resourceSourceIssueText } from '../domain/resource-source.js';
import { resourceMatches, type ResourceFilter } from './resource-filter.js';
import { ResourceRowPreview } from './resource-row-preview.js';
import type {
  ResourceDownloadProgressValue,
  ResourceDownloadReportValue,
} from '../shared/resource-download.js';

export interface ResourceEditorHandle {
  persist(): Promise<boolean>;
}
export function ResourceTableEditor({
  combination,
  onClose,
  onSaved,
  ref,
}: {
  combination: SavedCombination;
  onClose: () => void;
  onSaved: () => Promise<void>;
  ref?: Ref<ResourceEditorHandle>;
}) {
  const [table, setTable] = useState<ResourceTableValue | null>(null);
  const [rows, setRows] = useState<ResourceRowValue[]>([]);
  const [undo, setUndo] = useState<ResourceRowValue[][]>([]);
  const [range, setRange] = useState({ r1: 0, c1: 0, r2: 0, c2: 0 });
  const bounds = {
    minRow: Math.min(range.r1, range.r2, Math.max(0, rows.length - 1)),
    maxRow: Math.min(
      range.r1 === range.r2 ? range.r1 : Math.max(range.r1, range.r2),
      Math.max(0, rows.length - 1),
    ),
    minCol: Math.min(range.c1, range.c2),
    maxCol: Math.max(range.c1, range.c2),
  };
  const selected = new Set(rows.slice(bounds.minRow, bounds.maxRow + 1).map((row) => row.id));
  const cell = { row: range.r1, column: range.c1 };
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const editingRef = useRef<typeof editing>(null);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<'cells' | 'rows' | 'fill' | null>(null);
  const anchor = useRef({ r: 0, c: 0 });
  const fillTarget = useRef(0);
  const finishDrag = useRef(() => {});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ResourceFilter>('all');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const checking = useRef<AbortController | null>(null);
  const downloading = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [sourceReport, setSourceReport] = useState<ResourceSourceReportValue | null>(null);
  const [checkProgress, setCheckProgress] = useState<ResourceCheckProgressValue | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<ResourceDownloadProgressValue | null>(
    null,
  );
  const [downloadReport, setDownloadReport] = useState<ResourceDownloadReportValue | null>(null);
  const [sourceRows, setSourceRows] = useState<ResourceSourceReportValue['rows']>([]);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [preview, setPreview] = useState<{
    row: ResourceRowValue;
    revision: number;
    rowNumber: number;
  } | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const up = () => finishDrag.current();
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  const createId = () => crypto.randomUUID();
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    dialog.current?.showModal();
    void api
      .resourceTable(combination.id)
      .then((value) => {
        if (!alive) return;
        if (value.combinationId !== combination.id) throw Error('RESOURCE_RESPONSE_MISMATCH');
        setTable(value);
        setRows(value.rows.length ? value.rows : [emptyResourceRow(createId())]);
      })
      .catch(() => {
        if (alive) setError('资源表读取失败，请保留当前窗口并重试');
      });
    return () => {
      alive = false;
      mounted.current = false;
      checking.current?.abort();
      downloading.current?.abort();
    };
  }, [combination.id]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  function edit(next: ResourceRowValue[], remember = true) {
    setDownloadReport(null);
    setSourceReport(null);
    setSourceRows([]);
    setFilter('all');
    setUndo((history) => (remember ? [...history.slice(-9), rows] : history));
    setRows(next);
    setDirty(true);
    setError('');
    setDiscard(false);
  }
  function preparedRows() {
    const current = validateResourceRows(rows);
    const e = editingRef.current;
    return e
      ? pasteResourceCells(current, e.r, e.c, '"' + e.value.replace(/"/g, '""') + '"', createId)
      : current;
  }
  function attempt(work: () => ResourceRowValue[]) {
    try {
      const next = work();
      editingRef.current = null;
      setEditing(null);
      edit(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '本次修改未添加');
    }
  }
  async function save(close: boolean) {
    if (!table || saving.current) return false;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const next = preparedRows();
      const saved = dirty
        ? await api.saveResourceTable(combination.id, table.revision, next)
        : table;
      if (
        saved.combinationId !== combination.id ||
        (dirty && saved.revision !== table.revision + 1) ||
        (dirty && JSON.stringify(saved.rows) !== JSON.stringify(next))
      )
        throw Error('RESOURCE_RESPONSE_MISMATCH');
      setTable(saved);
      editingRef.current = null;
      setEditing(null);
      setRows(saved.rows);
      setDirty(false);
      await onSaved();
      if (close) onClose();
      return saved;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存未确认，当前编辑保留');
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    persist: () =>
      !dirty ? Promise.resolve(true) : busy ? Promise.resolve(false) : save(false).then(Boolean),
  }));
  async function checkSources() {
    if (!table || checking.current || saving.current) return;
    const controller = new AbortController();
    checking.current = controller;
    setCheckProgress(null);
    setError('');
    setBusy(true);
    try {
      // The check consumes the server's exact saved version; unsaved cells never authorize IO.
      const saved = dirty ? await save(false) : table;
      if (!saved || controller.signal.aborted || !mounted.current) return;
      setBusy(true);
      const selectedIds = saved.rows.filter((row) => selected.has(row.id)).map((row) => row.id);
      const report = await api.checkResourceSources(
        combination.id,
        saved.revision,
        controller.signal,
        selectedIds.length ? selectedIds : undefined,
        (progress) => {
          if (mounted.current && !controller.signal.aborted) setCheckProgress(progress);
        },
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (
        report.combinationId !== combination.id ||
        report.expectedRevision !== saved.revision ||
        JSON.stringify(report.rows.map((row) => row.rowId)) !==
          JSON.stringify(selectedIds.length ? selectedIds : saved.rows.map((row) => row.id))
      )
        throw Error('来源检查结果与当前资源版本不匹配');
      setSourceReport(report);
      setSourceRows((previous) => {
        const samples = new Map(previous.map((row) => [row.rowId, row]));
        for (const row of report.rows) samples.set(row.rowId, row);
        // Display observations only; any edit clears them, execution rechecks actual files.
        const first = new Map<string, string>();
        return saved.rows.flatMap((row) => {
          const sample = samples.get(row.id);
          if (!sample) return [];
          const duplicateOf = sample.fingerprint ? (first.get(sample.fingerprint) ?? null) : null;
          if (sample.fingerprint && !first.has(sample.fingerprint))
            first.set(sample.fingerprint, row.id);
          return [{ ...sample, duplicateOf }];
        });
      });
    } catch (failure) {
      if (mounted.current)
        setError(
          controller.signal.aborted
            ? '检查已取消，已保存资源保持'
            : failure instanceof Error
              ? failure.message
              : '来源检查未完成，请重试',
        );
    } finally {
      if (checking.current === controller) checking.current = null;
      if (mounted.current) setCheckProgress(null);
      if (mounted.current) setBusy(false);
    }
  }
  async function downloadSources(failedOnly = false) {
    if (!table || busy || saving.current || downloading.current) return;
    const controller = new AbortController();
    downloading.current = controller;
    setBusy(true);
    setError('');
    setDownloadProgress(null);
    try {
      const saved = dirty ? await save(false) : table;
      if (!saved || !mounted.current || controller.signal.aborted) return;
      setBusy(true);
      const failedIds = new Set(downloadReport?.issues.map((issue) => issue.rowId) ?? []);
      const ids = saved.rows
        .filter(
          (row) =>
            (failedOnly ? failedIds.has(row.id) : !selected.size || selected.has(row.id)) &&
            row.media.some((item) => item.kind === 'drive'),
        )
        .map((row) => row.id);
      if (!ids.length) {
        setError('当前选择没有待下载的网盘素材');
        return;
      }
      const report = await api.downloadResourceSources(
        combination.id,
        saved.revision,
        controller.signal,
        ids,
        (progress) => {
          if (mounted.current && !controller.signal.aborted) setDownloadProgress(progress);
        },
      );
      if (!mounted.current || controller.signal.aborted) return;
      setTable(report.table);
      setRows(report.table.rows);
      setUndo([]);
      setDirty(false);
      setSourceRows([]);
      setSourceReport(null);
      setDownloadReport(report);
      await onSaved();
    } catch (failure) {
      if (mounted.current) {
        // Successful members were saved through original revisions before delivery. Do not
        // save a stale editor over them after a cancellation or disconnected response.
        try {
          const refreshed = await api.resourceTable(combination.id);
          if (mounted.current) {
            setTable(refreshed);
            setRows(refreshed.rows);
            setUndo([]);
            setDirty(false);
            setSourceRows([]);
            setSourceReport(null);
            await onSaved();
          }
        } catch {
          /* Keep current display, revision CAS still rejects a stale save. */
        }
        setError(
          controller.signal.aborted
            ? '下载已取消；成功下载的素材已保存，未完成链接保留'
            : failure instanceof Error
              ? failure.message
              : '下载未完成，请重新读取后继续',
        );
      }
    } finally {
      if (downloading.current === controller) downloading.current = null;
      if (mounted.current) {
        setBusy(false);
        setDownloadProgress(null);
      }
    }
  }
  async function previewRow(rowId: string) {
    if (!table || busy || saving.current || checking.current) return;
    const saved = dirty ? await save(false) : table;
    if (!saved || !mounted.current) return;
    const index = saved.rows.findIndex((row) => row.id === rowId);
    const row = saved.rows[index];
    if (row) setPreview({ row, revision: saved.revision, rowNumber: index + 1 });
  }
  const quoteCell = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  function undoEdit() {
    const previous = undo.at(-1);
    if (previous) {
      edit(previous, false);
      setUndo(undo.slice(0, -1));
      setEditing(null);
      editingRef.current = null;
    }
  }
  function paste(event: React.ClipboardEvent) {
    if (editingRef.current || busy || !table) return;
    event.preventDefault();
    attempt(() =>
      pasteResourceCells(
        preparedRows(),
        bounds.minRow,
        bounds.minCol,
        event.clipboardData.getData('text/plain'),
        createId,
        bounds.maxRow,
        bounds.maxCol,
      ),
    );
  }
  function copy(event: React.ClipboardEvent) {
    if (editingRef.current) return;
    if (!rows.length) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.clipboardData.setData(
      'text/plain',
      formatResourceCellsForClipboard(
        preparedRows(),
        bounds.minRow,
        bounds.maxRow,
        bounds.minCol,
        bounds.maxCol,
      ),
    );
  }
  async function copyTable() {
    try {
      await copyTextToClipboard(
        formatResourceCellsForClipboard(preparedRows(), 0, rows.length - 1, 0, 4),
      );
    } catch {
      setError('复制失败，请选择表格后按 Ctrl/Cmd+C');
    }
  }
  function startEdit(r: number, c: number) {
    if (busy || !table) return;
    const row = rows[r];
    if (!row) return;
    if (c === 2 && row.media.length > 0) return;
    const next = { r, c, value: resourceCellValue(row, c) };
    editingRef.current = next;
    setEditing(next);
  }
  function commitEdit() {
    const e = editingRef.current;
    if (!e) return;
    try {
      const next = pasteResourceCells(preparedRows(), e.r, e.c, quoteCell(e.value), createId);
      editingRef.current = null;
      setEditing(null);
      edit(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '单元格格式不正确');
    }
  }
  function clearRange() {
    attempt(() => {
      const next = structuredClone(preparedRows());
      const keys = ['text', 'media', 'background', 'purpose', 'aiLabel'] as const;
      const defaults = ['', [], 'color', 'post', 'preserve-current'];
      for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
        for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
          const target = next[r],
            key = keys[c];
          if (target && key) Object.assign(target, { [key]: structuredClone(defaults[c]) });
        }
        const target = next[r];
        if (target && target.media.length > 0) target.background = 'plain';
      }
      return validateResourceRows(next);
    });
  }
  function deleteRows() {
    attempt(() => preparedRows().filter((row) => !selected.has(row.id)));
    setRange({ r1: 0, c1: 0, r2: 0, c2: 0 });
  }
  function beginRange(r: number, c: number, shift: boolean, kind: 'cells' | 'rows' = 'cells') {
    if (busy || !table) return;
    if (editingRef.current) commitEdit();
    grid.current?.focus();
    drag.current = kind;
    if (!shift) anchor.current = { r, c };
    const from = shift ? { r: range.r1, c: range.c1 } : anchor.current;
    anchor.current = from;
    setRange({ r1: from.r, c1: kind === 'rows' ? 0 : from.c, r2: r, c2: kind === 'rows' ? 4 : c });
  }
  function extendRange(r: number, c: number) {
    if (drag.current === 'fill') {
      fillTarget.current = r;
      setRange({ ...range, r2: Math.max(r, bounds.maxRow) });
    } else if (drag.current) {
      setRange({
        r1: anchor.current.r,
        c1: drag.current === 'rows' ? 0 : anchor.current.c,
        r2: r,
        c2: drag.current === 'rows' ? 4 : c,
      });
    }
  }
  finishDrag.current = () => {
    if (busy || !table) {
      drag.current = null;
      return;
    }
    if (drag.current === 'fill') {
      const end = fillTarget.current,
        first = rows[bounds.minRow];
      if (first && end > bounds.minRow)
        attempt(() => {
          const next = structuredClone(preparedRows()),
            keys = ['text', 'media', 'background', 'purpose', 'aiLabel'] as const;
          for (let r = bounds.minRow + 1; r <= end; r++) {
            for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
              const target = next[r],
                key = keys[c];
              if (target && key) Object.assign(target, { [key]: structuredClone(first[key]) });
            }
            const target = next[r];
            if (target && target.media.length > 0) target.background = 'plain';
          }
          return validateResourceRows(next);
        });
    }
    drag.current = null;
  };
  function gridKeys(event: React.KeyboardEvent) {
    if (editingRef.current || busy || !table) return;
    if (!rows.length) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoEdit();
      return;
    }
    if (['Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault();
      clearRange();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      startEdit(range.r1, range.c1);
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const movement = delta[event.key];
    if (movement) {
      event.preventDefault();
      const [dr, dc] = movement;
      const r = Math.max(0, Math.min(rows.length - 1, (event.shiftKey ? range.r2 : range.r1) + dr)),
        c = Math.max(0, Math.min(4, (event.shiftKey ? range.c2 : range.c1) + dc));
      setRange(event.shiftKey ? { ...range, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c });
      grid.current
        ?.querySelector(`[data-r="${r}"][data-c="${c}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function addFiles(list: FileList | null, start?: number) {
    if (!list?.length) return;
    attempt(() => {
      const desktop = window.workbenchDesktop;
      if (!desktop) throw Error('完整本机文件路径仅桌面端可用；请在桌面软件选择或拖入媒体。');
      const media = Array.from(list).map((file) => {
        const source = desktop.materialFilePath(file);
        if (!source) throw Error('文件没有真实本机路径，本批次尚未添加');
        return mediaReference(source);
      });
      const current = preparedRows();
      const firstEmpty = current.findIndex((row) => !row.media.length);
      if (start !== undefined)
        return pasteResourceCells(
          current,
          start,
          1,
          media.map((m) => quoteCell(m.source)).join('\n'),
          createId,
        );
      return fillResourceMedia(
        current,
        start ?? cell?.row ?? (firstEmpty < 0 ? current.length : firstEmpty),
        media,
        createId,
      );
    });
  }
  function mergeImages() {
    attempt(() => {
      const current = preparedRows();
      const chosen = current.filter((row) => selected.has(row.id));
      const first = chosen[0];
      if (
        !first ||
        chosen.length < 2 ||
        chosen.some(
          (row) =>
            row.text.trim() ||
            !row.media.length ||
            row.media.some((item) => item.mediaType !== 'image'),
        ) ||
        chosen.flatMap((row) => row.media).length > 20
      )
        throw Error('请选择2至20张没有文案的本机图片，合并成一条多图帖');
      return validateResourceRows(
        current
          .filter((row) => !selected.has(row.id) || row.id === first.id)
          .map((row) =>
            row.id === first.id ? { ...row, media: chosen.flatMap((item) => item.media) } : row,
          ),
      );
    });
  }
  const checkedRows = new Map(sourceRows.map((row) => [row.rowId, row]));
  const matching = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => resourceMatches(row, index, query, filter, checkedRows));
  const entries = matching;
  const remaining = rows.filter(hasResource).length;
  return (
    <dialog
      ref={dialog}
      className="resource-dialog"
      aria-labelledby="resource-heading"
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        if (dirty) setDiscard(true);
        else onClose();
      }}
    >
      <header className="resource-header">
        <div>
          <h2 id="resource-heading">设置发帖资源</h2>
          <p>{combination.draft?.name || combination.saved?.name || '任务组合'} · 发帖子任务共用</p>
        </div>
        <span className="version">
          {dirty ? '未保存' : '已保存'} · {remaining} 条资源
        </span>
      </header>
      <fieldset disabled={busy || !table} className="resource-body">
        <div className="resource-toolbar resource-main-toolbar">
          <div className="resource-toolbar-actions">
            <button
              disabled={rows.length >= 1000}
              onClick={() => {
                attempt(() => [...preparedRows(), emptyResourceRow(createId())]);
                setRange({ r1: rows.length, c1: 0, r2: rows.length, c2: 0 });
              }}
            >
              ＋ 新增一行
            </button>
            <button onClick={() => files.current?.click()}>＋ 添加本机图片/视频</button>
            <button disabled={!rows.length} onClick={() => void copyTable()}>
              复制整表
            </button>
            <button disabled={!undo.length} onClick={undoEdit}>
              撤销 (Ctrl+Z)
            </button>
            {rows.some((row) => row.media.some((m) => m.kind === 'drive')) && (
              <button onClick={() => void downloadSources()}>下载网盘素材</button>
            )}
            <input
              ref={files}
              type="file"
              accept=".mp4,.mov,.png,.jpg,.jpeg,.webp"
              multiple
              hidden
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </div>
          <div className="resource-toolbar-actions resource-search">
            <input
              aria-label="搜索资源"
              placeholder="搜索文案、文件或行号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="筛选资源状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value as ResourceFilter)}
            >
              <option value="all">全部状态</option>
              <option value="attention">需处理</option>
              <option value="unchecked">未检查</option>
              <option value="verified">来源已核对</option>
              <option value="duplicate">内容重复</option>
              <option value="drive">网盘待下载</option>
              <option value="post">可用于帖子</option>
              <option value="story">可用于快拍</option>
            </select>
            <button disabled={!remaining} onClick={() => void checkSources()}>
              检查资源
            </button>
          </div>
        </div>
        <div className="resource-selection-toolbar">
          <span>
            当前选区：{String.fromCharCode(65 + bounds.minCol)}
            {bounds.minRow + 1}:{String.fromCharCode(65 + bounds.maxCol)}
            {bounds.maxRow + 1}（{bounds.maxRow - bounds.minRow + 1}行×
            {bounds.maxCol - bounds.minCol + 1}列）
          </span>
          <button disabled={!rows.length} onClick={clearRange}>
            清空选区 (Del)
          </button>
          <select
            aria-label="一键填充选区选项"
            value=""
            onChange={(e) => {
              const [column, value] = e.target.value.split(':');
              if (!column || !value) return;
              attempt(() =>
                pasteResourceCells(
                  preparedRows(),
                  bounds.minRow,
                  Number(column),
                  value,
                  createId,
                  bounds.maxRow,
                  Number(column),
                ),
              );
            }}
          >
            <option value="">一键填充选区选项…</option>
            <optgroup label="C列·文字背景">
              <option value="2:color">彩贴</option>
              <option value="2:plain">普通文字</option>
            </optgroup>
            <optgroup label="D列·用途">
              <option value="3:post">帖子</option>
              <option value="3:story">快拍</option>
              <option value="3:both">通用</option>
            </optgroup>
            <optgroup label="E列·AI声明">
              <option value="4:preserve-current">默认</option>
              <option value="4:on">开启</option>
              <option value="4:off">关闭</option>
            </optgroup>
          </select>
          <button disabled={selected.size < 2} onClick={mergeImages}>
            合并为多图帖
          </button>
          <button disabled={!rows.length} onClick={deleteRows}>
            删除所涉整行
          </button>
        </div>
        {downloadReport && (
          <p className="resource-check-summary">
            下载成功 {downloadReport.progress.downloaded} 份 · 失败 {downloadReport.progress.failed}{' '}
            份{' '}
            {!!downloadReport.issues.length && (
              <button onClick={() => void downloadSources(true)}>重试失败行</button>
            )}
          </p>
        )}
        {sourceReport && (
          <p className="resource-check-summary">
            已检查 {sourceReport.rows.length} 行 · {sourceReport.verifiedSources} 条来源可用 ·{' '}
            {sourceReport.uniqueContents} 条不同内容
          </p>
        )}
        <div
          className="resource-grid-scroll"
          ref={grid}
          tabIndex={0}
          onKeyDown={gridKeys}
          onPaste={paste}
          onCopy={copy}
          aria-label="发帖资源矩阵"
        >
          <table
            className="resource-grid resource-matrix"
            role="grid"
            aria-rowcount={rows.length + 1}
            aria-colcount={7}
          >
            <thead>
              <tr>
                <th>
                  <button
                    aria-label="选择整表"
                    onClick={() =>
                      setRange({ r1: 0, c1: 0, r2: Math.max(0, rows.length - 1), c2: 4 })
                    }
                  >
                    #
                  </button>
                </th>
                {[
                  'A · 发帖文案',
                  'B · 本机媒体 / 网盘链接',
                  'C · 文字背景',
                  'D · 用途',
                  'E · AI 声明',
                ].map((title, c) => (
                  <th key={title}>
                    <button
                      onClick={() =>
                        setRange({ r1: 0, c1: c, r2: Math.max(0, rows.length - 1), c2: c })
                      }
                    >
                      {title}
                    </button>
                  </th>
                ))}
                <th>预览 / 状态</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(({ row, index: r }) => {
                const checked = checkedRows.get(row.id);
                return (
                  <tr key={row.id}>
                    <th
                      className="resource-row-number"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        beginRange(r, 0, e.shiftKey, 'rows');
                      }}
                      onPointerEnter={() => extendRange(r, 4)}
                    >
                      {r + 1}
                    </th>
                    {[0, 1, 2, 3, 4].map((c) => {
                      const inRange =
                          r >= bounds.minRow &&
                          r <= bounds.maxRow &&
                          c >= bounds.minCol &&
                          c <= bounds.maxCol,
                        active = r === range.r1 && c === range.c1,
                        isEditing = editing?.r === r && editing.c === c;
                      return (
                        <td
                          key={c}
                          data-r={r}
                          data-c={c}
                          role="gridcell"
                          aria-selected={inRange}
                          className={`${inRange ? 'in-range ' : ''}${active ? 'active-anchor ' : ''}${isEditing ? 'editing-cell' : ''}`}
                          onPointerDown={(e) => {
                            if (isEditing || e.button !== 0) return;
                            e.preventDefault();
                            beginRange(r, c, e.shiftKey);
                          }}
                          onPointerEnter={() => extendRange(r, c)}
                          onDoubleClick={() => startEdit(r, c)}
                          onDragOver={(e) => {
                            if (c === 1) e.preventDefault();
                          }}
                          onDrop={(e) => {
                            if (c === 1) {
                              e.preventDefault();
                              addFiles(e.dataTransfer.files, r);
                            }
                          }}
                        >
                          {isEditing ? (
                            c < 2 ? (
                              <textarea
                                autoFocus
                                aria-label={`${c === 0 ? '文案' : '媒体'}第${r + 1}行`}
                                value={editing.value}
                                onChange={(e) => {
                                  const next = { ...editing, value: e.target.value };
                                  editingRef.current = next;
                                  setEditing(next);
                                  setDirty(true);
                                }}
                                onBlur={commitEdit}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    commitEdit();
                                    grid.current?.focus();
                                  } else if (e.key === 'Escape') {
                                    editingRef.current = null;
                                    setEditing(null);
                                    grid.current?.focus();
                                  }
                                }}
                              />
                            ) : (
                              <select
                                autoFocus
                                onFocus={(e) => {
                                  try {
                                    e.currentTarget.showPicker?.();
                                  } catch {
                                    /* Keyboard edit remains available. */
                                  }
                                }}
                                aria-label={`${['', '', '背景', '用途', 'AI声明'][c]}第${r + 1}行`}
                                value={editing.value}
                                onChange={(e) => {
                                  editingRef.current = { ...editing, value: e.target.value };
                                  commitEdit();
                                  grid.current?.focus();
                                }}
                                onBlur={commitEdit}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === 'Escape') {
                                    editingRef.current = null;
                                    setEditing(null);
                                  } else if (e.key === 'Enter') {
                                    commitEdit();
                                  }
                                }}
                              >
                                {(c === 2
                                  ? ['彩贴', '普通文字']
                                  : c === 3
                                    ? ['帖子', '快拍', '通用']
                                    : ['默认', '开启', '关闭']
                                ).map((v) => (
                                  <option key={v}>{v}</option>
                                ))}
                              </select>
                            )
                          ) : (
                            <>
                              <span
                                className={`resource-cell-value${c === 2 && row.media.length > 0 ? ' media-background-readonly' : ''}`}
                                title={resourceCellValue(row, c)}
                              >
                                {resourceCellValue(row, c) || ' '}
                              </span>
                              {(c === 3 || c === 4 || (c === 2 && row.media.length === 0)) && (
                                <button
                                  className="cell-arrow"
                                  aria-label={`编辑${String.fromCharCode(65 + c)}${r + 1}`}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRange({ r1: r, c1: c, r2: r, c2: c });
                                    startEdit(r, c);
                                  }}
                                >
                                  ▾
                                </button>
                              )}
                            </>
                          )}
                          {!editing && r === bounds.maxRow && c === bounds.maxCol && (
                            <span
                              className="fill-handle"
                              aria-label="向下填充选区"
                              onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                drag.current = 'fill';
                                fillTarget.current = bounds.maxRow;
                              }}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td className="resource-status">
                      <span>{resourceType(row)}</span>
                      <small>
                        {checked
                          ? checked.issue
                            ? resourceSourceIssueText[checked.issue]
                            : '可用'
                          : '未检查'}
                      </small>
                      <button disabled={!hasResource(row)} onClick={() => void previewRow(row.id)}>
                        预览
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="resource-row-count">
          显示 {matching.length} / {rows.length} 行 · Ctrl/Cmd+C 复制，Ctrl/Cmd+V
          覆盖粘贴，Shift+Enter 在编辑格内换行
        </div>
      </fieldset>
      {preview && (
        <ResourceRowPreview
          combinationId={combination.id}
          revision={preview.revision}
          row={preview.row}
          rowNumber={preview.rowNumber}
          onClose={() => setPreview(null)}
        />
      )}
      {error && (
        <p className="resource-error" role="alert">
          {error}
        </p>
      )}
      {discard && (
        <div className="resource-error">
          放弃这次尚未保存的修改？
          <button disabled={busy} onClick={onClose}>
            放弃修改
          </button>
          <button disabled={busy} onClick={() => setDiscard(false)}>
            继续编辑
          </button>
        </div>
      )}
      <footer className="resource-footer">
        <p>
          {checkProgress && (
            <span role="status">
              已检查 {checkProgress.completed} / {checkProgress.total} 行<br />
            </span>
          )}
          {downloadProgress && (
            <span role="status">
              已处理 {downloadProgress.completed} / {downloadProgress.total} 份 · 下载成功{' '}
              {downloadProgress.downloaded} · 失败 {downloadProgress.failed} ·{' '}
              {(downloadProgress.bytes / 1024 ** 2).toFixed(1)} MiB
              <br />
            </span>
          )}
          检查资源只读取文件，不上传或发布。
        </p>
        <div>
          {checking.current && <button onClick={() => checking.current?.abort()}>取消检查</button>}
          {downloading.current && (
            <button onClick={() => downloading.current?.abort()}>取消下载</button>
          )}
          <button disabled={busy} onClick={() => (dirty ? setDiscard(true) : onClose())}>
            取消
          </button>
          <button className="primary" disabled={busy || !table} onClick={() => void save(true)}>
            {busy
              ? downloading.current
                ? '下载中…'
                : checking.current
                  ? '检查中…'
                  : '保存中…'
              : '保存资源'}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
