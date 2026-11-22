import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseGoogleSpreadsheetUrl,
  type GoogleSheetKind,
  type GoogleSheetLink,
  type SpreadsheetMeta,
} from '../../../shared/google-sheets.js';
import { api } from '../../api.js';

const KIND_LABELS: Record<GoogleSheetKind, string> = {
  group_library: '小组表',
  page_library: '专页表',
  post_schedule: '排贴表',
  post_records: '发帖记录表',
};

export function SheetConnectModal({
  kind,
  sameDocSuggestionUrl,
  sameDocSuggestionLabel,
  existingLinks = [],
  onClose,
  onConnected,
}: {
  kind: GoogleSheetKind;
  sameDocSuggestionUrl?: string | undefined;
  sameDocSuggestionLabel?: string | undefined;
  existingLinks?: readonly GoogleSheetLink[];
  onClose: () => void;
  onConnected: (linkId: string) => void;
}) {
  const [urlOrId, setUrlOrId] = useState('');
  const [meta, setMeta] = useState<(SpreadsheetMeta & { suggestedGid: number | null }) | null>(
    null,
  );
  const [selectedTabName, setSelectedTabName] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inspectSeqRef = useRef(0);
  const pastedUrlRef = useRef<string | null>(null);

  const isMultiKind = kind === 'post_schedule' || kind === 'post_records';

  const connectedSheetKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!isMultiKind) return keys;
    for (const item of existingLinks) {
      if (item.kind === kind) {
        keys.add(`${item.spreadsheetId}:${item.sheetId}`);
      }
    }
    return keys;
  }, [existingLinks, isMultiKind, kind]);

  const isTabAlreadyConnected = useCallback(
    (spreadsheetId: string, sheetId: number) =>
      connectedSheetKeys.has(`${spreadsheetId}:${sheetId}`),
    [connectedSheetKeys],
  );

  const runInspect = useCallback(
    async (rawInput: string) => {
      const trimmed = rawInput.trim();
      if (!trimmed) return;
      const seq = ++inspectSeqRef.current;
      setBusy(true);
      setError('');
      try {
        const inspected = await api.googleSheetsInspect(trimmed);
        if (seq !== inspectSeqRef.current) return;
        setMeta(inspected);

        const matchesKind = (tabTitle: string) => {
          if (kind === 'group_library') return /小组|小組|group/i.test(tabTitle);
          if (kind === 'page_library') return /专页|專頁|page/i.test(tabTitle);
          if (kind === 'post_schedule') return /排贴|排貼|schedule/i.test(tabTitle);
          return /发帖记录|發帖記錄|顶贴|頂貼|record/i.test(tabTitle);
        };

        const notConnected = (tab: SpreadsheetMeta['tabs'][number]) =>
          !isTabAlreadyConnected(inspected.spreadsheetId, tab.sheetId);

        const suggestedTab =
          inspected.suggestedGid !== null
            ? inspected.tabs.find((t) => t.sheetId === inspected.suggestedGid)
            : undefined;

        const preferred =
          (suggestedTab && notConnected(suggestedTab) ? suggestedTab : undefined) ??
          inspected.tabs.find((t) => matchesKind(t.title) && notConnected(t)) ??
          inspected.tabs.find((t) => notConnected(t)) ??
          suggestedTab ??
          inspected.tabs.find((t) => matchesKind(t.title)) ??
          inspected.tabs[0];

        if (preferred) {
          setSelectedTabName(preferred.title);
          setTitle(preferred.title);
        }
      } catch (err) {
        if (seq !== inspectSeqRef.current) return;
        setMeta(null);
        setError(err instanceof Error ? err.message : '读取 Google 表格失败');
      } finally {
        if (seq === inspectSeqRef.current) setBusy(false);
      }
    },
    [isTabAlreadyConnected, kind],
  );

  const selectedTab = useMemo(
    () => meta?.tabs.find((t) => t.title === selectedTabName) ?? null,
    [meta, selectedTabName],
  );

  const selectedTabDuplicate = Boolean(
    meta && selectedTab && isTabAlreadyConnected(meta.spreadsheetId, selectedTab.sheetId),
  );

  async function handleSubmit() {
    if (!urlOrId.trim() || selectedTabDuplicate) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.googleSheetsCreateLink({
        kind,
        spreadsheetUrlOrId: urlOrId.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(selectedTab ? { sheetName: selectedTab.title, sheetId: selectedTab.sheetId } : {}),
      });
      onConnected(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接表格失败');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div
      className="gs-modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="gs-modal" role="dialog" aria-label={`连接${KIND_LABELS[kind]}`}>
        <header className="gs-modal-head">
          <div>
            <h3>连接 {KIND_LABELS[kind]}</h3>
            <p className="hint">
              粘贴新的 Google 表格链接将自动读取工作表标签（支持带 #gid= 直接定位）。
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="gs-modal-body">
          {error && <div className="gs-banner is-err">{error}</div>}

          <label className="gs-field">
            <span>Google 表格链接或表格 ID</span>
            <div className="gs-token-row">
              <input
                type="text"
                autoFocus
                placeholder="粘贴新的 https://docs.google.com/spreadsheets/d/... 链接"
                value={urlOrId}
                onChange={(e) => {
                  const nextVal = e.target.value;
                  setUrlOrId(nextVal);
                  setMeta(null);
                  setError('');
                  const trimmed = nextVal.trim();
                  if (
                    pastedUrlRef.current &&
                    trimmed === pastedUrlRef.current &&
                    parseGoogleSpreadsheetUrl(trimmed)
                  ) {
                    pastedUrlRef.current = null;
                    void runInspect(trimmed);
                  }
                }}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text').trim();
                  pastedUrlRef.current =
                    pasted && parseGoogleSpreadsheetUrl(pasted) ? pasted : null;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runInspect(urlOrId);
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !urlOrId.trim()}
                onClick={() => void runInspect(urlOrId)}
              >
                {busy ? '读取中…' : '读取工作表'}
              </button>
            </div>
          </label>

          {sameDocSuggestionUrl && !urlOrId.trim() && (
            <div className="gs-doc-shortcut">
              <span className="hint">要连接同一份 Google 文档里的其他工作表？</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost gs-mini-btn"
                disabled={busy}
                onClick={() => {
                  setUrlOrId(sameDocSuggestionUrl);
                  void runInspect(sameDocSuggestionUrl);
                }}
              >
                {sameDocSuggestionLabel ?? '填入当前文档并读取'}
              </button>
            </div>
          )}

          {meta && (
            <>
              <div className="gs-meta-banner">
                <strong>表格：{meta.title}</strong>
                <span className="hint">共发现 {meta.tabs.length} 个工作表标签</span>
              </div>

              <label className="gs-field">
                <span>选择工作表标签（Sheet Tab）</span>
                <select
                  value={selectedTabName}
                  onChange={(e) => {
                    setSelectedTabName(e.target.value);
                    setTitle(e.target.value);
                  }}
                >
                  {meta.tabs.map((tab) => {
                    const dup = isTabAlreadyConnected(meta.spreadsheetId, tab.sheetId);
                    return (
                      <option key={tab.sheetId} value={tab.title}>
                        {tab.title}
                        {dup ? '（已连接）' : ''}（gid: {tab.sheetId}）
                      </option>
                    );
                  })}
                </select>
              </label>

              {selectedTabDuplicate && (
                <div className="gs-banner is-err">
                  该工作表「{selectedTab?.title}」已经连接过了，请换选其他工作表或粘贴新表格链接。
                </div>
              )}

              <label className="gs-field">
                <span>
                  {isMultiKind
                    ? '工作台内显示名称（底部标签名，可随时双击修改）'
                    : '工作台内显示名称'}
                </span>
                <input
                  type="text"
                  value={title}
                  placeholder={selectedTabName || KIND_LABELS[kind]}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <footer className="gs-modal-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !urlOrId.trim() || selectedTabDuplicate}
            onClick={() => void handleSubmit()}
          >
            {busy ? '连接中…' : '确认连接'}
          </button>
        </footer>
      </div>
    </div>
  );
}
