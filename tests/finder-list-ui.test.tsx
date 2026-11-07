// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FinderTargetList } from '../src/renderer/finder-target-list.js';
import { GroupInviterPage } from '../src/renderer/group-inviter-page.js';
import { GroupBumperPage } from '../src/renderer/group-bumper-page.js';
import { GroupPosterPage } from '../src/renderer/group-poster-page.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { PosterSettings } from '../src/shared/group-poster.js';
import { normalizeTargetToken } from '../src/renderer/select-by-ids-dialog.js';
import { Sidebar } from '../src/renderer/sidebar.js';
import { FeatureNavRail } from '../src/renderer/feature-nav-rail.js';
import { CombinationList } from '../src/renderer/combination-list.js';
import { projectSelectionControls } from '../src/renderer/modules/profile-activity-projector.js';
import {
  nudgeFinderIds,
  insertFinderIds,
  rangeFinderSelection,
} from '../src/renderer/finder-list-model.js';
import { api } from '../src/renderer/api.js';
vi.mock('../src/renderer/api.js', () => ({
  api: {
    targetFolders: vi.fn(),
    targetListCommand: vi.fn(),
    reorderProfiles: vi.fn(),
    reorderGroups: vi.fn(),
    cleanupProfileTabs: vi.fn(),
    bumperAction: vi.fn(),
    bumperLogs: vi.fn(),
    posterAction: vi.fn(),
    posterState: vi.fn(),
    posterLogs: vi.fn(),
    refreshGroupInviterGroups: vi.fn(),
  },
}));
let root: Root;
let host: HTMLDivElement;
const id = 'f0000000-0000-4000-8000-000000000001';
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
      [...host.querySelectorAll('[role="menuitem"]')].find((e) =>
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
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { setData: vi.fn(), setDragImage: vi.fn() },
    });
    await act(async () => host.querySelector('[data-finder-id="1"]')?.dispatchEvent(event));
    await act(async () =>
      host
        .querySelector('.finder-folder')
        ?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })),
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

    // Mousedown on name prevents dragstart on the row
    await act(async () => {
      nameEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const dragEvent = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragEvent, 'dataTransfer', {
      value: { setData: vi.fn(), setDragImage: vi.fn() },
    });
    await act(async () => {
      row1.dispatchEvent(dragEvent);
    });
    expect(dragEvent.defaultPrevented).toBe(true);
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup'));
    });

    // Non-empty text selection blocks row click from toggling checkbox
    const getSelectionSpy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => '条目1' } as unknown as Selection);
    await click(row1);
    expect(selected().has('1')).toBe(false);
    getSelectionSpy.mockRestore();
  });
});
it('Sidebar has one compact move/cleanup/stop toolbar and stops all three task kinds', async () => {
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
        onStopGroupInviterProfiles={onStop}
      />,
    ),
  );
  expect(host.querySelector('.selection-bar.compact-selection')).toBeTruthy();
  expect(host.querySelector('.selection-bar-actions')).toBeNull();
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent === '清理标签') ?? null,
  );
  expect(api.cleanupProfileTabs).toHaveBeenCalledWith([...selected]);
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === '停止') ?? null);
  expect(onStop).toHaveBeenCalledWith([...selected]);
  expect(host.querySelector('[aria-label="移到分组"]')).toBeTruthy();
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
it('painting cannot start HTML drag, child dragleave retains highlight and empty/unfiled accepts drops', async () => {
  await mount();
  const cell = host.querySelector('.finder-check-cell');
  await act(async () =>
    cell?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })),
  );
  const canceled = new Event('dragstart', { bubbles: true, cancelable: true });
  await act(async () => host.querySelector('.finder-row')?.dispatchEvent(canceled));
  expect(canceled.defaultPrevented).toBe(true);
  await act(async () => window.dispatchEvent(new PointerEvent('pointerup')));
  const transfer = { setData: vi.fn(), setDragImage: vi.fn() };
  const start = new Event('dragstart', { bubbles: true });
  Object.defineProperty(start, 'dataTransfer', { value: transfer });
  await act(async () => host.querySelector('.finder-row')?.dispatchEvent(start));
  const folder = host.querySelector('.finder-folder');
  await act(async () =>
    folder?.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })),
  );
  expect(folder?.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    folder?.dispatchEvent(
      new MouseEvent('dragleave', { bubbles: true, relatedTarget: folder.querySelector('button') }),
    ),
  );
  expect(folder?.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    host
      .querySelector('.finder-empty')
      ?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })),
  );
  expect(api.targetListCommand).toHaveBeenCalledWith({
    action: 'reorder-items',
    listKind: 'inviter_groups',
    folderId: id,
    orderedItemIds: ['1'],
  });
});
it('drop insertion uses final pointer coordinate even without matching dragover state', async () => {
  await mount();
  const e = new Event('dragstart', { bubbles: true });
  Object.defineProperty(e, 'dataTransfer', { value: { setData: vi.fn(), setDragImage: vi.fn() } });
  await act(async () => host.querySelector('[data-finder-id="1"]')?.dispatchEvent(e));
  const row = host.querySelector('[data-finder-id="2"]');
  vi.spyOn(row as Element, 'getBoundingClientRect').mockReturnValue({
    top: 10,
    height: 20,
  } as DOMRect);
  await act(async () =>
    row?.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 29 })),
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
      <GroupInviterPage
        state={{ groups: [], running: false, invitesPerGroup: 30 } as never}
        loaded={true}
        selectedProfileIds={new Set()}
        busy={false}
        onAddGroups={add}
        onDeleteGroups={async () => {}}
        onRefresh={async () => {}}
        onSaveInvitesPerGroup={async () => {}}
        onStart={async () => {}}
        onStop={async () => {}}
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

