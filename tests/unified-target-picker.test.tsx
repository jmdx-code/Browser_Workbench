// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import { UnifiedTargetPicker } from '../src/renderer/modules/shared/unified-target-picker.js';
import { InviterWorkspacePage } from '../src/renderer/inviter-workspace-page.js';
import { GroupPosterPage } from '../src/renderer/group-poster-page.js';
import { PosterSettings } from '../src/shared/group-poster.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/renderer/api.js', () => ({
  api: {
    targetFolders: vi.fn(),
    targetListCommand: vi.fn(),
    addInviterGroups: vi.fn(),
    deleteInviterGroups: vi.fn(),
    refreshGroupInviterGroups: vi.fn(),
    stopRefreshGroupInviterGroups: vi.fn(),
    bluestacksAction: vi.fn(),
  },
}));

describe('Unified Group & Page Picker + BlueStacks Inviter/Poster parity', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(api.targetFolders).mockResolvedValue([
      { id: 'folder-1', listKind: 'shared_groups', name: '新小组', sortOrder: 0, createdAt: 1 },
    ]);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    vi.clearAllMocks();
  });

  it('UnifiedTargetPicker renders real avatars, folder headers, numeric IDs, and supports whole-folder selection', async () => {
    let selected: string[] = [];
    const onChange = vi.fn((next: string[]) => {
      selected = next;
    });

    await act(async () => {
      root.render(
        <UnifiedTargetPicker
          title="1. 选择目标小组"
          listKind="shared_groups"
          showCodeSub
          items={[
            {
              id: '3017439278594998',
              name: '新小组测试群',
              sub: '3017439278594998',
              avatarUrl: 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4',
              folderId: 'folder-1',
              sortOrder: 0,
            },
            {
              id: '1072811415396195',
              name: '未分组测试群',
              sub: '1072811415396195',
              avatarUrl: 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4',
              folderId: null,
              sortOrder: 0,
            },
          ]}
          selectedIds={selected}
          onChange={onChange}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Real avatars rendered
    const imgs = host.querySelectorAll('.unified-picker-avatar img');
    expect(imgs.length).toBe(2);
    // Folders rendered in exact order
    const folderText = host.textContent ?? '';
    expect(folderText).toContain('新小组');
    expect(folderText).toContain('未分组');
    expect(folderText).toContain('3017439278594998');
    expect(folderText).toContain('按 ID 选中');

    // Selecting entire folder checkbox selects its items
    const folderCheck = host.querySelector(
      'input[aria-label="选择整组 新小组"]',
    ) as HTMLInputElement;
    expect(folderCheck).toBeTruthy();
    await act(async () => {
      folderCheck.click();
    });
    expect(onChange).toHaveBeenCalledWith(['3017439278594998']);
  });

  it('InviterWorkspacePage (bluestacks) uses unified FinderTargetList with real avatars, folders, and numeric IDs', async () => {
    await act(async () => {
      root.render(
        <InviterWorkspacePage
          carrier="bluestacks"
          bluestacksState={null}
          onBluestacksState={() => {}}
          selectedTargetIds={new Set()}
          fallbackGroups={[
            {
              id: '3017439278594998',
              name: 'Grace Group',
              avatarUrl: 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4',
              folderId: 'folder-1',
              sortOrder: 0,
              totalBumpedCount: 3,
              createdAt: 0,
              updatedAt: 0,
            },
          ]}
          state={null}
          onRefresh={async () => {}}
          onMessage={() => {}}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('.finder-target-list')).toBeTruthy();
    expect(host.querySelectorAll('.finder-name img').length).toBe(1);
    expect(host.textContent).toContain('新小组');
    expect(host.textContent).toContain('3017439278594998');
    expect(host.textContent).toContain('＋ 添加小组');
    expect(host.textContent).toContain('按 ID 选中');
  });

  it('Unified GroupPosterPage in bluestacks carrier renders material thumbnails and 目标小组库 FinderTargetList', async () => {
    await act(async () => {
      root.render(
        <GroupPosterPage
          carrier="bluestacks"
          state={{
            groups: [
              {
                id: '3017439278594998',
                name: 'Grace Group',
                avatarUrl: 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4',
                folderId: 'folder-1',
                sortOrder: 0,
                totalBumpedCount: 1,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
            materials: [
              {
                id: 'mat-1',
                caption: '带图素材测试',
                mediaSource: 'https://example.com/a.jpg',
                mediaKind: 'image',
                background: 'plain',
                aiLabel: 'default',
                localFilePath: 'C:/tmp/a.jpg',
                hasThumbnail: true,
                cacheStatus: 'ready',
                cacheError: null,
                selected: true,
                sortOrder: 0,
                usedCount: 0,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            settings: PosterSettings.parse({}),
            running: false,
            statusText: '',
            total: 0,
            profileCounts: {},
            pendingReviewOperations: [],
            tasks: [],
            postedGroupIdsByMaterial: {},
            activeGroupsByMaterial: {},
          }}
          selected={new Set()}
          bluestacksState={null}
          selectedBluestacks={new Set()}
          onState={() => {}}
          onMessage={() => {}}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const matImg = host.querySelector('img[src*="/api/workspace/group-poster/materials/media"]');
    expect(matImg).toBeTruthy();

    // Switch to 目标小组库 tab
    const groupsTab = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('目标小组库'),
    );
    expect(groupsTab).toBeTruthy();
    await act(async () => {
      groupsTab?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector('.finder-target-list')).toBeTruthy();
    expect(host.querySelectorAll('.finder-name img').length).toBe(1);
  });
});
