// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../src/renderer/api.js';
import {
  isUnsupportedOnBluestacks,
  validateSteps,
} from '../src/renderer/auto-scheduler-step-helpers.js';
import { CombinationCard } from '../src/renderer/combination-card.js';
import { Editor } from '../src/renderer/editor.js';
import { buildLiveRunCards, LiveRunsDrawer } from '../src/renderer/modules/live-runs-drawer.js';
import { Sidebar } from '../src/renderer/sidebar.js';
import { CombinationSchema, type SavedCombination } from '../src/shared/contracts.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('../src/renderer/api.js', () => ({
  api: {
    create: vi.fn(),
    saveCombination: vi.fn(),
    bumperState: vi.fn().mockResolvedValue({ pages: [] }),
    cleanupProfileTabs: vi.fn(),
    reorderProfiles: vi.fn(),
    reorderGroups: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    deleteGroup: vi.fn(),
    renameProfile: vi.fn(),
    deleteProfiles: vi.fn(),
    arrangeWindows: vi.fn(),
  },
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const click = async (el: Element | null | undefined) => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('W2 Active UI & Multi-Round Regression Suite', () => {
  it('preserves multi-round loop (rounds=3 & until-stopped) in Combination Editor and CombinationCard', async () => {
    const stepId = '10000000-0000-4000-8000-000000000001';
    const comboBase = CombinationSchema.parse({
      name: '多轮组合',
      note: '',
      randomOrder: false,
      loop: { mode: 'finite', rounds: 1 },
      steps: [{ id: stepId, type: 'feed', durationMinutes: 4, maxLikes: 1, minLikeCount: 0 }],
    });
    const row3: SavedCombination = {
      id: '20000000-0000-4000-8000-000000000001',
      version: 1,
      revision: 1,
      updatedAt: 1000,
      draft: null,
      saved: { ...comboBase, loop: { mode: 'finite', rounds: 3 } },
    };
    const rowInf: SavedCombination = {
      id: '20000000-0000-4000-8000-000000000002',
      version: 1,
      revision: 1,
      updatedAt: 1000,
      draft: null,
      saved: { ...comboBase, name: '无限组合', loop: { mode: 'until-stopped' } },
    };

    // CombinationCard shows loop badges for finite > 1 and until-stopped
    await act(async () =>
      root.render(
        <div>
          <CombinationCard
            row={row3}
            managing={false}
            isChecked={false}
            selectedCount={0}
            busySelected={0}
            offlineSelected={0}
            eligibleImmediateCount={0}
            resourceSummaries={[]}
            color="graphite"
            onToggleRow={vi.fn()}
            onEdit={vi.fn()}
            onCopy={vi.fn()}
            onRequestDelete={vi.fn()}
            onResources={vi.fn()}
          />
          <CombinationCard
            row={rowInf}
            managing={false}
            isChecked={false}
            selectedCount={0}
            busySelected={0}
            offlineSelected={0}
            eligibleImmediateCount={0}
            resourceSummaries={[]}
            color="blue"
            onToggleRow={vi.fn()}
            onEdit={vi.fn()}
            onCopy={vi.fn()}
            onRequestDelete={vi.fn()}
            onResources={vi.fn()}
          />
        </div>,
      ),
    );
    expect(host.textContent).toContain('循环 3 轮');
    expect(host.textContent).toContain('持续循环');

    // Editor saves rounds=3 and until-stopped accurately; BlueStacks disables until-stopped
    vi.mocked(api.saveCombination).mockResolvedValue(row3);
    await act(async () =>
      root.render(
        <Editor
          initial={row3}
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
    const roundsInput = host.querySelector<HTMLInputElement>('input[aria-label="循环轮数"]');
    expect(roundsInput?.value).toBe('3');

    const saveBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '保存组合',
    );
    await click(saveBtn);
    expect(api.saveCombination).toHaveBeenCalledWith(
      row3.id,
      1,
      expect.objectContaining({ loop: { mode: 'finite', rounds: 3 } }),
    );

    const untilBtn = [...host.querySelectorAll('button[role="radio"]')].find((b) =>
      b.textContent?.includes('持续循环'),
    );
    await click(untilBtn);
    await click(saveBtn);
    expect(api.saveCombination).toHaveBeenLastCalledWith(
      row3.id,
      1,
      expect.objectContaining({ loop: { mode: 'until-stopped' } }),
    );

    await act(async () =>
      root.render(
        <Editor
          carrier="bluestacks"
          initial={row3}
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
    const bsUntilBtn = [...host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
      (b) => b.textContent?.includes('持续循环'),
    );
    expect(bsUntilBtn?.disabled).toBe(true);
  });

  it('auto-scheduler-step-helpers allows marketplace on BlueStacks and blocks pure add_suggested', () => {
    const marketCombo: SavedCombination = {
      id: '30000000-0000-4000-8000-000000000001',
      version: 1,
      revision: 1,
      updatedAt: 1000,
      draft: null,
      saved: {
        name: '纯商城',
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: '30000000-0000-4000-8000-000000000011',
            type: 'marketplace',
            durationMinutes: 3,
            keyword: '',
            maxLikes: 0,
            minLikeCount: 0,
          },
        ],
      },
    };
    const addFriendCombo: SavedCombination = {
      id: '30000000-0000-4000-8000-000000000002',
      version: 1,
      revision: 1,
      updatedAt: 1000,
      draft: null,
      saved: {
        name: '纯加推荐好友',
        note: '',
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
        steps: [
          {
            id: '30000000-0000-4000-8000-000000000012',
            type: 'friends',
            friendAction: 'add_suggested',
            durationMinutes: 5,
            acceptMode: 'count',
            maxAccepts: 3,
            maxLikes: 0,
            minLikeCount: 0,
          },
        ],
      },
    };
    expect(isUnsupportedOnBluestacks(marketCombo)).toBe(false);
    expect(isUnsupportedOnBluestacks(addFriendCombo)).toBe(true);

    expect(
      validateSteps(
        [
          {
            id: '40000000-0000-4000-8000-000000000001',
            type: 'bluestacks-active-combination',
            combinationId: marketCombo.id,
          },
        ],
        [marketCombo, addFriendCombo],
      ),
    ).toBeNull();
    const err = validateSteps(
      [
        {
          id: '40000000-0000-4000-8000-000000000002',
          type: 'bluestacks-active-combination',
          combinationId: addFriendCombo.id,
        },
      ],
      [marketCombo, addFriendCombo],
    );
    expect(err?.message).toContain('加推荐好友');
  });

  it('LiveRunsDrawer matches multi-step scheduler progress and renders failed step in rose tone', async () => {
    const pidSched = '50000000-0000-4000-8000-000000000001';
    const pidPlan = '50000000-0000-4000-8000-000000000002';
    const planId = '50000000-0000-4000-8000-000000000010';
    const cards = buildLiveRunCards({
      profiles: [
        {
          id: pidSched,
          alias: '排班号',
          groupId: null,
          order: 0,
          online: true,
          phase: 'PAUSED',
          synced: true,
          unresolved: 0,
          extensionVersion: '0.3.92',
          capabilities: [],
          account: { state: 'logged-in', id: '1', name: 'A', avatar: null },
        },
        {
          id: pidPlan,
          alias: '组合号',
          groupId: null,
          order: 1,
          online: true,
          phase: 'PAUSED',
          synced: true,
          unresolved: 0,
          extensionVersion: '0.3.92',
          capabilities: [],
          account: { state: 'logged-in', id: '2', name: 'B', avatar: null },
        },
      ],
      runtime: {
        dispatchEnabled: true,
        settings: { maxConcurrentProfiles: 5 },
        plans: [
          {
            id: planId,
            batchId: 'b1',
            profileId: pidPlan,
            combinationId: 'c1',
            version: 1,
            accountId: '2',
            snapshot: {
              name: '活跃失败展示',
              note: '',
              randomOrder: false,
              loop: { mode: 'finite', rounds: 1 },
              steps: [
                { id: 's1', type: 'feed', durationMinutes: 3, maxLikes: 0, minLikeCount: 0 },
                { id: 's2', type: 'video', durationMinutes: 3, maxLikes: 0, minLikeCount: 0 },
              ],
            },
            state: 'RUNNING',
            reason: '',
            controlMode: null,
            controlRequestId: null,
            controlConfirmed: false,
            round: 1,
            position: 1,
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        currentSteps: [],
        roundSteps: [
          {
            id: 'rs1',
            jobId: planId,
            round: 1,
            position: 0,
            status: 'FAILED',
            type: 'feed',
            maxLikes: 0,
            outcome: {
              version: 1,
              kind: 'FAILED',
              reason: 'FACEBOOK_TASK_DOCUMENT_ERROR_PAGE',
              endedAt: 1500,
              submissionPhase: 'NOT_APPLICABLE',
              businessResult: 'NOT_APPLICABLE',
            },
            progress: {
              revision: 1,
              effectiveMilliseconds: 0,
              likes: 0,
              published: 0,
              cursor: null,
            },
          },
          {
            id: 'rs2',
            jobId: planId,
            round: 1,
            position: 1,
            status: 'ACTIVE',
            type: 'video',
            maxLikes: 0,
            progress: {
              revision: 0,
              effectiveMilliseconds: 0,
              likes: 0,
              published: 0,
              cursor: null,
            },
          },
        ],
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
        schedules: [
          {
            id: 'sched-1',
            name: '多步排班',
            enabled: true,
            carrier: 'browser',
            targetSelector: {
              mode: 'explicit',
              groupIds: [],
              targetIds: [pidSched],
              skipAbnormalAccounts: true,
            },
            trigger: {
              mode: 'weekly',
              onceAt: null,
              weekdays: [1],
              times: ['09:00'],
              timeZone: 'Asia/Shanghai',
              misfireGraceMinutes: 120,
            },
            steps: [
              { id: 'st1', type: 'page-bumper', pageIds: ['p1'] },
              { id: 'st2', type: 'page-bumper', pageIds: ['p2'] },
              { id: 'st3', type: 'page-bumper', pageIds: ['p3'] },
            ],
            closeWindowOnFinish: true,
            maxSafetyMinutesPerTarget: null,
            sortOrder: 0,
            createdAt: 1000,
            updatedAt: 1000,
            resolvedTargetCount: 1,
            nextRun: { nextAt: null, label: '' },
          },
        ],
        activeRuns: [
          {
            id: 'run-1',
            scheduleId: 'sched-1',
            scheduleName: '多步排班',
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
                runId: 'run-1',
                targetId: pidSched,
                targetName: '排班号',
                status: 'running',
                currentStep: '步骤 2/3 · 专页顶贴 (1专页)',
                summary: '顶贴中',
                bumpedCount: 0,
                postedCount: 0,
                softIssues: 0,
                hardBlockReason: null,
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

    const schedCard = cards.find((c) => c.targetId === pidSched);
    expect(schedCard?.steps.map((s) => s.state)).toEqual(['done', 'running', 'pending']);

    const planCard = cards.find((c) => c.targetId === pidPlan);
    expect(planCard?.steps[0]?.state).toBe('failed');

    await act(async () =>
      root.render(
        <LiveRunsDrawer
          open={true}
          onClose={vi.fn()}
          cards={cards}
          busy={false}
          onShowBrowser={vi.fn()}
          onStopCard={vi.fn()}
          onStopAll={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector('.text-rose-700')?.textContent).toContain('浏览首页');
  });

  it('Sidebar renders duplicate profileDirectory conflict badge in warn tone', async () => {
    const pid = '60000000-0000-4000-8000-000000000001';
    const conflictMsg = '绑定目录冲突：Profile 1（与 窗口B 共用）';
    await act(async () =>
      root.render(
        <Sidebar
          workspace={{
            profiles: [
              {
                id: pid,
                alias: '窗口A',
                browserName: '窗口A',
                groupId: null,
                order: 0,
                online: false,
                phase: 'OFFLINE',
                synced: false,
                unresolved: 0,
                extensionVersion: null,
                capabilities: [],
                bindingConflict: conflictMsg,
                account: { state: 'unknown', id: null, name: null, avatar: null },
              },
            ],
            groups: [],
            combinations: [],
            support: { comboExecution: true },
          }}
          tasks={null}
          selected={new Set()}
          onSelect={vi.fn()}
          onInspect={vi.fn()}
          mutate={vi.fn().mockResolvedValue(undefined)}
          inspections={[]}
          inspectionAvailable={false}
          inspectionError=""
          busy={false}
          onCheck={vi.fn()}
          onShow={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain(conflictMsg);
    const badgeSpan = [...host.querySelectorAll('span')].find(
      (el) =>
        el.textContent?.includes(conflictMsg) && el.className.includes('bg-[var(--warn-soft)]'),
    );
    expect(badgeSpan).toBeTruthy();
  });
});