it('Sidebar direct arrows support repeated nudge and empty unfiled drop with child highlight preserved', async () => {
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
  await click(host.querySelector('[aria-label="上移"]'));
  expect(api.reorderProfiles).toHaveBeenLastCalledWith(id, [ids[1], ids[0], ids[2]]);
  await click(host.querySelector('[aria-label="下移"]'));
  await click(host.querySelector('[aria-label="下移"]'));
  expect(api.reorderProfiles).toHaveBeenLastCalledWith(id, [ids[0], ids[2], ids[1]]);
  const start = new Event('dragstart', { bubbles: true });
  Object.defineProperty(start, 'dataTransfer', {
    value: { setData: vi.fn(), setDragImage: vi.fn() },
  });
  await act(async () => host.querySelector('.profile-row')?.dispatchEvent(start));
  const head = [...host.querySelectorAll('.group-head')].find((e) =>
    e.textContent?.includes('未分组'),
  );
  expect(head).toBeTruthy();
  await act(async () =>
    head?.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true })),
  );
  expect(head?.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    head?.dispatchEvent(
      new MouseEvent('dragleave', { bubbles: true, relatedTarget: head.querySelector('button') }),
    ),
  );
  expect(head?.classList.contains('is-drop')).toBe(true);
  await act(async () =>
    host
      .querySelector('.group-empty')
      ?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })),
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
  const probInput = host.querySelector<HTMLInputElement>('input[aria-label="likeProbability"]');
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
        onSchedule={() => {}}
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
  expect(scheduleBtn?.disabled).toBe(true);
  expect(scheduleBtn?.getAttribute('title')).toContain('3 份资料已有任务');
});

it('GroupBumperPage supports ID-only paste without name and collapses low-frequency settings into 高级参数 popover', async () => {
  const dailyStats = [
    { date: '2026-11-01', count: 5 },
    { date: '2026-10-31', count: 2 },
    { date: '2026-10-30', count: 0 },
    { date: '2026-10-29', count: 0 },
    { date: '2026-10-28', count: 0 },
    { date: '2026-10-27', count: 1 },
    { date: '2026-10-26', count: 0 },
  ];
  vi.mocked(api.bumperAction).mockResolvedValue({
    groups: [],
    pages: [],
    settings: BumperSettings.parse({}),
    comments: [],
    total: 8,
    running: false,
    statusText: '就绪',
    profileCounts: {},
    dailyStats,
  });
  vi.mocked(api.bumperLogs).mockResolvedValue([]);
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
          dailyStats,
        }}
        selected={new Set()}
        onState={() => {}}
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
  const groups = host.querySelectorAll('.bumper-advanced-panel .bumper-advanced-group');
  expect(groups.length).toBe(2);
  expect(groups[0]?.querySelector('input[aria-label="dailyMaxLikesPerAccount"]')).toBeTruthy();
  expect(
    groups[0]?.querySelector<HTMLInputElement>('input[aria-label="maxLikesPerPost"]')?.value,
  ).toBe('50');
  expect(groups[0]?.querySelector('input[aria-label="likeProbability"]')).toBeTruthy();
  expect(groups[0]?.querySelector('input[aria-label="commentProbability"]')).toBeTruthy();
  expect(groups[1]?.querySelector('input[aria-label="maxPostsPerGroupPage"]')).toBeTruthy();

  // Open 顶贴记录 modal and check right-side 7-day stats sidebar
  await click(
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('顶贴记录')) ?? null,
  );
  const statsAside = host.querySelector('aside.bumper-logs-stats[aria-label="顶贴统计"]');
  expect(statsAside?.textContent).toContain('顶贴统计（最近7天）');
  const statRows = statsAside?.querySelectorAll('tbody tr') ?? [];
  expect(statRows.length).toBe(7);
  expect(statRows[0]?.textContent).toContain('2026-11-01');
  expect(statRows[0]?.textContent).toContain('5');
  await click(host.querySelector('button[aria-label="关闭弹窗"]'));

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

