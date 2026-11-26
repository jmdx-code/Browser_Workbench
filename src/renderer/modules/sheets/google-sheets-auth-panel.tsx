import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  maskGyazoToken,
  parseGyazoTokenList,
  type GoogleAuthStatus,
  type SheetImageHostPreference,
  type SheetImageHostStatus,
} from '../../../shared/google-sheets.js';
import { api } from '../../api.js';
import { copyTextToClipboard } from '../../clipboard.js';
import { ConfirmDialog } from '../../confirm-dialog.js';
import { UI_CARD, UI_INPUT_SM, UI_MUTED, UI_TEXTAREA } from '../../ui/primitives.js';
import { Btn, errMsg, InFld, NoticeBanner, SelFld } from '../shared/module-ui.js';
import { clearGoogleSheetsGridCache } from './google-sheets-page.js';

interface Draft {
  preferredHost: SheetImageHostPreference;
  defaultMachineName: string;
  gyazoTokens: string[];
}
const sameDraft = (a: Draft | null, b: Draft) =>
  a !== null &&
  a.preferredHost === b.preferredHost &&
  a.defaultMachineName === b.defaultMachineName &&
  a.gyazoTokens.length === b.gyazoTokens.length &&
  a.gyazoTokens.every((t, i) => t === b.gyazoTokens[i]);
const cloneDraft = (d: Draft): Draft => ({ ...d, gyazoTokens: [...d.gyazoTokens] });

