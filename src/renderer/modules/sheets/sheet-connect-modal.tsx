import { useCallback, useMemo, useRef, useState } from 'react';
import {
  parseGoogleSpreadsheetUrl,
  type GoogleSheetKind,
  type GoogleSheetLink,
  type SpreadsheetMeta,
} from '../../../shared/google-sheets.js';
import { api } from '../../api.js';
import { UI_INPUT_SM, UI_SELECT_SM } from '../../ui/primitives.js';
import {
  BackdropModal,
  Btn,
  errMsg,
  Fld,
  ModalFoot,
  ModalHeading,
  NoticeBanner,
} from '../shared/module-ui.js';

const KIND_LABELS: Record<GoogleSheetKind, string> = {
  group_library: '小组表',
  page_library: '专页表',
  post_schedule: '排贴表',
  post_records: '发帖记录表',
};
const KIND_PATTERNS: Record<GoogleSheetKind, RegExp> = {
  group_library: /小组|小組|group/i,
  page_library: /专页|專頁|page/i,
  post_schedule: /排贴|排貼|schedule/i,
  post_records: /发帖记录|發帖記錄|顶贴|頂貼|record/i,
};

export function SheetConnectModal(p: {
  kind: GoogleSheetKind;
  sameDocSuggestionUrl?: string | undefined;
  sameDocSuggestionLabel?: string | undefined;
  existingLinks?: readonly GoogleSheetLink[];
  onClose: () => void;
  onConnected: (linkId: string) => void;
}) {
  const { kind, existingLinks = [], onClose, onConnected } = p;
  const [urlOrId, setUrlOrId] = useState(''),
    [meta, setMeta] = useState<(SpreadsheetMeta & { suggestedGid: number | null }) | null>(null),
    [selectedTabName, setSelectedTabName] = useState(''),
    [title, setTitle] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const inspectSeqRef = useRef(0),
    pastedUrlRef = useRef<string | null>(null);
  const isMultiKind = kind === 'post_schedule' || kind === 'post_records';

  const connectedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (isMultiKind)
      for (const item of existingLinks)
        if (item.kind === kind) keys.add(`${item.spreadsheetId}:${item.sheetId}`);
    return keys;
  }, [existingLinks, isMultiKind, kind]);
  const isDup = useCallback(
    (sid: string, tid: number) => connectedKeys.has(`${sid}:${tid}`),
    [connectedKeys],
  );

  const runInspect = useCallback(
    async (rawInput: string) => {
      const trimmed = rawInput.trim();
      if (!trimmed) return;
      const seq = ++inspectSeqRef.current;
      setBusy(true);
      setError('');
      try {
        const res = await api.googleSheetsInspect(trimmed);
        if (seq !== inspectSeqRef.current) return;
        setMeta(res);
        const pat = KIND_PATTERNS[kind],
          free = (t: SpreadsheetMeta['tabs'][number]) => !isDup(res.spreadsheetId, t.sheetId),
          suggested =
            res.suggestedGid !== null
              ? res.tabs.find((t) => t.sheetId === res.suggestedGid)
              : undefined;
        const pref =
          (suggested && free(suggested) ? suggested : undefined) ??
          res.tabs.find((t) => pat.test(t.title) && free(t)) ??
          res.tabs.find(free) ??
          suggested ??
          res.tabs.find((t) => pat.test(t.title)) ??
          res.tabs[0];
        if (pref) {
          setSelectedTabName(pref.title);
          setTitle(pref.title);
        }
      } catch (err) {
        if (seq === inspectSeqRef.current) {
          setMeta(null);
          setError(errMsg(err, '读取 Google 表格失败'));
        }
      } finally {
        if (seq === inspectSeqRef.current) setBusy(false);
      }
    },
    [isDup, kind],
  );

  const selectedTab = useMemo(
    () => meta?.tabs.find((t) => t.title === selectedTabName) ?? null,
    [meta, selectedTabName],
  );
  const selectedTabDup = Boolean(
    meta && selectedTab && isDup(meta.spreadsheetId, selectedTab.sheetId),
  );

  async function handleSubmit() {
    if (!urlOrId.trim() || selectedTabDup) return;
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
      setError(errMsg(err, '连接表格失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BackdropModal
      label={`连接${KIND_LABELS[kind]}`}
      modalClass="contents"
      busy={busy}
      onClose={onClose}
    >
      <div className="modal flex max-h-[calc(100vh-40px)] w-[min(600px,94vw)] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white text-[var(--text)] shadow-2xl">
        <ModalHeading
          title={`连接 ${KIND_LABELS[kind]}`}
          subtitle="粘贴新的 Google 表格链接将自动读取工作表标签（支持带 #gid= 直接定位）。"
          disabled={busy}
          onClose={onClose}
        />
        <div className="flex flex-col gap-3 overflow-y-auto p-4">
          {error && <NoticeBanner tone="err">{error}</NoticeBanner>}
          <Fld label="Google 表格链接或表格 ID">
            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                className={`${UI_INPUT_SM} min-w-0 flex-1`}
                placeholder="粘贴新的 https://docs.google.com/spreadsheets/d/... 链接"
                value={urlOrId}
                onChange={(e) => {
                  const v = e.target.value,
                    tr = v.trim();
                  setUrlOrId(v);
                  setMeta(null);
                  setError('');
                  if (
                    pastedUrlRef.current &&
                    tr === pastedUrlRef.current &&
                    parseGoogleSpreadsheetUrl(tr)
                  ) {
                    pastedUrlRef.current = null;
                    void runInspect(tr);
                  }
                }}
                onPaste={(e) => {
                  const pt = e.clipboardData.getData('text').trim();
                  pastedUrlRef.current = pt && parseGoogleSpreadsheetUrl(pt) ? pt : null;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && urlOrId.trim()) void runInspect(urlOrId);
                }}
              />
              <Btn
                className="shrink-0"
                disabled={busy || !urlOrId.trim()}
                onClick={() => void runInspect(urlOrId)}
              >
                {busy ? '读取中…' : '读取工作表'}
              </Btn>
            </div>
          </Fld>
          {p.sameDocSuggestionUrl && !urlOrId.trim() && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-[var(--line-strong)] bg-slate-50 px-3 py-2 text-xs">
              <span className="text-xs text-[var(--text-3)]">
                要连接同一份 Google 文档里的其他工作表？
              </span>
              <Btn
                v="ghost"
                className="h-6 px-2 text-[11px]"
                disabled={busy}
                onClick={() => {
                  const u = p.sameDocSuggestionUrl ?? '';
                  setUrlOrId(u);
                  void runInspect(u);
                }}
              >
                {p.sameDocSuggestionLabel ?? '填入当前文档并读取'}
              </Btn>
            </div>
          )}
          {meta && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-slate-50 px-3 py-2 text-xs">
                <strong>表格：{meta.title}</strong>
                <span className="text-xs text-[var(--text-3)]">
                  共发现 {meta.tabs.length} 个工作表标签
                </span>
              </div>
              <Fld label="选择工作表标签（Sheet Tab）">
                <select
                  className={`${UI_SELECT_SM} w-full`}
                  value={selectedTabName}
                  onChange={(e) => {
                    setSelectedTabName(e.target.value);
                    setTitle(e.target.value);
                  }}
                >
                  {meta.tabs.map((tab) => (
                    <option key={tab.sheetId} value={tab.title}>
                      {tab.title}
                      {isDup(meta.spreadsheetId, tab.sheetId) ? '（已连接）' : ''}（gid:{' '}
                      {tab.sheetId}）
                    </option>
                  ))}
                </select>
              </Fld>
              {selectedTabDup && (
                <NoticeBanner tone="err">
                  该工作表「{selectedTab?.title}」已经连接过了，请换选其他工作表或粘贴新表格链接。
                </NoticeBanner>
              )}
              <Fld
                label={
                  isMultiKind
                    ? '工作台内显示名称（底部标签名，可随时双击修改）'
                    : '工作台内显示名称'
                }
              >
                <input
                  type="text"
                  className={`${UI_INPUT_SM} w-full`}
                  value={title}
                  placeholder={selectedTabName || KIND_LABELS[kind]}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Fld>
            </>
          )}
        </div>
        <ModalFoot
          busy={busy}
          okText={busy ? '连接中…' : '确认连接'}
          okDisabled={
            !urlOrId.trim() ||
            selectedTabDup ||
            (!meta && !parseGoogleSpreadsheetUrl(urlOrId.trim()))
          }
          onCancel={onClose}
          onOk={() => void handleSubmit()}
        />
      </div>
    </BackdropModal>
  );
}