for (const [activeCount, pausedCount] of [
  [15, 6],
  [0, 2],
]) {
  it(`WO51: combination shows ${activeCount} active and ${pausedCount} paused while retaining delete protection`, async () => {
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
        plans: Array.from({ length: activeCount + pausedCount }, (_, i) => ({
          id: `plan-${i}`,
          combinationId: comboId,
          profileId: `profile-${i}`,
          state: i < activeCount ? (i % 2 ? 'QUEUED' : 'RUNNING') : 'PAUSED',
        })),
      } as Props['runtime'],
    };
    await act(async () => root.render(<CombinationList {...props} />));
    expect(host.querySelector('.combo-stat:not(.resource-count)')?.textContent).toContain(
      `执行/排队 ${activeCount} · 暂停 ${pausedCount}`,
    );
    // Open actual card menu and retain its deletion guard.
    const more = host.querySelector('button[aria-label="更多操作"]');
    await click(more);
    const deletion = [...document.querySelectorAll('button')].find(
      (el) => el.textContent?.trim() === '删除组合',
    );
    expect(deletion).toBeTruthy();
    expect(deletion?.disabled).toBe(true);
    const manage = [...host.querySelectorAll('button')].find(
      (el) => el.textContent?.trim() === '批量管理',
    );
    await click(manage!);
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="选择组合 WO51组合"]')?.disabled,
    ).toBe(true);
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
    dailyStats: [{ date: '2026-11-04', count: 2 }],
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

  // 1. 4-char title "小组列表" and 0 default selected groups (never auto-selects 2/2)
  const toolbarTitle = host.querySelector('.finder-toolbar > strong')?.textContent;
  expect(toolbarTitle).toBe('小组列表');
  expect(host.textContent).toContain('已选 0/2');
  expect(host.textContent).toContain('▶ 开始发帖 (已选0号 × 0组 × 1素材)');

  // 2. Outer 7-day pills removed from main page header
  expect(host.querySelector('.bumper-sticky-header .poster-daily-pills')).toBeNull();

  // 3. Outer "按 ID 选中" button works with shared_groups Facebook URLs
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
  const refreshAvatarBtn = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '刷新头像',
  );
  expect(refreshAvatarBtn).toBeTruthy();
  await click(refreshAvatarBtn ?? null);
  expect(api.posterAction).toHaveBeenCalledWith('groups/refresh', { ids: ['3017439278594998'] });

  // 5. PosterMaterialMatrix streamlined buttons, column resizers, floating + button, no bottom hint, and binary thumbnail img
  expect(host.textContent).not.toContain('填入测试素材');
  expect(host.textContent).not.toContain('复制整表');
  expect(host.textContent).not.toContain('显示 1 / 1 行 · 支持从 Excel');
  expect(host.querySelectorAll('.poster-col-resizer').length).toBe(5);
  expect(host.querySelector('.poster-floating-add-row-btn')?.textContent?.trim()).toMatch(
    /^[+＋]$/,
  );
  const thumbImg = host.querySelector<HTMLImageElement>(
    'img[src*="/api/workspace/group-poster/materials/thumbnail"]',
  );
  expect(thumbImg).toBeTruthy();
  expect(thumbImg?.getAttribute('src')).toContain('id=mat-thumb-1&v=777888');
  expect(thumbImg?.getAttribute('loading')).toBe('lazy');
});
