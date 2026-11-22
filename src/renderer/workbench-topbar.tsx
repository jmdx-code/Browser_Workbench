import { useEffect, useRef, useState } from 'react';
import type { AutoSchedulerGlobalSettings } from '../shared/auto-scheduler.js';
import type { UpdateStatus } from '../shared/software-update.js';
import { api } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { IconBrand, IconMenu, IconMinus, IconPlus } from './icons.js';

const BROWSER_PRESETS = [5, 10, 15, 20, 30] as const;
const BLUESTACKS_PRESETS = [2, 4, 5, 8, 10] as const;

function GlobalConcurrencyPopover({
  settings,
  onSave,
}: {
  settings: AutoSchedulerGlobalSettings | null;
  onSave: (patch: {
    browserConcurrency: number;
    bluestacksConcurrency: number;
  }) => Promise<boolean | void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const browserVal = settings?.browserConcurrency ?? 15;
  const bsVal = settings?.bluestacksConcurrency ?? 5;

  const [browserDraft, setBrowserDraft] = useState(String(browserVal));
  const [bsDraft, setBsDraft] = useState(String(bsVal));

  useEffect(() => {
    setBrowserDraft(String(browserVal));
  }, [browserVal]);

  useEffect(() => {
    setBsDraft(String(bsVal));
  }, [bsVal]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function applyConcurrency(nextBrowser: number, nextBs: number) {
    if (savingRef.current) return;
    const b = Math.max(1, Math.min(50, Math.round(nextBrowser)));
    const s = Math.max(1, Math.min(30, Math.round(nextBs)));
    setBrowserDraft(String(b));
    setBsDraft(String(s));
    if (b === browserVal && s === bsVal) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const ok = await onSave({ browserConcurrency: b, bluestacksConcurrency: s });
      if (ok === false) {
        setBrowserDraft(String(browserVal));
        setBsDraft(String(bsVal));
      }
    } catch {
      setBrowserDraft(String(browserVal));
      setBsDraft(String(bsVal));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function commitBrowserInput() {
    const trimmed = browserDraft.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isFinite(parsed) || parsed < 1) {
      setBrowserDraft(String(browserVal));
      return;
    }
    void applyConcurrency(parsed, bsVal);
  }

  function commitBsInput() {
    const trimmed = bsDraft.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isFinite(parsed) || parsed < 1) {
      setBsDraft(String(bsVal));
      return;
    }
    void applyConcurrency(browserVal, parsed);
  }

  return (
    <div className="topbar-concurrency-wrap" ref={wrapRef}>
      <button
        type="button"
        className={'topbar-concurrency-btn' + (open ? ' is-open' : '')}
        aria-expanded={open}
        aria-label="全局并发设置"
        title="点击统一设置全软件的浏览器与蓝蝶模拟器最大并发窗口数（所有功能共用）"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="topbar-concurrency-label">并发</span>
        <span className="topbar-concurrency-val">
          浏览器 <strong>{browserVal}</strong>
        </span>
        <span className="topbar-concurrency-sep">·</span>
        <span className="topbar-concurrency-val">
          蓝蝶 <strong>{bsVal}</strong>
        </span>
        <span className="topbar-concurrency-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="topbar-concurrency-popover" role="dialog" aria-label="全局并发设置面板">
          <div className="topbar-concurrency-head">
            <strong>全局最大并发</strong>
            <span className="topbar-concurrency-tag">{saving ? '同步中…' : '全模块共用'}</span>
          </div>

          <div className="topbar-concurrency-section">
            <div className="topbar-concurrency-row">
              <div className="topbar-concurrency-meta">
                <span>Chrome 浏览器</span>
                <small>活跃 / 顶贴 / 发帖 / 邀请 / 排班 / 表格</small>
              </div>
              <div className="topbar-concurrency-stepper">
                <button
                  type="button"
                  aria-label="减少浏览器并发"
                  disabled={saving || browserVal <= 1}
                  onClick={() => void applyConcurrency(browserVal - 1, bsVal)}
                >
                  <IconMinus size={13} />
                </button>
                <input
                  type="number"
                  aria-label="浏览器最大并发数"
                  min={1}
                  max={50}
                  value={browserDraft}
                  disabled={saving}
                  onChange={(e) => setBrowserDraft(e.target.value)}
                  onBlur={commitBrowserInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label="增加浏览器并发"
                  disabled={saving || browserVal >= 50}
                  onClick={() => void applyConcurrency(browserVal + 1, bsVal)}
                >
                  <IconPlus size={13} />
                </button>
              </div>
            </div>
            <div className="topbar-concurrency-presets">
              {BROWSER_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={'topbar-concurrency-preset' + (browserVal === n ? ' is-active' : '')}
                  disabled={saving}
                  onClick={() => void applyConcurrency(n, bsVal)}
                >
                  {n} 窗
                </button>
              ))}
            </div>
          </div>

          <div className="topbar-concurrency-section">
            <div className="topbar-concurrency-row">
              <div className="topbar-concurrency-meta">
                <span>蓝蝶模拟器</span>
                <small>蓝蝶小组顶贴 / 专页顶贴 / 排班</small>
              </div>
              <div className="topbar-concurrency-stepper">
                <button
                  type="button"
                  aria-label="减少蓝蝶并发"
                  disabled={saving || bsVal <= 1}
                  onClick={() => void applyConcurrency(browserVal, bsVal - 1)}
                >
                  <IconMinus size={13} />
                </button>
                <input
                  type="number"
                  aria-label="蓝蝶最大并发数"
                  min={1}
                  max={30}
                  value={bsDraft}
                  disabled={saving}
                  onChange={(e) => setBsDraft(e.target.value)}
                  onBlur={commitBsInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label="增加蓝蝶并发"
                  disabled={saving || bsVal >= 30}
                  onClick={() => void applyConcurrency(browserVal, bsVal + 1)}
                >
                  <IconPlus size={13} />
                </button>
              </div>
            </div>
            <div className="topbar-concurrency-presets">
              {BLUESTACKS_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={'topbar-concurrency-preset' + (bsVal === n ? ' is-active' : '')}
                  disabled={saving}
                  onClick={() => void applyConcurrency(browserVal, n)}
                >
                  {n} 窗
                </button>
              ))}
            </div>
          </div>

          <p className="topbar-concurrency-foot">
            超出并发上限的账号自动排队等待；调低时不会中断正在执行的任务。
          </p>
        </div>
      )}
    </div>
  );
}

