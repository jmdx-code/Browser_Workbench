import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
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
import { UI_CARD, UI_INPUT_SM, UI_MUTED, UI_ROW, UI_TEXTAREA } from '../../ui/primitives.js';
import { Btn, errMsg, InFld, NoticeBanner, SelFld } from '../shared/module-ui.js';
import { clearGoogleSheetsGridCache } from './google-sheets-page.js';
interface Draft {
  preferredHost: SheetImageHostPreference;
  defaultMachineName: string;
  gyazoTokens: string[];
}
type StepId = 1 | 2 | 3;
type Tone = 'ok' | 'warn' | 'info' | 'neutral';
const TONE: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  info: 'bg-sky-50 text-sky-700',
  neutral: 'bg-slate-100 text-slate-600',
};
const ROW = 'flex flex-wrap items-center justify-between gap-2';
const FILE_LBL =
  'relative inline-flex h-7 cursor-pointer items-center rounded-md bg-[var(--brand)] px-2.5 text-xs font-semibold text-white hover:bg-[var(--brand-hover)]';
const CHIP = 'rounded border border-[var(--line)] bg-white px-2 py-0.5 font-mono text-[11px]';
const CFM = {
  revoke: [
    '确认断开 Google 账号授权',
    '断开后将暂停自动同步、排贴与顶贴，确定断开吗？',
    '确认断开授权',
  ],
  'clear-token': [
    '确认清空全部 Gyazo Token',
    '清空后将回退至 Google 网盘图床，确定清空吗？',
    '确认清空',
  ],
} as const;
const sameDraft = (a: Draft | null, b: Draft) =>
  a !== null &&
  a.preferredHost === b.preferredHost &&
  a.defaultMachineName === b.defaultMachineName &&
  a.gyazoTokens.length === b.gyazoTokens.length &&
  a.gyazoTokens.every((t, i) => t === b.gyazoTokens[i]);
