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
import { UI_CARD, UI_MUTED, UI_ROW_BT, UI_SELECT_SM, UI_TEXTAREA } from '../ui/primitives.js';
import {
  BATCH_RESULT_PILL_CLS,
  BatchStatusPill,
  BluestacksBatchResultList,
  type BatchTone,
} from './bluestacks-batch-result-list.js';
import {
  Btn,
  Chk,
  CtrlNum,
  DataTbl,
  NativeModalShell,
  SegTabs,
  useBusyTask,
} from './shared/module-ui.js';
const STATUS_META: Record<BluestacksBatchLoginItemStatus, [string, BatchTone]> = {
  queued: ['排队中', 'slate'],
  running: ['执行中', 'blue'],
  succeeded: ['已登录', 'green'],
  skipped: ['已跳过', 'muted'],
  verification: ['需验证', 'amber'],
  restricted: ['受限/封禁', 'red'],
  failed: ['失败', 'red'],
  stopped: ['已停止', 'muted'],
};
const STATE_LABELS: Record<string, string> = {
  'missing-app': '未装 FB Lite',
  'logged-out': '未登录',
  verification: '需验证',
  restricted: '已受限',
};
function instanceStateLabel(i: BluestacksInstance): string {
  if (!isBluestacksPortraitResolution(i.fbWidth, i.fbHeight))
    return `横屏 ${i.fbWidth}×${i.fbHeight}`;
  if (i.accountState === 'logged-in') return i.accountName ? `已登录 (${i.accountName})` : '已登录';
  return STATE_LABELS[i.accountState] ?? (i.online ? '在线未检测' : '离线未检测');
}
function batchActionNote(
  inst: BluestacksInstance,
  policy: BluestacksLoginExistingPolicy,
  autoInstall: boolean,
  autoLaunch: boolean,
): string {
  if (inst.accountState === 'logged-in')
    return policy === 'skip' ? '已登录将跳过' : '清旧会话覆盖重登';
  if (inst.accountState === 'missing-app')
    return autoInstall ? '自动装 APK + 登录' : '缺少 APK 将失败';
  return inst.online ? '自动登录' : autoLaunch ? '自动开机 + 登录' : '离线将跳过';
}
export function BluestacksBatchLoginModal({
  state,
  selected,
  onSelect,
  onChange,
  onClose,
}: {
  state: BluestacksState;
  selected: ReadonlySet<string>;
  onSelect: (next: Set<string>) => void;
  onChange: (next: BluestacksState) => void;
  onClose: () => void;
}) {
  const batchLogin = state.batchLogin ?? null;
  const [tab, setTab] = useState<'setup' | 'progress'>(() =>
    batchLogin?.running || (batchLogin && batchLogin.total > 0 && selected.size === 0)
      ? 'progress'
      : 'setup',
  );
  const [rawText, setRawText] = useState('');
  const [opts, setOpts] = useState(() => ({
    maxConcurrency: Math.max(1, Math.min(5, state.bumperSettings.maxConcurrentProfiles || 3)),
    ifAlreadyLoggedIn: 'skip' as BluestacksLoginExistingPolicy,
    autoLaunch: true,
    autoInstallApk: true,
    saveLoginInfo: true,
    closeOnFinish: true,
  }));
  const { busy, error, notice, setError, setNotice, run } = useBusyTask();
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (batchLogin?.running) setTab('progress');
  }, [batchLogin?.running]);
  const parsed = useMemo(() => parseBatchLoginText(rawText), [rawText]);
  const eligiblePortrait = useMemo(
    () =>
      state.instances.filter(
        (i) => selected.has(i.id) && isBluestacksPortraitResolution(i.fbWidth, i.fbHeight),
      ),
    [state.instances, selected],
  );
  const idlePortrait = useMemo(
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
  const pairedRows = useMemo(
    () =>
      Array.from({ length: Math.min(eligiblePortrait.length, parsed.entries.length) }, (_, idx) => {
        const inst = eligiblePortrait[idx],
          cred = parsed.entries[idx];
        return inst && cred
          ? {
              inst,
              cred,
              actionNote: batchActionNote(
                inst,
                opts.ifAlreadyLoggedIn,
                opts.autoInstallApk,
                opts.autoLaunch,
              ),
            }
          : null;
      }).filter((r): r is NonNullable<typeof r> => r !== null),
    [
      eligiblePortrait,
      parsed.entries,
      opts.ifAlreadyLoggedIn,
      opts.autoInstallApk,
      opts.autoLaunch,
    ],
  );
  function handleImportFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (!text.trim()) return;
      setRawText(text);
      setNotice(`已读取文件「${file.name}」（仅驻留内存，不会落盘保存）`);
      setError('');
    };
    reader.readAsText(file, 'utf-8');
  }
  function handleStart() {
    if (busy || batchLogin?.running) return;
    if (parsed.errors.length > 0)
      return setError(`输入中存在 ${parsed.errors.length} 处格式错误，请先修正后再启动`);
    if (!pairedRows.length)
      return setError('请先勾选至少 1 台竖屏蓝蝶实例，并粘贴至少 1 条有效账号密码');
    void run(async () => {
      const next = await api.bluestacksAction('batch-login/start', {
        items: pairedRows.map((r) => ({
          instanceId: r.inst.id,
          account: r.cred.account,
          password: r.cred.password,
          ...(r.cred.totpSecret ? { totpSecret: r.cred.totpSecret } : {}),
        })),
        ...opts,
      });
      setRawText('');
      onChange(next);
      setTab('progress');
    }, '启动批量自动登录失败');
  }
  const handleStop = () =>
    void run(
      async () => onChange(await api.bluestacksAction('batch-login/stop', {})),
      '停止批量登录失败',
    );
  async function copyIssueReport() {
    if (!batchLogin) return;
    const issueRows = batchLogin.items.filter((i) =>
      ['verification', 'restricted', 'failed'].includes(i.status),
    );
    const lines = (issueRows.length > 0 ? issueRows : batchLogin.items).map(
      (i) => `${i.instanceName} | ${i.maskedAccount} | ${STATUS_META[i.status][0]} | ${i.stepText}`,
    );
    await copyTextToClipboard(lines.join('\n')).then(
      () => setNotice(`已复制 ${lines.length} 条掩码摘要（不含密码与密钥）`),
      () => setNotice('复制失败'),
    );
  }
  const hasApk = Boolean(state.config.apkPath?.trim() || state.config.detectedApkPath?.trim());
  const totpCount = parsed.entries.filter((e) => Boolean(e.totpSecret)).length;
  return (
    <NativeModalShell
      title="蓝蝶批量一键自动登录（支持 2FA）"
      subtitle="账密与 2FA 密钥严格仅驻留内存并在单台完成后即刻擦除，绝不写入数据库或日志。"
      width="min(860px, 94vw)"
      error={error}
      notice={notice}
      onClose={onClose}
      headerRight={
        batchLogin && (
          <SegTabs
            value={tab}
            disabled={false}
            options={[
              ['setup', '导入配对'],
              [
                'progress',
                batchLogin.running
                  ? `实时进度 ${batchLogin.completed}/${batchLogin.total}`
                  : `上次战报 (${batchLogin.succeeded}/${batchLogin.total})`,
              ],
            ]}
            onChange={(next) => !(next === 'setup' && batchLogin.running) && setTab(next)}
          />
        )
      }
      footer={
        <>
          <div className="flex flex-wrap gap-2">
            {tab === 'progress' && batchLogin && !batchLogin.running && (
              <>
                {batchLogin.succeeded > 0 && (
                  <Btn
                    onClick={() => {
                      const ids = batchLogin.items
                        .filter((i) => i.status === 'succeeded')
                        .map((i) => i.instanceId);
                      if (ids.length) {
                        onSelect(new Set(ids));
                        setNotice(`已在左侧蓝蝶列表勾选全部 ${ids.length} 台登录成功实例`);
                      }
                    }}
                  >
                    勾选成功实例 ({batchLogin.succeeded})
                  </Btn>
                )}
                <Btn onClick={() => void copyIssueReport()}>复制脱敏战报</Btn>
                <Btn onClick={() => setTab('setup')}>新一轮批量登录</Btn>
              </>
            )}
          </div>
          <div className="flex gap-2">
            {tab === 'setup' ? (
              <>
                <Btn sm={false} onClick={onClose}>
                  取消
                </Btn>
                <Btn
                  v="primary"
                  sm={false}
                  disabled={
                    busy ||
                    Boolean(batchLogin?.running) ||
                    !pairedRows.length ||
                    parsed.errors.length > 0
                  }
                  onClick={handleStart}
                >
                  {busy ? '正在启动…' : `开始批量登录 (${pairedRows.length} 台)`}
                </Btn>
              </>
            ) : batchLogin?.running ? (
              <>
                <Btn sm={false} onClick={onClose}>
                  后台运行
                </Btn>
                <Btn v="danger" sm={false} disabled={busy} onClick={handleStop}>
                  {busy ? '正在停止…' : '停止批量登录'}
                </Btn>
              </>
            ) : (
              <Btn v="primary" sm={false} onClick={onClose}>
                完成
              </Btn>
            )}
          </div>
        </>
      }
    >
      {tab === 'setup' ? (
        <>
          <div
            className={`${UI_CARD} flex flex-wrap items-center justify-between gap-2.5 bg-[var(--surface-2)] px-3.5 py-2.5`}
          >
            <div className="text-[12.5px]">
              <strong>目标竖屏蓝蝶：{eligiblePortrait.length} 台</strong>
              {selectedLandscapeCount > 0 && (
                <span className={`${UI_MUTED} ml-2`}>
                  （已自动剔除 {selectedLandscapeCount} 台横屏实例）
                </span>
              )}
              {!eligiblePortrait.length && (
                <span className={`${UI_MUTED} ml-2`}>
                  请先在左侧勾选蓝蝶窗口，或点击右侧快捷选中
                </span>
              )}
            </div>
            <Btn
              disabled={!idlePortrait.length}
              onClick={() => {
                if (!idlePortrait.length) return setNotice('当前没有空闲或未登录的竖屏蓝蝶实例');
                onSelect(new Set(idlePortrait.map((i) => i.id)));
                setNotice(`已自动勾选 ${idlePortrait.length} 台未登录/未检测竖屏蓝蝶`);
              }}
            >
              自动勾选未登录竖屏蓝蝶 ({idlePortrait.length})
            </Btn>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className={UI_ROW_BT}>
              <label className="text-[13px] font-semibold text-slate-900">
                粘贴账号清单（支持多行 <code>账号:/密码:/totp:</code> 或{' '}
                <code>账号|密码|2FA密钥</code> / Tab / CSV）
              </label>
              <div className="flex gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.csv,.tsv"
                  className="hidden"
                  onChange={(e) => (handleImportFile(e.target.files?.[0]), (e.target.value = ''))}
                />
                <Btn onClick={() => fileInputRef.current?.click()}>导入 .txt / .csv</Btn>
                {rawText && (
                  <Btn v="ghost" onClick={() => (setRawText(''), setError(''))}>
                    清空
                  </Btn>
                )}
              </div>
            </div>
            <textarea
              value={rawText}
              onChange={(e) => (setRawText(e.target.value), setError(''))}
              rows={6}
              spellCheck={false}
              placeholder={
                '示例 1（多行标签，密码含冒号/逗号也不受影响）：\n账号: demo@example.com\n密码: My:Pass,123\ntotp: JBSW Y3DP EHPK 3PXP\n\n示例 2（单行管道或 Excel 复制粘贴）：\ndemo2@example.com|Pass456|JBSWY3DPEHPK3PXP'
              }
              className={`${UI_TEXTAREA} min-h-[168px] shrink-0 font-mono`}
            />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {[
                `已解析有效账号 ${parsed.entries.length} 条`,
                `含 2FA 密钥 ${totpCount} 条`,
                `本次可配对 ${pairedRows.length} 台`,
              ].map((lbl) => (
                <span key={lbl} className={BATCH_RESULT_PILL_CLS}>
                  {lbl}
                </span>
              ))}
              {parsed.entries.length > eligiblePortrait.length && eligiblePortrait.length > 0 && (
                <span className={UI_MUTED}>
                  另有 {parsed.entries.length - eligiblePortrait.length}{' '}
                  条账号超出已选蓝蝶数量，将仅执行前 {pairedRows.length} 条
                </span>
              )}
            </div>
            {parsed.errors.length > 0 && (
              <div className="max-h-[90px] overflow-y-auto rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {parsed.errors.slice(0, 8).map((errItem) => (
                  <div key={`${errItem.lineNumber}-${errItem.reason}`}>
                    第 {errItem.lineNumber} 行：{errItem.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            className={`${UI_CARD} grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5 bg-[var(--surface-2)] px-3.5 py-3 text-[12.5px]`}
          >
            <label className="flex items-center gap-2">
              <span className="text-[var(--text-2)]">并发台数</span>
              <CtrlNum
                aria="批量登录并发台数"
                min={1}
                max={10}
                def={3}
                val={opts.maxConcurrency}
                onChange={(maxConcurrency) => setOpts((p) => ({ ...p, maxConcurrency }))}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[var(--text-2)]">已登录处理</span>
              <select
                value={opts.ifAlreadyLoggedIn}
                onChange={(e) =>
                  setOpts((p) => ({
                    ...p,
                    ifAlreadyLoggedIn:
                      e.target.value === 'clear-and-relogin' ? 'clear-and-relogin' : 'skip',
                  }))
                }
                className={UI_SELECT_SM}
              >
                <option value="skip">跳过已登录（推荐）</option>
                <option value="clear-and-relogin">清除旧会话并覆盖重登</option>
              </select>
            </label>
            {(
              [
                ['自动拉起离线蓝蝶', 'autoLaunch'],
                ['缺 FB Lite 自动安装 APK', 'autoInstallApk'],
                ['允许 FB Lite 保存登录信息', 'saveLoginInfo'],
                ['单台完成后自动关窗释放内存', 'closeOnFinish'],
              ] as const
            ).map(([label, key]) => (
              <Chk
                key={label}
                label={label}
                checked={opts[key]}
                onChange={(v) => setOpts((p) => ({ ...p, [key]: v }))}
              />
            ))}
          </div>
          {opts.autoInstallApk && !hasApk && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              提示：尚未在「蓝蝶路径与 APK 设置」中配置 FB Lite 安装包路径。若所选蓝蝶未装 FB
              Lite，请先指定本地 .apk 文件。
            </div>
          )}
          {pairedRows.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-[var(--line)]">
              <div className="border-b border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold">
                1 对 1 分配预览（共 {pairedRows.length} 台 · 密码与密钥已自动脱敏）
              </div>
              <DataTbl
                wrapClass="max-h-[190px] overflow-y-auto"
                headers={['#', '蓝蝶窗口', '当前状态', '待登录账号', '2FA', '执行策略']}
                rows={pairedRows}
                empty=""
                renderRow={(row, idx) => (
                  <tr key={row.inst.id}>
                    <td className="px-2.5 py-2 text-[var(--text-3)]">{idx + 1}</td>
                    <td className="px-2.5 py-2 font-medium">{bluestacksDisplayTitle(row.inst)}</td>
                    <td className="px-2.5 py-2 text-[var(--text-3)]">
                      {instanceStateLabel(row.inst)}
                    </td>
                    <td className="px-2.5 py-2 font-mono">
                      {maskLoginAccountLabel(row.cred.account)}
                    </td>
                    <td className="px-2.5 py-2">
                      {row.cred.totpSecret ? (
                        <BatchStatusPill label="已配置" tone="green" />
                      ) : (
                        <span className={UI_MUTED}>无</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2">{row.actionNote}</td>
                  </tr>
                )}
              />
            </div>
          )}
        </>
      ) : batchLogin ? (
        <BluestacksBatchResultList
          summaryCard
          showSummaryHeader
          total={batchLogin.total}
          completed={batchLogin.completed}
          running={batchLogin.running}
          statusText={batchLogin.statusText}
          onCancel={handleStop}
          canceling={busy}
          cancelLabel="中止执行"
          pills={[
            ['总计', batchLogin.total],
            ['成功', batchLogin.succeeded, 'text-emerald-700'],
            ['跳过', batchLogin.skipped],
            ['需验证', batchLogin.verification, 'text-amber-700'],
            ['受限', batchLogin.restricted, 'text-rose-700'],
            ['失败', batchLogin.failed, 'text-rose-700'],
            ...(batchLogin.stopped > 0 ? ([['已停止', batchLogin.stopped]] as const) : []),
          ]}
          headers={['蓝蝶窗口', '掩码账号', '状态', '实时步骤 / 识别结果']}
          rows={batchLogin.items}
          empty="暂无批量登录记录"
          renderRow={(item) => {
            const [label, tone] = STATUS_META[item.status];
            return (
              <tr key={item.instanceId}>
                <td className="px-2.5 py-2 font-medium">{item.instanceName}</td>
                <td className="px-2.5 py-2 font-mono">
                  {item.maskedAccount}
                  {item.hasTotp && (
                    <span className="ml-1.5">
                      <BatchStatusPill label="2FA" tone="blue" />
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-2">
                  <BatchStatusPill label={label} tone={tone} />
                </td>
                <td className="px-2.5 py-2 text-[var(--text-2)]">
                  {item.stepText}
                  {item.accountName && item.status === 'succeeded' && (
                    <span className={`${UI_MUTED} ml-1.5`}>
                      ({item.accountName}
                      {item.numericAccountId ? ` · ${item.numericAccountId}` : ''})
                    </span>
                  )}
                </td>
              </tr>
            );
          }}
        />
      ) : (
        <div className={`${UI_MUTED} p-6 text-center`}>暂无批量登录记录</div>
      )}
    </NativeModalShell>
  );
}
