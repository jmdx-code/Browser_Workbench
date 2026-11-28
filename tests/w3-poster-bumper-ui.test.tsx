// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import { GroupBumperPage } from '../src/renderer/group-bumper-page.js';
import { GroupPosterPage } from '../src/renderer/group-poster-page.js';
import { parseElectronFilePaths } from '../src/renderer/matrix-grid.js';
import { PosterMaterialCardGrid } from '../src/renderer/modules/poster-material-cards.js';
import { PosterMaterialDetailModal } from '../src/renderer/modules/poster-material-detail-modal.js';
import { PopoverMenu } from '../src/renderer/popover-menu.js';
import { PosterMaterialMatrix } from '../src/renderer/poster-material-matrix.js';
import { BumperSettings } from '../src/shared/group-bumper.js';
import { PosterSettings, type PosterState } from '../src/shared/group-poster.js';

vi.mock('../src/renderer/api.js', () => ({
  api: {
    targetFolders: vi.fn(),
    targetListCommand: vi.fn(),
    bumperAction: vi.fn(),
    bumperState: vi.fn(),
    posterAction: vi.fn(),
    posterState: vi.fn(),
    posterLogs: vi.fn(),
    bluestacksAction: vi.fn(),
    bluestacksState: vi.fn(),
  },
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api.targetFolders).mockResolvedValue([]);
  vi.mocked(api.posterLogs).mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('W3 Group Poster & Bumper UI Suite', () => {
  it('PopoverMenu portals to document.body and <dialog>, uses fixed positioning, flips/clamps to viewport, and closes on outside click & Escape', async () => {
    const origW = window.innerWidth;
    const origH = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 360, configurable: true });

    try {
      // 1. Normal tree -> portals into document.body with upward auto-flip & horizontal clamping
      await act(async () =>
        root.render(
          <div className="workspace">
            <PopoverMenu label="测试菜单" align="end" trigger={<span>菜单</span>}>
              {() => <div className="w-[240px]">菜单内容</div>}
            </PopoverMenu>
          </div>,
        ),
      );
      const triggerWrap = host.querySelector<HTMLElement>('.popover')!;
      vi.spyOn(triggerWrap, 'getBoundingClientRect').mockReturnValue({
        left: 20,
        right: 90,
        top: 300,
        bottom: 330,
        width: 70,
        height: 30,
        x: 20,
        y: 300,
        toJSON: () => ({}),
      });
      await click(host.querySelector('button[aria-label="测试菜单"]'));
      const bodyPanel = document.body.querySelector<HTMLElement>(':scope > .popover-panel');
      expect(bodyPanel).toBeTruthy();
      expect(bodyPanel?.className).toContain('fixed');
      expect(Number.parseInt(bodyPanel?.style.top || '999', 10)).toBeLessThan(300);
      expect(Number.parseInt(bodyPanel?.style.left || '-1', 10)).toBeGreaterThanOrEqual(8);

      // Outside pointerdown closes
      await act(async () => {
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });
      expect(document.querySelector('.popover-panel')).toBeNull();

      // Reopen & Escape closes with stopPropagation
      await click(host.querySelector('button[aria-label="测试菜单"]'));
      expect(document.querySelector('.popover-panel')).toBeTruthy();
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(esc, 'stopPropagation');
      await act(async () => {
        document.dispatchEvent(esc);
      });
      expect(stopSpy).toHaveBeenCalled();
      expect(document.querySelector('.popover-panel')).toBeNull();

      // 2. Inside <dialog open> -> portals inside that <dialog>
      await act(async () =>
        root.render(
          <dialog open>
            <PopoverMenu label="弹窗菜单" trigger={<span>菜单</span>}>
              {() => <div>弹窗内容</div>}
            </PopoverMenu>
          </dialog>,
        ),
      );
      await click(host.querySelector('button[aria-label="弹窗菜单"]'));
      const dlg = host.querySelector('dialog');
      expect(dlg?.querySelector('.popover-panel')).toBeTruthy();
      expect(document.body.querySelector(':scope > .popover-panel')).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origW, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: origH, configurable: true });
    }
  });

  it('.bumper-sticky-header stays unclipped (no overflow-hidden) on GroupBumperPage and GroupPosterPage', async () => {
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
    expect(host.querySelector('.bumper-sticky-header')?.className).not.toContain('overflow-hidden');

    await act(async () =>
      root.render(
        <GroupPosterPage
          state={{
            groups: [],
            materials: [],
            settings: PosterSettings.parse({}),
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
    expect(host.querySelector('.bumper-sticky-header')?.className).not.toContain('overflow-hidden');
  });

  it('parseElectronFilePaths prefers window.workbenchDesktop.materialFilePath, falls back to file.path, and drops work in CardGrid & Matrix', async () => {
    const mockBridgeFile = new File(['abc'], 'video1.mp4', { type: 'video/mp4' });
    const mockFallbackFile = Object.assign(
      new File(['def'], 'photo1.jpg', { type: 'image/jpeg' }),
      {
        path: 'D:\\fallback\\photo1.jpg',
      },
    );
    Object.defineProperty(window, 'workbenchDesktop', {
      value: {
        materialFilePath: (f: File) => (f === mockBridgeFile ? 'C:\\bridge\\video1.mp4' : ''),
      },
      configurable: true,
    });
    const fakeList = [mockBridgeFile, mockFallbackFile] as unknown as FileList;
    expect(parseElectronFilePaths(fakeList)).toEqual([
      'C:\\bridge\\video1.mp4',
      'D:\\fallback\\photo1.jpg',
    ]);

    const addedPaths: string[][] = [];
    await act(async () =>
      root.render(
        <PosterMaterialCardGrid
          rows={[]}
          state={null}
          persistedIds={new Set()}
          busy={false}
          onOpenDispatch={() => {}}
          onOpenDetail={() => {}}
          onEditCard={() => {}}
          onAddCard={() => {}}
          onAddLocalFiles={(paths) => addedPaths.push(paths)}
          onDeleteCard={() => {}}
          onOpenTableEditor={() => {}}
          onCancelTask={async () => {}}
          onThumbnailSaved={() => {}}
        />,
      ),
    );
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [mockBridgeFile] },
    });
    await act(async () => {
      host.querySelector('.poster-cards-toolbar')?.parentElement?.dispatchEvent(dropEvent);
    });
    expect(addedPaths).toEqual([['C:\\bridge\\video1.mp4']]);

    // Matrix scroll-area drop fallback
    const matrixChanges: unknown[] = [];
    await act(async () =>
      root.render(
        <PosterMaterialMatrix
          rows={[]}
          dirty={false}
          busy={false}
          onChange={(r) => matrixChanges.push(r)}
          onSave={() => {}}
          onDeleteSelected={async () => {}}
          onError={() => {}}
          onThumbnailSaved={() => {}}
        />,
      ),
    );
    const matrixDrop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(matrixDrop, 'dataTransfer', {
      value: { types: ['Files'], files: [mockFallbackFile] },
    });
    await act(async () => {
      host.querySelector('.poster-matrix-scroll')?.dispatchEvent(matrixDrop);
    });
    expect(matrixChanges.length).toBeGreaterThan(0);
    Reflect.deleteProperty(window, 'workbenchDesktop');
  });

  it('待核对 (N) badge & PendingReviewModal resolve not_applied & confirmed on GroupPosterPage and GroupBumperPage', async () => {
    const pendingPosterState: PosterState = {
      groups: [],
      materials: [],
      settings: PosterSettings.parse({}),
      total: 0,
      running: false,
      statusText: '',
      profileCounts: {},
      pendingReviewOperations: [
        {
          id: 'op-poster-1',
          profileId: 'p1',
          accountId: '10001',
          groupId: '88001',
          groupName: 'Test Group',
          materialId: null,
          reason: '\x1B[31mSubmit timeout\x1B[0m',
          updatedAt: Date.now(),
        },
      ],
    };
    vi.mocked(api.posterAction).mockResolvedValue({
      ...pendingPosterState,
      pendingReviewOperations: [],
    });
    await act(async () =>
      root.render(
        <GroupPosterPage
          state={pendingPosterState}
          selected={new Set()}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    const posterBadge = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('待核对 (1)'),
    );
    expect(posterBadge).toBeTruthy();
    await click(posterBadge);
    expect(host.textContent).toContain('Submit timeout');
    await click(
      [...host.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('确认未发，解锁重试'),
      ),
    );
    expect(api.posterAction).toHaveBeenCalledWith('pending-operations/resolve', {
      operationId: 'op-poster-1',
      resolution: 'not_applied',
    });

    // Bumper
    const pendingBumperState = {
      groups: [],
      pages: [],
      settings: BumperSettings.parse({}),
      comments: [],
      total: 0,
      running: false,
      statusText: '',
      profileCounts: {},
      pendingReviewOperations: [
        {
          id: 'op-bumper-1',
          profileId: 'p1',
          accountId: '10001',
          groupId: '88001',
          groupName: 'Test Group',
          pageId: '61501',
          pageName: 'Test Page',
          postId: '9911',
          actionKind: 'comment' as const,
          reason: '\x1B[33mUncertain comment\x1B[0m',
          updatedAt: Date.now(),
        },
      ],
    };
    vi.mocked(api.bumperAction).mockResolvedValue({
      ...pendingBumperState,
      pendingReviewOperations: [],
    });
    await act(async () =>
      root.render(
        <GroupBumperPage
          state={pendingBumperState}
          selected={new Set()}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('待核对 (1)')),
    );
    expect(host.textContent).toContain('Uncertain comment');
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '确认已发'),
    );
    expect(api.bumperAction).toHaveBeenCalledWith('pending-operations/resolve', {
      operationId: 'op-bumper-1',
      resolution: 'confirmed',
    });
  });

  it('Slim PosterMaterialDetailModal shows summary & jump-to-records button without TSV bulk copy', async () => {
    const onClose = vi.fn();
    const onOpenRecords = vi.fn();
    vi.mocked(api.posterLogs).mockResolvedValue([
      {
        id: 'log-1',
        profileId: 'p1',
        accountId: '10001',
        accountName: 'Acc1',
        accountAvatar: null,
        identityType: 'personal',
        groupId: '88001',
        groupName: 'G1',
        groupAvatar: null,
        materialId: 'mat-1',
        captionPreview: 'Hello',
        postId: 'pfbid0xyz',
        postUrl: 'https://www.facebook.com/groups/88001/posts/pfbid0xyz/',
        postedAt: Date.now(),
      },
    ]);
    await act(async () =>
      root.render(
        <PosterMaterialDetailModal
          material={{
            id: 'mat-1',
            caption: 'Hello',
            mediaSource: '',
            background: 'plain',
            aiLabel: 'default',
            localFilePath: null,
            mediaKind: 'none',
            cacheStatus: 'ready',
            cacheError: null,
            selected: true,
            usedCount: 3,
            sortOrder: 0,
            createdAt: 1,
            updatedAt: 1,
            hasThumbnail: false,
          }}
          state={{
            groups: [],
            materials: [],
            settings: PosterSettings.parse({}),
            total: 3,
            running: false,
            statusText: '',
            profileCounts: {},
            postedGroupIdsByMaterial: { 'mat-1': ['88001', '88002'] },
            pendingReviewOperations: [
              {
                id: 'op-1',
                profileId: 'p1',
                accountId: '10001',
                groupId: '88003',
                groupName: 'G3',
                materialId: 'mat-1',
                reason: '\x1B[31mNetwork reset\x1B[0m',
                updatedAt: Date.now(),
              },
            ],
          }}
          profiles={[]}
          busy={false}
          onClose={onClose}
          onCancelTask={async () => {}}
          onDeleteTask={async () => {}}
          onOpenRecords={onOpenRecords}
          onMessage={() => {}}
        />,
      ),
    );
    expect(host.textContent).toContain('执行摘要');
    expect(host.textContent).toContain('Network reset');
    expect(host.textContent).not.toContain('批量复制全部');
    const jumpBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('前往「数据与记录」查看完整明细'),
    );
    expect(jumpBtn).toBeTruthy();
    await click(jumpBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenRecords).toHaveBeenCalledTimes(1);
  });

  it('Scoped comment list modal (group vs page, line count badge, confirm before clear) & standalone closeBrowserOnFinish toggle', async () => {
    const baseState = {
      groups: [
        {
          id: '111',
          name: 'G1',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      pages: [
        {
          id: '61501',
          name: 'P1',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      settings: BumperSettings.parse({}),
      pageSettings: BumperSettings.parse({}),
      comments: [
        { id: '00000000-0000-4000-8000-000000000001', text: 'Group A', usedCount: 0, createdAt: 1 },
      ],
      pageComments: [
        { id: '00000000-0000-4000-8000-000000000002', text: 'Page A', usedCount: 0, createdAt: 1 },
        { id: '00000000-0000-4000-8000-000000000003', text: 'Page B', usedCount: 0, createdAt: 2 },
      ],
      total: 0,
      pageTotal: 0,
      running: false,
      statusText: '',
      profileCounts: {},
    };
    vi.mocked(api.bumperAction).mockResolvedValue(baseState);

    await act(async () =>
      root.render(
        <GroupBumperPage
          mode="page-bumper"
          state={baseState}
          selected={new Set()}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('留言列表')),
    );
    expect(host.textContent).toContain('专页作用域');
    expect(host.querySelector('[data-testid="bumper-comment-line-count"]')?.textContent).toBe(
      '2 条',
    );
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '清空列表'),
    );
    expect(host.querySelector('dialog')).toBeTruthy();
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '确认清空'),
    );
    expect(host.querySelector('[data-testid="bumper-comment-line-count"]')?.textContent).toBe(
      '0 条',
    );
    expect(api.bumperAction).not.toHaveBeenCalled();
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '保存'));
    expect(api.bumperAction).toHaveBeenCalledWith(
      'page-comments',
      expect.objectContaining({ scope: 'page', texts: [] }),
    );

    // Standalone closeBrowserOnFinish toggle
    const closeSwitch = host.querySelector<HTMLButtonElement>(
      'button[aria-label="顶贴完毕关闭浏览器"]',
    );
    expect(closeSwitch).toBeTruthy();
    await click(closeSwitch);
    expect(window.localStorage.getItem('wb.pageBumper.closeBrowserOnFinish')).toBe('1');
    expect(api.bumperAction).toHaveBeenLastCalledWith(
      'page-settings',
      expect.objectContaining({ closeBrowserOnFinish: true }),
    );
  });

  it('Chrome multi-card batch dispatch & BlueStacks 加入排班 emits carrier=bluestacks', async () => {
    const mat1 = {
      id: 'mat-b1',
      caption: 'Batch 1',
      mediaSource: '',
      background: 'plain' as const,
      aiLabel: 'default' as const,
      localFilePath: null,
      mediaKind: 'none' as const,
      cacheStatus: 'ready' as const,
      cacheError: null,
      selected: true,
      usedCount: 0,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const mat2 = { ...mat1, id: 'mat-b2', caption: 'Batch 2', sortOrder: 1 };
    const state: PosterState = {
      groups: [
        {
          id: '88001',
          name: 'Group 1',
          avatarUrl: null,
          folderId: null,
          sortOrder: 0,
          totalBumpedCount: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      materials: [mat1, mat2],
      settings: PosterSettings.parse({ closeBrowserOnFinish: true }),
      total: 0,
      running: false,
      statusText: '',
      profileCounts: {},
    };
    vi.mocked(api.posterAction).mockResolvedValue(state);

    const profile = {
      id: '00000000-0000-4000-8000-000000000001',
      browserName: 'Chrome 1',
      alias: 'Chrome 1',
      order: 0,
      groupId: null,
      online: true,
      phase: 'PAUSED' as const,
      synced: true,
      unresolved: 0,
      extensionVersion: '0.3.99',
      capabilities: [],
      account: { state: 'logged_in' as const, id: '10001', name: 'A1', avatar: null },
    };

    await act(async () =>
      root.render(
        <GroupPosterPage
          state={state}
          selected={new Set([profile.id])}
          profiles={[profile]}
          onState={() => {}}
          onMessage={() => {}}
        />,
      ),
    );
    const selectAllCheckbox = [...host.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('全选'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await click(selectAllCheckbox);
    const batchBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('批量发帖 (2)'),
    );
    expect(batchBtn).toBeTruthy();
    await click(batchBtn);
    expect(host.textContent).toContain('批量创建发帖任务 (2 条素材)');
    const submitBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('立即开始批量发帖'),
    );
    await click(submitBtn);
    expect(api.posterAction).toHaveBeenCalledWith(
      'tasks/create',
      expect.objectContaining({ materialId: 'mat-b1', closeBrowserOnFinish: true }),
    );
    expect(api.posterAction).toHaveBeenCalledWith(
      'tasks/create',
      expect.objectContaining({ materialId: 'mat-b2', closeBrowserOnFinish: true }),
    );

    // BlueStacks 加入排班
    const quickSeeds: unknown[] = [];
    await act(async () =>
      root.render(
        <GroupPosterPage
          carrier="bluestacks"
          state={state}
          selected={new Set()}
          selectedBluestacks={new Set(['bs-1'])}
          bluestacksState={{
            configured: true,
            exePath: '',
            confPath: '',
            adbPath: '',
            instances: [],
            folders: [],
            bumperSettings: BumperSettings.parse({}),
            pageBumperSettings: BumperSettings.parse({}),
            riskLimits: { enabled: false, maxDailyActions: 50, actionCounts: {} },
            running: false,
            pageBumperRunning: false,
            activeRunning: false,
            posterRunning: false,
            inviterRunning: false,
            batchLoginRunning: false,
            healthCheckRunning: false,
            statusText: '',
            pageBumperStatusText: '',
            activeStatusText: '',
            posterStatusText: '',
            inviterStatusText: '',
            batchLoginStatusText: '',
            healthCheckStatusText: '',
            total: 0,
            pageTotal: 0,
            profileCounts: {},
            pageBumperProfileCounts: {},
            activeProfileCounts: {},
            posterProfileCounts: {},
            inviterProfileCounts: {},
          }}
          onState={() => {}}
          onQuickSchedule={(seed) => quickSeeds.push(seed)}
          onMessage={() => {}}
        />,
      ),
    );
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('加入排班')),
    );
    expect(quickSeeds[0]).toMatchObject({
      carrier: 'bluestacks',
      targetIds: ['bs-1'],
      steps: [
        expect.objectContaining({
          type: 'bluestacks-group-poster',
          materialIds: ['mat-b1', 'mat-b2'],
        }),
      ],
    });
  });
});