export function WorkbenchTopbar({
  version,
  breadcrumbText,
  busy,
  error,
  onlineCount,
  totalProfilesCount,
  updateStatus,
  updateError,
  schedulerSettings,
  onSaveGlobalConcurrency,
  onOpenDiagnosticModal,
  onOpenMenu,
  onOpenUpdateMenu,
  onApplyUpdate,
  onNotify,
}: {
  version: string;
  breadcrumbText: string;
  busy: boolean;
  error: string | null;
  onlineCount: number;
  totalProfilesCount: number;
  updateStatus: UpdateStatus | null;
  updateError: string;
  schedulerSettings: AutoSchedulerGlobalSettings | null;
  onSaveGlobalConcurrency: (patch: {
    browserConcurrency: number;
    bluestacksConcurrency: number;
  }) => Promise<boolean | void>;
  onOpenDiagnosticModal: () => void;
  onOpenMenu: () => void;
  onOpenUpdateMenu: () => void;
  onApplyUpdate: () => Promise<void>;
  onNotify: (msg: string) => void;
}) {
  const [ignoredUpdate, setIgnoredUpdate] = useState('');

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <IconBrand size={18} />
          </span>
          <strong>浏览器工作台</strong>
          <span className="build-label">v{version}</span>
          <span className="topbar-breadcrumb" aria-label="当前模块">
            {breadcrumbText}
          </span>
        </div>
        <div className="topbar-right">
          {busy && <span className="spinner" role="status" aria-label="正在处理" />}
          <GlobalConcurrencyPopover settings={schedulerSettings} onSave={onSaveGlobalConcurrency} />
          <button
            type="button"
            className="topbar-action-btn"
            title="一键打包当前所有浏览器状态、任务账本、顶贴/邀请日志与内核黑匣子记录为 .zip 反馈包并打开文件夹"
            onClick={onOpenDiagnosticModal}
          >
            记录问题现场
          </button>
          <button
            type="button"
            className="topbar-action-btn"
            title={
              updateStatus?.extensionDirectory
                ? `点击复制固定插件目录：${updateStatus.extensionDirectory}`
                : '点击复制浏览器扩展（固定插件目录）路径'
            }
            onClick={() => {
              void (async () => {
                try {
                  const dir =
                    updateStatus?.extensionDirectory ||
                    (await api.softwareUpdateStatus()).extensionDirectory;
                  await copyTextToClipboard(dir);
                  onNotify(`已复制固定插件路径：${dir}`);
                } catch (err) {
                  onNotify(err instanceof Error ? err.message : '复制插件路径失败');
                }
              })();
            }}
          >
            复制插件路径
          </button>
          <button
            type="button"
            className={'connection-status' + (error ? ' is-error' : onlineCount ? ' is-on' : '')}
            title={
              error
                ? '控制服务连接待刷新，点击查看插件连接与更新'
                : '已连接的浏览器 / 全部浏览器（点击查看插件连接与更新）'
            }
            onClick={onOpenUpdateMenu}
          >
            <i />
            {error ? '连接待刷新' : `${onlineCount}/${totalProfilesCount} 已连接`}
          </button>
          <button
            type="button"
            className="btn btn-icon menu-button"
            aria-label="打开菜单"
            title="菜单：表格与图床、偏好设置、数据清理、插件更新、AI 工作夹、重启等"
            onClick={onOpenMenu}
          >
            <IconMenu size={18} />
          </button>
        </div>
      </header>
      {updateStatus?.availableUpdate &&
        ignoredUpdate !==
          updateStatus.availableUpdate.softwareVersion +
            ':' +
            updateStatus.availableUpdate.extensionVersion && (
          <div className="update-banner" role="status">
            <span>
              发现新版本 v{updateStatus.availableUpdate.softwareVersion}
              {updateStatus.availableUpdate.extensionVersion
                ? ' · 插件 v' + updateStatus.availableUpdate.extensionVersion
                : ''}
            </span>
            <button
              className="btn btn-primary btn-sm"
              disabled={updateStatus.applying || updateStatus.availableUpdate.requiresInstaller}
              onClick={() => void onApplyUpdate()}
            >
              {updateStatus.applying
                ? '正在下载并更新软件与插件…'
                : updateStatus.availableUpdate.requiresInstaller
                  ? '需要完整安装包'
                  : '一键更新'}
            </button>
            <button className="btn btn-sm" onClick={onOpenUpdateMenu}>
              查看详情
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                setIgnoredUpdate(
                  updateStatus.availableUpdate?.softwareVersion +
                    ':' +
                    updateStatus.availableUpdate?.extensionVersion,
                )
              }
            >
              稍后
            </button>
            {updateError && <span>{updateError}</span>}
          </div>
        )}
    </>
  );
}
