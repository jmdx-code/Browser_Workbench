// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FinderTargetList } from '../src/renderer/finder-target-list.js';
import { computePopoverPlacement, PopoverMenu } from '../src/renderer/popover-menu.js';
import { InviterWorkspacePage } from '../src/renderer/inviter-workspace-page.js';
import { GroupBumperPage } from '../src/renderer/group-bumper-page.js';
import { GroupPosterPage } from '../src/renderer/group-poster-page.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { PosterSettings } from '../src/shared/group-poster.js';
import { normalizeTargetToken } from '../src/renderer/select-by-ids-dialog.js';
import { Sidebar } from '../src/renderer/sidebar.js';
import { FeatureNavRail } from '../src/renderer/feature-nav-rail.js';
import { CombinationList, parseImportedCombination } from '../src/renderer/combination-list.js';
import { PostBumpRecordsPage } from '../src/renderer/modules/post-bump-records-page.js';
import {
  buildFeatureNavItems,
  buildWorkbenchProjection,
  projectSelectionControls,
} from '../src/renderer/modules/profile-activity-projector.js';
import {
  nudgeFinderIds,
  insertFinderIds,
  rangeFinderSelection,
} from '../src/renderer/finder-list-model.js';
import { api } from '../src/renderer/api.js';
import { Editor, newCombination, normalizeCombinationResources } from '../src/renderer/editor.js';
import { AutoSchedulerPage } from '../src/renderer/auto-scheduler-page.js';
import { AutoSchedulerEditorModal } from '../src/renderer/auto-scheduler-editor-modal.js';
import { ActiveAccountsPage } from '../src/renderer/active-accounts-page.js';
import { buildLiveRunCards, LiveRunsDrawer } from '../src/renderer/modules/live-runs-drawer.js';
import { mapProfilesToScopeOptions } from '../src/renderer/modules/shared/target-scope-bar.js';
import { getTargetProfileIds } from '../src/renderer/modules/window-layout-preview-canvas.js';
import { relativePostAge } from '../src/shared/bluestacks.js';
import { CombinationSchema, profileDisplayName } from '../src/shared/contracts.js';

it('new Story defaults to the native current audience while explicit saved Friends stays unchanged', () => {
  const fresh = newCombination('story');
  expect(fresh.steps[0]?.type === 'post' && fresh.steps[0].audience).toBe('preserve-current');
  const saved = CombinationSchema.parse({
    ...fresh,
    steps: fresh.steps.map((s) => ({ ...s, audience: 'friends' })),
  });
  expect(normalizeCombinationResources(saved).steps[0]).toMatchObject({ audience: 'friends' });
  expect(saved.steps[0]).toMatchObject({ audience: 'friends' });
});
vi.mock('../src/renderer/api.js', () => ({
  api: {
    activityStats: vi.fn(),
    postBumpRecords: vi.fn(),
    deletePostBumpRecords: vi.fn(),
    inviterRecords: vi.fn(),
    deleteInviterRecords: vi.fn(),
    browserRiskLimits: vi.fn(),
    saveBrowserRiskLimits: vi.fn(),
    groupInviterLogs: vi.fn(),
    cleanupSettings: vi.fn(),
    targetFolders: vi.fn(),
    targetListCommand: vi.fn(),
    reorderProfiles: vi.fn(),
    reorderGroups: vi.fn(),
    cleanupProfileTabs: vi.fn(),
    bumperAction: vi.fn(),
    bumperState: vi.fn(),
    bluestacksAction: vi.fn(),
    bluestacksState: vi.fn(),
    posterAction: vi.fn(),
    posterState: vi.fn(),
    posterLogs: vi.fn(),
    refreshGroupInviterGroups: vi.fn(),
    create: vi.fn(),
    saveCombination: vi.fn(),
    autoSchedulerAction: vi.fn(),
    runtimeSummary: vi.fn(),
  },
}));
let root: Root;
let host: HTMLDivElement;
const id = 'f0000000-0000-4000-8000-000000000001';
it('editing a marketplace step preserves its visible filters without mutating the saved version', () => {
  const saved = CombinationSchema.parse({
    ...newCombination(),
    steps: [
      {
        id,
        type: 'marketplace',
        durationMinutes: 7,
        keyword: 'old search',
        categoryId: '123',
        minPrice: 10,
        maxPrice: 100,
        maxLikes: 0,
        minLikeCount: 0,
      },
    ],
  });
  const original = structuredClone(saved);
  const edited = normalizeCombinationResources(saved);
  expect(saved).toEqual(original);
  expect(edited.steps[0]).toEqual(original.steps[0]);
});
const rows = [1, 2, 3].map((n) => ({
  id: String(n),
  name: '条目' + n,
  folderId: null,
  sortOrder: n,
  avatarUrl: null,
  count: n,
}));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api.targetFolders).mockResolvedValue([
    { id, listKind: 'inviter_groups', name: '收藏', sortOrder: 0, createdAt: 1 },
  ]);
  vi.mocked(api.targetListCommand).mockResolvedValue({ saved: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(el: Element | null, shiftKey = false) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
  });
}
async function mount() {
  let selected = new Set<string>();
  function Render() {
    const [chosen, set] = React.useState(selected);
    return (
      <FinderTargetList
        listKind="inviter_groups"
        items={rows}
        selected={chosen}
        onSelect={(value) => {
          selected = value;
          set(value);
        }}
        onChanged={async () => {}}
        onDelete={async () => {}}
        title="测试列表"
        countLabel="累计"
      />
    );
  }
  await act(async () => root.render(<Render />));
  return () => selected;
}
describe('shared Finder UI', () => {
  it('shift range and group checkbox support mixed/full selection', async () => {
    const selected = await mount();
    await click(host.querySelector('[data-finder-id="1"]'));
    await click(host.querySelector('[data-finder-id="3"]'), true);
    expect([...selected()]).toEqual(['1', '2', '3']);
    await click(host.querySelector('input[aria-label="选择整组 未分组"]'));
    expect(selected().size).toBe(0);
    await click(host.querySelector('[data-finder-id="2"]'));
    const group = host.querySelector<HTMLInputElement>('input[aria-label="选择整组 未分组"]');
    expect(group?.indeterminate).toBe(true);
  });
  it('move menu inside more popover writes ordered batch to destination folder and removes up/down arrows', async () => {
    await mount();
    expect(host.querySelector('[aria-label="测试列表上移"]')).toBeNull();
    expect(host.querySelector('[aria-label="测试列表下移"]')).toBeNull();
    await click(host.querySelector('[data-finder-id="1"]'));
    await click(host.querySelector('[aria-label="更多测试列表操作"]'));
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
        e.textContent?.includes('移到：收藏'),
      ) ?? null,
    );
    expect(api.targetListCommand).toHaveBeenCalledWith({
      action: 'reorder-items',
      listKind: 'inviter_groups',
      folderId: id,
      orderedItemIds: ['1'],
    });
  });
  it('expandable search toggle opens input on click and filters rows', async () => {
    await mount();
    expect(host.querySelector('input[aria-label="搜索测试列表"]')).toBeNull();
    await click(host.querySelector('[aria-label="展开搜索测试列表"]'));
    const searchInput = host.querySelector<HTMLInputElement>('input[aria-label="搜索测试列表"]');
    expect(searchInput).toBeTruthy();
    await act(async () => {
      if (searchInput) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(searchInput, '条目2');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    expect(host.querySelector('[data-finder-id="1"]')).toBeNull();
    expect(host.querySelector('[data-finder-id="2"]')).toBeTruthy();
    await click(host.querySelector('[aria-label="关闭搜索测试列表"]'));
    expect(host.querySelector('input[aria-label="搜索测试列表"]')).toBeNull();
    expect(host.querySelector('[data-finder-id="1"]')).toBeTruthy();
  });
  it('cross-folder drop preserves dragged multi selection order', async () => {
    await mount();
    await click(host.querySelector('[data-finder-id="1"]'));
    await click(host.querySelector('[data-finder-id="2"]'));
    const row1 = host.querySelector('[data-finder-id="1"]')!;
    const folder = host.querySelector('.finder-folder')!;
    vi.spyOn(folder, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 130,
      left: 0,
      right: 300,
      width: 300,
      height: 30,
    } as DOMRect);
    await act(async () =>
      row1.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 20 }),
      ),
    );
    await act(async () =>
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 50, clientY: 115 }),
      ),
    );
    await act(async () =>
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 50, clientY: 115 }),
      ),
    );
    expect(api.targetListCommand).toHaveBeenCalledWith({
      action: 'reorder-items',
      listKind: 'inviter_groups',
      folderId: id,
      orderedItemIds: ['1', '2'],
    });
  });
  it('checkbox column pointer painting selects more than one row', async () => {
    const selected = await mount();
    const cells = host.querySelectorAll('.finder-check-cell');
    await act(async () =>
      cells[0]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    await act(async () =>
      cells[1]?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, buttons: 1 })),
    );
    expect(selected().has('1')).toBe(true);
    expect(selected().has('2')).toBe(true);
  });
  it('text selection on name or ID prevents row drag and does not toggle row checkbox on click', async () => {
    const selected = await mount();
    const row1 = host.querySelector('[data-finder-id="1"]')!;
    const nameEl = row1.querySelector('.finder-row-name')!;
    const codeEl = row1.querySelector('code')!;
    expect(nameEl.textContent).toBe('条目1');
    expect(codeEl.textContent).toBe('1');

    // Pointerdown on data-no-drag name element does not start pointer drag
    await act(async () => {
      nameEl.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 80 }),
      );
    });
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 80 }),
      );
    });

    // Non-empty text selection blocks row pointer drag and row click from toggling checkbox
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '条目1',
      removeAllRanges: () => {},
    } as unknown as Selection);
    await act(async () => {
      row1.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 80 }),
      );
    });
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 80 }),
      );
    });
    await click(row1);
    expect(selected().has('1')).toBe(false);
    expect(api.targetListCommand).not.toHaveBeenCalled();
    getSelectionSpy.mockRestore();
  });
});
it('Sidebar has the 5-action compact toolbar (启动/停止/关闭/清理标签/整理窗口) and stops all task kinds', async () => {
  const selected = new Set(['00000000-0000-4000-8000-000000000001']);
  const onStop = vi.fn();
  const profile = {
    id: [...selected][0],
    alias: '浏览器',
    order: 0,
    groupId: null,
    online: true,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.58',
    capabilities: [],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  };
  vi.mocked(api.cleanupProfileTabs).mockResolvedValue({
    cleanedProfiles: 1,
    closedTabs: 2,
    skippedBusy: 0,
    skippedOffline: 0,
  });
  await act(async () =>
    root.render(
      <Sidebar
        workspace={
          {
            schemaVersion: 1,
            groups: [],
            profiles: [profile],
            combinations: [],
            records: [],
            support: {},
          } as never
        }
        selected={selected}
        onSelect={() => {}}
        onInspect={() => {}}
        mutate={async (work) => {
          await work();
        }}
        inspections={[]}
        inspectionAvailable={true}
        inspectionError=""
        busy={false}
        onCheck={() => {}}
        bumperRunningIds={[profile.id ?? '']}
        groupInviterRunningIds={[profile.id ?? '']}
        onStopModules={onStop}
      />,
    ),
  );
  const bar = host.querySelector('.selection-bar.compact-selection');
  expect(bar).toBeTruthy();
  expect(host.querySelector('.selection-bar-actions')).toBeNull();
  const actionButtons = [...(bar?.querySelectorAll('button.btn') ?? [])];
  const actionLabels = actionButtons.map((b) => b.textContent?.trim());
  expect(actionLabels).toEqual(['启动', '停止', '关闭', '清理标签', '整理窗口']);
  for (const btn of actionButtons) {
    expect(btn.className).not.toContain('btn-ghost');
    expect(btn.className).not.toContain('bg-transparent');
    expect(btn.className).not.toContain('text-[var(--text-2)]');
  }
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent === '清理标签') ?? null,
  );
  expect(api.cleanupProfileTabs).toHaveBeenCalledWith([...selected]);
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === '停止') ?? null);
  expect(onStop).toHaveBeenCalledWith([...selected]);
});
it('model keeps filtered selection and stable multi drag/nudge order', () => {
  expect(insertFinderIds(['a', 'b', 'c'], ['x', 'y'], 'b', true)).toEqual([
    'a',
    'b',
    'x',
    'y',
    'c',
  ]);
  expect(nudgeFinderIds(['a', 'b', 'c', 'd'], new Set(['b', 'c']), -1)).toEqual([
    'b',
    'c',
    'a',
    'd',
  ]);
  expect([
    ...rangeFinderSelection(new Set(['hidden']), ['a', 'b', 'c'], 'a', 'c', true, true),
  ]).toEqual(['hidden', 'a', 'b', 'c']);
});

