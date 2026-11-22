import { useEffect, useState, type ReactNode } from 'react';
import type { FeatureModuleId, FeatureNavItem } from './modules/module-contracts.js';
import { IconBack, IconCheckList, IconChevron, IconChevronDown, IconLayers } from './icons.js';

const RAIL_COLLAPSED_STORAGE_KEY = 'workbench.nav-rail-collapsed.v1';
const RAIL_CLOSED_GROUPS_STORAGE_KEY = 'workbench.nav-rail-closed-groups.v1';

function readInitialCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function readInitialClosedGroups(): Set<string> {
  try {
    const raw = window.localStorage.getItem(RAIL_CLOSED_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
}

function renderNavIcon(icon: FeatureNavItem['icon']): ReactNode {
  switch (icon) {
    case 'auto-scheduler':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="13" r="8" />
          <path d="M12 9v4l2.8 2" />
          <path d="M5 3 2 6M22 6l-3-3" />
        </svg>
      );
    case 'active-accounts':
      return <IconLayers size={16} />;
    case 'group-inviter':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="9" cy="8" r="3.5" />
          <path d="M3.5 19c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2" />
          <path d="M19 8v6M16 11h6" />
        </svg>
      );
    case 'group-bumper':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
          <path d="M12 8v6M9 11l3-3 3 3" />
        </svg>
      );
    case 'page-bumper':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M5 21V4h11l-1.5 4L16 12H5" />
          <path d="M12 20v-5M9.5 17.5 12 15l2.5 2.5" />
        </svg>
      );
    case 'group-poster':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      );
    case 'sheets-groups':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 4v16" />
        </svg>
      );
    case 'sheets-pages':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M15 4v16" />
        </svg>
      );
    case 'sheets-schedule':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M8 2v4M16 2v4M3 10h18" />
          <path d="M8 14h3M8 17h7" />
        </svg>
      );
    case 'sheets-records':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 5h16M4 12h16M4 19h10" />
          <path d="M18 16v6M15 19l3-3 3 3" />
        </svg>
      );
    case 'bluestacks-active':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M10 18.5h4" />
          <path d="M9 10.5h2l1.5-3 2 6 1.5-3h1" />
        </svg>
      );
    case 'bluestacks-group-poster':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M10 18.5h4" />
          <path d="M9 13.5 14.5 8l1.5 1.5L10.5 15H9v-1.5z" />
        </svg>
      );
    case 'bluestacks-group-inviter':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M10 18.5h4" />
          <circle cx="11" cy="9.5" r="2" />
          <path d="M8.5 14.5c0-1.4 1.1-2.4 2.5-2.4s2.5 1 2.5 2.4M15.5 9.5v3M14 11h3" />
        </svg>
      );
    case 'bluestacks-group-bumper':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M10 18.5h4" />
          <path d="M12 13v-5M9.5 10.5 12 8l2.5 2.5" />
        </svg>
      );
    case 'bluestacks-page-bumper':
      return (
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
          <path d="M10 18.5h4" />
          <path d="M9.5 13.5V7l5 2.2-5 2.2" />
        </svg>
      );
    case 'records':
      return <IconCheckList size={16} />;
  }
}

