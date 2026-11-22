import './google-sheets-auth-panel.css';
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

interface EditableImageHostDraft {
  preferredHost: SheetImageHostPreference;
  defaultMachineName: string;
  gyazoTokens: string[];
}

function sameDraft(a: EditableImageHostDraft | null, b: EditableImageHostDraft): boolean {
  if (!a) return false;
  if (a.preferredHost !== b.preferredHost) return false;
  if (a.defaultMachineName !== b.defaultMachineName) return false;
  if (a.gyazoTokens.length !== b.gyazoTokens.length) return false;
  return a.gyazoTokens.every((t, idx) => t === b.gyazoTokens[idx]);
}

export function GoogleSheetsAuthPanel({ onChanged }: { onChanged?: () => void }) {
  const [auth, setAuth] = useState<GoogleAuthStatus | null>(null);
  const [imageHost, setImageHost] = useState<SheetImageHostStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testingHost, setTestingHost] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const [credText, setCredText] = useState('');
  const [showPasteCred, setShowPasteCred] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [showManualBox, setShowManualBox] = useState(false);

  const [preferredHost, setPreferredHost] = useState<SheetImageHostPreference>('auto');
  const [gyazoTokensText, setGyazoTokensText] = useState('');
  const [maskTokensView, setMaskTokensView] = useState(false);
  const [machineName, setMachineName] = useState('电脑1号');
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);
  const [testImageUrl, setTestImageUrl] = useState<string | null>(null);

  const [confirmAction, setConfirmAction] = useState<'revoke' | 'clear-token' | null>(null);

  const pollInFlight = useRef(false);
  const initializedRef = useRef(false);
  const lastSavedRef = useRef<EditableImageHostDraft | null>(null);
  const latestDraftRef = useRef<EditableImageHostDraft>({
    preferredHost: 'auto',
    defaultMachineName: '电脑1号',
    gyazoTokens: [],
  });
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);

  const parsedTokens = useMemo(() => parseGyazoTokenList(gyazoTokensText), [gyazoTokensText]);

  latestDraftRef.current = {
    preferredHost,
    defaultMachineName: machineName.trim() || '电脑1号',
    gyazoTokens: parsedTokens,
  };

  const load = useCallback(async () => {
    try {
      const [ov, tokenRes] = await Promise.all([
        api.googleSheetsOverview(),
        api.googleSheetsImageHostTokens().catch(() => ({ tokens: [] as string[] })),
      ]);
      if (!mountedRef.current) return;
      setAuth(ov.auth);
      setImageHost(ov.imageHost);
      setAuthUrl(ov.auth.pendingAuthUrl);
      const loadedMachine = ov.imageHost.defaultMachineName || '电脑1号';
      const loadedTokens = parseGyazoTokenList(tokenRes.tokens);
      setPreferredHost(ov.imageHost.preferredHost);
      setMachineName(loadedMachine);
      setGyazoTokensText(loadedTokens.join('\n'));
      const snapshot: EditableImageHostDraft = {
        preferredHost: ov.imageHost.preferredHost,
        defaultMachineName: loadedMachine,
        gyazoTokens: loadedTokens,
      };
      lastSavedRef.current = snapshot;
      latestDraftRef.current = snapshot;
      initializedRef.current = true;
    } catch (err) {
      if (!mountedRef.current) return;
      setFeedback({
        tone: 'err',
        text: err instanceof Error ? err.message : '读取 Google 授权配置失败',
      });
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = latestDraftRef.current;
      if (initializedRef.current && !sameDraft(lastSavedRef.current, pending)) {
        lastSavedRef.current = {
          preferredHost: pending.preferredHost,
          defaultMachineName: pending.defaultMachineName,
          gyazoTokens: [...pending.gyazoTokens],
        };
        void api
          .googleSheetsSaveImageHost({
            preferredHost: pending.preferredHost,
            defaultMachineName: pending.defaultMachineName,
            gyazoAccessTokens: pending.gyazoTokens,
          })
          .catch(() => {});
      }
    };
  }, [load]);

  const flushSaveDraft = useCallback(
    (override?: EditableImageHostDraft): Promise<void> => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const target = override ?? latestDraftRef.current;
      if (!initializedRef.current || sameDraft(lastSavedRef.current, target)) {
        return saveQueueRef.current;
      }
      const task = saveQueueRef.current
        .catch(() => {})
        .then(async () => {
          if (sameDraft(lastSavedRef.current, target)) return;
          if (mountedRef.current) {
            setAutoSaveState('saving');
            setAutoSaveError(null);
          }
          try {
            const next = await api.googleSheetsSaveImageHost({
              preferredHost: target.preferredHost,
              defaultMachineName: target.defaultMachineName,
              gyazoAccessTokens: target.gyazoTokens,
            });
            lastSavedRef.current = {
              preferredHost: target.preferredHost,
              defaultMachineName: target.defaultMachineName,
              gyazoTokens: [...target.gyazoTokens],
            };
            if (mountedRef.current) {
              setImageHost(next);
              setAutoSaveState('saved');
              setAutoSaveError(null);
              onChanged?.();
            }
          } catch (err) {
            if (mountedRef.current) {
              const msg = err instanceof Error ? err.message : '自动保存失败';
              setAutoSaveState('error');
              setAutoSaveError(msg);
              setFeedback({ tone: 'err', text: msg });
            }
          }
        });
      saveQueueRef.current = task;
      return task;
    },
    [onChanged],
  );

  const scheduleAutoSave = useCallback(
    (nextDraft: EditableImageHostDraft, delayMs = 450) => {
      latestDraftRef.current = nextDraft;
      if (!initializedRef.current) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (sameDraft(lastSavedRef.current, nextDraft)) return;
      setAutoSaveState('saving');
      setAutoSaveError(null);
      if (delayMs <= 0) {
        void flushSaveDraft(nextDraft);
        return;
      }
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSaveDraft(nextDraft);
      }, delayMs);
    },
    [flushSaveDraft],
  );

  // Poll briefly while waiting for user to finish OAuth in external browser
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

  async function importAndStartAuth(rawJson: string, sourceLabel: string) {
    const imported = await api.googleSheetsImportCredentials(rawJson);
    setAuth(imported);
    onChanged?.();

    const started = await api.googleSheetsStartAuth();
    setAuth(started.status);
    setAuthUrl(started.authUrl);

    let copied = false;
    try {
      await copyTextToClipboard(started.authUrl);
      copied = true;
    } catch {
      copied = false;
    }
    setFeedback({
      tone: 'ok',
      text: copied
        ? `${sourceLabel}，已自动生成并复制授权链接到剪贴板！请直接粘贴到目标 Gmail 浏览器打开完成授权。`
        : `${sourceLabel}，已自动生成授权链接（未能自动写入剪贴板，请点击下方「复制链接」）。`,
    });
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setFeedback(null);
    try {
      const text = await file.text();
      await importAndStartAuth(text, `已导入授权文件（${file.name}）`);
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '导入失败' });
    } finally {
      setBusy(false);
    }
  }

  async function handleImportPasted() {
    if (!credText.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      await importAndStartAuth(credText, '已保存 Google OAuth 凭据');
      setCredText('');
      setShowPasteCred(false);
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '保存失败' });
    } finally {
      setBusy(false);
    }
  }

  async function handleStartAuth() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.googleSheetsStartAuth();
      setAuth(res.status);
      setAuthUrl(res.authUrl);
      let copied = false;
      try {
        await copyTextToClipboard(res.authUrl);
        copied = true;
      } catch {
        copied = false;
      }
      setFeedback({
        tone: 'ok',
        text: copied
          ? '已生成并自动复制授权链接！请粘贴到目标 Gmail 浏览器打开并同意授权。'
          : '已生成授权链接，请点击下方「复制链接」到目标 Gmail 浏览器打开。',
      });
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '生成授权链接失败' });
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyAuthUrl() {
    if (!authUrl) return;
    try {
      await copyTextToClipboard(authUrl);
      setFeedback({ tone: 'ok', text: '已复制授权链接，请粘贴到指定邮箱浏览器打开' });
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '复制失败' });
    }
  }

  async function handleCompleteManual() {
    if (!manualCode.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
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
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '手动验证失败' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await api.googleSheetsRevokeAuth();
      setAuth(next);
      setAuthUrl(null);
      setFeedback({ tone: 'ok', text: '已断开 Google 授权' });
      onChanged?.();
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '断开失败' });
    } finally {
      setBusy(false);
    }
  }

  async function handleClearTokens() {
    setGyazoTokensText('');
    setMaskTokensView(false);
    const nextDraft: EditableImageHostDraft = {
      preferredHost,
      defaultMachineName: machineName.trim() || '电脑1号',
      gyazoTokens: [],
    };
    latestDraftRef.current = nextDraft;
    await flushSaveDraft(nextDraft);
    setFeedback({ tone: 'ok', text: '已清空 Gyazo Token，将自动使用 Google 网盘兜底' });
  }

  async function handleTestImageHost() {
    setTestingHost(true);
    setFeedback(null);
    setTestImageUrl(null);
    try {
      await flushSaveDraft();
      const res = await api.googleSheetsTestImageHost();
      setTestImageUrl(res.remoteUrl);
      const label =
        res.host === 'gyazo'
          ? res.tokenIndex !== undefined && (res.tokenCount ?? 0) > 1
            ? `Gyazo · Token #${res.tokenIndex + 1}/${res.tokenCount}`
            : 'Gyazo'
          : res.fallbackFromGyazo
            ? 'Gyazo 失败，已自动切换 Google 网盘兜底'
            : 'Google 网盘自建';
      setFeedback({
        tone: 'ok',
        text: `图床上传测试成功（${label}）`,
      });
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : '测试上传失败' });
    } finally {
      setTestingHost(false);
    }
  }

  if (loading) {
    return <p className="hint">正在读取 Google 表格授权配置…</p>;
  }

  return (
    <div className="gs-auth-panel">
      {feedback && (
        <div className={'gs-banner ' + (feedback.tone === 'err' ? 'is-err' : 'is-ok')}>
          {feedback.text}
        </div>
      )}

      <section className="gs-auth-card">
        <div className="gs-auth-card-head">
          <div>
            <h3>1. Google 账号授权</h3>
            <p className="hint">
              选择或粘贴 OAuth JSON 后将自动生成并复制授权链接，直接粘贴到目标 Gmail
              浏览器打开即可完成授权。
            </p>
          </div>
          <span className={'pill ' + (auth?.authorized ? 'pill-ok' : 'pill-warn')}>
            {auth?.authorized
              ? `已授权${auth.authorizedEmail ? ` · ${auth.authorizedEmail}` : ''}`
              : '未授权'}
          </span>
        </div>

        <div className="gs-auth-step-row">
          <div className="gs-auth-meta">
            <strong>OAuth 凭据文件（credentials.json）</strong>
            <span className="hint">
              {auth?.hasCredentials
                ? `已载入：${auth.clientIdHint ?? 'Desktop OAuth Client'}`
                : '从 Google Cloud Console 下载「桌面应用」JSON，选中即自动生成并复制授权链接'}
            </span>
          </div>
          <div className="gs-auth-actions">
            <label className="btn btn-sm btn-primary gs-file-btn">
              选择 JSON 并生成链接
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(e) => void handleFileSelect(e)}
              />
            </label>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => setShowPasteCred((v) => !v)}
            >
              {showPasteCred ? '收起粘贴框' : '粘贴 JSON'}
            </button>
            {auth?.hasCredentials && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void handleStartAuth()}
              >
                {auth?.authorized ? '重新授权' : '重新生成链接'}
              </button>
            )}
            {auth?.authorized && (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() => setConfirmAction('revoke')}
              >
                断开授权
              </button>
            )}
          </div>
        </div>

        {showPasteCred && (
          <div className="gs-auth-paste-box">
            <textarea
              rows={4}
              placeholder='粘贴完整的 Google OAuth credentials.json 内容，例如 {"installed":{"client_id":...}}'
              value={credText}
              onChange={(e) => setCredText(e.target.value)}
            />
            <div className="gs-auth-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !credText.trim()}
                onClick={() => void handleImportPasted()}
              >
                导入并自动生成复制链接
              </button>
            </div>
          </div>
        )}

        {authUrl && (
          <div className="gs-auth-url-box">
            <div className="gs-auth-url-head">
              <strong>授权链接（已自动复制，等待浏览器回传…）</strong>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void handleCopyAuthUrl()}
              >
                再次复制
              </button>
            </div>
            <input type="text" readOnly value={authUrl} onFocus={(e) => e.currentTarget.select()} />
            <div className="gs-auth-url-foot">
              <span className="hint">
                直接粘贴到登录了目标 Gmail 的 Chrome 浏览器打开，点击同意后本软件会自动完成连接。
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setShowManualBox((v) => !v)}
              >
                {showManualBox ? '收起手动回填' : '跨机/手动回填'}
              </button>
            </div>
            {showManualBox && (
              <div className="gs-manual-code-row">
                <input
                  type="text"
                  placeholder="粘贴浏览器跳转后的完整 http://127.0.0.1:.../oauth2/callback?code=... 或授权码"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !manualCode.trim()}
                  onClick={() => void handleCompleteManual()}
                >
                  提交完成授权
                </button>
              </div>
            )}
          </div>
        )}

        {auth?.lastError && <p className="gs-inline-err">最近错误：{auth.lastError}</p>}
      </section>

      <section className="gs-auth-card">
        <div className="gs-auth-card-head">
          <div>
            <h3>2. 永久图床与本机标识</h3>
            <p className="hint">
              修改后自动立即保存，无需点保存按钮；支持填多个 Gyazo Token 自动轮询与失效切换。
            </p>
          </div>
          <div className="gs-auth-head-pills">
            {autoSaveState === 'saving' && (
              <span className="pill gs-autosave-pill is-saving">自动保存中…</span>
            )}
            {autoSaveState === 'saved' && (
              <span className="pill pill-ok gs-autosave-pill">已自动保存</span>
            )}
            {autoSaveState === 'error' && (
              <span className="pill gs-autosave-pill is-err" title={autoSaveError ?? undefined}>
                保存失败
              </span>
            )}
            <span className="pill">已缓存去重 {imageHost?.cachedImageCount ?? 0} 张</span>
          </div>
        </div>

        <div className="gs-form-grid">
          <label className="gs-field">
            <span>默认本机名称（发帖记录右侧顶贴列名）</span>
            <input
              type="text"
              maxLength={60}
              value={machineName}
              placeholder="例如：电脑1号"
              onChange={(e) => {
                const val = e.target.value;
                setMachineName(val);
                scheduleAutoSave(
                  {
                    preferredHost,
                    defaultMachineName: val.trim() || '电脑1号',
                    gyazoTokens: parsedTokens,
                  },
                  450,
                );
              }}
              onBlur={() => void flushSaveDraft()}
            />
          </label>

          <label className="gs-field">
            <span>图床托管策略</span>
            <select
              value={preferredHost}
              onChange={(e) => {
                const nextHost = e.target.value as SheetImageHostPreference;
                setPreferredHost(nextHost);
                scheduleAutoSave(
                  {
                    preferredHost: nextHost,
                    defaultMachineName: machineName.trim() || '电脑1号',
                    gyazoTokens: parsedTokens,
                  },
                  0,
                );
              }}
            >
              <option value="auto">自动（优先 Gyazo 轮询，全部失效自动切 Google 网盘）</option>
              <option value="gyazo">仅使用 Gyazo API</option>
              <option value="drive">仅使用 Google 网盘（0 额外配置）</option>
            </select>
          </label>

          <div className="gs-field gs-field-full">
            <div className="gs-token-label-bar">
              <span>
                Gyazo Access Token 轮询池（每行一个，修改后自动保存
                {parsedTokens.length > 1
                  ? ` · 已配置 ${parsedTokens.length} 个 · 自动轮询 + 失效切换`
                  : parsedTokens.length === 1
                    ? ' · 已配置 1 个'
                    : ' · 留空自动用 Google 网盘兜底'}
                ）
              </span>
              <div className="gs-token-mini-actions">
                {parsedTokens.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost gs-mini-btn"
                      onClick={() => setMaskTokensView((v) => !v)}
                    >
                      {maskTokensView ? '编辑明文' : '隐藏明文'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost gs-mini-btn"
                      disabled={testingHost}
                      onClick={() => setConfirmAction('clear-token')}
                    >
                      清空全部
                    </button>
                  </>
                )}
              </div>
            </div>

            {maskTokensView && parsedTokens.length > 0 ? (
              <div className="gs-token-masked-list">
                {parsedTokens.map((token, idx) => (
                  <span key={`${idx}-${token.slice(0, 4)}`} className="gs-token-masked-chip">
                    #{idx + 1} · {maskGyazoToken(token) ?? '••••••'}
                  </span>
                ))}
              </div>
            ) : (
              <textarea
                rows={Math.max(3, Math.min(6, parsedTokens.length + 1))}
                className="gs-token-textarea"
                spellCheck={false}
                placeholder={
                  '粘贴 1 个或多个 Gyazo Access Token，每行一个（输入或粘贴后自动立即保存）。\n支持多 Token 轮流上传，某个失效/限流时自动切到下一个。'
                }
                value={gyazoTokensText}
                onChange={(e) => {
                  const val = e.target.value;
                  setGyazoTokensText(val);
                  scheduleAutoSave(
                    {
                      preferredHost,
                      defaultMachineName: machineName.trim() || '电脑1号',
                      gyazoTokens: parseGyazoTokenList(val),
                    },
                    450,
                  );
                }}
                onBlur={() => void flushSaveDraft()}
              />
            )}
          </div>
        </div>

        <div className="gs-auth-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={testingHost || busy}
            onClick={() => void handleTestImageHost()}
          >
            {testingHost ? '测试上传中…' : '测试图床上传'}
          </button>
          {testImageUrl && (
            <span className="hint gs-test-url">
              测试直链：<code>{testImageUrl}</code>
            </span>
          )}
        </div>
      </section>

      {confirmAction === 'revoke' && (
        <ConfirmDialog
          title="确认断开 Google 账号授权"
          description="断开后所有已连接的 Google 表格将暂停自动同步、排贴与顶贴，直到重新完成 OAuth 授权。确定断开吗？"
          label="确认断开授权"
          onClose={() => setConfirmAction(null)}
          onConfirm={async () => {
            setConfirmAction(null);
            await handleRevoke();
          }}
        />
      )}
      {confirmAction === 'clear-token' && (
        <ConfirmDialog
          title="确认清空全部 Gyazo Token"
          description="清空后将自动回退至免配置的 Google 网盘图床（已上传缓存直链不受影响）。确定清空吗？"
          label="确认清空"
          onClose={() => setConfirmAction(null)}
          onConfirm={async () => {
            setConfirmAction(null);
            await handleClearTokens();
          }}
        />
      )}
    </div>
  );
}
