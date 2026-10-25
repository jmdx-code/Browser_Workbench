import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../shared/contracts.js';
import type { PreviewScan } from '../shared/materials.js';
import type { Arrangement, ArrangementRequest } from '../shared/material-arrangement.js';
import { api, ApiError } from './api.js';

const formatNames = {
  text: '文字',
  'single-image': '单图',
  'multi-image': '多图',
  video: '视频',
} as const;
const blockerNames = {
  MISSING_CONTENT: '缺少素材',
  TEXT_INPUT_LIMIT: '正文超出当前输入上限',
  DUPLICATE_CONTENT: '未允许重复，却再次分配同一资源',
  SAME_PROFILE_CONTENT_REPEATED: '未允许重复，却给同一浏览器分配同一资源',
} as const;
const rowKey = (row: { profileId: string; ordinal: number }) => row.profileId + ':' + row.ordinal;
export function MaterialArrangementEditor({
  scan,
  selectedProfiles,
  count,
  allowRepeat,
  onPreview,
}: {
  scan: PreviewScan;
  selectedProfiles: Profile[];
  count: number;
  allowRepeat: boolean;
  onPreview: (source: string) => void;
}) {
  const scope = JSON.stringify([
    scan.scanId,
    selectedProfiles.map((profile) => profile.id),
    count,
    allowRepeat,
  ]);
  const [draft, setDraft] = useState<{ scope: string; value: Arrangement } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replacement, setReplacement] = useState('');
  const [editing, setEditing] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const visible = draft?.scope === scope && !expired ? draft.value : null;
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setDraft(null);
    setSelected(new Set());
    setReplacement('');
    setEditing('');
    setPage(0);
    setBusy(false);
    setError('');
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [scope]);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        generation.current++;
        controller.current?.abort();
        setExpired(true);
        setDraft(null);
        setBusy(false);
      },
      Math.max(0, Date.parse(scan.report.scannedAt) + 600_000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [scan.scanId, scan.report.scannedAt]);
  async function generate(overrides?: ArrangementRequest['overrides']) {
    const current = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    const input = {
      scanId: scan.scanId,
      profileIds: selectedProfiles.map((profile) => profile.id),
      count,
      allowRepeat,
      ...(overrides ? { overrides } : {}),
    };
    try {
      const result = await api.materialArrangement(input, controller.current.signal);
      if (
        result.scanId !== scan.scanId ||
        result.directory !== scan.report.directory ||
        result.scannedAt !== scan.report.scannedAt ||
        result.count !== count ||
        result.allowRepeat !== allowRepeat ||
        result.targets.length !== input.profileIds.length ||
        result.targets.some((target, index) => target.profileId !== input.profileIds[index]) ||
        result.candidates.length !== scan.report.packages.length ||
        result.candidates.some((item, index) => {
          const expected = scan.report.packages[index];
          return (
            !expected ||
            item.source !== expected.source ||
            item.fingerprint !== expected.fingerprint ||
            item.format !== expected.format
          );
        }) ||
        result.rows.length !== input.profileIds.length * count ||
        result.rows.some(
          (row, index) =>
            row.profileId !== input.profileIds[Math.floor(index / count)] ||
            row.ordinal !== (index % count) + 1 ||
            (row.sourceIndex !== null && !result.candidates[row.sourceIndex]),
        )
      )
        throw Error('MATERIAL_ARRANGEMENT_MISMATCH');
      if (generation.current === current) {
        setDraft({ scope, value: result });
        setEditing('');
      }
    } catch (failure) {
      if (generation.current === current) {
        setDraft(null);
        setError(
          failure instanceof ApiError && failure.code === 'MATERIAL_PREVIEW_EXPIRED'
            ? '本次扫描已失效，请重新检查素材。'
            : '草案未能完成，请检查素材和所选范围。',
        );
      }
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  function change(keys: Set<string>, sourceIndex: number | null) {
    if (!visible) return;
    void generate(
      visible.rows.map((row) => ({
        profileId: row.profileId,
        ordinal: row.ordinal,
        sourceIndex: keys.has(rowKey(row)) ? sourceIndex : row.sourceIndex,
      })),
    );
  }
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil((visible?.rows.length ?? 0) / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const rows = visible?.rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? [];
  const targets = new Map(visible?.targets.map((target) => [target.profileId, target]) ?? []);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 20;
  return (
    <section className="material-arrangement" aria-label="批量排贴草案">
      <div className="material-media-toolbar">
        <strong>批量排贴 · 左侧已选 {selectedProfiles.length} 份浏览器</strong>
        <button
          type="button"
          disabled={
            busy ||
            expired ||
            !scan.report.complete ||
            !selectedProfiles.length ||
            !validCount ||
            selectedProfiles.length * count > 1000
          }
          onClick={() => void generate()}
        >
          {busy ? '正在分配…' : visible ? '按顺序重新分配' : '生成排贴草案'}
        </button>
      </div>
      <p className="field-hint">
        按本次扫描的素材来源分配，允许重复时同一账号也可复用。这里只预览分配方案，离开或重新扫描后清除；实际任务使用已保存的组合配置。
      </p>
      {!validCount && <p role="alert">每份发布数量须为1至20。</p>}
      {selectedProfiles.length * count > 1000 && (
        <p role="alert">草案最多1000行，请减少本批范围或每份数量。</p>
      )}
      {expired && <p role="status">扫描已过期，请重新检查素材。</p>}
      {error && <p role="alert">{error}</p>}
      {visible && (
        <>
          <p role="status">
            共 {visible.rows.length} 条 · 已分配 {visible.rows.length - visible.missing} 条 · 缺{' '}
            {visible.missing} 份素材 · {visible.conflicted} 条内容冲突或超限
          </p>
          <div className="material-arrangement-tools">
            <button
              type="button"
              disabled={busy}
              onClick={() => setSelected(new Set(visible.rows.map(rowKey)))}
            >
              全选草案
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected(new Set())}>
              清空行选择
            </button>
            <span>已选 {selected.size} 行</span>
            <select
              aria-label="批量替换素材"
              value={replacement}
              disabled={busy}
              onChange={(event) => setReplacement(event.target.value)}
            >
              <option value="">选择替换素材</option>
              <option value="clear">清空素材</option>
              {visible.candidates.map((item, index) => (
                <option key={item.source} value={index}>
                  {item.source} · {formatNames[item.format]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !selected.size || !replacement}
              onClick={() => change(selected, replacement === 'clear' ? null : Number(replacement))}
            >
              替换所选行
            </button>
          </div>
          <div className="material-arrangement-rows">
            {rows.map((row) => {
              const key = rowKey(row),
                target = targets.get(row.profileId),
                item = row.sourceIndex === null ? null : visible.candidates[row.sourceIndex];
              return (
                <div key={key} className="material-arrangement-row">
                  <input
                    type="checkbox"
                    aria-label={
                      '选择排贴 ' + (target?.alias ?? row.profileId) + ' 第' + row.ordinal + '条'
                    }
                    checked={selected.has(key)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                  <div>
                    <strong>{target?.alias ?? row.profileId}</strong>
                    <small>
                      第{row.ordinal}条 · {target?.online ? '身份待确认' : '未连接 · 身份待确认'}
                    </small>
                  </div>
                  <div>
                    {editing === key ? (
                      <select
                        aria-label={
                          '素材 ' + (target?.alias ?? row.profileId) + ' 第' + row.ordinal + '条'
                        }
                        value={row.sourceIndex ?? ''}
                        disabled={busy}
                        onChange={(event) =>
                          change(
                            new Set([key]),
                            event.target.value === '' ? null : Number(event.target.value),
                          )
                        }
                      >
                        <option value="">未分配素材</option>
                        {visible.candidates.map((candidate, index) => (
                          <option key={candidate.source} value={index}>
                            {candidate.source} · {formatNames[candidate.format]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>
                        {item ? item.source + ' · ' + formatNames[item.format] : '未分配素材'}
                      </span>
                    )}{' '}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(editing === key ? '' : key)}
                    >
                      {editing === key ? '收起' : '更换'}
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={!item || busy}
                    onClick={() => {
                      if (item) onPreview(item.source);
                    }}
                  >
                    查看内容
                  </button>
                  {row.blockers.length > 0 && (
                    <small className="material-arrangement-warning">
                      {row.blockers.map((blocker) => blockerNames[blocker]).join(' · ')}
                    </small>
                  )}
                </div>
              );
            })}
          </div>
          <div className="material-arrangement-tools">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </button>
            <span>
              {currentPage + 1} / {pages} · 每页50条
            </span>
            <button
              type="button"
              disabled={currentPage + 1 >= pages}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
            <span>请保存组合，再从任务入口启动发布。</span>
          </div>
        </>
      )}
    </section>
  );
}
