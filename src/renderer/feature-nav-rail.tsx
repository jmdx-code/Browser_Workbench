import { useEffect, useState } from 'react';
import {
  Award,
  CalendarClock,
  ClipboardList,
  LayoutGrid,
  Send,
  Sparkles,
  Table2,
  ThumbsUp,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { IconBack, IconChevron, IconChevronDown } from './icons.js';
import type { FeatureModuleId, FeatureNavItem } from './modules/module-contracts.js';
const RAIL_COLLAPSED_KEY = 'workbench.nav-rail-collapsed.v1';
const RAIL_CLOSED_KEY = 'workbench.nav-rail-closed-groups.v1';
const ICON_MAP: Record<FeatureNavItem['icon'], LucideIcon> = {
  'auto-scheduler': CalendarClock,
  records: ClipboardList,
  'window-layout': LayoutGrid,
  'active-accounts': Sparkles,
  'bluestacks-active': Sparkles,
  'group-poster': Send,
  'bluestacks-group-poster': Send,
  'group-bumper': ThumbsUp,
  'bluestacks-group-bumper': ThumbsUp,
  'page-bumper': Award,
  'bluestacks-page-bumper': Award,
  'group-inviter': UserPlus,
  'bluestacks-group-inviter': UserPlus,
  'sheets-groups': Table2,
  'sheets-pages': Table2,
  'sheets-schedule': Table2,
  'sheets-records': Table2,
};
function readInitialClosedGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RAIL_CLOSED_KEY) || '[]');
    return Array.isArray(parsed)
      ? new Set(parsed.filter((item): item is string => typeof item === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}
const BADGE_TONE = {
  run: 'text-[#8ab4ff] bg-[rgba(47,111,237,0.32)]',
  err: 'text-white bg-[var(--err)]',
  warn: 'text-[#1f242c] bg-[var(--warn-dot)]',
  ok: 'text-[#6ee7a8] bg-[rgba(60,207,127,0.24)]',
} as const;
const MINI_DOT_TONE = {
  run: 'bg-[var(--run)]',
  err: 'bg-[var(--err)]',
  warn: 'bg-[var(--warn-dot)]',
  ok: 'bg-[#3ccf7f]',
} as const;
const GRP_PILL =
  'h-4 min-w-4 px-1.5 rounded-full text-[10px] font-bold inline-flex items-center justify-center shrink-0 ';
export function FeatureNavRail({
  activeModule,
  carrier = 'browser',
  items,
  onSelectModule,
}: {
  activeModule: FeatureModuleId;
  carrier?: 'browser' | 'bluestacks' | undefined;
  items: readonly FeatureNavItem[];
  onSelectModule: (moduleId: FeatureModuleId) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [closedGroups, setClosedGroups] = useState<Set<string>>(readInitialClosedGroups);
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {}
  }, [collapsed]);
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_CLOSED_KEY, JSON.stringify([...closedGroups].sort()));
    } catch {}
  }, [closedGroups]);
  const navGroups = (
    [
      [
        'control',
        '调度与监控',
        (i: FeatureNavItem) => i.group === 'control' || i.group === 'monitor',
      ],
      ['automation', '核心功能', (i: FeatureNavItem) => i.group === 'automation'],
      ['bluestacks', '蓝蝶模拟器', (i: FeatureNavItem) => i.group === 'bluestacks'],
      ['sheets', '云表协同', (i: FeatureNavItem) => i.group === 'sheets'],
    ] as const
  )
    .map(([key, label, pred]) => ({ key, label, items: items.filter(pred) }))
    .filter((g) => g.items.length > 0);
  const toggleGroup = (key: string) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <nav
      className={`feature-nav-rail flex min-h-0 shrink-0 flex-col border-r border-white/[0.06] bg-[#1f242c] text-[#c8d0dc] select-none transition-[width] duration-150 ${
        collapsed ? 'is-collapsed w-[50px]' : 'w-[172px] max-[860px]:w-[152px]'
      }`}
      aria-label="功能模块导航"
    >
      <div
        className={`flex h-11 shrink-0 items-center border-b border-white/[0.06] ${collapsed ? 'justify-center p-0' : 'justify-between pl-3 pr-2'}`}
      >
        {!collapsed && (
          <span className="text-[11px] font-bold tracking-wider whitespace-nowrap text-[#8b95a5]">
            功能导航
          </span>
        )}
        <button
          type="button"
          className="inline-grid h-7 w-7 place-content-center rounded-md border-0 bg-transparent p-0 text-[#9ba5b4] hover:bg-white/[0.08] hover:text-white"
          aria-label={collapsed ? '展开功能导航' : '折叠功能导航'}
          title={collapsed ? '展开功能导航栏' : '折叠功能导航栏'}
          onClick={() => setCollapsed((p) => !p)}
        >
          {collapsed ? <IconChevron size={15} /> : <IconBack size={15} />}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto px-1.5 pt-1.5 pb-2.5">
        {navGroups.map((group, idx) => {
          const isClosed = closedGroups.has(group.key),
            groupRunning = group.items.reduce((s, it) => s + (it.runningCount ?? 0), 0),
            groupAlert = group.items.reduce(
              (s, it) => s + (it.badgeTone !== 'ok' ? (it.badgeCount ?? 0) : 0),
              0,
            ),
            groupEnabled = group.items.reduce(
              (s, it) => s + (it.badgeTone === 'ok' ? (it.badgeCount ?? 0) : 0),
              0,
            );
          return (
            <div key={group.key} className="flex flex-col gap-1">
              {idx > 0 && <div className="mx-1 my-0.5 h-px bg-white/[0.07]" role="separator" />}
              <div className="nav-rail-group flex flex-col gap-0.5">
                {!collapsed && (
                  <button
                    type="button"
                    className={`nav-rail-group-title flex h-[22px] w-full items-center gap-1 rounded-[5px] border-0 bg-transparent px-1.5 text-left text-[11px] font-bold text-[#7f8a9a] hover:bg-white/5 hover:text-[#b7c0ce]${isClosed ? ' is-closed' : ''}`}
                    aria-expanded={!isClosed}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <IconChevronDown
                      size={12}
                      className={`shrink-0 transition-transform ${isClosed ? '-rotate-90' : ''}`}
                    />
                    <span className="nav-rail-group-title-text min-w-0 flex-1 truncate">
                      {group.label}
                    </span>
                    {group.key === 'automation' && !isClosed && (
                      <span
                        className={GRP_PILL + 'bg-white/10 font-semibold text-[#cbd5e1]'}
                        title={`当前核心功能载体：${carrier === 'bluestacks' ? '蓝蝶模拟器' : 'Chrome 浏览器'}`}
                      >
                        {carrier === 'bluestacks' ? '蓝蝶' : '浏览器'}
                      </span>
                    )}
                    {isClosed &&
                      (groupRunning > 0 ? (
                        <span className={GRP_PILL + 'bg-[rgba(47,111,237,0.28)] text-[#93b8ff]'}>
                          {groupRunning}运行
                        </span>
                      ) : groupAlert > 0 ? (
                        <span className={GRP_PILL + 'bg-[rgba(235,87,87,0.25)] text-[#ff9c9c]'}>
                          {groupAlert}
                        </span>
                      ) : groupEnabled > 0 ? (
                        <span className={GRP_PILL + 'bg-[rgba(60,207,127,0.2)] text-[#7ee3ad]'}>
                          {groupEnabled}
                        </span>
                      ) : null)}
                  </button>
                )}
                {(collapsed || !isClosed) && (
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const isActive =
                          item.group === 'sheets'
                            ? activeModule.startsWith('sheets-')
                            : activeModule === item.id,
                        running = item.runningCount ?? 0,
                        badge = item.badgeCount ?? 0,
                        badgeDesc =
                          item.badgeTone === 'ok' ? `${badge} 项已启用` : `${badge} 项需要处理`,
                        Icon = ICON_MAP[item.icon],
                        tone = item.badgeTone ?? 'err';
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`nav-rail-item relative flex h-[31px] min-w-0 items-center gap-2 rounded-[7px] border-0 bg-transparent text-left text-[13px] font-semibold transition-colors ${
                            collapsed ? 'justify-center p-0' : 'px-2'
                          } ${
                            isActive
                              ? 'active bg-[rgba(47,111,237,0.22)] text-white shadow-[inset_3px_0_0_var(--brand)]'
                              : 'text-[#b8c2d0] hover:bg-white/[0.07] hover:text-white'
                          }`}
                          aria-current={isActive ? 'page' : undefined}
                          title={`${item.tooltip ?? item.title}${running > 0 ? `（${running} 运行中）` : ''}${badge > 0 ? `（${badgeDesc}）` : ''}`}
                          onClick={() => onSelectModule(item.id)}
                        >
                          <span className="relative inline-grid h-5 w-5 shrink-0 place-content-center">
                            <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                            {collapsed && (running > 0 || badge > 0) && (
                              <i
                                className={`absolute -top-px -right-px h-[7px] w-[7px] rounded-full border-[1.5px] border-[#1f242c] ${MINI_DOT_TONE[badge > 0 ? tone : 'run']}`}
                              />
                            )}
                          </span>
                          {!collapsed && (
                            <span className="nav-rail-label min-w-0 flex-1 truncate">
                              {item.title}
                            </span>
                          )}
                          {!collapsed && (running > 0 || badge > 0) && (
                            <span
                              className={`h-[18px] min-w-[18px] shrink-0 rounded-full px-[5px] text-center text-[10px] leading-[18px] font-bold tabular-nums ${BADGE_TONE[running > 0 ? 'run' : tone]}`}
                              title={
                                running > 0 ? `${running} 个任务正在运行${item.title}` : badgeDesc
                              }
                            >
                              {running > 0 ? (running > 1 ? `${running}运行` : '运行中') : badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
