import { useEffect, useState, type ReactNode } from 'react';
import type { FeatureModuleId, FeatureNavItem } from './modules/module-contracts.js';
import { IconBack, IconCheckList, IconChevron, IconChevronDown, IconLayers } from './icons.js';

const RAIL_COLLAPSED_STORAGE_KEY = 'workbench.nav-rail-collapsed.v1';

function readInitialCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function renderNavIcon(icon: FeatureNavItem['icon']): ReactNode {
  switch (icon) {
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
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Ignore storage write errors in restricted contexts.
    }
  }, [collapsed]);

  const automationItems = items.filter((item) => item.group === 'automation');
  const bluestacksItems = items.filter((item) => item.group === 'bluestacks');
  const monitorItems = items.filter((item) => item.group === 'monitor');

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
    return (
      <button
        key={item.id}
        type="button"
        className={'nav-rail-item' + (isActive ? ' active' : '')}
        aria-current={isActive ? 'page' : undefined}
        title={
          item.title +
          (showRunning ? `（${runningCount} 运行中）` : '') +
          (showBadge ? `（${badgeCount} 需处理）` : '')
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
            title={`${runningCount} 个浏览器正在运行${item.title}`}
          >
            {runningCount > 1 ? `${runningCount}运行` : '运行中'}
          </span>
        )}
        {!collapsed && !showRunning && showBadge && (
          <span
            className={'nav-rail-badge tone-' + (item.badgeTone ?? 'err')}
            title={`${badgeCount} 项需要处理`}
          >
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
        <div className="nav-rail-group">
          {!collapsed && (
            <button
              type="button"
              className={
                'nav-rail-group-title' + (closedGroups.has('automation') ? ' is-closed' : '')
              }
              aria-expanded={!closedGroups.has('automation')}
              onClick={() => toggleGroup('automation')}
            >
              <IconChevronDown size={12} />
              <span>自动化功能</span>
            </button>
          )}
          {(collapsed || !closedGroups.has('automation')) && (
            <div className="nav-rail-list">{automationItems.map(renderItem)}</div>
          )}
        </div>

        {bluestacksItems.length > 0 && (
          <>
            <div className="nav-rail-divider" role="separator" />
            <div className="nav-rail-group">
              {!collapsed && (
                <button
                  type="button"
                  className={
                    'nav-rail-group-title' + (closedGroups.has('bluestacks') ? ' is-closed' : '')
                  }
                  aria-expanded={!closedGroups.has('bluestacks')}
                  onClick={() => toggleGroup('bluestacks')}
                >
                  <IconChevronDown size={12} />
                  <span>蓝蝶自动化</span>
                </button>
              )}
              {(collapsed || !closedGroups.has('bluestacks')) && (
                <div className="nav-rail-list">{bluestacksItems.map(renderItem)}</div>
              )}
            </div>
          </>
        )}

        <div className="nav-rail-divider" role="separator" />

        <div className="nav-rail-group nav-rail-group-bottom">
          {!collapsed && (
            <button
              type="button"
              className={'nav-rail-group-title' + (closedGroups.has('monitor') ? ' is-closed' : '')}
              aria-expanded={!closedGroups.has('monitor')}
              onClick={() => toggleGroup('monitor')}
            >
              <IconChevronDown size={12} />
              <span>全局中心</span>
            </button>
          )}
          {(collapsed || !closedGroups.has('monitor')) && (
            <div className="nav-rail-list">{monitorItems.map(renderItem)}</div>
          )}
        </div>
      </div>
    </nav>
  );
}