async function pointerClick(el: Element, shiftKey = false) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, shiftKey }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
  });
}
it('native pointerdown/up/click checkbox toggles once, preserves anchor for shift and permits keyboard click', async () => {
  const selected = await mount();
  const inputs = host.querySelectorAll('.finder-check-cell input');
  expect(inputs[0]).toBeTruthy();
  await pointerClick(inputs[0] as Element);
  expect([...selected()]).toEqual(['1']);
  await pointerClick(inputs[2] as Element, true);
  expect([...selected()]).toEqual(['1', '2', '3']);
  await click(inputs[1] as Element);
  expect([...selected()]).toEqual(['1', '3']);
});
it('painting cannot start pointer drag, folder highlight tracks pointer and empty/unfiled accepts drops', async () => {
  await mount();
  const cell = host.querySelector('.finder-check-cell');
  await act(async () =>
    cell?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 10, clientY: 60 }),
    ),
  );
  expect(document.querySelector('[data-drag-ghost]')).toBeNull();
  await act(async () => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));

  const row = host.querySelector('.finder-row')!;
  const folder = host.querySelector('.finder-folder')!;
  const empty = host.querySelector('.finder-empty')!;
  vi.spyOn(folder, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 130,
    left: 0,
    right: 300,
    width: 300,
    height: 30,
  } as DOMRect);
  vi.spyOn(empty, 'getBoundingClientRect').mockReturnValue({
    top: 140,
    bottom: 180,
    left: 0,
    right: 300,
    width: 300,
    height: 40,
  } as DOMRect);

  await act(async () =>
    row.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 115 }),
    ),
  );
  expect(document.querySelector('[data-drag-ghost]')).toBeTruthy();
  expect(folder.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 160 }),
    ),
  );
  expect(empty.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 160 }),
    ),
  );
  expect(api.targetListCommand).toHaveBeenCalledWith({
    action: 'reorder-items',
    listKind: 'inviter_groups',
    folderId: id,
    orderedItemIds: ['1'],
  });
});
it('drop insertion uses final pointer coordinate even without prior pointermove over target', async () => {
  await mount();
  const row1 = host.querySelector('[data-finder-id="1"]')!;
  const row2 = host.querySelector('[data-finder-id="2"]')!;
  await act(async () =>
    row1.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 5 }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 15 }),
    ),
  );
  vi.spyOn(row2, 'getBoundingClientRect').mockReturnValue({
    top: 10,
    bottom: 30,
    left: 0,
    right: 300,
    width: 300,
    height: 20,
  } as DOMRect);
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 29 }),
    ),
  );
  expect(api.targetListCommand).toHaveBeenCalledWith({
    action: 'reorder-items',
    listKind: 'inviter_groups',
    folderId: null,
    orderedItemIds: ['2', '1', '3'],
  });
});
async function pasteDraft() {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => '12345\t测试小组' } });
  await act(async () => host.querySelector('.group-inviter-grid-scroll')?.dispatchEvent(event));
}
it('inviter add grid submits selected folder with each row', async () => {
  const add = vi.fn().mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <InviterWorkspacePage
        carrier="browser"
        state={{ groups: [], running: false, invitesPerGroup: 30 } as never}
        loaded={true}
        selectedTargetIds={new Set()}
        externalBusy={false}
        onAddGroups={add}
        onDeleteGroups={async () => {}}
        onRefresh={async () => {}}
        onSaveInvitesPerGroup={async () => {}}
        onStartBrowser={async () => {}}
        onStopBrowser={async () => {}}
      />,
    ),
  );
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('添加小组')) ?? null,
  );
  const select = host.querySelector<HTMLSelectElement>('[aria-label="添加小组归入分组"]');
  expect(select).toBeTruthy();
  await act(async () => {
    if (select) {
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await pasteDraft();
  await act(async () =>
    host
      .querySelector('form.group-inviter-add-modal')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(add).toHaveBeenCalledWith([{ groupId: '12345', groupName: '测试小组', folderId: id }]);
});
it('bumper add page grid submits the chosen folder', async () => {
  vi.mocked(api.bumperAction).mockResolvedValue({
    groups: [],
    pages: [],
    settings: BumperSettings.parse({}),
    comments: [],
    total: 0,
    running: false,
    statusText: '',
    profileCounts: {},
  });
  await act(async () =>
    root.render(
      <GroupBumperPage
        state={{
          groups: [],
          pages: [],
          settings: BumperSettings.parse({}),
          comments: [],
          total: 0,
          running: false,
          statusText: '',
          profileCounts: {},
        }}
        selected={new Set()}
        onState={() => {}}
        onMessage={() => {}}
      />,
    ),
  );
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('添加主页')) ?? null,
  );
  const select = host.querySelector<HTMLSelectElement>('[aria-label="添加主页归入分组"]');
  expect(select).toBeTruthy();
  await act(async () => {
    if (select) {
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await pasteDraft();
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === '保存') ?? null);
  expect(api.bumperAction).toHaveBeenCalledWith('pages/add', {
    items: [{ id: '12345', name: '测试小组', folderId: id }],
  });
});

it('Sidebar row menu supports repeated nudge and empty unfiled drop with child highlight preserved', async () => {
  const ids = [
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000013',
  ];
  const initial = ids.map((key, i) => ({
    id: key,
    alias: '浏览器' + i,
    order: i,
    groupId: id,
    online: true,
    phase: 'PAUSED',
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.58',
    capabilities: [],
    account: { state: 'unknown', id: null, name: null, avatar: null },
  }));
  function Render() {
    const [profiles, set] = React.useState(initial);
    vi.mocked(api.reorderProfiles).mockImplementation(async (group, order) => {
      set((prev) =>
        prev.map((p) =>
          order.includes(p.id) ? { ...p, groupId: group as string, order: order.indexOf(p.id) } : p,
        ),
      );
      return { saved: true };
    });
    return (
      <Sidebar
        workspace={
          {
            schemaVersion: 1,
            groups: [{ id, name: '收藏', color: 'blue', order: 0 }],
            profiles,
            combinations: [],
            records: [],
            support: {},
          } as never
        }
        selected={new Set([ids[1] ?? ''])}
        onSelect={() => {}}
        onInspect={() => {}}
        mutate={async (work) => {
          await work();
        }}
        inspections={[]}
        inspectionAvailable={true}
        inspectionError=""
        busy={false}
        onCheck={() => {}}
      />
    );
  }
  await act(async () => root.render(<Render />));
  const openMenuAndClick = async (rowLabel: string, itemText: string) => {
    await click(host.querySelector(`[aria-label="更多 · ${rowLabel}"]`));
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent?.includes(itemText),
    );
    await click(item ?? null);
  };
  await openMenuAndClick('浏览器1', '↑ 上移');
  expect(api.reorderProfiles).toHaveBeenLastCalledWith(id, [ids[1], ids[0], ids[2]]);
  await openMenuAndClick('浏览器1', '↓ 下移');
  await openMenuAndClick('浏览器1', '↓ 下移');
  expect(api.reorderProfiles).toHaveBeenLastCalledWith(id, [ids[0], ids[2], ids[1]]);
  const profileRow = host.querySelector('.profile-row')!;
  const head = [...host.querySelectorAll('.group-head')].find((e) =>
    e.textContent?.includes('未分组'),
  )!;
  const emptyGroup = host.querySelector('.group-empty')!;
  expect(head).toBeTruthy();
  expect(emptyGroup).toBeTruthy();
  vi.spyOn(head, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 130,
    left: 0,
    right: 280,
    width: 280,
    height: 30,
  } as DOMRect);
  vi.spyOn(emptyGroup, 'getBoundingClientRect').mockReturnValue({
    top: 135,
    bottom: 170,
    left: 0,
    right: 280,
    width: 280,
    height: 35,
  } as DOMRect);
  await act(async () =>
    profileRow.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
    ),
  );
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 115 }),
    ),
  );
  expect(head.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 150 }),
    ),
  );
  expect(emptyGroup.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    window.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 20, clientY: 150 }),
    ),
  );
  expect(api.reorderProfiles).toHaveBeenLastCalledWith(null, [ids[0]]);
});

it('FinderTargetList SelectByIdsDialog parses URLs, previews unmatched IDs, supports append/replace and auto-expands folded folders', async () => {
  let selected = new Set<string>(['1']);
  const folderItems = [
    { id: '1', name: '第一组', folderId: null, sortOrder: 0, avatarUrl: null, count: 1 },
    { id: '222333', name: '折叠组内小组', folderId: id, sortOrder: 0, avatarUrl: null, count: 2 },
    { id: '444555', name: '第三组', folderId: null, sortOrder: 1, avatarUrl: null, count: 3 },
  ];
  function Render() {
    const [chosen, setChosen] = React.useState(selected);
    return (
      <FinderTargetList
        listKind="inviter_groups"
        items={folderItems}
        selected={chosen}
        onSelect={(next) => {
          selected = next;
          setChosen(next);
        }}
        onChanged={async () => {}}
        onDelete={async () => {}}
        title="目标小组列表"
        countLabel="累计"
      />
    );
  }
  await act(async () => root.render(<Render />));
  // Fold the "收藏" folder first
  const folderToggle = [...host.querySelectorAll('.finder-folder-title')].find((b) =>
    b.textContent?.includes('收藏'),
  );
  await click(folderToggle ?? null);
  expect(host.querySelector('[data-finder-id="222333"]')).toBeNull();

  // Open SelectByIdsDialog via outer toolbar button
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('按 ID 选中')) ?? null,
  );
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="批量输入 ID"]');
  expect(textarea).toBeTruthy();
  await act(async () => {
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'https://www.facebook.com/groups/222333/\n444555, 222333, 999888');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(host.textContent).toContain('已识别 3 个去重 ID · 匹配到 2 项');
  expect(host.textContent).toContain('999888');

  // Click 追加选中 (2)
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('追加选中 (2)')) ??
      null,
  );
  expect([...selected]).toEqual(['1', '222333', '444555']);
  // Folded folder "收藏" auto-expanded!
  expect(host.querySelector('[data-finder-id="222333"]')).toBeTruthy();

  // Reopen and test 覆盖选中
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('按 ID 选中')) ?? null,
  );
  const textarea2 = host.querySelector<HTMLTextAreaElement>('[aria-label="批量输入 ID"]');
  await act(async () => {
    if (textarea2) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea2, '444555');
      textarea2.dispatchEvent(new Event('input', { bubbles: true }));
      textarea2.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('覆盖选中 (1)')) ??
      null,
  );
  expect([...selected]).toEqual(['444555']);
});

it('Sidebar SelectByIdsDialog matches FB ID, profile ID, and numeric browser shorthand, and GroupBumperPage normalizes inputs onBlur', async () => {
  const pid1 = '00000000-0000-4000-8000-000000000021';
  const pid2 = '00000000-0000-4000-8000-000000000022';
  let selected = new Set<string>();
  const profiles = [
    {
      id: pid1,
      alias: '用户 15',
      browserName: '用户 15',
      order: 0,
      groupId: id,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      extensionVersion: '0.3.58',
      capabilities: [],
      account: { state: 'ok', id: '100088881111', name: 'Alice', avatar: null },
    },
    {
      id: pid2,
      alias: '主力号B',
      browserName: '主力号B',
      order: 1,
      groupId: null,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      extensionVersion: '0.3.58',
      capabilities: [],
      account: { state: 'ok', id: '100088882222', name: 'Bob', avatar: null },
    },
  ];
  await act(async () =>
    root.render(
      <Sidebar
        workspace={
          {
            schemaVersion: 1,
            groups: [{ id, name: '收藏组', color: 'blue', order: 0 }],
            profiles,
            combinations: [],
            records: [],
            support: {},
          } as never
        }
        selected={selected}
        onSelect={(next) => {
          selected = next;
        }}
        onInspect={() => {}}
        mutate={async (work) => {
          await work();
        }}
        inspections={[]}
        inspectionAvailable={true}
        inspectionError=""
        busy={false}
        onCheck={() => {}}
      />,
    ),
  );
  await click(host.querySelector('[aria-label="按 ID 选中浏览器"]'));
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="批量输入 ID"]');
  await act(async () => {
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '15\n100088882222');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('覆盖选中 (2)')) ??
      null,
  );
  expect([...selected]).toEqual([pid1, pid2]);

  // Also test GroupBumperPage warning banner & onBlur normalization
  vi.mocked(api.bumperAction).mockResolvedValue({
    groups: [],
    pages: [],
    settings: BumperSettings.parse({}),
    comments: [],
    total: 0,
    running: false,
    statusText: '',
    profileCounts: {},
  });
  await act(async () =>
    root.render(
      <GroupBumperPage
        state={{
          groups: [],
          pages: [],
          settings: BumperSettings.parse({}),
          comments: [],
          total: 0,
          running: false,
          statusText: '',
          profileCounts: {},
        }}
        selected={new Set()}
        onState={() => {}}
        onMessage={() => {}}
      />,
    ),
  );
  expect(host.querySelector('.bumper-warning-banner')?.textContent).toContain('留言列表为空');
  await click(host.querySelector('button[aria-label="高级参数"]'));
  const probInput = document.querySelector<HTMLInputElement>('input[aria-label="likeProbability"]');
  expect(probInput).toBeTruthy();
  await act(async () => {
    if (probInput) {
      probInput.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(probInput, '125.6');
      probInput.dispatchEvent(new Event('input', { bubbles: true }));
      probInput.dispatchEvent(new Event('change', { bubbles: true }));
      probInput.blur();
    }
  });
  expect(api.bumperAction).toHaveBeenCalledWith(
    'settings',
    expect.objectContaining({ likeProbability: 100 }),
  );
});

