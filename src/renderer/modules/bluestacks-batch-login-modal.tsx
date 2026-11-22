import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
  maskLoginAccountLabel,
  parseBatchLoginText,
  type BluestacksBatchLoginItemStatus,
  type BluestacksInstance,
  type BluestacksLoginExistingPolicy,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import { ControlledNumberInput } from './shared/controlled-number-input.js';

interface BluestacksBatchLoginModalProps {
  state: BluestacksState;
  selected: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void;
  onChange: (next: BluestacksState) => void;
  onClose: () => void;
}

const STATUS_META: Record<
  BluestacksBatchLoginItemStatus,
  { label: string; color: string; bg: string }
> = {
  queued: { label: '排队中', color: '#475569', bg: 'rgba(100,116,139,0.12)' },
  running: { label: '执行中', color: '#1d4ed8', bg: 'rgba(59,130,246,0.14)' },
  succeeded: { label: '已登录', color: '#15803d', bg: 'rgba(34,197,94,0.14)' },
  skipped: { label: '已跳过', color: '#64748b', bg: 'rgba(148,163,184,0.16)' },
  verification: { label: '需验证', color: '#b45309', bg: 'rgba(245,158,11,0.16)' },
  restricted: { label: '受限/封禁', color: '#b91c1c', bg: 'rgba(239,68,68,0.14)' },
  failed: { label: '失败', color: '#b91c1c', bg: 'rgba(239,68,68,0.14)' },
  stopped: { label: '已停止', color: '#64748b', bg: 'rgba(148,163,184,0.16)' },
};

function instanceStateLabel(inst: BluestacksInstance): string {
  if (!isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight)) {
    return `横屏 ${inst.fbWidth}×${inst.fbHeight}`;
  }
  if (inst.accountState === 'logged-in') {
    return inst.accountName ? `已登录 (${inst.accountName})` : '已登录';
  }
  if (inst.accountState === 'missing-app') return '未装 FB Lite';
  if (inst.accountState === 'logged-out') return '未登录';
  if (inst.accountState === 'verification') return '需验证';
  if (inst.accountState === 'restricted') return '已受限';
  return inst.online ? '在线未检测' : '离线未检测';
}