export function GoogleSheetsAuthPanel({ onChanged }: { onChanged?: () => void }) {
  const [auth, setAuth] = useState<GoogleAuthStatus | null>(null),
    [imageHost, setImageHost] = useState<SheetImageHostStatus | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [testingHost, setTestingHost] = useState(false),
    [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null),
    [credText, setCredText] = useState(''),
    [showPasteCred, setShowPasteCred] = useState(false),
    [authUrl, setAuthUrl] = useState<string | null>(null),
    [manualCode, setManualCode] = useState(''),
    [showManualBox, setShowManualBox] = useState(false),
    [preferredHost, setPreferredHost] = useState<SheetImageHostPreference>('auto'),
    [gyazoTokensText, setGyazoTokensText] = useState(''),
    [maskTokensView, setMaskTokensView] = useState(false),
    [machineName, setMachineName] = useState('电脑1号'),
    [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'),
    [autoSaveError, setAutoSaveError] = useState<string | null>(null),
    [testImageUrl, setTestImageUrl] = useState<string | null>(null),
    [confirmAction, setConfirmAction] = useState<'revoke' | 'clear-token' | null>(null);

  const pollInFlight = useRef(false),
    initRef = useRef(false),
    lastSavedRef = useRef<Draft | null>(null),
    latestRef = useRef<Draft>({
      preferredHost: 'auto',
      defaultMachineName: '电脑1号',
      gyazoTokens: [],
    }),
    saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    saveQueueRef = useRef<Promise<void>>(Promise.resolve()),
    mountedRef = useRef(true);

  const parsedTokens = useMemo(() => parseGyazoTokenList(gyazoTokensText), [gyazoTokensText]);
  const makeDraft = (o?: Partial<Draft>): Draft => ({
    preferredHost: o?.preferredHost ?? preferredHost,
    defaultMachineName: o?.defaultMachineName ?? (machineName.trim() || '电脑1号'),
    gyazoTokens: o?.gyazoTokens ?? parsedTokens,
  });
  const saveImageHost = (d: Draft) =>
    api.googleSheetsSaveImageHost({
      preferredHost: d.preferredHost,
      defaultMachineName: d.defaultMachineName,
      gyazoAccessTokens: d.gyazoTokens,
    });
  latestRef.current = makeDraft();

  const load = useCallback(async () => {
    try {
      const [ov, tok] = await Promise.all([
        api.googleSheetsOverview(),
        api.googleSheetsImageHostTokens().catch(() => ({ tokens: [] as string[] })),
      ]);
      if (!mountedRef.current) return;
      setAuth(ov.auth);
      setImageHost(ov.imageHost);
      setAuthUrl(ov.auth.pendingAuthUrl);
      const m = ov.imageHost.defaultMachineName || '电脑1号',
        t = parseGyazoTokenList(tok.tokens);
      setPreferredHost(ov.imageHost.preferredHost);
      setMachineName(m);
      setGyazoTokensText(t.join('\n'));
      const snap: Draft = {
        preferredHost: ov.imageHost.preferredHost,
        defaultMachineName: m,
        gyazoTokens: t,
      };
      lastSavedRef.current = snap;
      latestRef.current = snap;
      initRef.current = true;
    } catch (e) {
      if (mountedRef.current)
        setFeedback({ tone: 'err', text: errMsg(e, '读取 Google 授权配置失败') });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const p = latestRef.current;
      if (initRef.current && !sameDraft(lastSavedRef.current, p)) {
        lastSavedRef.current = cloneDraft(p);
        void saveImageHost(p).catch(() => {});
      }
    };
  }, [load]);

  const flushSaveDraft = useCallback(
    (override?: Draft): Promise<void> => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const target = override ?? latestRef.current;
      if (!initRef.current || sameDraft(lastSavedRef.current, target)) return saveQueueRef.current;
      const task = saveQueueRef.current
        .catch(() => {})
        .then(async () => {
          if (sameDraft(lastSavedRef.current, target)) return;
          if (mountedRef.current) {
            setAutoSaveState('saving');
            setAutoSaveError(null);
          }
          try {
            const next = await saveImageHost(target);
            lastSavedRef.current = cloneDraft(target);
            if (mountedRef.current) {
              setImageHost(next);
              setAutoSaveState('saved');
              setAutoSaveError(null);
              onChanged?.();
            }
          } catch (e) {
            if (mountedRef.current) {
              const m = errMsg(e, '自动保存失败');
              setAutoSaveState('error');
              setAutoSaveError(m);
              setFeedback({ tone: 'err', text: m });
            }
          }
        });
      saveQueueRef.current = task;
      return task;
    },
    [onChanged],
  );

  const scheduleAutoSave = useCallback(
    (nextDraft: Draft, delayMs = 450) => {
      latestRef.current = nextDraft;
      if (!initRef.current) return;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (sameDraft(lastSavedRef.current, nextDraft)) return;
      setAutoSaveState('saving');
      setAutoSaveError(null);
      if (delayMs <= 0) return void flushSaveDraft(nextDraft);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSaveDraft(nextDraft);
      }, delayMs);
    },
    [flushSaveDraft],
  );

  useEffect(() => {
    if (!authUrl || auth?.authorized) return;
    const timer = setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void api
        .googleSheetsOverview()
        .then((ov) => {
          if (!mountedRef.current) return;
          setAuth(ov.auth);
          setImageHost(ov.imageHost);
          if (ov.auth.authorized) {
            setAuthUrl(null);
            setFeedback({
              tone: 'ok',
              text: `授权成功：${ov.auth.authorizedEmail ?? 'Google 账号已连接'}`,
            });
            onChanged?.();
          }
        })
        .catch(() => {})
        .finally(() => {
          pollInFlight.current = false;
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [authUrl, auth?.authorized, onChanged]);

  async function runBusy(work: () => Promise<void>, fb: string) {
    setBusy(true);
    setFeedback(null);
    try {
      await work();
    } catch (e) {
      setFeedback({ tone: 'err', text: errMsg(e, fb) });
    } finally {
      setBusy(false);
    }
  }
  async function startAndCopyAuthUrl(prefix?: string) {
    const res = await api.googleSheetsStartAuth();
    setAuth(res.status);
    setAuthUrl(res.authUrl);
    const copied = await copyTextToClipboard(res.authUrl).then(
      () => true,
      () => false,
    );
    const tail = copied
      ? '已自动生成并复制授权链接到剪贴板！请直接粘贴到目标 Gmail 浏览器打开完成授权。'
      : '已自动生成授权链接（未能自动写入剪贴板，请点击下方「复制链接」）。';
    setFeedback({
      tone: 'ok',
      text: prefix
        ? `${prefix}，${tail}`
        : copied
          ? '已生成并自动复制授权链接！请粘贴到目标 Gmail 浏览器打开并同意授权。'
          : '已生成授权链接，请点击下方「复制链接」到目标 Gmail 浏览器打开。',
    });
  }
  async function importAndStartAuth(rawJson: string, label: string) {
    setAuth(await api.googleSheetsImportCredentials(rawJson));
    onChanged?.();
    await startAndCopyAuthUrl(label);
  }
  async function onPickCredFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f)
      await runBusy(
        async () => importAndStartAuth(await f.text(), `已导入授权文件（${f.name}）`),
        '导入失败',
      );
  }
  async function handleTestImageHost() {
    setTestingHost(true);
    setFeedback(null);
    setTestImageUrl(null);
    try {
      await flushSaveDraft();
      const res = await api.googleSheetsTestImageHost();
      setTestImageUrl(res.remoteUrl);
      const lbl =
        res.host === 'gyazo'
          ? res.tokenIndex !== undefined && (res.tokenCount ?? 0) > 1
            ? `Gyazo · Token #${res.tokenIndex + 1}/${res.tokenCount}`
            : 'Gyazo'
          : res.fallbackFromGyazo
            ? 'Gyazo 失败，已自动切换 Google 网盘兜底'
            : 'Google 网盘自建';
      setFeedback({ tone: 'ok', text: `图床上传测试成功（${lbl}）` });
    } catch (e) {
      setFeedback({ tone: 'err', text: errMsg(e, '测试上传失败') });
    } finally {
      setTestingHost(false);
    }
  }

  if (loading) return <p className={UI_MUTED}>正在读取 Google 表格授权配置…</p>;

  return (
    <div className="flex flex-col gap-3">
      {feedback && <NoticeBanner tone={feedback.tone}>{feedback.text}</NoticeBanner>}
      <section className={`${UI_CARD} flex flex-col gap-3 p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-2.5">
          <div>
            <h3 className="m-0 text-sm font-semibold">1. Google 账号授权</h3>
            <p className={`${UI_MUTED} m-0 mt-0.5`}>
              选择或粘贴 OAuth JSON 后将自动生成并复制授权链接，直接粘贴到目标 Gmail
              浏览器打开即可完成授权。
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${auth?.authorized ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
          >
            {auth?.authorized
              ? `已授权${auth.authorizedEmail ? ` · ${auth.authorizedEmail}` : ''}`
              : '未授权'}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-dashed border-[var(--line-strong)] bg-slate-50 px-3 py-2.5">
          <div className="flex flex-col gap-0.5 text-xs">
            <strong>OAuth 凭据文件（credentials.json）</strong>
            <span className={UI_MUTED}>
              {auth?.hasCredentials
                ? `已载入：${auth.clientIdHint ?? 'Desktop OAuth Client'}`
                : '从 Google Cloud Console 下载「桌面应用」JSON，选中即自动生成并复制授权链接'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-md border border-[var(--brand)] bg-[var(--brand)] px-2.5 text-xs font-semibold whitespace-nowrap text-white transition-colors hover:bg-[var(--brand-hover)]">
              选择 JSON 并生成链接
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={(e) => void onPickCredFile(e)}
              />
            </label>
            <Btn v="ghost" disabled={busy} onClick={() => setShowPasteCred((v) => !v)}>
              {showPasteCred ? '收起粘贴框' : '粘贴 JSON'}
            </Btn>
            {auth?.hasCredentials && (
              <Btn
                disabled={busy}
                onClick={() => void runBusy(() => startAndCopyAuthUrl(), '生成授权链接失败')}
              >
                {auth?.authorized ? '重新授权' : '重新生成链接'}
              </Btn>
            )}
            {auth?.authorized && (
              <Btn v="danger" disabled={busy} onClick={() => setConfirmAction('revoke')}>
                断开授权
              </Btn>
            )}
          </div>
        </div>
        {showPasteCred && (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--line)] bg-slate-50 p-2.5">
            <textarea
              rows={4}
              className="w-full rounded-md border border-[var(--line-strong)] bg-white p-2 font-mono text-[11px] text-[var(--text)] focus:border-[var(--brand)] focus:outline-none"
              placeholder='粘贴完整的 Google OAuth credentials.json 内容，例如 {"installed":{"client_id":...}}'
              value={credText}
              onChange={(e) => setCredText(e.target.value)}
            />
            <div>
              <Btn
                v="primary"
                disabled={busy || !credText.trim()}
                onClick={() =>
                  void runBusy(async () => {
                    await importAndStartAuth(credText, '已保存 Google OAuth 凭据');
                    setCredText('');
                    setShowPasteCred(false);
                  }, '保存失败')
                }
              >
                导入并自动生成复制链接
              </Btn>
            </div>
          </div>
        )}
        {authUrl && (
          <div className="flex flex-col gap-2 rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <strong>授权链接（已自动复制，等待浏览器回传…）</strong>
              <Btn
                v="primary"
                onClick={() =>
                  void copyTextToClipboard(authUrl)
                    .then(() =>
                      setFeedback({
                        tone: 'ok',
                        text: '已复制授权链接，请粘贴到指定邮箱浏览器打开',
                      }),
                    )
                    .catch((e) => setFeedback({ tone: 'err', text: errMsg(e, '复制失败') }))
                }
              >
                再次复制
              </Btn>
            </div>
            <input
              type="text"
              readOnly
              value={authUrl}
              className={`${UI_INPUT_SM} w-full font-mono text-[11px]`}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-sky-900/80">
                直接粘贴到登录了目标 Gmail 的 Chrome 浏览器打开，点击同意后本软件会自动完成连接。
              </span>
              <Btn v="ghost" onClick={() => setShowManualBox((v) => !v)}>
                {showManualBox ? '收起手动回填' : '跨机/手动回填'}
              </Btn>
            </div>
            {showManualBox && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className={`${UI_INPUT_SM} min-w-0 flex-1`}
                  placeholder="粘贴浏览器跳转后的完整 http://127.0.0.1:.../oauth2/callback?code=... 或授权码"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                />
                <Btn
                  v="primary"
                  disabled={busy || !manualCode.trim()}
                  onClick={() =>
                    void runBusy(async () => {
                      const next = await api.googleSheetsCompleteManualAuth(manualCode);
                      setAuth(next);
                      setAuthUrl(null);
                      setManualCode('');
                      setShowManualBox(false);
                      setFeedback({
                        tone: 'ok',
                        text: `授权成功：${next.authorizedEmail ?? 'Google 账号已连接'}`,
                      });
                      onChanged?.();
                    }, '手动验证失败')
                  }
                >
                  提交完成授权
                </Btn>
              </div>
            )}
          </div>
        )}
        {auth?.lastError && <p className="m-0 text-xs text-rose-700">最近错误：{auth.lastError}</p>}
      </section>

      <section className={`${UI_CARD} flex flex-col gap-3 p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-2.5">
          <div>
            <h3 className="m-0 text-sm font-semibold">2. 永久图床与本机标识</h3>
            <p className={`${UI_MUTED} m-0 mt-0.5`}>
              修改后自动立即保存，无需点保存按钮；支持填多个 Gyazo Token 自动轮询与失效切换。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {autoSaveState === 'saving' && (
              <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                自动保存中…
              </span>
            )}
            {autoSaveState === 'saved' && (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                已自动保存
              </span>
            )}
            {autoSaveState === 'error' && (
              <span
                className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700"
                title={autoSaveError ?? undefined}
              >
                保存失败
              </span>
            )}
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              已缓存去重 {imageHost?.cachedImageCount ?? 0} 张
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <InFld
            label="默认本机名称（发帖记录右侧顶贴列名）"
            maxLength={60}
            value={machineName}
            placeholder="例如：电脑1号"
            onVal={(v) => {
              setMachineName(v);
              scheduleAutoSave(makeDraft({ defaultMachineName: v.trim() || '电脑1号' }), 450);
            }}
            onBlur={() => void flushSaveDraft()}
          />
          <SelFld
            label="图床托管策略"
            value={preferredHost}
            onVal={(v) => {
              const h = v as SheetImageHostPreference;
              setPreferredHost(h);
              scheduleAutoSave(makeDraft({ preferredHost: h }), 0);
            }}
          >
            <option value="auto">自动（优先 Gyazo，失效切网盘）</option>
            <option value="gyazo">仅 Gyazo 图床</option>
            <option value="drive">仅 Google 网盘</option>
          </SelFld>
          <div className="flex flex-col gap-1 text-xs font-medium text-[var(--text-2)] sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <span>
                Gyazo Access Token 轮询池（每行一个，修改后自动保存
                {parsedTokens.length > 1
                  ? ` · 已配置 ${parsedTokens.length} 个 · 自动轮询 + 失效切换`
                  : parsedTokens.length === 1
                    ? ' · 已配置 1 个'
                    : ' · 留空自动用 Google 网盘兜底'}
                ）
              </span>
              {parsedTokens.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Btn
                    v="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setMaskTokensView((v) => !v)}
                  >
                    {maskTokensView ? '编辑明文' : '隐藏明文'}
                  </Btn>
                  <Btn
                    v="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={testingHost}
                    onClick={() => setConfirmAction('clear-token')}
                  >
                    清空全部
                  </Btn>
                </div>
              )}
            </div>
            {maskTokensView && parsedTokens.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 rounded-md border border-[var(--line)] bg-slate-50 p-2">
                {parsedTokens.map((t, idx) => (
                  <span
                    key={`${idx}-${t.slice(0, 4)}`}
                    className="rounded border border-[var(--line)] bg-white px-2 py-0.5 font-mono text-[11px]"
                  >
                    #{idx + 1} · {maskGyazoToken(t) ?? '••••••'}
                  </span>
                ))}
              </div>
            ) : (
              <textarea
                rows={Math.max(3, Math.min(6, parsedTokens.length + 1))}
                className={`${UI_TEXTAREA} gs-token-textarea font-mono text-[11px]`}
                spellCheck={false}
                placeholder={
                  '粘贴 1 个或多个 Gyazo Access Token，每行一个（输入或粘贴后自动立即保存）。\n支持多 Token 轮流上传，某个失效/限流时自动切到下一个。'
                }
                value={gyazoTokensText}
                onChange={(e) => {
                  setGyazoTokensText(e.target.value);
                  scheduleAutoSave(
                    makeDraft({ gyazoTokens: parseGyazoTokenList(e.target.value) }),
                    450,
                  );
                }}
                onBlur={() => void flushSaveDraft()}
              />
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn disabled={testingHost || busy} onClick={() => void handleTestImageHost()}>
            {testingHost ? '测试上传中…' : '测试图床上传'}
          </Btn>
          {testImageUrl && (
            <span className={`${UI_MUTED} max-w-[420px] truncate text-[11px]`}>
              测试直链：<code>{testImageUrl}</code>
            </span>
          )}
        </div>
      </section>

      {confirmAction && (
        <ConfirmDialog
          title={
            confirmAction === 'revoke' ? '确认断开 Google 账号授权' : '确认清空全部 Gyazo Token'
          }
          description={
            confirmAction === 'revoke'
              ? '断开后所有已连接的 Google 表格将暂停自动同步、排贴与顶贴，直到重新完成 OAuth 授权。确定断开吗？'
              : '清空后将自动回退至免配置的 Google 网盘图床（已上传缓存直链不受影响）。确定清空吗？'
          }
          label={confirmAction === 'revoke' ? '确认断开授权' : '确认清空'}
          onClose={() => setConfirmAction(null)}
          onConfirm={
            confirmAction === 'revoke'
              ? () =>
                  runBusy(async () => {
                    setConfirmAction(null);
                    setAuth(await api.googleSheetsRevokeAuth());
                    clearGoogleSheetsGridCache();
                    setAuthUrl(null);
                    setFeedback({ tone: 'ok', text: '已断开 Google 授权' });
                    onChanged?.();
                  }, '断开失败')
              : async () => {
                  setConfirmAction(null);
                  setGyazoTokensText('');
                  setMaskTokensView(false);
                  const d = makeDraft({ gyazoTokens: [] });
                  latestRef.current = d;
                  await flushSaveDraft(d);
                  setFeedback({
                    tone: 'ok',
                    text: '已清空 Gyazo Token，将自动使用 Google 网盘兜底',
                  });
                }
          }
        />
      )}
    </div>
  );
}