for (const mode of ['group-bumper', 'page-bumper'] as const) {
  for (const dirty of [false, true]) {
    it(`comment editor ${mode} refreshes untouched text and preserves dirty edits with a save baseline (${dirty})`, async () => {
      const original = [{ id, text: 'used comment', usedCount: 0, createdAt: 0 }];
      const state = {
        groups: [],
        pages: [],
        settings: BumperSettings.parse({ consumeCommentOnUse: true }),
        pageSettings: BumperSettings.parse({ consumeCommentOnUse: true }),
        comments: original,
        pageComments: original,
        total: 0,
        running: false,
        statusText: '',
        profileCounts: {},
      };
      const render = async (next: typeof state) =>
        act(async () =>
          root.render(
            <GroupBumperPage
              mode={mode}
              state={next}
              selected={new Set()}
              onState={() => {}}
              onMessage={() => {}}
            />,
          ),
        );
      await render(state);
      await click(
        [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('留言列表')) ??
          null,
      );
      const area = host.querySelector<HTMLTextAreaElement>('[aria-label="留言话术"]')!;
      expect(area.value).toBe('used comment');
      if (dirty) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
            area,
            'used comment\nnew edit',
          );
          area.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      const next = { ...state, comments: [], pageComments: [] };
      vi.mocked(api.bumperAction).mockResolvedValue(next);
      await render(next);
      expect(area.value).toBe(dirty ? 'used comment\nnew edit' : '');
      await click(
        [...host.querySelectorAll('.bumper-modal-footer button')].find(
          (b) => b.textContent?.trim() === '保存',
        ) ?? null,
      );
      expect(api.bumperAction).toHaveBeenCalledWith(
        mode === 'page-bumper' ? 'page-comments' : 'comments',
        {
          texts: dirty ? ['used comment', 'new edit'] : [],
          scope: mode === 'page-bumper' ? 'page' : 'group',
          consumeCommentOnUse: true,
          baseComments: dirty ? [{ id, text: 'used comment' }] : [],
        },
      );
    });
  }
}

it('FeatureNavRail supports collapsible rail persisted in localStorage, group folding, and module selection', async () => {
  window.localStorage.removeItem('workbench.nav-rail-collapsed.v1');
  const selectedModules: string[] = [];
  await act(async () =>
    root.render(
      <FeatureNavRail
        activeModule="active-accounts"
        items={[
          {
            id: 'active-accounts',
            group: 'automation',
            title: '活跃账号',
            icon: 'active-accounts',
            runningCount: 2,
          },
          {
            id: 'group-inviter',
            group: 'automation',
            title: '小组邀请人',
            icon: 'group-inviter',
            runningCount: 0,
          },
          {
            id: 'group-bumper',
            group: 'automation',
            title: '小组顶贴',
            icon: 'group-bumper',
            runningCount: 1,
          },
          {
            id: 'records',
            group: 'monitor',
            title: '执行记录',
            icon: 'records',
            badgeCount: 3,
            badgeTone: 'err',
          },
        ]}
        onSelectModule={(mod) => selectedModules.push(mod)}
      />,
    ),
  );

  const rail = host.querySelector('.feature-nav-rail');
  expect(rail?.classList.contains('is-collapsed')).toBe(false);
  expect(host.textContent).toContain('活跃账号');
  expect(host.textContent).toContain('2运行');
  expect(host.textContent).toContain('执行记录');

  await click(
    [...host.querySelectorAll('.nav-rail-item')].find((b) => b.textContent?.includes('执行记录')) ??
      null,
  );
  expect(selectedModules).toEqual(['records']);

  await click(host.querySelector('button[aria-label="折叠功能导航"]'));
  expect(rail?.classList.contains('is-collapsed')).toBe(true);
  expect(window.localStorage.getItem('workbench.nav-rail-collapsed.v1')).toBe('1');

  await click(host.querySelector('button[aria-label="展开功能导航"]'));
  expect(rail?.classList.contains('is-collapsed')).toBe(false);
  expect(window.localStorage.getItem('workbench.nav-rail-collapsed.v1')).toBe('0');
});

it('CombinationList uses unified isProfileBusy to disable start and schedule when selected profiles are busy in active-accounts, group-inviter, or group-bumper', async () => {
  const pidTask = '10000000-0000-4000-8000-000000000001';
  const pidInviter = '10000000-0000-4000-8000-000000000002';
  const pidBumper = '10000000-0000-4000-8000-000000000003';
  const selectedIds = new Set([pidTask, pidInviter, pidBumper]);
  const controls = projectSelectionControls(selectedIds, {
    activeModule: 'active-accounts',
    tasks: {
      dispatchEnabled: true,
      settings: { maxConcurrentProfiles: 2 },
      plans: [
        {
          id: '20000000-0000-4000-8000-000000000001',
          batchId: '50000000-0000-4000-8000-000000000001',
          profileId: pidTask,
          combinationId: '40000000-0000-4000-8000-000000000001',
          version: 1,
          accountId: '1',
          snapshot: {
            name: '组合A',
            note: '',
            randomOrder: false,
            loop: { mode: 'finite', rounds: 1 },
            steps: [
              {
                id: '30000000-0000-4000-8000-000000000001',
                type: 'video',
                durationMinutes: 5,
                likeProbability: 0,
                maxLikes: 1,
                minLikeCount: 0,
              },
            ],
          },
          state: 'RUNNING',
          reason: '',
          controlMode: null,
          controlRequestId: null,
          controlConfirmed: true,
          round: 1,
          position: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      currentSteps: [],
    },
    groupInviterRunningIds: [pidInviter],
    bumperRunningIds: [pidBumper],
  });

  await act(async () =>
    root.render(
      <CombinationList
        rows={[
          {
            id: '40000000-0000-4000-8000-000000000001',
            version: 1,
            revision: 1,
            updatedAt: 1000,
            saved: {
              name: '测试启动组合',
              note: '',
              randomOrder: false,
              loop: { mode: 'finite', rounds: 1 },
              steps: [
                {
                  id: '30000000-0000-4000-8000-000000000001',
                  type: 'video',
                  durationMinutes: 5,
                  likeProbability: 0,
                },
              ],
            },
            draft: null,
          },
        ]}
        selectedCount={selectedIds.size}
        selectedIds={selectedIds}
        isProfileBusy={controls.isProfileBusy}
        profiles={[
          {
            id: pidTask,
            alias: 'B1',
            browserName: 'B1',
            groupId: null,
            order: 0,
            online: true,
            synced: true,
            phase: 'CONNECTED',
            unresolved: 0,
            extensionVersion: '0.3.58',
            capabilities: [],
            account: { state: 'logged-in', id: '1', name: 'B1', avatar: null },
          },
          {
            id: pidInviter,
            alias: 'B2',
            browserName: 'B2',
            groupId: null,
            order: 1,
            online: true,
            synced: true,
            phase: 'CONNECTED',
            unresolved: 0,
            extensionVersion: '0.3.58',
            capabilities: [],
            account: { state: 'logged-in', id: '2', name: 'B2', avatar: null },
          },
          {
            id: pidBumper,
            alias: 'B3',
            browserName: 'B3',
            groupId: null,
            order: 2,
            online: true,
            synced: true,
            phase: 'CONNECTED',
            unresolved: 0,
            extensionVersion: '0.3.58',
            capabilities: [],
            account: { state: 'logged-in', id: '3', name: 'B3', avatar: null },
          },
        ]}
        capabilities={{
          types: ['feed', 'video', 'post', 'marketplace', 'friends'],
          combinations: [
            {
              id: '40000000-0000-4000-8000-000000000001',
              version: 1,
              enabled: true,
              reason: '',
            },
          ],
        }}
        resourceSummaries={[]}
        onEdit={() => {}}
        onNew={() => {}}
        onCopy={() => {}}
        onResources={() => {}}
        onStart={() => {}}
      />,
    ),
  );

  const startBtn = host.querySelector<HTMLButtonElement>('button.combo-start');
  expect(startBtn?.disabled).toBe(true);
  expect(startBtn?.getAttribute('title')).toContain('3 份资料已有任务');

  const moreBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === '更多操作',
  );
  await act(async () => {
    moreBtn?.click();
  });
  const scheduleBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('定时启动'),
  );
  expect(scheduleBtn).toBeUndefined();
});

it('GroupBumperPage supports ID-only paste without name and collapses low-frequency settings into 高级参数 popover', async () => {
  vi.mocked(api.bumperAction).mockResolvedValue({
    groups: [],
    pages: [],
    settings: BumperSettings.parse({}),
    comments: [],
    total: 8,
    running: false,
    statusText: '就绪',
    profileCounts: {},
  });
  const onOpenRecords = vi.fn();
  await act(async () =>
    root.render(
      <GroupBumperPage
        state={{
          groups: [],
          pages: [],
          settings: BumperSettings.parse({}),
          comments: [],
          total: 8,
          running: false,
          statusText: '就绪',
          profileCounts: {},
        }}
        selected={new Set()}
        onState={() => {}}
        onOpenRecords={onOpenRecords}
        onMessage={() => {}}
      />,
    ),
  );
  // Top header h1 and count chips are removed; searchMode and maxPostAgeHours remain prominent
  expect(host.querySelector('.bumper-sticky-header h1')).toBeNull();
  expect(host.querySelector('.bumper-sticky-header .count-chip')).toBeNull();
  expect(host.querySelector('.bumper-search-highlight select[aria-label="查找方式"]')).toBeTruthy();
  expect(
    host.querySelector('.bumper-search-highlight input[aria-label="maxPostAgeHours"]'),
  ).toBeTruthy();

  // Low-frequency inputs are hidden until 高级参数 popover is opened
  expect(host.querySelector('input[aria-label="dailyMaxLikesPerAccount"]')).toBeNull();
  expect(host.querySelector('input[aria-label="maxLikesPerPost"]')).toBeNull();
  expect(host.querySelector('input[aria-label="likeProbability"]')).toBeNull();
  expect(host.querySelector('input[aria-label="commentProbability"]')).toBeNull();
  expect(host.querySelector('input[aria-label="maxPostsPerGroupPage"]')).toBeNull();

  await click(host.querySelector('button[aria-label="高级参数"]'));
  const groups = document.querySelectorAll('.bumper-advanced-panel .bumper-advanced-group');
  expect(groups.length).toBe(2);
  expect(groups[0]?.querySelector('input[aria-label="dailyMaxLikesPerAccount"]')).toBeTruthy();
  expect(
    groups[0]?.querySelector<HTMLInputElement>('input[aria-label="maxLikesPerPost"]')?.value,
  ).toBe('50');
  expect(groups[0]?.querySelector('input[aria-label="likeProbability"]')).toBeTruthy();
  expect(groups[0]?.querySelector('input[aria-label="commentProbability"]')).toBeTruthy();
  expect(groups[1]?.querySelector('input[aria-label="maxPostsPerGroupPage"]')).toBeTruthy();

  // Click 顶贴记录 delegates directly to unified PostBumpRecordsPage
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('顶贴记录')) ?? null,
  );
  expect(onOpenRecords).toHaveBeenCalledTimes(1);

  // Add page with URL only (no name)
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('添加主页')) ?? null,
  );
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: () =>
        'https://www.facebook.com/profile.php?id=61578473189457\nhttps://www.facebook.com/100085926219692',
    },
  });
  await act(async () => host.querySelector('.group-inviter-grid-scroll')?.dispatchEvent(event));
  expect(host.textContent).toContain('已填有效主页 2 个');
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === '保存') ?? null);
  expect(api.bumperAction).toHaveBeenCalledWith('pages/add', {
    items: [
      { id: '61578473189457', name: '', folderId: null },
      { id: '100085926219692', name: '', folderId: null },
    ],
  });
});