function Step(p: {
  id: StepId;
  title: string;
  badge: string;
  tone: Tone;
  open: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`${UI_CARD} overflow-hidden`}>
      <button
        type="button"
        aria-expanded={p.open}
        onClick={p.toggle}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50"
      >
        <span className="text-xs font-semibold text-[var(--text)]">{`${p.id}. ${p.title}`}</span>
        <span className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[p.tone]}`}>
            {p.badge}
          </span>
          <span className="text-[11px] text-[var(--muted)]">{p.open ? '收起' : '展开'}</span>
        </span>
      </button>
      <div className={p.open ? 'flex flex-col gap-2 border-t border-[var(--line)] p-3' : 'hidden'}>
        {p.children}
      </div>
    </section>
  );
}
export function GoogleSheetsAuthPanel({ onChanged }: { onChanged?: () => void }) {
  const [auth, setAuth] = useState<GoogleAuthStatus | null>(null);
  const [hostStat, setHostStat] = useState<SheetImageHostStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [ui, setUi] = useState({
    busy: false,
    testing: false,
    paste: false,
    manual: false,
    mask: false,
  });
  const [steps, setSteps] = useState<Record<StepId, boolean>>({ 1: true, 2: false, 3: false });
  const [fb, setFb] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [cred, setCred] = useState('');
  const [code, setCode] = useState('');
  const [form, setForm] = useState({
    host: 'auto' as SheetImageHostPreference,
    machine: '电脑1号',
    tokens: '',
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [cfmKey, setCfmKey] = useState<'revoke' | 'clear-token' | null>(null);
  const refs = useRef({
    poll: false,
    init: false,
    mounted: true,
    saved: null as Draft | null,
    latest: { preferredHost: 'auto', defaultMachineName: '电脑1号', gyazoTokens: [] } as Draft,
    timer: null as ReturnType<typeof setTimeout> | null,
  });
  const ok = useCallback((text: string) => setFb({ tone: 'ok', text }), []);
  const fail = useCallback(
    (e: unknown, def: string) => setFb({ tone: 'err', text: errMsg(e, def) }),
    [],
  );
  const tokens = useMemo(() => parseGyazoTokenList(form.tokens), [form.tokens]);
  const toDraft = (f = form): Draft => ({
    preferredHost: f.host,
    defaultMachineName: f.machine.trim() || '电脑1号',
    gyazoTokens: parseGyazoTokenList(f.tokens),
  });
  refs.current.latest = toDraft();
  const saveNow = useCallback(
    async (override?: Draft) => {
      const r = refs.current;
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      const target = override ?? r.latest;
      if (!r.init || sameDraft(r.saved, target)) return;
      r.saved = target;
      if (r.mounted) setSaveState('saving');
      try {
        const next = await api.googleSheetsSaveImageHost({
          preferredHost: target.preferredHost,
          defaultMachineName: target.defaultMachineName,
          gyazoAccessTokens: target.gyazoTokens,
        });
        if (r.mounted) {
          setHostStat(next);
          setSaveState('saved');
          onChanged?.();
        }
      } catch (e) {
        r.saved = null;
        if (r.mounted) {
          setSaveState('error');
          fail(e, '自动保存失败');
        }
      }
    },
    [fail, onChanged],
  );
  const queueDraft = (nf: typeof form, ms = 450) => {
    setForm(nf);
    const next = toDraft(nf),
      r = refs.current;
    r.latest = next;
    if (!r.init || sameDraft(r.saved, next)) return;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    setSaveState('saving');
    if (ms <= 0) void saveNow(next);
    else r.timer = setTimeout(() => void saveNow(next), ms);
  };
  useEffect(() => {
    const r = refs.current;
    r.mounted = true;
    void Promise.all([
      api.googleSheetsOverview(),
      api.googleSheetsImageHostTokens().catch(() => ({ tokens: [] as string[] })),
    ])
      .then(([ov, tok]) => {
        if (!r.mounted) return;
        const m = ov.imageHost.defaultMachineName || '电脑1号',
          t = parseGyazoTokenList(tok.tokens),
          snap: Draft = {
            preferredHost: ov.imageHost.preferredHost,
            defaultMachineName: m,
            gyazoTokens: t,
          };
        setAuth(ov.auth);
        setHostStat(ov.imageHost);
        setSteps({
          1: !ov.auth.hasCredentials,
          2: ov.auth.hasCredentials && !ov.auth.authorized,
          3: ov.auth.authorized,
        });
        setForm({ host: ov.imageHost.preferredHost, machine: m, tokens: t.join('\n') });
        r.saved = snap;
        r.latest = snap;
        r.init = true;
      })
      .catch((e) => r.mounted && fail(e, '读取 Google 授权配置失败'))
      .finally(() => r.mounted && setLoading(false));
    return () => {
      r.mounted = false;
      if (r.timer) clearTimeout(r.timer);
      if (r.init && !sameDraft(r.saved, r.latest)) void saveNow(r.latest);
    };
  }, [fail, saveNow]);
  const authUrl = auth?.pendingAuthUrl ?? null;
  useEffect(() => {
    if (!authUrl || auth?.authorized) return;
    const t = setInterval(() => {
      if (refs.current.poll) return;
      refs.current.poll = true;
      void api
        .googleSheetsOverview()
        .then((ov) => {
          if (!refs.current.mounted) return;
          setAuth(ov.auth);
          setHostStat(ov.imageHost);
          if (ov.auth.authorized) {
            setSteps({ 1: false, 2: false, 3: true });
            ok(`授权成功：${ov.auth.authorizedEmail ?? 'Google 账号已连接'}`);
            onChanged?.();
          }
        })
        .catch(() => {})
        .finally(() => {
          refs.current.poll = false;
        });
    }, 2500);
    return () => clearInterval(t);
  }, [authUrl, auth?.authorized, ok, onChanged]);
  const runBusy = async (work: () => Promise<void>, def: string) => {
    setUi((s) => ({ ...s, busy: true }));
    setFb(null);
    try {
      await work();
    } catch (e) {
      fail(e, def);
    } finally {
      setUi((s) => ({ ...s, busy: false }));
    }
  };
  const startAndCopy = async (prefix?: string) => {
    const res = await api.googleSheetsStartAuth();
    setAuth({ ...res.status, pendingAuthUrl: res.authUrl });
    setSteps((s) => ({ ...s, 1: false, 2: true }));
    const copied = await copyTextToClipboard(res.authUrl).then(
      () => true,
      () => false,
    );
    const tail = copied
      ? '已自动生成并复制授权链接！请粘贴到目标 Gmail 浏览器打开并同意授权。'
      : '已生成授权链接，请点击「再次复制」到目标 Gmail 浏览器打开。';
    ok(prefix ? `${prefix}，${tail}` : tail);
  };
  const importAndStart = async (raw: string, label: string) => {
    setAuth(await api.googleSheetsImportCredentials(raw));
    onChanged?.();
    await startAndCopy(label);
  };
  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f)
      void runBusy(
        async () => importAndStart(await f.text(), `已导入授权文件（${f.name}）`),
        '导入失败',
      );
  };
  const onTestHost = async () => {
    setUi((s) => ({ ...s, testing: true }));
    setFb(null);
    setTestUrl(null);
    try {
      await saveNow();
      const res = await api.googleSheetsTestImageHost();
      setTestUrl(res.remoteUrl);
      const lbl =
        res.host === 'gyazo'
          ? res.tokenIndex !== undefined && (res.tokenCount ?? 0) > 1
            ? `Gyazo · Token #${res.tokenIndex + 1}/${res.tokenCount}`
            : 'Gyazo'
          : res.fallbackFromGyazo
            ? 'Gyazo 失败，已自动切换 Google 网盘兜底'
            : 'Google 网盘自建';
      ok(`图床上传测试成功（${lbl}）`);
    } catch (e) {
      fail(e, '测试上传失败');
    } finally {
      setUi((s) => ({ ...s, testing: false }));
    }
  };
  const onConfirm = () => {
    if (cfmKey === 'revoke') {
      return void runBusy(async () => {
        setCfmKey(null);
        setAuth(await api.googleSheetsRevokeAuth());
        clearGoogleSheetsGridCache();
        setSteps({ 1: false, 2: true, 3: false });
        ok('已断开 Google 授权');
        onChanged?.();
      }, '断开失败');
    }
    setCfmKey(null);
    const nf = { ...form, tokens: '' };
    setForm(nf);
    setUi((s) => ({ ...s, mask: false }));
    void saveNow(toDraft(nf)).then(() => ok('已清空 Gyazo Token，将自动使用 Google 网盘兜底'));
  };
  if (loading) return <p className={UI_MUTED}>正在读取 Google 表格授权配置…</p>;
  const togStep = (s: StepId) => setSteps((p) => ({ ...p, [s]: !p[s] }));
  const togUi = (k: 'paste' | 'manual' | 'mask') => setUi((p) => ({ ...p, [k]: !p[k] }));
  const cached = hostStat?.cachedImageCount ?? 0;
  const step3Bdg =
    saveState === 'saving'
      ? '自动保存中…'
      : saveState === 'error'
        ? '保存失败'
        : saveState === 'saved'
          ? `已自动保存 · 缓存 ${cached}`
          : `已缓存去重 ${cached} 张`;
  const tokHint =
    tokens.length > 1
      ? ` · 已配置 ${tokens.length} 个 · 自动轮询`
      : tokens.length === 1
        ? ' · 已配置 1 个'
        : ' · 留空用网盘兜底';
  const authBdg = auth?.authorized
    ? `已授权${auth.authorizedEmail ? ` · ${auth.authorizedEmail}` : ''}`
    : authUrl
      ? '等待回传…'
      : '未授权';
  const cfm = cfmKey ? CFM[cfmKey] : null;
  const doPaste = () =>
    void runBusy(async () => {
      await importAndStart(cred, '已保存凭据');
      setCred('');
      togUi('paste');
    }, '保存失败');
  const doManual = () =>
    void runBusy(async () => {
      const next = await api.googleSheetsCompleteManualAuth(code);
      setAuth(next);
      setCode('');
      togUi('manual');
      setSteps({ 1: false, 2: false, 3: true });
      ok(`授权成功：${next.authorizedEmail ?? 'Google 账号已连接'}`);
      onChanged?.();
    }, '手动验证失败');
  const doCopy = () =>
    authUrl &&
    void copyTextToClipboard(authUrl).then(
      () => ok('已复制授权链接'),
      (e) => fail(e, '复制失败'),
    );
  return (
    <div className="flex flex-col gap-2">
      {fb && <NoticeBanner tone={fb.tone}>{fb.text}</NoticeBanner>}
      <Step
        id={1}
        title="导入 OAuth 凭证"
        badge={auth?.hasCredentials ? (auth.clientIdHint ?? '已载入') : '未导入'}
        tone={auth?.hasCredentials ? 'ok' : 'warn'}
        open={steps[1]}
        toggle={() => togStep(1)}
      >
        <div className={ROW}>
          <span className={UI_MUTED}>
            选择「桌面应用」credentials.json 自动导入并复制授权链接。
          </span>
          <div className="flex items-center gap-2">
            <label className={FILE_LBL}>
              选择 JSON 并生成链接
              <input
                type="file"
                accept=".json,application/json"
                disabled={ui.busy}
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={onPickFile}
              />
            </label>
            <Btn v="ghost" disabled={ui.busy} onClick={() => togUi('paste')}>
              {ui.paste ? '收起粘贴' : '粘贴 JSON'}
            </Btn>
          </div>
        </div>
        {ui.paste && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--line)] bg-slate-50 p-2">
            <textarea
              rows={3}
              className="w-full rounded border border-[var(--line-strong)] bg-white p-2 font-mono text-[11px]"
              placeholder='粘贴 credentials.json 内容，例如 {"installed":{"client_id":...}}'
              value={cred}
              onChange={(e) => setCred(e.target.value)}
            />
            <Btn v="primary" disabled={ui.busy || !cred.trim()} onClick={doPaste}>
              导入并自动生成复制链接
            </Btn>
          </div>
        )}
      </Step>
      <Step
        id={2}
        title="完成 Google 授权"
        badge={authBdg}
        tone={auth?.authorized ? 'ok' : authUrl ? 'info' : 'warn'}
        open={steps[2]}
        toggle={() => togStep(2)}
      >
        <div className={ROW}>
          <span className={UI_MUTED}>
            {auth?.hasCredentials
              ? '将链接粘贴到目标 Gmail 的 Chrome 打开并同意授权。'
              : '请先在第 1 步导入 OAuth 凭据。'}
          </span>
          <div className="flex items-center gap-2">
            {auth?.hasCredentials && (
              <Btn
                disabled={ui.busy}
                onClick={() => void runBusy(() => startAndCopy(), '生成授权链接失败')}
              >
                {auth.authorized ? '重新授权' : '生成/刷新链接'}
              </Btn>
            )}
            {auth?.authorized && (
              <Btn v="danger" disabled={ui.busy} onClick={() => setCfmKey('revoke')}>
                断开授权
              </Btn>
            )}
          </div>
        </div>
        {authUrl && (
          <div className="flex flex-col gap-2 rounded-md border border-sky-200 bg-sky-50 p-2 text-xs">
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={authUrl}
                className={`${UI_INPUT_SM} min-w-0 flex-1 font-mono text-[11px]`}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Btn v="primary" onClick={doCopy}>
                再次复制
              </Btn>
              <Btn v="ghost" onClick={() => togUi('manual')}>
                {ui.manual ? '收起回填' : '手动回填'}
              </Btn>
            </div>
            {ui.manual && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className={`${UI_INPUT_SM} min-w-0 flex-1`}
                  placeholder="粘贴回调 URL 或授权码"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Btn v="primary" disabled={ui.busy || !code.trim()} onClick={doManual}>
                  提交完成授权
                </Btn>
              </div>
            )}
          </div>
        )}
        {auth?.lastError && (
          <p className="m-0 text-xs text-rose-700">{`最近错误：${auth.lastError}`}</p>
        )}
      </Step>
      <Step
        id={3}
        title="图床测试"
        badge={step3Bdg}
        tone={saveState === 'error' ? 'warn' : saveState === 'saved' ? 'ok' : 'neutral'}
        open={steps[3]}
        toggle={() => togStep(3)}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InFld
            label="默认本机名称（发帖记录顶贴列名）"
            maxLength={60}
            value={form.machine}
            placeholder="例如：电脑1号"
            onVal={(v) => queueDraft({ ...form, machine: v })}
            onBlur={() => void saveNow()}
          />
          <SelFld
            label="图床托管策略"
            value={form.host}
            onVal={(v) => queueDraft({ ...form, host: v as SheetImageHostPreference }, 0)}
          >
            <option value="auto">自动（优先 Gyazo，失效切网盘）</option>
            <option value="gyazo">仅 Gyazo 图床</option>
            <option value="drive">仅 Google 网盘</option>
          </SelFld>
          <div className="flex flex-col gap-1 text-xs font-medium text-[var(--text-2)] sm:col-span-2">
            <div className={ROW}>
              <span>{`Gyazo Token 轮询池（自动保存${tokHint}）`}</span>
              {tokens.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <Btn v="ghost" className="h-6 px-2 text-[11px]" onClick={() => togUi('mask')}>
                    {ui.mask ? '编辑明文' : '隐藏明文'}
                  </Btn>
                  <Btn
                    v="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={ui.testing}
                    onClick={() => setCfmKey('clear-token')}
                  >
                    清空全部
                  </Btn>
                </span>
              )}
            </div>
            {ui.mask && tokens.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 rounded-md border border-[var(--line)] bg-slate-50 p-2">
                {tokens.map((t, i) => (
                  <span
                    key={`${i}-${t.slice(0, 4)}`}
                    className={CHIP}
                  >{`#${i + 1} · ${maskGyazoToken(t) ?? '••••••'}`}</span>
                ))}
              </div>
            ) : (
              <textarea
                rows={Math.max(2, Math.min(5, tokens.length + 1))}
                className={`${UI_TEXTAREA} gs-token-textarea font-mono text-[11px]`}
                spellCheck={false}
                placeholder="每行一个 Gyazo Access Token（修改后自动保存）。"
                value={form.tokens}
                onChange={(e) => queueDraft({ ...form, tokens: e.target.value })}
                onBlur={() => void saveNow()}
              />
            )}
          </div>
        </div>
        <div className={UI_ROW}>
          <Btn disabled={ui.testing || ui.busy} onClick={() => void onTestHost()}>
            {ui.testing ? '测试上传中…' : '测试图床上传'}
          </Btn>
          {testUrl && (
            <span className={`${UI_MUTED} max-w-[420px] truncate text-[11px]`}>
              测试直链：<code>{testUrl}</code>
            </span>
          )}
        </div>
      </Step>
      {cfm && (
        <ConfirmDialog
          title={cfm[0]}
          description={cfm[1]}
          label={cfm[2]}
          onClose={() => setCfmKey(null)}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}