export function FeatureNavRail({
  activeModule,
  items,
  onSelectModule,
}: {
  activeModule: FeatureModuleId;
  items: readonly FeatureNavItem[];
  onSelectModule: (moduleId: FeatureModuleId) => void;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(readInitialCollapsed);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(readInitialClosedGroups);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Ignore storage write errors in restricted contexts.
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RAIL_CLOSED_GROUPS_STORAGE_KEY,
        JSON.stringify([...closedGroups].sort()),
      );
    } catch {
      // Ignore storage write errors in restricted contexts.
    }
  }, [closedGroups]);

  const controlItems = items.filter((item) => item.group === 'control' || item.group === 'monitor');
  const automationItems = items.filter((item) => item.group === 'automation');
  const bluestacksItems = items.filter((item) => item.group === 'bluestacks');
  const sheetsItems = items.filter((item) => item.group === 'sheets');

  const navGroups: Array<{ key: string; label: string; items: readonly FeatureNavItem[] }> = [
    { key: 'control', label: '调度与监控', items: controlItems },
    { key: 'automation', label: '浏览器自动化', items: automationItems },
    { key: 'bluestacks', label: '蓝蝶模拟器', items: bluestacksItems },
    { key: 'sheets', label: '云表协同', items: sheetsItems },
  ].filter((group) => group.items.length > 0);

  function toggleGroup(groupKey: string) {
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function renderItem(item: FeatureNavItem) {
    const isActive = activeModule === item.id;
    const runningCount = item.runningCount ?? 0;
    const badgeCount = item.badgeCount ?? 0;
    const showRunning = runningCount > 0;
    const showBadge = badgeCount > 0;
    const isHealthyBadge = item.badgeTone === 'ok';
    const badgeDesc = isHealthyBadge ? `${badgeCount} 项已启用` : `${badgeCount} 项需要处理`;
    return (
      <button
        key={item.id}
        type="button"
        className={'nav-rail-item' + (isActive ? ' active' : '')}
        aria-current={isActive ? 'page' : undefined}
        title={
          (item.tooltip ?? item.title) +
          (showRunning ? `（${runningCount} 运行中）` : '') +
          (showBadge ? `（${badgeDesc}）` : '')
        }
        onClick={() => onSelectModule(item.id)}
      >
        <span className="nav-rail-icon">
          {renderNavIcon(item.icon)}
          {collapsed && (showRunning || showBadge) && (
            <i
              className={
                'nav-rail-mini-dot ' +
                (showBadge ? 'tone-' + (item.badgeTone ?? 'err') : 'tone-run')
              }
            />
          )}
        </span>
        {!collapsed && <span className="nav-rail-label">{item.title}</span>}
        {!collapsed && showRunning && (
          <span
            className="nav-rail-badge tone-run"
            title={`${runningCount} 个任务正在运行${item.title}`}
          >
            {runningCount > 1 ? `${runningCount}运行` : '运行中'}
          </span>
        )}
        {!collapsed && !showRunning && showBadge && (
          <span className={'nav-rail-badge tone-' + (item.badgeTone ?? 'err')} title={badgeDesc}>
            {badgeCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <nav
      className={'feature-nav-rail' + (collapsed ? ' is-collapsed' : '')}
      aria-label="功能模块导航"
    >
      <div className="nav-rail-header">
        {!collapsed && <span className="nav-rail-heading">功能导航</span>}
        <button
          type="button"
          className="nav-rail-collapse-btn"
          aria-label={collapsed ? '展开功能导航' : '折叠功能导航'}
          title={collapsed ? '展开功能导航栏' : '折叠功能导航栏'}
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? <IconChevron size={15} /> : <IconBack size={15} />}
        </button>
      </div>

      <div className="nav-rail-groups">
        {navGroups.map((group, idx) => {
          const isClosed = closedGroups.has(group.key);
          const groupRunning = group.items.reduce((sum, it) => sum + (it.runningCount ?? 0), 0);
          const groupAlert = group.items.reduce(
            (sum, it) => sum + (it.badgeTone !== 'ok' ? (it.badgeCount ?? 0) : 0),
            0,
          );
          const groupEnabled = group.items.reduce(
            (sum, it) => sum + (it.badgeTone === 'ok' ? (it.badgeCount ?? 0) : 0),
            0,
          );
          return (
            <div key={group.key} className="nav-rail-group-wrap">
              {idx > 0 && <div className="nav-rail-divider" role="separator" />}
              <div className="nav-rail-group">
                {!collapsed && (
                  <button
                    type="button"
                    className={'nav-rail-group-title' + (isClosed ? ' is-closed' : '')}
                    aria-expanded={!isClosed}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <IconChevronDown size={12} />
                    <span className="nav-rail-group-title-text">{group.label}</span>
                    {isClosed && groupRunning > 0 && (
                      <span className="nav-rail-group-pill tone-run">{groupRunning}运行</span>
                    )}
                    {isClosed && groupRunning === 0 && groupAlert > 0 && (
                      <span className="nav-rail-group-pill tone-err">{groupAlert}</span>
                    )}
                    {isClosed && groupRunning === 0 && groupAlert === 0 && groupEnabled > 0 && (
                      <span className="nav-rail-group-pill tone-ok">{groupEnabled}</span>
                    )}
                  </button>
                )}
                {(collapsed || !isClosed) && (
                  <div className="nav-rail-list">{group.items.map(renderItem)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