export function BluestacksBatchLoginModal({
  state,
  selected,
  onSelect,
  onChange,
  onClose,
}: BluestacksBatchLoginModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchLogin = state.batchLogin ?? null;

  const [tab, setTab] = useState<'setup' | 'progress'>(() =>
    batchLogin?.running || (batchLogin && batchLogin.total > 0) ? 'progress' : 'setup',
  );
  const [rawText, setRawText] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(() =>
    Math.max(1, Math.min(5, state.bumperSettings.maxConcurrentProfiles || 3)),
  );
  const [ifAlreadyLoggedIn, setIfAlreadyLoggedIn] = useState<BluestacksLoginExistingPolicy>('skip');
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [autoInstallApk, setAutoInstallApk] = useState(true);
  const [saveLoginInfo, setSaveLoginInfo] = useState(true);
  const [closeOnFinish, setCloseOnFinish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    if (batchLogin?.running) {
      setTab('progress');
    }
  }, [batchLogin?.running]);

  const parsed = useMemo(() => parseBatchLoginText(rawText), [rawText]);

  const eligiblePortraitInstances = useMemo(() => {
    const picked = state.instances.filter(
      (i) => selected.has(i.id) && isBluestacksPortraitResolution(i.fbWidth, i.fbHeight),
    );
    return picked;
  }, [state.instances, selected]);

  const idlePortraitCandidates = useMemo(
    () =>
      state.instances.filter(
        (i) =>
          isBluestacksPortraitResolution(i.fbWidth, i.fbHeight) && i.accountState !== 'logged-in',
      ),
    [state.instances],
  );

  const selectedLandscapeCount = useMemo(
    () =>
      state.instances.filter(
        (i) => selected.has(i.id) && !isBluestacksPortraitResolution(i.fbWidth, i.fbHeight),
      ).length,
    [state.instances, selected],
  );

  const pairedRows = useMemo(() => {
    const count = Math.min(eligiblePortraitInstances.length, parsed.entries.length);
    return Array.from({ length: count }, (_, idx) => {
      const inst = eligiblePortraitInstances[idx];
      const cred = parsed.entries[idx];
      if (!inst || !cred) return null;
      let actionNote = '自动登录';
      if (inst.accountState === 'logged-in') {
        actionNote = ifAlreadyLoggedIn === 'skip' ? '已登录将跳过' : '清旧会话覆盖重登';
      } else if (inst.accountState === 'missing-app') {
        actionNote = autoInstallApk ? '自动装 APK + 登录' : '缺少 APK 将失败';
      } else if (!inst.online) {
        actionNote = autoLaunch ? '自动开机 + 登录' : '离线将跳过';
      }
      return { inst, cred, actionNote };
    }).filter((r): r is NonNullable<typeof r> => r !== null);
  }, [eligiblePortraitInstances, parsed.entries, ifAlreadyLoggedIn, autoInstallApk, autoLaunch]);

  const hasApkConfigured = Boolean(
    state.config.apkPath?.trim() || state.config.detectedApkPath?.trim(),
  );

  function selectAllIdlePortrait() {
    if (idlePortraitCandidates.length === 0) {
      setNotice('当前没有空闲或未登录的竖屏蓝蝶实例');
      return;
    }
    onSelect(new Set(idlePortraitCandidates.map((i) => i.id)));
    setNotice(`已自动勾选 ${idlePortraitCandidates.length} 台未登录/未检测竖屏蓝蝶`);
  }

  function handleImportFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (text.trim()) {
        setRawText(text);
        setNotice(`已读取文件「${file.name}」（仅驻留内存，不会落盘保存）`);
        setError('');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  async function handleStart() {
    if (busy || batchLogin?.running) return;
    if (parsed.errors.length > 0) {
      setError(`输入中存在 ${parsed.errors.length} 处格式错误，请先修正后再启动`);
      return;
    }
    if (pairedRows.length === 0) {
      setError('请先勾选至少 1 台竖屏蓝蝶实例，并粘贴至少 1 条有效账号密码');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.bluestacksAction('batch-login/start', {
        items: pairedRows.map((row) => ({
          instanceId: row.inst.id,
          account: row.cred.account,
          password: row.cred.password,
          ...(row.cred.totpSecret ? { totpSecret: row.cred.totpSecret } : {}),
        })),
        maxConcurrency,
        autoLaunch,
        autoInstallApk,
        ifAlreadyLoggedIn,
        saveLoginInfo,
        closeOnFinish,
      });
      // Immediately clear volatile credential textarea once dispatched to backend memory
      setRawText('');
      onChange(next);
      setTab('progress');
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动批量自动登录失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.bluestacksAction('batch-login/stop', {});
      onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '停止批量登录失败');
    } finally {
      setBusy(false);
    }
  }

  async function copyIssueReport() {
    if (!batchLogin) return;
    const issueRows = batchLogin.items.filter(
      (i) => i.status === 'verification' || i.status === 'restricted' || i.status === 'failed',
    );
    const lines = (issueRows.length > 0 ? issueRows : batchLogin.items).map(
      (i) =>
        `${i.instanceName} | ${i.maskedAccount} | ${STATUS_META[i.status].label} | ${i.stepText}`,
    );
    try {
      await copyTextToClipboard(lines.join('\n'));
      setNotice(`已复制 ${lines.length} 条掩码摘要（不含密码与密钥）`);
    } catch {
      setNotice('复制失败');
    }
  }

  function selectSucceededInstances() {
    if (!batchLogin) return;
    const ids = batchLogin.items.filter((i) => i.status === 'succeeded').map((i) => i.instanceId);
    if (ids.length === 0) return;
    onSelect(new Set(ids));
    setNotice(`已在左侧蓝蝶列表勾选全部 ${ids.length} 台登录成功实例`);
  }

  const pct =
    batchLogin && batchLogin.total > 0
      ? Math.round((batchLogin.completed / batchLogin.total) * 100)
      : 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      style={{ width: 'min(860px, 94vw)', maxWidth: 860, padding: 0 }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '86vh',
          background: 'var(--surface, #fff)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '16px 20px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>蓝蝶批量一键自动登录（支持 2FA）</h3>
            <p className="hint" style={{ margin: '3px 0 0', fontSize: 12 }}>
              账密与 2FA 密钥严格仅驻留内存并在单台完成后即刻擦除，绝不写入数据库或日志。
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {batchLogin && (
              <div className="segmented" style={{ margin: 0 }}>
                <button
                  type="button"
                  className={tab === 'setup' ? 'active' : ''}
                  disabled={batchLogin.running}
                  onClick={() => setTab('setup')}
                >
                  导入配对
                </button>
                <button
                  type="button"
                  className={tab === 'progress' ? 'active' : ''}
                  onClick={() => setTab('progress')}
                >
                  {batchLogin.running
                    ? `实时进度 ${batchLogin.completed}/${batchLogin.total}`
                    : `上次战报 (${batchLogin.succeeded}/${batchLogin.total})`}
                </button>
              </div>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label="关闭弹窗"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </header>

        <div
          style={{
            padding: '16px 20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {error && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.28)',
                color: '#b91c1c',
                fontSize: 12.5,
              }}
            >
              {error}
            </div>
          )}
          {notice && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.22)',
                color: '#1d4ed8',
                fontSize: 12.5,
              }}
            >
              {notice}
            </div>
          )}

          {tab === 'setup' ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'var(--surface-2, #f8fafc)',
                  border: '1px solid var(--line)',
                }}
              >
                <div style={{ fontSize: 12.5 }}>
                  <strong>目标竖屏蓝蝶：{eligiblePortraitInstances.length} 台</strong>
                  {selectedLandscapeCount > 0 && (
                    <span className="hint" style={{ marginLeft: 8 }}>
                      （已自动剔除 {selectedLandscapeCount} 台横屏实例）
                    </span>
                  )}
                  {eligiblePortraitInstances.length === 0 && (
                    <span className="hint" style={{ marginLeft: 8 }}>
                      请先在左侧勾选蓝蝶窗口，或点击右侧快捷选中
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={idlePortraitCandidates.length === 0}
                  onClick={selectAllIdlePortrait}
                >
                  自动勾选未登录竖屏蓝蝶 ({idlePortraitCandidates.length})
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                  }}
                >
                  <label style={{ fontSize: 13, fontWeight: 600 }}>
                    粘贴账号清单（支持多行 <code>账号:/密码:/totp:</code> 或{' '}
                    <code>账号|密码|2FA密钥</code> / Tab / CSV）
                  </label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".txt,.csv,.tsv"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        handleImportFile(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      导入 .txt / .csv
                    </button>
                    {rawText && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setRawText('');
                          setError('');
                        }}
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  value={rawText}
                  onChange={(e) => {
                    setRawText(e.target.value);
                    setError('');
                  }}
                  rows={6}
                  spellCheck={false}
                  placeholder={`示例 1（多行标签，密码含冒号/逗号也不受影响）：\n账号: demo@example.com\n密码: My:Pass,123\ntotp: JBSW Y3DP EHPK 3PXP\n\n示例 2（单行管道或 Excel 复制粘贴）：\ndemo2@example.com|Pass456|JBSWY3DPEHPK3PXP`}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 12,
                    lineHeight: 1.5,
                    resize: 'vertical',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    fontSize: 12,
                  }}
                >
                  <span className="pill">已解析有效账号 {parsed.entries.length} 条</span>
                  <span className="pill">
                    含 2FA 密钥 {parsed.entries.filter((e) => Boolean(e.totpSecret)).length} 条
                  </span>
                  <span className="pill">本次可配对 {pairedRows.length} 台</span>
                  {parsed.entries.length > eligiblePortraitInstances.length &&
                    eligiblePortraitInstances.length > 0 && (
                      <span className="hint">
                        另有 {parsed.entries.length - eligiblePortraitInstances.length}{' '}
                        条账号超出已选蓝蝶数量，将仅执行前 {pairedRows.length} 条
                      </span>
                    )}
                </div>
                {parsed.errors.length > 0 && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'rgba(239,68,68,0.07)',
                      color: '#b91c1c',
                      fontSize: 12,
                      maxHeight: 90,
                      overflowY: 'auto',
                    }}
                  >
                    {parsed.errors.slice(0, 8).map((errItem) => (
                      <div key={`${errItem.lineNumber}-${errItem.reason}`}>
                        第 {errItem.lineNumber} 行：{errItem.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 8,
                  background: 'var(--surface-2, #f8fafc)',
                  border: '1px solid var(--line)',
                  fontSize: 12.5,
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>并发台数</span>
                  <ControlledNumberInput
                    ariaLabel="批量登录并发台数"
                    min={1}
                    max={10}
                    defaultValue={3}
                    value={maxConcurrency}
                    onChange={setMaxConcurrency}
                  />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>已登录处理</span>
                  <select
                    value={ifAlreadyLoggedIn}
                    onChange={(e) =>
                      setIfAlreadyLoggedIn(
                        e.target.value === 'clear-and-relogin' ? 'clear-and-relogin' : 'skip',
                      )
                    }
                    style={{ height: 30, borderRadius: 6, padding: '0 8px' }}
                  >
                    <option value="skip">跳过已登录（推荐）</option>
                    <option value="clear-and-relogin">清除旧会话并覆盖重登</option>
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={autoLaunch}
                    onChange={(e) => setAutoLaunch(e.target.checked)}
                  />
                  <span>自动拉起离线蓝蝶</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={autoInstallApk}
                    onChange={(e) => setAutoInstallApk(e.target.checked)}
                  />
                  <span>缺 FB Lite 自动安装 APK</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={saveLoginInfo}
                    onChange={(e) => setSaveLoginInfo(e.target.checked)}
                  />
                  <span>允许 FB Lite 保存登录信息</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={closeOnFinish}
                    onChange={(e) => setCloseOnFinish(e.target.checked)}
                  />
                  <span>单台完成后自动关窗释放内存</span>
                </label>
              </div>

              {autoInstallApk && !hasApkConfigured && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'rgba(245,158,11,0.1)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    color: '#92400e',
                    fontSize: 12,
                  }}
                >
                  提示：尚未在「蓝蝶路径与 APK 设置」中配置 FB Lite 安装包路径。若所选蓝蝶未装 FB
                  Lite，请先指定本地 .apk 文件。
                </div>
              )}

              {pairedRows.length > 0 && (
                <div
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 12px',
                      background: 'var(--surface-2, #f8fafc)',
                      borderBottom: '1px solid var(--line)',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    1 对 1 分配预览（共 {pairedRows.length} 台 · 密码与密钥已自动脱敏）
                  </div>
                  <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                    <table
                      style={{
                        width: '100%',
                        borderCollapse: 'collapse',
                        fontSize: 12,
                      }}
                    >
                      <thead>
                        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                          <th style={{ padding: '6px 10px', width: 34 }}>#</th>
                          <th style={{ padding: '6px 10px' }}>蓝蝶窗口</th>
                          <th style={{ padding: '6px 10px' }}>当前状态</th>
                          <th style={{ padding: '6px 10px' }}>待登录账号</th>
                          <th style={{ padding: '6px 10px', width: 72 }}>2FA</th>
                          <th style={{ padding: '6px 10px' }}>执行策略</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pairedRows.map((row, idx) => (
                          <tr
                            key={row.inst.id}
                            style={{ borderBottom: '1px solid var(--line-soft, #f1f5f9)' }}
                          >
                            <td style={{ padding: '6px 10px', color: 'var(--muted)' }}>
                              {idx + 1}
                            </td>
                            <td style={{ padding: '6px 10px', fontWeight: 500 }}>
                              {bluestacksDisplayTitle(row.inst)}
                            </td>
                            <td style={{ padding: '6px 10px', color: 'var(--muted)' }}>
                              {instanceStateLabel(row.inst)}
                            </td>
                            <td style={{ padding: '6px 10px', fontFamily: 'monospace' }}>
                              {maskLoginAccountLabel(row.cred.account)}
                            </td>
                            <td style={{ padding: '6px 10px' }}>
                              {row.cred.totpSecret ? (
                                <span
                                  style={{
                                    padding: '1px 6px',
                                    borderRadius: 99,
                                    background: 'rgba(34,197,94,0.14)',
                                    color: '#15803d',
                                    fontSize: 11,
                                  }}
                                >
                                  已配置
                                </span>
                              ) : (
                                <span className="hint">无</span>
                              )}
                            </td>
                            <td style={{ padding: '6px 10px' }}>{row.actionNote}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : batchLogin ? (
            <>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 8,
                  background: 'var(--surface-2, #f8fafc)',
                  border: '1px solid var(--line)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <strong style={{ fontSize: 13 }}>{batchLogin.statusText}</strong>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{pct}%</span>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 99,
                    background: 'rgba(148,163,184,0.22)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: batchLogin.running ? 'var(--accent, #2563eb)' : '#16a34a',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <span className="pill">总计 {batchLogin.total}</span>
                  <span className="pill" style={{ color: '#15803d' }}>
                    成功 {batchLogin.succeeded}
                  </span>
                  <span className="pill">跳过 {batchLogin.skipped}</span>
                  <span className="pill" style={{ color: '#b45309' }}>
                    需验证 {batchLogin.verification}
                  </span>
                  <span className="pill" style={{ color: '#b91c1c' }}>
                    受限 {batchLogin.restricted}
                  </span>
                  <span className="pill" style={{ color: '#b91c1c' }}>
                    失败 {batchLogin.failed}
                  </span>
                </div>
              </div>

              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr
                        style={{
                          textAlign: 'left',
                          background: 'var(--surface-2, #f8fafc)',
                          borderBottom: '1px solid var(--line)',
                        }}
                      >
                        <th style={{ padding: '7px 10px' }}>蓝蝶窗口</th>
                        <th style={{ padding: '7px 10px' }}>掩码账号</th>
                        <th style={{ padding: '7px 10px', width: 84 }}>状态</th>
                        <th style={{ padding: '7px 10px' }}>实时步骤 / 识别结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchLogin.items.map((item) => {
                        const meta = STATUS_META[item.status];
                        return (
                          <tr
                            key={item.instanceId}
                            style={{ borderBottom: '1px solid var(--line-soft, #f1f5f9)' }}
                          >
                            <td style={{ padding: '7px 10px', fontWeight: 500 }}>
                              {item.instanceName}
                            </td>
                            <td style={{ padding: '7px 10px', fontFamily: 'monospace' }}>
                              {item.maskedAccount}
                              {item.hasTotp && (
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 10,
                                    padding: '1px 5px',
                                    borderRadius: 99,
                                    background: 'rgba(59,130,246,0.12)',
                                    color: '#1d4ed8',
                                  }}
                                >
                                  2FA
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '7px 10px' }}>
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '2px 7px',
                                  borderRadius: 99,
                                  fontSize: 11,
                                  fontWeight: 500,
                                  color: meta.color,
                                  background: meta.bg,
                                }}
                              >
                                {meta.label}
                              </span>
                            </td>
                            <td style={{ padding: '7px 10px', color: 'var(--ink-2, #334155)' }}>
                              {item.stepText}
                              {item.accountName && item.status === 'succeeded' && (
                                <span className="hint" style={{ marginLeft: 6 }}>
                                  ({item.accountName}
                                  {item.numericAccountId ? ` · ${item.numericAccountId}` : ''})
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="hint" style={{ padding: 24, textAlign: 'center' }}>
              暂无批量登录记录
            </div>
          )}
        </div>

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            padding: '12px 20px',
            borderTop: '1px solid var(--line)',
            background: 'var(--surface-2, #f8fafc)',
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tab === 'progress' && batchLogin && !batchLogin.running && (
              <>
                {batchLogin.succeeded > 0 && (
                  <button type="button" className="btn btn-sm" onClick={selectSucceededInstances}>
                    勾选成功实例 ({batchLogin.succeeded})
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => void copyIssueReport()}>
                  复制脱敏战报
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setTab('setup')}>
                  新一轮批量登录
                </button>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {tab === 'setup' ? (
              <>
                <button type="button" className="btn" onClick={onClose}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    busy ||
                    Boolean(batchLogin?.running) ||
                    pairedRows.length === 0 ||
                    parsed.errors.length > 0
                  }
                  onClick={() => void handleStart()}
                >
                  {busy ? '正在启动…' : `开始批量登录 (${pairedRows.length} 台)`}
                </button>
              </>
            ) : batchLogin?.running ? (
              <>
                <button type="button" className="btn" onClick={onClose}>
                  后台运行
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => void handleStop()}
                >
                  {busy ? '正在停止…' : '停止批量登录'}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                完成
              </button>
            )}
          </div>
        </footer>
      </div>
    </dialog>
  );
}