for (const [runningCount, queuedCount] of [
  [10, 5],
  [0, 0],
]) {
  const totalActive = runningCount + queuedCount;
  it(`WO51: combination shows ${runningCount} running and ${queuedCount} queued with accurate delete protection`, async () => {
    type Props = React.ComponentProps<typeof CombinationList>;
    const comboId = '40000000-0000-4000-8000-000000000001';
    const saved = {
      name: 'WO51组合',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite' as const, rounds: 1 },
      steps: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          type: 'feed' as const,
          durationMinutes: 1,
          maxLikes: 0,
          minLikeCount: 0,
        },
      ],
    };
    const props: Props = {
      rows: [{ id: comboId, version: 1, revision: 1, updatedAt: 1, saved, draft: null }],
      selectedCount: 0,
      onEdit: vi.fn(),
      onNew: vi.fn(),
      onCopy: vi.fn(),
      onDelete: vi.fn(),
      onDeleteMany: vi.fn(),
      onResources: vi.fn(),
      resourceSummaries: [],
      runtime: {
        plans: [
          ...Array.from({ length: runningCount }, (_, i) => ({
            id: `plan-r-${i}`,
            combinationId: comboId,
            profileId: `profile-r-${i}`,
            state: 'RUNNING' as const,
          })),
          ...Array.from({ length: queuedCount }, (_, i) => ({
            id: `plan-q-${i}`,
            combinationId: comboId,
            profileId: `profile-q-${i}`,
            state: 'QUEUED' as const,
          })),
        ],
      } as Props['runtime'],
    };
    await act(async () => root.render(<CombinationList {...props} />));
    expect(host.querySelector('.combo-stat:not(.resource-count)')?.textContent).toContain(
      `${totalActive}使用中浏览器`,
    );
    const more = host.querySelector('button[aria-label="更多操作"]');
    await click(more);
    const deletion = [...document.querySelectorAll('button')].find(
      (el) => el.textContent?.trim() === '删除',
    );
    expect(deletion).toBeTruthy();
    expect(deletion?.disabled).toBe(totalActive > 0);
    const manage = [...host.querySelectorAll('button')].find(
      (el) => el.textContent?.trim() === '批量管理',
    );
    await click(manage!);
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="选择组合 WO51组合"]')?.disabled,
    ).toBe(totalActive > 0);
  });
}

it('WO-U4 UI: GroupPosterPage renders 4-char 小组列表 with 0 default selection, no outer 7-day pills, shared_groups URL parsing, compact matrix with column resizers, floating + button, and binary thumbnail route', async () => {
  expect(
    normalizeTargetToken(
      'shared_groups',
      'https://www.facebook.com/groups/3017439278594998/?ref=share',
    ),
  ).toBe('3017439278594998');

  const posterGroups = [
    {
      id: '3017439278594998',
      name: 'Myanmar Group 1',
      avatarUrl: null,
      folderId: null,
      sortOrder: 0,
      totalBumpedCount: 2,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: '1834045181273689',
      name: 'Myanmar Group 2',
      avatarUrl: null,
      folderId: null,
      sortOrder: 1,
      totalBumpedCount: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const posterMaterials = [
    {
      id: 'mat-thumb-1',
      caption: 'Amen test caption',
      mediaSource: 'D:\\videos\\clip.mp4',
      background: 'plain' as const,
      localFilePath: 'D:\\videos\\clip.mp4',
      mediaKind: 'video' as const,
      cacheStatus: 'ready' as const,
      cacheError: null,
      hasThumbnail: true,
      selected: true,
      usedCount: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 777888,
    },
  ];
  const posterStatePayload = {
    groups: posterGroups,
    materials: posterMaterials,
    settings: PosterSettings.parse({}),
    total: 2,
    running: false,
    statusText: '请选择账号、目标小组和发帖素材',
    profileCounts: {},
  };
  vi.mocked(api.posterAction).mockResolvedValue(posterStatePayload);
  vi.mocked(api.posterState).mockResolvedValue(posterStatePayload);
  vi.mocked(api.posterLogs).mockResolvedValue([]);

  await act(async () =>
    root.render(
      <GroupPosterPage
        state={posterStatePayload}
        selected={new Set()}
        onState={() => {}}
        onMessage={() => {}}
      />,
    ),
  );

  // 1. Main page renders full-width post card grid without outer 7-day pills
  expect(host.querySelector('.bumper-sticky-header .poster-daily-pills')).toBeNull();
  expect(host.querySelectorAll('.poster-rect-card').length).toBe(1);

  // 2. Open "发帖 / 定时" modal -> embeds FinderTargetList ("小组列表") and PosterProfileSelector ("发帖账号")
  const dispatchBtn = host.querySelector<HTMLButtonElement>('.poster-card-post-btn');
  expect(dispatchBtn).toBeTruthy();
  await click(dispatchBtn);
  const toolbarTitle = host.querySelector('.finder-toolbar > strong')?.textContent;
  expect(toolbarTitle).toBe('小组列表');

  // 3. Outer "按 ID 选中" button inside dispatch modal works with shared_groups Facebook URLs
  const selectIdsBtn = [...host.querySelectorAll('.finder-toolbar button')].find((b) =>
    b.textContent?.includes('按 ID 选中'),
  );
  expect(selectIdsBtn).toBeTruthy();
  await click(selectIdsBtn ?? null);
  const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="批量输入 ID"]');
  await act(async () => {
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'https://www.facebook.com/groups/3017439278594998/');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(host.textContent).toContain('已识别 1 个去重 ID · 匹配到 1 项');
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('覆盖选中 (1)')) ??
      null,
  );
  expect(host.textContent).toContain('已选 1/2');

  // 4. "刷新头像" is inside ⋯ menu and calls api.posterAction('groups/refresh', { ids: [...] })
  const moreBtn = host.querySelector('.finder-toolbar button[aria-label="更多小组列表操作"]');
  await click(moreBtn);
  const refreshAvatarBtn = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '刷新头像',
  );
  expect(refreshAvatarBtn).toBeTruthy();
  await click(refreshAvatarBtn ?? null);
  expect(api.posterAction).toHaveBeenCalledWith('groups/refresh', { ids: ['3017439278594998'] });

  // Close dispatch modal and open table editor ("表格编辑")
  await click(host.querySelector('.poster-dispatch-right-head button[aria-label="关闭弹窗"]'));
  const tableBtn = [...host.querySelectorAll('.poster-cards-toolbar button')].find((b) =>
    b.textContent?.includes('表格编辑'),
  );
  await click(tableBtn ?? null);

  // 5. PosterMaterialMatrix streamlined buttons, 6 column resizers (including AI label), floating + button, and video preview
  expect(host.textContent).not.toContain('填入测试素材');
  expect(host.textContent).not.toContain('复制整表');
  expect(host.querySelectorAll('.poster-col-resizer').length).toBe(6);
  expect(host.querySelector('.poster-floating-add-row-btn')?.textContent?.trim()).toMatch(
    /^[+＋]$/,
  );
  const videoThumb = host.querySelector<HTMLVideoElement>(
    'video[src*="/api/workspace/group-poster/materials/media"]',
  );
  expect(videoThumb).toBeTruthy();
  expect(videoThumb?.getAttribute('src')).toContain('id=mat-thumb-1&v=777888#t=0.1');
});

it('bulk copy buttons copy TSV post & bump records across GroupPosterPage, DetailModal, GroupBumperPage, and PostBumpRecordsPage', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  vi.mocked(api.targetFolders).mockResolvedValue([]);

  const samplePosterLog = {
    id: 'pl-1',
    profileId: id,
    accountId: '615501',
    accountName: '测试专页',
    accountAvatar: null,
    identityType: 'page' as const,
    groupId: '88001',
    groupName: '缅甸交流群',
    groupAvatar: null,
    materialId: 'mat-1',
    captionPreview: '第一行文案\n第二行文案',
    postId: '99001122',
    postUrl: 'https://www.facebook.com/groups/88001/posts/99001122/',
    postedAt: new Date(2026, 10, 12, 10, 0, 0).getTime(),
  };
  const sampleBumperLog = {
    id: 'bl-1',
    profileId: id,
    accountId: '100088',
    groupId: '88001',
    groupName: '缅甸交流群',
    pageId: '615501',
    pageName: '测试专页',
    postId: '99001122',
    postUrl: 'https://www.facebook.com/groups/88001/posts/99001122/',
    liked: true,
    commentText: '顶贴支持\n赞',
    bumpedAt: new Date(2026, 10, 12, 11, 0, 0).getTime(),
    sourceMode: 'group' as const,
  };
  const profile = {
    id,
    browserName: '用户8',
    alias: '浏览器8',
    order: 0,
    groupId: null,
    online: true,
    phase: 'PAUSED' as const,
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.82',
    capabilities: [],
    account: { state: 'logged_in' as const, id: '100088', name: 'Zhang', avatar: null },
  };

  vi.mocked(api.posterLogs).mockResolvedValue([samplePosterLog]);

  // 1. GroupPosterPage 发帖记录跳转 + 单条贴文详情弹窗
  const onOpenPosterRecords = vi.fn();
  const posterMessages: string[] = [];
  await act(async () =>
    root.render(
      <GroupPosterPage
        state={{
          groups: [],
          materials: [
            {
              id: 'mat-1',
              caption: '第一行文案\n第二行文案',
              mediaSource: '',
              localFilePath: null,
              mediaKind: 'none',
              background: 'plain',
              aiLabel: 'default',
              cacheStatus: 'none',
              cacheError: null,
              thumbnailDataUrl: null,
              selected: true,
              usedCount: 1,
              sortOrder: 0,
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
            },
          ],
          settings: PosterSettings.parse({}),
          running: false,
          statusText: '',
          total: 1,
          dailyStats: [],
          profileCounts: {},
          pendingReviewOperations: [],
          tasks: [],
          postedGroupIdsByMaterial: { 'mat-1': ['88001'] },
          activeGroupsByMaterial: {},
        }}
        selected={new Set()}
        profiles={[profile]}
        onState={() => {}}
        onOpenRecords={onOpenPosterRecords}
        onMessage={(m) => posterMessages.push(m)}
      />,
    ),
  );

  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('发帖记录')) ?? null,
  );
  expect(onOpenPosterRecords).toHaveBeenCalledTimes(1);

  // Open 详情 modal on the material card: slim summary has 复制链接 + jump-to-records action (no embedded TSV bulk copy)
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('详情')) ?? null,
  );
  expect(host.textContent).toContain('已发确认');
  expect(host.textContent).not.toContain('批量复制全部');
  const copyLinkBtn = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('复制链接'),
  );
  expect(copyLinkBtn).toBeTruthy();
  await click(copyLinkBtn ?? null);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0]?.[0]).toBe(samplePosterLog.postUrl);
  const jumpRecordsBtn = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('前往「数据与记录」查看完整明细'),
  );
  expect(jumpRecordsBtn).toBeTruthy();
  await click(jumpRecordsBtn ?? null);
  expect(onOpenPosterRecords).toHaveBeenCalledTimes(2);

  // 2. GroupBumperPage 顶贴记录跳转
  const onOpenBumperRecords = vi.fn();
  await act(async () =>
    root.render(
      <GroupBumperPage
        state={{
          groups: [],
          pages: [],
          comments: [],
          pageComments: [],
          settings: BumperSettings.parse({}),
          pageSettings: BumperSettings.parse({}),
          running: false,
          pageBumperRunning: false,
          statusText: '',
          pageBumperStatusText: '',
          total: 1,
          pageTotal: 0,
          profileCounts: {},
          pageBumperProfileCounts: {},
          pendingReviewOperations: [],
        }}
        selected={new Set()}
        profiles={[profile]}
        onState={() => {}}
        onOpenRecords={onOpenBumperRecords}
        onMessage={() => {}}
      />,
    ),
  );
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('顶贴记录')) ?? null,
  );
  expect(onOpenBumperRecords).toHaveBeenCalledTimes(1);

  // 2b. PostBumpRecordsPage 按当前可见列动态复制 + 单账本清空确认弹窗
  vi.mocked(api.postBumpRecords).mockResolvedValue({
    records: [
      {
        id: 'pbr-post-1',
        recordType: 'post',
        carrier: 'browser',
        status: 'success',
        profileId: id,
        windowName: 'Browser 8',
        accountId: samplePosterLog.accountId,
        accountName: samplePosterLog.accountName,
        accountAvatarUrl: '',
        groupId: samplePosterLog.groupId,
        groupName: samplePosterLog.groupName,
        groupAvatarUrl: '',
        pageId: '',
        pageName: '',
        pageAvatarUrl: '',
        postId: samplePosterLog.postId,
        postUrl: samplePosterLog.postUrl,
        liked: false,
        commentText: null,
        storyShared: false,
        captionPreview: samplePosterLog.captionPreview,
        errorReason: '',
        sourceLogId: samplePosterLog.id,
        createdAt: samplePosterLog.postedAt,
      },
    ],
    total: 1,
    hasMore: false,
    statusCounts: { total: 1, confirmed: 1, pending: 0, failed: 0 },
  });
  await act(async () =>
    root.render(<PostBumpRecordsPage initialTab="posts" onNotify={() => {}} />),
  );
  const copyLedgerBtn = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('复制表格'),
  );
  expect(copyLedgerBtn).toBeTruthy();
  await click(copyLedgerBtn ?? null);
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(writeText.mock.calls[1]?.[0]).toContain(samplePosterLog.postUrl);
  const clearBtn = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '清空全部',
  );
  expect(clearBtn).toBeTruthy();
  await click(clearBtn ?? null);
  expect(host.querySelector('dialog')).toBeTruthy();
  expect(host.textContent).toContain('防重去重账本');
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '取消') ?? null,
  );
});

it('Sidebar header collapse button triggers onHideSidebar', async () => {
  const onHideSidebar = vi.fn();
  const profile = {
    id,
    browserName: '用户8',
    alias: '浏览器8',
    order: 0,
    groupId: null,
    online: true,
    phase: 'PAUSED' as const,
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.82',
    capabilities: [],
    account: { state: 'logged_in' as const, id: '100088', name: 'Zhang', avatar: null },
  };
  await act(async () =>
    root.render(
      <Sidebar
        workspace={
          {
            schemaVersion: 1,
            groups: [],
            profiles: [profile],
            combinations: [],
            records: [],
            support: {},
          } as never
        }
        selected={new Set()}
        onSelect={() => {}}
        onInspect={() => {}}
        mutate={async (work) => {
          await work();
        }}
        inspections={[]}
        inspectionAvailable={true}
        inspectionError=""
        busy={false}
        onCheck={() => {}}
        onHideSidebar={onHideSidebar}
      />,
    ),
  );
  await click(host.querySelector('[aria-label="收起设备栏"]'));
  expect(onHideSidebar).toHaveBeenCalledTimes(1);
});

it('PosterMaterialCardGrid renders all 5 action buttons and ⏱ 加入排班 triggers unified quick schedule seed', async () => {
  const profile = {
    id,
    browserName: '用户8',
    alias: '用户8',
    order: 0,
    groupId: null,
    online: true,
    phase: 'PAUSED' as const,
    synced: true,
    unresolved: 0,
    extensionVersion: '0.3.82',
    capabilities: [],
    account: { state: 'logged_in' as const, id: '61593615564708', name: '用户8', avatar: null },
  };
  const onQuickSchedule = vi.fn();
  await act(async () =>
    root.render(
      <GroupPosterPage
        state={{
          groups: [
            {
              id: '3017439278594998',
              name: '测试小组1',
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalBumpedCount: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          materials: [
            {
              id: 'mat-card-sched',
              caption: '测试贴文',
              mediaSource: '',
              localFilePath: null,
              mediaKind: 'none',
              background: 'plain',
              aiLabel: 'default',
              cacheStatus: 'none',
              cacheError: null,
              thumbnailDataUrl: null,
              selected: true,
              usedCount: 2,
              sortOrder: 0,
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
            },
          ],
          settings: PosterSettings.parse({}),
          running: false,
          statusText: '',
          total: 2,
          profileCounts: {},
          pendingReviewOperations: [],
          tasks: [],
          postedGroupIdsByMaterial: {},
          activeGroupsByMaterial: {},
        }}
        selected={new Set([id])}
        profiles={[profile]}
        onState={() => {}}
        onQuickSchedule={onQuickSchedule}
        onMessage={() => {}}
      />,
    ),
  );

  const actionBtns = [...host.querySelectorAll('.poster-rect-card-actions > button')].map((b) =>
    b.textContent?.trim(),
  );
  expect(actionBtns).toEqual(['发帖', '加入排班', '详情 (2)', '编辑', '删除']);

  const schedBtn = host.querySelector<HTMLButtonElement>('.poster-card-schedule-btn');
  await click(schedBtn);
  expect(onQuickSchedule).toHaveBeenCalledTimes(1);
  expect(onQuickSchedule).toHaveBeenCalledWith(
    expect.objectContaining({
      carrier: 'browser',
      targetIds: [id],
      steps: [
        expect.objectContaining({
          type: 'group-poster',
          materialIds: ['mat-card-sched'],
          groupIds: ['3017439278594998'],
        }),
      ],
    }),
  );
});

it('BlueStacks Page Bumper renders nav rail item, single-column Page UI, and dispatches page-settings + bumper/start-page', async () => {
  const navItems = buildFeatureNavItems({
    carrier: 'bluestacks',
    activeAccountRunningCount: 0,
    groupInviterRunning: false,
    inviterRunningCount: 0,
    groupBumperRunning: false,
    bumperRunningCount: 0,
    pageBumperRunningCount: 0,
    groupPosterRunningCount: 0,
    bluestacksBumperRunningCount: 1,
    bluestacksPageBumperRunningCount: 2,
    attentionCount: 0,
  });
  const bsItems = navItems.filter((item) => item.group === 'automation');
  expect(bsItems.map((i) => ({ id: i.id, title: i.title, runningCount: i.runningCount }))).toEqual([
    { id: 'bluestacks-active', title: '活跃账号', runningCount: 0 },
    { id: 'bluestacks-group-poster', title: '小组发帖', runningCount: 0 },
    { id: 'bluestacks-group-bumper', title: '小组顶贴', runningCount: 1 },
    { id: 'bluestacks-page-bumper', title: '专页顶贴', runningCount: 2 },
    { id: 'bluestacks-group-inviter', title: '小组邀请人', runningCount: 0 },
  ]);

  const clickedNav: string[] = [];
  await act(async () =>
    root.render(
      <FeatureNavRail
        activeModule="bluestacks-page-bumper"
        items={navItems}
        onSelectModule={(mod) => clickedNav.push(mod)}
      />,
    ),
  );
  const pageNavBtn = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('专页顶贴'),
  );
  expect(pageNavBtn).toBeTruthy();
  await click(pageNavBtn ?? null);
  expect(clickedNav).toEqual(['bluestacks-page-bumper']);

  const instId = '6f625a7b-4dc1-4c40-bb6f-4ca3b7cf28bc';
  const mockBsState = {
    config: {
      installDir: null,
      confPath: null,
      detectedInstallDir: 'C:\\Program Files\\BlueStacks_nxt',
      detectedConfPath: 'D:\\BlueStacks_nxt\\bluestacks.conf',
      adbReady: true,
      playerReady: true,
    },
    folders: [],
    instances: [],
    bumperSettings: BumperSettings.parse({ maxPostsPerPage: 3, maxConcurrentProfiles: 4 }),
    pageBumperSettings: BumperSettings.parse({ maxPostsPerPage: 5, maxConcurrentProfiles: 2 }),
    running: false,
    statusText: '请选择蓝蝶窗口、目标小组和目标主页',
    profileCounts: {},
    total: 10,
    pageBumperRunning: false,
    pageBumperStatusText: '请选择蓝蝶窗口和目标专页',
    pageBumperProfileCounts: {},
    pageTotal: 4,
    launchingIds: [],
    closingIds: [],
    inspectingIds: [],
  };
  vi.mocked(api.targetFolders).mockResolvedValue([]);
  vi.mocked(api.bluestacksAction).mockResolvedValue(mockBsState as never);
  vi.mocked(api.bumperState).mockResolvedValue({
    groups: [],
    pages: [],
    settings: BumperSettings.parse({}),
    comments: [],
    total: 0,
    running: false,
    statusText: '',
    profileCounts: {},
  });

  await act(async () =>
    root.render(
      <GroupBumperPage
        mode="bluestacks-page-bumper"
        state={{
          groups: [
            {
              id: '111222333',
              name: '不应该显示的小组',
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalBumpedCount: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          pages: [
            {
              id: '61588452821652',
              name: 'Grace Myanmar Page',
              avatarUrl: null,
              folderId: null,
              sortOrder: 0,
              totalBumpedCount: 4,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          settings: BumperSettings.parse({}),
          pageSettings: BumperSettings.parse({}),
          comments: [],
          pageComments: [{ id, text: '阿门', usedCount: 0, createdAt: 1 }],
          total: 10,
          pageTotal: 4,
          running: false,
          pageBumperRunning: false,
          statusText: '',
          pageBumperStatusText: '',
          profileCounts: {},
          pageBumperProfileCounts: {},
        }}
        selected={new Set([instId])}
        bluestacksState={mockBsState}
        onBluestacksState={() => {}}
        onState={() => {}}
        onMessage={() => {}}
      />,
    ),
  );

  // Single column: Page list rendered, Group list hidden, concurrency unified into topbar
  expect(host.textContent).toContain('专页列表');
  expect(host.textContent).not.toContain('小组列表');
  expect(host.textContent).not.toContain('最大并发模拟器数');
  expect(host.textContent).toContain('顶贴记录 (4 条)');

  // Select the Page row checkbox and click Start
  const pageCheckbox = host.querySelector<HTMLInputElement>('.finder-row input[type="checkbox"]');
  expect(pageCheckbox).toBeTruthy();
  await click(pageCheckbox);

  const startBtn = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('运行 (1窗 · 1专页)'),
  );
  expect(startBtn).toBeTruthy();
  expect((startBtn as HTMLButtonElement | undefined)?.disabled).toBe(false);

  // Modify maxPostsPerPage and verify page-settings action
  const scanInput = host.querySelector<HTMLInputElement>('input[aria-label="maxPostsPerPage"]');
  expect(scanInput?.value).toBe('5');
  await act(async () => {
    if (scanInput) {
      scanInput.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        scanInput,
        '6',
      );
      scanInput.dispatchEvent(new Event('input', { bubbles: true }));
      scanInput.dispatchEvent(new Event('change', { bubbles: true }));
      scanInput.blur();
    }
  });
  expect(api.bluestacksAction).toHaveBeenCalledWith(
    'page-settings',
    expect.objectContaining({ maxPostsPerPage: 6 }),
  );

  await click(startBtn ?? null);
  expect(api.bluestacksAction).toHaveBeenCalledWith('bumper/start-page', {
    profileIds: [instId],
    pageIds: ['61588452821652'],
  });
});

it('PopoverMenu flips to align-start when trigger is near the left edge of .workspace so 高级参数 is never clipped', async () => {
  await act(async () =>
    root.render(
      <main className="workspace">
        <PopoverMenu className="bumper-advanced-popover" label="高级参数" trigger={<>⚙ 高级参数</>}>
          {() => <div className="bumper-advanced-panel">参数面板</div>}
        </PopoverMenu>
      </main>,
    ),
  );

  const workspaceEl = host.querySelector<HTMLElement>('main.workspace');
  const popoverEl = host.querySelector<HTMLElement>('.popover.bumper-advanced-popover');
  expect(workspaceEl).toBeTruthy();
  expect(popoverEl).toBeTruthy();

  if (workspaceEl && popoverEl) {
    // Simulate sidebar + nav rail occupying 0..416px and .workspace occupying 416..1280px,
    // with wrapped ⚙ 高级参数 sitting at x = 505..590px (590 - 252 = 338 < 424 would clip left under align-end!)
    vi.spyOn(workspaceEl, 'getBoundingClientRect').mockReturnValue({
      x: 416,
      y: 60,
      left: 416,
      top: 60,
      right: 1280,
      bottom: 900,
      width: 864,
      height: 840,
      toJSON: () => ({}),
    });
    vi.spyOn(popoverEl, 'getBoundingClientRect').mockReturnValue({
      x: 505,
      y: 160,
      left: 505,
      top: 160,
      right: 590,
      bottom: 188,
      width: 85,
      height: 28,
      toJSON: () => ({}),
    });

    const placement = computePopoverPlacement(popoverEl, 252, 'end');
    expect(placement).toEqual({ effectiveAlign: 'start', offsetPx: 0 });
  }

  await click(host.querySelector('button[aria-label="高级参数"]'));
  const panel = document.querySelector<HTMLElement>('.popover-panel');
  expect(panel).toBeTruthy();
  expect(panel?.classList.contains('align-start')).toBe(true);
  expect(panel?.classList.contains('align-end')).toBe(false);
});

it('FeatureNavRail organizes 3 condensed groups (8 items total with unified 云表协同), persists folded groups, and projects live Google Sheets browser badges', async () => {
  window.localStorage.removeItem('workbench.nav-rail-collapsed.v1');
  window.localStorage.removeItem('workbench.nav-rail-closed-groups.v1');

  const p1 = '10000000-0000-4000-8000-000000000011';
  const p2 = '10000000-0000-4000-8000-000000000012';
  const projection = buildWorkbenchProjection({
    viewKind: 'sheets-schedule',
    profiles: [
      {
        id: p1,
        alias: '专页号A',
        browserName: 'Chrome A',
        groupId: null,
        order: 0,
        online: true,
        phase: 'READY',
        synced: true,
        unresolved: 0,
        extensionVersion: '0.3.84',
        capabilities: [],
        presentation: null,
        account: { state: 'logged-in', id: 'page-1', name: 'Page A', avatar: null },
      },
      {
        id: p2,
        alias: '顶贴号B',
        browserName: 'Chrome B',
        groupId: null,
        order: 1,
        online: true,
        phase: 'READY',
        synced: true,
        unresolved: 0,
        extensionVersion: '0.3.84',
        capabilities: [],
        presentation: null,
        account: { state: 'logged-in', id: 'user-2', name: 'User B', avatar: null },
      },
    ],
    selected: new Set([p1, p2]),
    tasks: null,
    groupBumper: null,
    groupInviter: null,
    groupPoster: null,
    bluestacks: null,
    autoScheduler: null,
    googleSheets: {
      runningScheduleCount: 1,
      runningRecordsCount: 1,
      activeProfiles: [
        {
          profileId: p1,
          linkId: 'link-sched',
          kind: 'post_schedule',
          title: '早班排贴表',
          status: '正在发布第 2/5 群',
        },
        {
          profileId: p2,
          linkId: 'link-rec',
          kind: 'post_records',
          title: '总发帖记录',
          status: '正在顶贴 (1/3)',
        },
      ],
      links: [],
    },
    attentionCount: 2,
    message: '',
  });

  expect(projection.breadcrumbText).toBe('云表协同 · 排贴表');
  expect(projection.sheetsRunningIds.sort()).toEqual([p1, p2]);
  expect(projection.projectedControls.isProfileBusy(p1)).toBe(true);
  expect(projection.projectedControls.isProfileBusy(p2)).toBe(true);
  expect(projection.projectedControls.stoppableModuleProfileIds.sort()).toEqual([p1, p2]);
  expect(projection.projectedActivities?.get(p1)).toMatchObject({
    moduleId: 'sheets-schedule',
    moduleLabel: '云表排贴',
    running: true,
    tone: 'run',
    text: '云表排贴 · 正在发布第 2/5 群',
  });
  expect(projection.projectedActivities?.get(p2)).toMatchObject({
    moduleId: 'sheets-records',
    moduleLabel: '云表顶贴',
    running: true,
    tone: 'run',
    text: '云表顶贴 · 正在顶贴 (1/3)',
  });

  await act(async () =>
    root.render(
      <FeatureNavRail
        activeModule="sheets-schedule"
        items={projection.navItems}
        onSelectModule={() => {}}
      />,
    ),
  );

  // Verify 3-group condensed 8-item visual order
  const groupTitles = [...host.querySelectorAll('.nav-rail-group-title-text')].map(
    (el) => el.textContent,
  );
  expect(groupTitles).toEqual(['调度与监控', '核心功能', '云表协同']);

  // Verify condensed 9-item labels inside groups
  const itemLabels = [...host.querySelectorAll('.nav-rail-label')].map((el) => el.textContent);
  expect(itemLabels).toEqual([
    '定时排班',
    '数据与记录',
    '窗口排版',
    '活跃账号',
    '小组发帖',
    '小组顶贴',
    '专页顶贴',
    '小组邀请人',
    '云表协同',
  ]);

  // Fold 云表协同 -> persists to localStorage and surfaces combined running pill (sched=1 + rec=1 = 2) on header
  const sheetsGroupBtn = [...host.querySelectorAll('.nav-rail-group-title')].find((b) =>
    b.textContent?.includes('云表协同'),
  );
  await click(sheetsGroupBtn ?? null);
  expect(window.localStorage.getItem('workbench.nav-rail-closed-groups.v1')).toBe('["sheets"]');
  expect(sheetsGroupBtn?.textContent).toContain('2运行');
  expect(host.querySelectorAll('.nav-rail-item')).toHaveLength(8);

  // Re-mount should remember folded group
  await act(async () => root.render(<div />));
  await act(async () =>
    root.render(
      <FeatureNavRail
        activeModule="active-accounts"
        items={projection.navItems}
        onSelectModule={() => {}}
      />,
    ),
  );
  expect(host.querySelectorAll('.nav-rail-item')).toHaveLength(8);
  window.localStorage.removeItem('workbench.nav-rail-closed-groups.v1');
});

it('CombinationList hides version numbers, rounds, and draft ribbon; Editor removes draft autosave and loop controls', async () => {
  const comboId = '40000000-0000-4000-8000-000000000099';
  const saved = {
    name: '日常',
    note: '',
    randomOrder: true,
    loop: { mode: 'finite' as const, rounds: 1 },
    steps: [
      {
        id: '30000000-0000-4000-8000-000000000099',
        type: 'video' as const,
        durationMinutes: 15,
        maxLikes: 2,
        minLikeCount: 500,
      },
    ],
  };
  const legacyRow = {
    id: comboId,
    version: 7,
    revision: 33,
    updatedAt: 1000,
    saved,
    draft: null,
  };

  await act(async () =>
    root.render(
      <CombinationList
        rows={[legacyRow]}
        selectedCount={0}
        onEdit={vi.fn()}
        onNew={vi.fn()}
        onCopy={vi.fn()}
        onResources={vi.fn()}
        resourceSummaries={[]}
      />,
    ),
  );
  expect(host.querySelector('.combo-ribbon')).toBeNull();
  expect(host.querySelector('.combo-meta')?.textContent?.trim()).toBe('随机顺序');
  expect(host.textContent).not.toContain('v7');
  expect(host.textContent).not.toContain('1 轮');
  expect(host.textContent).not.toContain('草稿');

  // Imported multi-round/until-stopped JSON preserves loop cleanly and rejects empty steps.
  const imported = parseImportedCombination(
    JSON.stringify({
      format: 'wb-combination-v1',
      combination: { ...saved, loop: { mode: 'until-stopped' } },
    }),
    new Set(),
  );
  expect(imported.value.loop).toEqual({ mode: 'until-stopped' });
  expect(() =>
    parseImportedCombination(
      JSON.stringify({ format: 'wb-combination-v1', combination: { ...saved, steps: [] } }),
      new Set(),
    ),
  ).toThrow();

  // Editor loads saved (ignoring stale draft), hides version controls, exposes loop radiogroup, and preserves loop on save.
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const notify = vi.fn();
  vi.mocked(api.saveCombination).mockResolvedValueOnce({
    ...legacyRow,
    version: 8,
    revision: 34,
    draft: null,
  });

  await act(async () =>
    root.render(
      <Editor
        initial={legacyRow}
        selectedProfiles={[]}
        onResources={vi.fn()}
        resourceUsage={null}
        resourceUsageLoaded={true}
        onSaved={onSaved}
        onClose={onClose}
        notify={notify}
      />,
    ),
  );
  const nameInput = host.querySelector<HTMLInputElement>('.combination-fields input');
  expect(nameInput?.value).toBe('日常');
  expect(host.textContent).not.toContain('已保存 v7');
  expect(host.textContent).toContain('单轮 (1次)');
  expect(host.textContent).toContain('指定轮数');
  expect(host.textContent).toContain('持续循环');
  expect(host.textContent).not.toContain('直接返回将放弃未保存修改');

  const saveBtn = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '保存组合',
  );
  expect(saveBtn).toBeTruthy();
  await click(saveBtn ?? null);
  expect(api.saveCombination).toHaveBeenCalledTimes(1);
  expect(api.saveCombination).toHaveBeenCalledWith(
    comboId,
    33,
    expect.objectContaining({ name: '日常', loop: { mode: 'finite', rounds: 1 } }),
  );
  expect(notify).toHaveBeenCalledWith('已保存');
  expect(onClose).toHaveBeenCalledTimes(1);

  // New unsaved combination does NOT create any DB row when returning without saving.
  vi.mocked(api.create).mockClear();
  const onCloseNew = vi.fn();
  await act(async () =>
    root.render(
      <Editor
        initial={null}
        selectedProfiles={[]}
        onResources={vi.fn()}
        resourceUsage={null}
        resourceUsageLoaded={true}
        onSaved={onSaved}
        onClose={onCloseNew}
        notify={notify}
      />,
    ),
  );
  const backBtn = host.querySelector<HTMLButtonElement>('button.back');
  await click(backBtn);
  expect(api.create).not.toHaveBeenCalled();
  expect(onCloseNew).toHaveBeenCalledTimes(1);
});

it('Active Accounts toolbar integrates close-on-finish toggle and Editor shares marketplace filters via StepConfigFields', async () => {
  const comboId = '40000000-0000-4000-8000-000000000101';
  const onToggleClose = vi.fn();
  const row = {
    id: comboId,
    version: 1,
    revision: 1,
    updatedAt: 1000,
    saved: {
      name: '商城养号',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite' as const, rounds: 1 },
      steps: [
        {
          id: '30000000-0000-4000-8000-000000000101',
          type: 'marketplace' as const,
          durationMinutes: 4,
          keyword: 'sofa',
          maxLikes: 0,
          minLikeCount: 0,
        },
      ],
    },
    draft: null,
  };

  await act(async () =>
    root.render(
      <CombinationList
        rows={[row]}
        selectedCount={1}
        closeBrowserOnFinish={false}
        onCloseBrowserOnFinishChange={onToggleClose}
        onEdit={vi.fn()}
        onNew={vi.fn()}
        onCopy={vi.fn()}
        onResources={vi.fn()}
        resourceSummaries={[]}
      />,
    ),
  );
  expect(host.querySelector('.combo-finish-bar')).toBeNull();
  expect(host.querySelector('.combo-new')).toBeNull();
  const toggleInput = host.querySelector<HTMLElement>(
    '.toolbar-toggle [aria-label="活跃完毕关闭浏览器"]',
  );
  expect(toggleInput).toBeTruthy();
  await click(toggleInput);
  expect(onToggleClose).toHaveBeenCalledWith(true);

  await act(async () =>
    root.render(
      <Editor
        initial={row}
        selectedProfiles={[]}
        onResources={vi.fn()}
        resourceUsage={null}
        resourceUsageLoaded={true}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector('input[placeholder="留空浏览推荐"]')).toBeNull();
  expect(host.textContent).toContain('浏览时长');
  expect(host.textContent).toContain('分钟');
});

it('AutoSchedulerPage renders minimalist alarm cards and table-driven editor saves smart defaults without prewarm/advanced clutter', async () => {
  const groupId = '10000000-0000-4000-8000-000000000001';
  const comboId = '20000000-0000-4000-8000-000000000001';
  const profileId = '30000000-0000-4000-8000-000000000001';
  const onState = vi.fn();
  const onMessage = vi.fn();
  const initialState = {
    settings: {
      browserConcurrency: 15,
      bluestacksConcurrency: 5,
      launchStaggerSeconds: 3,
      idleWatchdogMinutes: 5,
      preventSystemSleep: true,
    },
    powerLockMode: 'none' as const,
    activeBrowserWorkers: 0,
    queuedBrowserTargets: 0,
    activeBluestacksWorkers: 0,
    queuedBluestacksTargets: 0,
    schedules: [],
    activeRuns: [],
    recentRuns: [],
  };
  vi.mocked(api.autoSchedulerAction).mockResolvedValueOnce(initialState);

  await act(async () =>
    root.render(
      <AutoSchedulerPage
        state={initialState}
        onState={onState}
        profiles={[
          {
            id: profileId,
            alias: '用户1',
            order: 0,
            groupId,
            online: false,
            phase: 'OFFLINE',
            synced: false,
            unresolved: 0,
            extensionVersion: null,
            capabilities: [],
            account: { state: 'unknown', id: null, name: null, avatar: null },
          },
        ]}
        profileGroups={[{ id: groupId, name: '养号组', order: 0 }]}
        selectedProfileIds={new Set([profileId])}
        combinations={[
          {
            id: comboId,
            version: 1,
            revision: 1,
            updatedAt: 1000,
            saved: {
              name: '日常',
              note: '',
              randomOrder: true,
              loop: { mode: 'finite', rounds: 1 },
              steps: [
                {
                  id: '40000000-0000-4000-8000-000000000001',
                  type: 'feed',
                  durationMinutes: 5,
                  maxLikes: 0,
                  minLikeCount: 0,
                },
              ],
            },
            draft: null,
          },
        ]}
        bumperState={null}
        posterState={null}
        bluestacksState={null}
        onMessage={onMessage}
      />,
    ),
  );

  const createBtn = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('新建排班'),
  );
  await click(createBtn ?? null);
  expect(host.textContent).not.toContain('提前独立预热');
  expect(host.textContent).not.toContain('高级选项');
  expect(host.textContent).toContain('跑完自动关窗');

  const saveBtn = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '保存',
  );
  await click(saveBtn ?? null);
  expect(api.autoSchedulerAction).toHaveBeenCalledWith(
    'schedules/save',
    expect.objectContaining({
      carrier: 'browser',
      closeWindowOnFinish: true,
      maxSafetyMinutesPerTarget: null,
      trigger: expect.objectContaining({ misfireGraceMinutes: 120 }),
    }),
  );
});

it('v0.1.262: LiveRunsDrawer shows queued items + BS show, PostBumpRecordsPage supports 7-day filter & drill-down, CombinationList shows direct material button', async () => {
  // 1. LiveRunsDrawer renders both running + queued scheduler items & BlueStacks 显示窗口
  const bsRunId = '50000000-0000-4000-8000-000000000001';
  const bsTargetRunning = '50000000-0000-4000-8000-000000000011';
  const bsTargetQueued = '50000000-0000-4000-8000-000000000012';
  const cards = buildLiveRunCards({
    profiles: [],
    runtime: null,
    combinations: [],
    autoScheduler: {
      running: true,
      nextSchedule: null,
      schedules: [
        {
          id: 'sched-bs-1',
          name: '蓝蝶排班',
          enabled: true,
          carrier: 'bluestacks',
          targetIds: [bsTargetRunning, bsTargetQueued],
          concurrency: 1,
          closeWindowOnFinish: true,
          maxSafetyMinutesPerTarget: null,
          prewarm: { enabled: false, leadMinutes: 90, steps: [] },
          trigger: {
            kind: 'daily',
            times: ['09:00'],
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            intervalMinutes: 120,
            runAt: null,
            jitterMinutes: 0,
            misfireGraceMinutes: 120,
          },
          steps: [
            {
              id: '50000000-0000-4000-8000-000000000099',
              type: 'bluestacks-group-poster',
              maxGroups: 2,
              postTimeline: false,
            },
          ],
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      activeRuns: [
        {
          runId: bsRunId,
          scheduleId: 'sched-bs-1',
          scheduleName: '蓝蝶排班',
          carrier: 'bluestacks',
          status: 'running',
          startedAt: 1000,
          finishedAt: null,
          concurrency: 1,
          stopReason: '',
          items: [
            {
              targetId: bsTargetRunning,
              targetName: 'BS Instance 1',
              status: 'running',
              currentStep: '蓝蝶发帖',
              summary: '正在发送第 1 组',
              startedAt: 1000,
              finishedAt: null,
              error: '',
            },
            {
              targetId: bsTargetQueued,
              targetName: 'BS Instance 2',
              status: 'queued',
              currentStep: '',
              summary: '',
              startedAt: null,
              finishedAt: null,
              error: '',
            },
          ],
        },
      ],
      history: [],
      guardSettings: {
        preventSystemSleep: false,
        defaultConcurrency: 1,
        closeWindowOnFinish: true,
        updatedAt: 1000,
      },
    },
    groupBumper: null,
    groupPoster: null,
    groupInviter: null,
    googleSheets: null,
    bluestacks: null,
  });
  expect(cards).toHaveLength(2);
  expect(cards[0]?.statusText).not.toBe('等待并发槽位');
  expect(cards[1]?.statusText).toBe('等待并发槽位');

  const onShowBluestacks = vi.fn();
  await act(async () =>
    root.render(
      <LiveRunsDrawer
        open={true}
        onClose={() => {}}
        cards={cards}
        busy={false}
        onShowBrowser={() => {}}
        onShowBluestacks={onShowBluestacks}
        onStopCard={() => {}}
        onStopAll={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain('等待并发槽位');
  const showBsBtns = [...host.querySelectorAll('button')].filter((b) =>
    b.textContent?.includes('显示窗口'),
  );
  expect(showBsBtns.length).toBeGreaterThanOrEqual(2);
  await click(showBsBtns[0] ?? null);
  expect(onShowBluestacks).toHaveBeenCalledWith(bsTargetRunning);

  // 2. PostBumpRecordsPage status badges + clickable postUrl + filter reset
  vi.mocked(api.postBumpRecords).mockClear();
  vi.mocked(api.postBumpRecords).mockResolvedValue({
    records: [
      {
        id: 'pbr-v262-1',
        recordType: 'post',
        carrier: 'browser',
        status: 'success',
        profileId: id,
        windowName: 'Browser Window',
        accountId: 'acc-991',
        accountName: 'Alpha Account',
        accountAvatarUrl: '',
        groupId: 'grp-881',
        groupName: 'Alpha Group',
        groupAvatarUrl: '',
        pageId: 'page-771',
        pageName: 'Alpha Page',
        pageAvatarUrl: '',
        postId: 'post-661',
        postUrl: 'https://www.facebook.com/groups/grp-881/posts/post-661/',
        liked: false,
        commentText: '',
        storyShared: false,
        captionPreview: '测试文案',
        errorReason: '',
        sourceLogId: null,
        createdAt: 1700000000000,
      },
    ],
    total: 3,
    hasMore: false,
    statusCounts: { total: 3, confirmed: 1, pending: 1, failed: 1 },
  });
  await act(async () =>
    root.render(<PostBumpRecordsPage initialTab="posts" onNotify={() => {}} />),
  );
  expect(host.textContent).toContain('Alpha Account');
  expect(host.textContent).toContain('Alpha Group');
  expect(
    host.querySelector('a[href="https://www.facebook.com/groups/grp-881/posts/post-661/"]'),
  ).toBeTruthy();

  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('筛选')) ?? null,
  );
  const resetBtn = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '重置全部',
  );
  expect(resetBtn).toBeTruthy();
  await click(resetBtn ?? null);

  // 3. CombinationList renders direct 素材 (N) button when combo includes table post step
  const comboPostId = '60000000-0000-4000-8000-000000000001';
  await act(async () =>
    root.render(
      <CombinationList
        rows={[
          {
            id: comboPostId,
            version: 1,
            revision: 1,
            updatedAt: 1000,
            saved: {
              name: '表格发帖组合',
              note: '',
              randomOrder: false,
              loop: { mode: 'finite', rounds: 1 },
              steps: [
                {
                  id: '60000000-0000-4000-8000-000000000002',
                  type: 'post',
                  destination: 'post',
                  count: 1,
                  resourceMode: 'table',
                  resourceDirectory: '',
                  allowRepeat: false,
                  forbidSameAccountRepeat: true,
                  archivePublished: false,
                  audience: 'preserve-current',
                },
              ],
            },
            draft: null,
          },
        ]}
        selectedCount={0}
        onEdit={() => {}}
        onNew={() => {}}
        onCopy={() => {}}
        onResources={() => {}}
        resourceSummaries={[
          {
            combinationId: comboPostId,
            kind: 'post_content',
            total: 4,
            remaining: 4,
            exhausted: 0,
            invalid: 0,
          },
        ]}
      />,
    ),
  );
  const directMatBtn = [...host.querySelectorAll('.combo-foot button')].find((b) =>
    b.textContent?.includes('素材 (4)'),
  );
  expect(directMatBtn).toBeTruthy();
});

it('v0.1.267: LiveRunsDrawer shows shuffled roundSteps & BS steps, ActiveAccountsPage unifies bluestacks, relativePostAge parses multi-locale times', async () => {
  const pid = '70000000-0000-4000-8000-000000000001';
  const planId = '70000000-0000-4000-8000-000000000002';
  const comboId = '70000000-0000-4000-8000-000000000003';
  const bsId = '70000000-0000-4000-8000-000000000004';
  const s1 = '70000000-0000-4000-8000-000000000011';
  const s2 = '70000000-0000-4000-8000-000000000012';
  const s3 = '70000000-0000-4000-8000-000000000013';

  const cards = buildLiveRunCards({
    profiles: [
      {
        id: pid,
        alias: 'Browser1',
        browserName: '用户9',
        groupId: null,
        order: 0,
        online: true,
        phase: 'PAUSED',
        synced: true,
        unresolved: 0,
        extensionVersion: '0.3.92',
        account: { state: 'logged-in', id: '123', name: 'A', avatar: null },
      },
    ],
    runtime: {
      plans: [
        {
          id: planId,
          profileId: pid,
          combinationId: comboId,
          version: 1,
          name: '随机养号',
          accountId: '123',
          state: 'RUNNING',
          reason: '',
          controlConfirmed: false,
          round: 1,
          position: 0,
          snapshot: {
            name: '随机养号',
            note: '',
            randomOrder: true,
            loop: { mode: 'finite', rounds: 1 },
            steps: [
              { id: s1, type: 'video', durationMinutes: 15, maxLikes: 2, minLikeCount: 0 },
              {
                id: s2,
                type: 'marketplace',
                durationMinutes: 4,
                keyword: '',
                maxLikes: 0,
                minLikeCount: 0,
              },
              { id: s3, type: 'feed', durationMinutes: 8, maxLikes: 2, minLikeCount: 0 },
            ],
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      currentSteps: [
        {
          id: s2,
          jobId: planId,
          round: 1,
          position: 0,
          type: 'marketplace',
          status: 'ACTIVE',
          budget: { kind: 'time', milliseconds: 240_000 },
          progress: { revision: 1, effectiveMilliseconds: 0, likes: 0, published: 0, cursor: null },
        },
      ],
      roundSteps: [
        {
          id: s3,
          jobId: planId,
          round: 1,
          position: 2,
          type: 'feed',
          status: 'PENDING',
          budget: { kind: 'time', milliseconds: 480_000 },
          maxLikes: 2,
          progress: { revision: 0, effectiveMilliseconds: 0, likes: 0, published: 0, cursor: null },
        },
        {
          id: s2,
          jobId: planId,
          round: 1,
          position: 0,
          type: 'marketplace',
          status: 'ACTIVE',
          budget: { kind: 'time', milliseconds: 240_000 },
          progress: { revision: 1, effectiveMilliseconds: 0, likes: 0, published: 0, cursor: null },
        },
        {
          id: s1,
          jobId: planId,
          round: 1,
          position: 1,
          type: 'video',
          status: 'PENDING',
          budget: { kind: 'time', milliseconds: 900_000 },
          maxLikes: 2,
          progress: { revision: 0, effectiveMilliseconds: 0, likes: 0, published: 0, cursor: null },
        },
      ],
      settings: { maxConcurrentProfiles: 5 },
    },
    combinations: [
      {
        id: comboId,
        version: 1,
        revision: 1,
        updatedAt: 1000,
        saved: {
          name: '随机养号',
          note: '',
          randomOrder: true,
          loop: { mode: 'finite', rounds: 1 },
          steps: [
            { id: s1, type: 'video', durationMinutes: 15, maxLikes: 2, minLikeCount: 0 },
            {
              id: s2,
              type: 'marketplace',
              durationMinutes: 4,
              keyword: '',
              maxLikes: 0,
              minLikeCount: 0,
            },
            { id: s3, type: 'feed', durationMinutes: 8, maxLikes: 2, minLikeCount: 0 },
          ],
        },
        draft: null,
      },
    ],
    autoScheduler: null,
    groupBumper: null,
    groupPoster: null,
    groupInviter: null,
    googleSheets: null,
    bluestacks: {
      running: false,
      pageBumperRunning: false,
      activeRunning: true,
      posterRunning: false,
      inviterRunning: false,
      statusText: '',
      pageBumperStatusText: '',
      activeStatusText: '运行中',
      posterStatusText: '',
      inviterStatusText: '',
      launchingIds: [],
      closingIds: [],
      inspectingIds: [],
      installingIds: [],
      loggingInIds: [],
      switchingIds: [],
      config: {
        installDir: null,
        confPath: null,
        detectedInstallDir: null,
        detectedConfPath: null,
        adbReady: true,
        playerReady: true,
        apkPath: null,
        detectedApkPath: null,
      },
      bumperSettings: BumperSettings.parse({}),
      pageBumperSettings: BumperSettings.parse({}),
      riskLimitSettings: {
        dailyMaxTotalActions: 60,
        dailyMaxBumps: 30,
        dailyMaxPosts: 10,
        dailyMaxInvites: 20,
        dailyMaxActiveLikes: 25,
        enabled: true,
        perInstanceOverrides: {},
      },
      dailyUsage: {
        dateYmd: '2026-11-26',
        totalGroupBumps: 0,
        totalPageBumps: 0,
        totalPosts: 0,
        totalInvites: 0,
        totalActiveLikes: 0,
        totalActions: 0,
        reachedLimitInstances: 0,
        perInstance: {},
      },
      total: 0,
      pageTotal: 0,
      commentsCount: 0,
      pageCommentsCount: 0,
      healthCheck: null,
      batchLogin: null,
      profileCounts: {},
      pageBumperProfileCounts: {},
      activeProfileCounts: {
        [bsId]: {
          running: true,
          status: '执行第 1 步',
          session: 0,
          today: 0,
          steps: [
            { label: '浏览 Reels (15分)', state: 'running' },
            { label: '浏览首页 (8分)', state: 'pending' },
          ],
        },
      },
      posterProfileCounts: {},
      inviterProfileCounts: {},
      folders: [],
      instances: [
        {
          id: bsId,
          instanceKey: 'Pie64_1',
          displayName: 'p023',
          alias: null,
          folderId: null,
          order: 0,
          adbPort: 5555,
          fbWidth: 720,
          fbHeight: 1280,
          fbLiteInstalled: true,
          online: true,
          accountState: 'logged-in',
          accountId: '999',
          accountName: 'BS Acc',
          avatar: null,
          lastStatus: null,
          identityType: 'personal',
          numericAccountId: '999',
          managedIdentities: [],
          updatedAt: 1000,
        },
      ],
    },
  });

  const browserCard = cards.find((c) => c.key === `plan:${planId}`);
  expect(browserCard?.subtitle).toContain('随机顺序');
  expect(browserCard?.steps.map((s) => s.label)).toEqual([
    '浏览商城 (4分)',
    '浏览 Reels (15分)',
    '浏览首页 (8分)',
  ]);
  const bsCard = cards.find((c) => c.key === `bs:active/stop:${bsId}`);
  expect(bsCard?.steps.map((s) => s.label)).toEqual(['浏览 Reels (15分)', '浏览首页 (8分)']);

  // Unified capability-driven ActiveAccountsPage on BlueStacks carrier (no bottom progress panel)
  const mixedComboId = '70000000-0000-4000-8000-000000000021';
  await act(async () =>
    root.render(
      <ActiveAccountsPage
        carrier="bluestacks"
        workspace={{
          version: 1,
          groups: [],
          profiles: [],
          combinations: [
            {
              id: mixedComboId,
              version: 1,
              revision: 1,
              updatedAt: 1000,
              saved: {
                name: '混合组合',
                note: '',
                randomOrder: false,
                loop: { mode: 'finite', rounds: 1 },
                steps: [
                  {
                    id: '70000000-0000-4000-8000-000000000031',
                    type: 'feed',
                    feedMode: 'random_profile',
                    detourDwellSeconds: 25,
                    durationMinutes: 5,
                    maxLikes: 1,
                    minLikeCount: 0,
                  },
                  {
                    id: '70000000-0000-4000-8000-000000000032',
                    type: 'post',
                    destination: 'post',
                    count: 1,
                    resourceMode: 'table',
                    resourceDirectory: '',
                    allowRepeat: false,
                    forbidSameAccountRepeat: true,
                    archivePublished: false,
                    audience: 'preserve-current',
                  },
                ],
              },
              draft: null,
            },
          ],
        }}
        selected={new Set()}
        tasks={
          {
            capabilities: {
              types: ['feed', 'video', 'marketplace', 'friends', 'post'],
              combinations: [],
            },
            runtime: { plans: [], currentSteps: [], settings: { maxConcurrentProfiles: 5 } },
            command: vi.fn(),
            start: vi.fn(),
            refresh: vi.fn(),
          } as unknown as Parameters<typeof ActiveAccountsPage>[0]['tasks']
        }
        cardColors={
          {
            colorOf: () => 'graphite',
            setColor: vi.fn(),
            supported: true,
          } as unknown as Parameters<typeof ActiveAccountsPage>[0]['cardColors']
        }
        busy={false}
        resourceSummaries={null}
        selectionControls={
          {
            stoppableTargets: [],
            stoppableModuleProfileIds: [],
            totalStoppableCount: 0,
            isProfileBusy: () => false,
          } as unknown as Parameters<typeof ActiveAccountsPage>[0]['selectionControls']
        }
        bluestacksState={{
          running: false,
          pageBumperRunning: false,
          activeRunning: true,
          posterRunning: false,
          inviterRunning: false,
          statusText: '',
          pageBumperStatusText: '',
          activeStatusText: '运行中',
          posterStatusText: '',
          inviterStatusText: '',
          launchingIds: [],
          closingIds: [],
          inspectingIds: [],
          installingIds: [],
          loggingInIds: [],
          switchingIds: [],
          config: {
            installDir: null,
            confPath: null,
            detectedInstallDir: null,
            detectedConfPath: null,
            adbReady: true,
            playerReady: true,
            apkPath: null,
            detectedApkPath: null,
          },
          bumperSettings: BumperSettings.parse({}),
          pageBumperSettings: BumperSettings.parse({}),
          riskLimitSettings: {
            dailyMaxTotalActions: 60,
            dailyMaxBumps: 30,
            dailyMaxPosts: 10,
            dailyMaxInvites: 20,
            dailyMaxActiveLikes: 25,
            enabled: true,
            perInstanceOverrides: {},
          },
          dailyUsage: {
            dateYmd: '2026-11-26',
            totalGroupBumps: 0,
            totalPageBumps: 0,
            totalPosts: 0,
            totalInvites: 0,
            totalActiveLikes: 0,
            totalActions: 0,
            reachedLimitInstances: 0,
            perInstance: {},
          },
          total: 0,
          pageTotal: 0,
          commentsCount: 0,
          pageCommentsCount: 0,
          healthCheck: null,
          batchLogin: null,
          profileCounts: {},
          pageBumperProfileCounts: {},
          activeProfileCounts: {
            [bsId]: { running: true, status: '执行中', session: 0, today: 0 },
          },
          posterProfileCounts: {},
          inviterProfileCounts: {},
          folders: [],
          instances: [],
        }}
        selectedBluestacks={new Set([bsId])}
        onSelectBluestacks={() => {}}
        onSetResourceSummaries={() => {}}
        onOpenResources={() => {}}
        onEditCombination={() => {}}
        onNewCombination={() => {}}
        onOpenLiveRuns={() => {}}
        onRefreshWorkspace={async () => {}}
        onRefreshResources={async () => {}}
        onMutate={async () => {}}
        onNotify={() => {}}
      />,
    ),
  );
  for (const label of [
    '浏览首页',
    '浏览 Reels',
    '浏览商城',
    '接受好友',
    '发时间线',
    '发布快拍',
    '新建组合',
    '导入',
    '批量管理',
    '完毕关窗',
    '按首页',
    '仅浏览器',
    '查看队列',
  ]) {
    expect(host.textContent).toContain(label);
  }
  expect(host.querySelector('.active-progress')).toBeNull();

  expect(relativePostAge('၂ နာရီ')).toBe(2);
  expect(relativePostAge('3 giờ')).toBe(3);
  expect(relativePostAge('45 นาที')).toBeCloseTo(0.75, 4);
  expect(host.querySelector('[aria-label="今日战报"]')).toBeNull();
  expect(host.textContent).not.toContain('今日战报');
});

it('v0.1.268: unifies browser display names across LiveRunsDrawer, scope bar, layout sort, and scheduler modal', async () => {
  const pid1 = '1a761215-0000-4000-8000-000000000001';
  const pid2 = '9bfb6b7f-0000-4000-8000-000000000002';
  const profiles = [
    {
      id: pid1,
      alias: 'Chrome 1a761215',
      browserName: '用户9',
      groupId: null,
      order: 0,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      extensionVersion: '0.3.92',
      capabilities: [],
      account: { state: 'logged-in' as const, id: '1001', name: 'FB 9', avatar: null },
    },
    {
      id: pid2,
      alias: 'Chrome 9bfb6b7f',
      browserName: 'p017',
      groupId: null,
      order: 1,
      online: true,
      phase: 'PAUSED',
      synced: true,
      unresolved: 0,
      extensionVersion: '0.3.92',
      capabilities: [],
      account: { state: 'logged-in' as const, id: '1002', name: 'FB 17', avatar: null },
    },
  ];
  expect(profiles.map((pr) => profileDisplayName(pr))).toEqual(['用户9', 'p017']);
  expect(mapProfilesToScopeOptions(profiles).map((o) => o.label)).toEqual(['用户9', 'p017']);
  const [p1, p2] = profiles;
  if (!p1 || !p2) throw Error('missing fixture profiles');
  expect(
    getTargetProfileIds(
      [
        { ...p1, browserName: 'B组-用户9' },
        { ...p2, browserName: 'A组-p017' },
      ],
      new Set([pid1, pid2]),
      'selected',
      'name',
    ),
  ).toEqual([pid2, pid1]);
  const liveCards = buildLiveRunCards({
    profiles,
    runtime: {
      schemaVersion: 1,
      plans: [
        {
          id: 'plan-u9',
          profileId: pid1,
          combinationId: 'combo-1',
          combinationVersion: 1,
          state: 'RUNNING',
          position: 0,
          round: 1,
          reason: null,
          closeBrowserOnFinish: false,
          snapshot: {
            name: '日常',
            note: '',
            randomOrder: false,
            loop: { mode: 'finite', rounds: 1 },
            steps: [{ id: 's1', type: 'feed', feedMode: 'home', durationMinutes: 5, maxLikes: 1 }],
          },
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      currentSteps: [],
      roundSteps: [],
    },
    combinations: [],
    autoScheduler: {
      settings: {
        browserConcurrency: 15,
        bluestacksConcurrency: 5,
        launchStaggerSeconds: 3,
        idleWatchdogMinutes: 5,
        preventSystemSleep: true,
      },
      running: true,
      powerLockMode: 'none',
      activeBrowserWorkers: 1,
      queuedBrowserTargets: 0,
      activeBluestacksWorkers: 0,
      queuedBluestacksTargets: 0,
      schedules: [],
      activeRuns: [
        {
          id: 'run-p17',
          scheduleId: 'sched-1',
          scheduleName: '晨间排班',
          carrier: 'browser',
          phase: 'main',
          slotKey: 'k1',
          triggerMode: 'manual',
          status: 'running',
          statusReason: '',
          totalTargets: 1,
          completedCount: 0,
          softIssueCount: 0,
          hardBlockedCount: 0,
          watchdogTimeoutCount: 0,
          skippedCount: 0,
          scheduledFor: 1000,
          startedAt: 1000,
          finishedAt: null,
          items: [
            {
              runId: 'run-p17',
              targetId: pid2,
              targetName: 'Chrome 9bfb6b7f',
              status: 'running',
              currentStep: '浏览首页',
              summary: '运行中',
              bumpedCount: 0,
              postedCount: 0,
              softIssues: 0,
              hardBlockReason: null,
              seamlessHandoff: false,
              startedAt: 1000,
              finishedAt: null,
              updatedAt: 2000,
            },
          ],
        },
      ],
      recentRuns: [],
    },
    groupBumper: null,
    groupPoster: null,
    groupInviter: null,
    googleSheets: null,
    bluestacks: null,
  });
  expect(liveCards.map((c) => c.targetName)).toEqual(['p017', '用户9']);

  await act(async () =>
    root.render(
      <AutoSchedulerEditorModal
        initial={null}
        browserConcurrency={15}
        bluestacksConcurrency={5}
        profiles={profiles}
        profileGroups={[]}
        selectedProfileIds={new Set([pid1])}
        combinations={[]}
        sharedGroups={[]}
        sharedPages={[]}
        posterMaterials={[]}
        inviterGroups={[]}
        bluestacksState={null}
        onSave={async () => {}}
        onClose={() => {}}
      />,
    ),
  );
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '手动选') ?? null,
  );
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('勾选')) ?? null,
  );
  expect(host.textContent).toContain('1. 用户9');
  expect(host.textContent).toContain('2. p017');
  expect(host.textContent).not.toContain('Chrome 1a761215');
  expect(host.textContent).not.toContain('Chrome 9bfb6b7f');
});
