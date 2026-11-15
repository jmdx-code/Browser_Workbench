// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright-core';
import { KernelLease } from '../src/domain/kernel-lease.js';
import { KernelExecutor } from '../src/application/kernel-executor.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { isBenignScrollPreconditionError } from '../src/shared/kernel-policy.js';
import {
  isRecoverableBrowseFault,
  isSessionBreakingBrowseFault,
} from '../src/shared/browse-execution.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import type { Core, Peer } from '../src/bridge/core.js';
import {
  BUMPER_DEBUGGER_CANCELED_MESSAGE,
  formatBumperDisconnectReason,
  GroupBumperBrowserAdapter,
  isBumperDebuggerCanceledByUser,
  isBumperRecoverableDisconnectError,
} from '../src/infrastructure/group-bumper-runner.js';
import { GroupBumperService } from '../src/application/group-bumper-service.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { watchBumperVideo } from '../src/infrastructure/bumper-video.js';
import type { BumperPost } from '../src/infrastructure/group-bumper-effects.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';
import type { Binding } from '../src/shared/task-execution.js';

const mkTarget = (id: string, name = id): BumperTarget => ({
  id,
  name,
  avatarUrl: null,
  folderId: null,
  sortOrder: 0,
  totalBumpedCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  document.body.innerHTML = '<main></main>';
  document.head.innerHTML = '<base href="https://www.facebook.com/">';
  vi.stubGlobal('location', new URL('https://www.facebook.com/groups/111/'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Feedback 20261114-200204 Root-Cause Fixes', () => {
  it('Fix 1: DOM.scrollIntoViewIfNeeded stale objectId (Could not find object with given id) is treated as benign scroll precondition in both KernelExecutor and ExtensionKernelChannel without weakening Input.*', async () => {
    expect(
      isBenignScrollPreconditionError(
        'DOM.scrollIntoViewIfNeeded',
        new Error('Could not find object with given id'),
        false,
      ),
    ).toBe(true);
    expect(
      isBenignScrollPreconditionError(
        'DOM.scrollIntoViewIfNeeded',
        new Error('Could not find object with given id'),
        true,
      ),
    ).toBe(false);
    expect(
      isBenignScrollPreconditionError(
        'Input.dispatchMouseEvent',
        new Error('Could not find object with given id'),
        false,
      ),
    ).toBe(false);

    const profileId = randomUUID();
    const epoch = randomUUID();
    const leaseId = randomUUID();
    const lease = new KernelLease(profileId, epoch);
    let failMode: 'scroll_stale_object' | 'mouse_stale_object' | 'ok' = 'scroll_stale_object';
    const executor = new KernelExecutor(
      lease,
      {
        scope: async () => {},
        attach: async () => ({
          targetId: 't-1',
          type: 'page',
          url: 'https://www.facebook.com/groups/111/',
          attached: true,
        }),
        detach: async () => {},
        create: async () => ({ tabId: 1 }),
        remove: async () => {},
        send: async (_target, method) => {
          if (method === 'DOM.scrollIntoViewIfNeeded' && failMode === 'scroll_stale_object') {
            throw new Error('Could not find object with given id');
          }
          if (method === 'Input.dispatchMouseEvent' && failMode === 'mouse_stale_object') {
            throw new Error('Could not find object with given id');
          }
          return {};
        },
      },
      [1],
      new Set(),
      'facebook-task',
    );
    executor.grant({
      profileId,
      connectionEpoch: epoch,
      leaseId,
      generation: 0,
      expiresAt: Date.now() + 60_000,
    });
    await executor.attach(1);

    await expect(
      executor.send({ tabId: 1 }, 'DOM.scrollIntoViewIfNeeded', { objectId: 'stale-obj-1' }),
    ).rejects.toThrow('Could not find object with given id');
    expect(executor.reviewRequired).toBe(false);

    // ExtensionKernelChannel keeps activeOperation alive across stale objectId scroll precondition
    const emitted: Array<Record<string, unknown>> = [];
    const journalFinished: Array<{ status: string; reason?: string }> = [];
    const channel = new ExtensionKernelChannel(
      () => ({ profileId, epoch, valid: true }),
      (msg) => emitted.push(msg as Record<string, unknown>),
    );
    Reflect.set(channel, 'access', 'facebook-task');
    Reflect.set(channel, 'activeLeaseId', leaseId);
    Reflect.set(channel, 'executor', executor);
    Reflect.set(channel, 'backend', {});
    const binding: Binding = {
      profileId,
      accountId: '10001',
      connectionEpoch: epoch,
      leaseId,
      generation: 0,
      operationId: randomUUID(),
      jobId: randomUUID(),
      stepId: randomUUID(),
      actionDigest: 'a'.repeat(64),
    };
    Reflect.set(channel, 'activeOperation', binding);
    Reflect.set(channel, 'journal', {
      writable: true,
      finish: async (_b: Binding, status: string, reason?: string) => {
        journalFinished.push({ status, reason });
      },
    });

    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId: randomUUID(),
      sequence: 1,
      connectionEpoch: epoch,
      leaseId,
      kind: 'send',
      target: { tabId: 1 },
      method: 'DOM.scrollIntoViewIfNeeded',
      params: { objectId: 'stale-obj-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted.at(-1)?.error).toContain('Could not find object with given id');
    expect(Reflect.get(channel, 'activeOperation')).toEqual(binding);
    expect(journalFinished).toEqual([]);

    // Subsequent Input.dispatchMouseEvent still works under the same active operation
    failMode = 'ok';
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId: randomUUID(),
      sequence: 2,
      connectionEpoch: epoch,
      leaseId,
      kind: 'send',
      target: { tabId: 1 },
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 10, y: 10 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted.at(-1)?.error).toBeUndefined();

    // Real Input.* errors still trigger reviewRequired & UNKNOWN journal finish
    failMode = 'mouse_stale_object';
    channel.receive({
      type: 'KERNEL_REQUEST',
      requestId: randomUUID(),
      sequence: 3,
      connectionEpoch: epoch,
      leaseId,
      kind: 'send',
      target: { tabId: 1 },
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 10 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(executor.reviewRequired).toBe(true);
    expect(Reflect.get(channel, 'activeOperation')).toBeUndefined();
    expect(journalFinished).toEqual([{ status: 'UNKNOWN', reason: 'NATIVE_RESULT_UNKNOWN' }]);
  });

  it('Fix 2a: canceled_by_user debugger detach propagates from ExtensionKernelChannel -> KernelBridge -> Bumper fast-stop without re-attaching', async () => {
    const profileId = randomUUID();
    const epoch = randomUUID();
    const leaseId = randomUUID();
    const emitted: Array<Record<string, unknown>> = [];
    const channel = new ExtensionKernelChannel(
      () => ({ profileId, epoch, valid: true }),
      (msg) => emitted.push(msg as Record<string, unknown>),
    );
    Reflect.set(channel, 'backend', {
      owns: () => true,
      detached: () => {},
      expectedDetach: () => false,
    });
    Reflect.set(channel, 'activeLeaseId', leaseId);
    channel.detached(42, 'canceled_by_user');
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'KERNEL_EVENT',
        connectionEpoch: epoch,
        leaseId,
        source: { tabId: 42 },
        method: 'Inspector.detached',
        params: { reason: 'canceled_by_user' },
      }),
    ]);

    expect(isRecoverableBrowseFault('KERNEL_DEBUGGER_CANCELED_BY_USER')).toBe(false);
    expect(isSessionBreakingBrowseFault('KERNEL_DEBUGGER_CANCELED_BY_USER')).toBe(true);
    expect(isBumperDebuggerCanceledByUser(new Error('KERNEL_DEBUGGER_CANCELED_BY_USER'))).toBe(
      true,
    );
    expect(isBumperRecoverableDisconnectError(new Error('KERNEL_DEBUGGER_CANCELED_BY_USER'))).toBe(
      false,
    );

    // KernelBridge upgrades session.failureReason & lastSessionFailureReason even if empty Inspector.detached arrived first
    const peer: Peer = {
      profileId,
      epoch,
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      send: () => {},
      close: () => {},
    };
    const coreStub = {
      peers: new Map([[profileId, peer]]),
      hasFixtureKernelOwner: () => false,
      stop: async () => ({ accepted: true, requestId: randomUUID(), state: 'STOPPING' }),
    } as unknown as Core;
    const bridge = new KernelBridge(coreStub, { busy: () => false } as never);
    const fakeSession = {
      peer,
      owner: 'owner-1',
      stamp: { profileId, connectionEpoch: epoch, leaseId, generation: 0, expiresAt: Date.now() },
      closing: false,
      failureReason: null as string | null,
      record: () => {},
      fail(r: string) {
        this.failureReason ??= r;
      },
      endpoint: { close: async () => ({ requestId: 'x', state: 'stopped' }) },
    };
    Reflect.get(bridge, 'sessions').set(profileId, fakeSession);

    await bridge.message(peer, {
      type: 'KERNEL_EVENT',
      connectionEpoch: epoch,
      leaseId,
      source: { tabId: 42 },
      method: 'Inspector.detached',
      params: {},
    });
    expect(fakeSession.failureReason).toBe('KERNEL_DEBUGGER_DETACHED');

    await bridge.message(peer, {
      type: 'KERNEL_EVENT',
      connectionEpoch: epoch,
      leaseId,
      source: { tabId: 42 },
      method: 'Inspector.detached',
      params: { reason: 'canceled_by_user' },
    });
    expect(fakeSession.failureReason).toBe('KERNEL_DEBUGGER_CANCELED_BY_USER');
    expect(bridge.lastSessionFailureReason(profileId, epoch)).toBe(
      'KERNEL_DEBUGGER_CANCELED_BY_USER',
    );

    // GroupBumperBrowserAdapter stops immediately without reconnecting even when Playwright throws generic closed-target error
    let connectCount = 0;
    const proof = {
      profileId,
      tabId: 42,
      targetId: 'target-42',
      ownershipId: randomUUID(),
      browserSessionEpoch: 'bse-1',
    };
    let connFailureReason: string | null = null;
    const page = {
      on: () => {},
      off: () => {},
      url: () => 'https://www.facebook.com/groups/111/',
      goto: async () => {
        connFailureReason = 'KERNEL_DEBUGGER_CANCELED_BY_USER';
        throw new Error('page.evaluate: Target page, context or browser has been closed');
      },
      evaluate: async () => ({
        url: 'https://www.facebook.com/groups/111/',
        ready: true,
        visible: true,
        accountId: '10001',
        verificationRequired: false,
        restricted: false,
      }),
    };
    const kernelMock = {
      lastSessionFailureReason: () => connFailureReason,
      withSummary: async (_p: Peer, run: (port: Record<string, unknown>) => Promise<unknown>) =>
        run({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            workspaceMain: proof,
            operations: [],
          }),
          stopCurrent: async (id: string) => ({
            requestId: id,
            connectionEpoch: peer.epoch,
            state: 'stopped',
          }),
        }),
      inspectIdleFacebookPage: async () => ({ actor: { accountId: '10001' }, proof }),
      inspectFacebookIdentity: async () => ({ actor: { accountId: '10001' }, proof }),
      connectFacebook: async () => {
        connectCount++;
        return {
          stopRequestId: randomUUID(),
          proof,
          get failureReason() {
            return connFailureReason;
          },
          nativeMutationCalls: { input: 0 },
          revokeInput: () => {},
          browser: { contexts: () => [{ pages: () => [page] }] },
          context: async () => ({
            profileId,
            accountId: '10001',
            connectionEpoch: peer.epoch,
            leaseId: randomUUID(),
            generation: 1,
          }),
          execute: async (b: Binding, work: () => Promise<unknown>) => ({
            binding: b,
            value: await work(),
          }),
          reconcile: async () => {},
          close: async () => ({ requestId: randomUUID(), state: 'stopped' }),
          retryClose: async () => ({ requestId: randomUUID(), state: 'stopped' }),
          stopOnCloseFailure: async () => {},
          closeLocalAfterDisconnect: async () => {},
          confirmReconnectedStop: async () => {},
        };
      },
    };
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernelMock as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
      );
      await expect(
        adapter.run(
          profileId,
          [mkTarget('111', 'Group 111')],
          [mkTarget('61570010', 'Target Page')],
          BumperSettings.parse({}),
          { cancelled: () => false, status: () => {}, added: () => {} },
        ),
      ).rejects.toThrow(BUMPER_DEBUGGER_CANCELED_MESSAGE);
      expect(connectCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('Fix 2b: non-manual disconnect formats clean Chinese status, navigateRetainedPageHome fails fast on closed page, and inspectOwnedFacebookPage aligns closeRequestId with connection.stopRequestId', async () => {
    expect(
      formatBumperDisconnectReason(
        new Error(
          'page.evaluate: Target page, context or browser has been closed\nCall log:\n  - waiting',
        ),
      ),
    ).toBe('任务标签页被关闭或调试连接已断开');
    expect(formatBumperDisconnectReason(new Error('KERNEL_DEBUGGER_DETACHED'))).toBe(
      '浏览器调试连接已断开',
    );

    // navigateRetainedPageHome rethrows closed-page errors immediately instead of spinning 15s
    const bridge = new KernelBridge(
      { peers: new Map() } as unknown as Core,
      { busy: () => false } as never,
    );
    const closedPage = {
      url: () => 'https://www.facebook.com/groups/111/',
      off: () => {},
      on: () => {},
      evaluate: async () => {
        throw new Error('page.evaluate: Target page, context or browser has been closed');
      },
    } as unknown as Page;
    const t0 = performance.now();
    await expect(
      (
        bridge as unknown as {
          navigateRetainedPageHome: (p: Page, g: () => void) => Promise<boolean>;
        }
      ).navigateRetainedPageHome(closedPage, () => {}),
    ).rejects.toThrow('Target page, context or browser has been closed');
    expect(performance.now() - t0).toBeLessThan(1000);

    // inspectOwnedFacebookPage uses connection.stopRequestId so pre-assigned session.stopControlId never hits KERNEL_STOP_RETRY_BINDING_MISMATCH
    const profileId = randomUUID();
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      capabilities: ['facebook-task-kernel-v1', 'facebook-task-main-frame-v1'],
      send: () => {},
      close: () => {},
    };
    const preAssignedStopId = randomUUID();
    const closeIdsSeen: string[] = [];
    vi.spyOn(
      bridge as unknown as { connectOwned: (...args: unknown[]) => Promise<unknown> },
      'connectOwned',
    ).mockResolvedValue({
      stopRequestId: preAssignedStopId,
      proof: {
        profileId,
        tabId: 7,
        targetId: 't-7',
        ownershipId: randomUUID(),
        browserSessionEpoch: 'bse-7',
      },
      browser: { contexts: () => [{ pages: () => [{}] }] },
      closedInventory: { tabs: [] },
      close: async (reqId: string) => {
        closeIdsSeen.push(reqId);
        if (reqId !== preAssignedStopId) {
          throw new Error('KERNEL_CONTROL_ID_CONFLICT');
        }
        return { requestId: reqId, state: 'stopped' };
      },
      stopOnCloseFailure: async () => {},
      retryClose: async () => {
        throw new Error('KERNEL_STOP_RETRY_BINDING_MISMATCH');
      },
    });
    const targetProof = {
      profileId,
      tabId: 7,
      targetId: 't-7',
      ownershipId: randomUUID(),
      browserSessionEpoch: 'bse-7',
    };
    await expect(
      (
        bridge as unknown as {
          inspectOwnedFacebookPage: (
            p: Peer,
            assertAllowed: () => void,
            initialUrl: string,
            read: () => Promise<never>,
            foreground: boolean,
            retainForTask: boolean,
            existing: typeof targetProof,
            readOptions: { noWorkspaceCleanup: boolean },
          ) => Promise<unknown>;
        }
      ).inspectOwnedFacebookPage(
        peer,
        () => {},
        'https://www.facebook.com/',
        async () => {
          throw new Error('KERNEL_DEBUGGER_DETACHED');
        },
        false,
        false,
        targetProof,
        { noWorkspaceCleanup: true },
      ),
    ).rejects.toThrow('KERNEL_DEBUGGER_DETACHED');
    expect(closeIdsSeen).toEqual([preAssignedStopId]);
  });

  it('Fix 3 & Fix 4: watchBumperVideo performs multi-wakeup + delayed speaker confirmation polling, and GroupBumperService marks slow-video skips as COMPLETED instead of FAILED', async () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    document.body.append(video);
    video.getBoundingClientRect = () => ({
      x: 100,
      y: 200,
      left: 100,
      top: 200,
      right: 500,
      bottom: 500,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
    video.scrollIntoView = vi.fn();
    let paused = false;
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => paused,
    });
    let playCalls = 0;
    video.play = vi.fn(async () => {
      playCalls++;
      paused = false;
    });

    // Speaker takes 2 poll reads (~600ms) after click before React flips videoSpeakerMuted -> false;
    // a premature 2nd click would toggle it BACK to muted!
    let speakerClicks = 0;
    let speakerState: 'muted' | 'pending_react' | 'unmuted' = 'muted';
    let pollReadsAfterClick = 0;
    const audioSelector = '[data-wb-bumper-video-audio="post-v1"]';

    const page = {
      locator: (sel: string) => ({
        first() {
          return this;
        },
        evaluate: async (fn: Function, arg?: unknown) => fn(video, arg),
        hover: async () => {},
        click: async () => {
          if (sel === audioSelector) {
            speakerClicks++;
            if (speakerState === 'muted') {
              speakerState = 'pending_react';
            } else {
              // Would re-mute if double-clicked!
              speakerState = 'muted';
            }
          }
        },
      }),
    } as unknown as Page;

    let tickCount = 0;
    let currentTime = 0;
    const initial = {
      postId: 'post-v1',
      feedbackId: 'fb-v1',
      videoCSS: 'video',
      videoAudioCSS: audioSelector,
      videoMuted: true,
      videoSpeakerMuted: true,
      videoCurrentTime: 0,
      videoFrames: 0,
      videoPaused: false,
    } as BumperPost;

    let summaryOut: { speakerConfirmedUnmuted: boolean; unmuteClicks: number } | null = null;
    const watchPromise = watchBumperVideo({
      page,
      initial,
      guard: () => {},
      readCurrent: async () => {
        if (speakerState === 'pending_react') {
          pollReadsAfterClick++;
          if (pollReadsAfterClick >= 2) {
            speakerState = 'unmuted';
            video.muted = false;
          }
        }
        tickCount++;
        // Simulate Facebook pausing the video 3 times during playback (at tickCount 3, 5, and 7)
        if (tickCount === 3 || tickCount === 5 || tickCount === 7) {
          paused = true;
        }
        if (!paused && speakerState === 'unmuted') {
          currentTime += 1;
        }
        return {
          ...initial,
          videoPaused: paused,
          videoMuted: speakerState !== 'unmuted',
          videoSpeakerMuted: speakerState !== 'unmuted',
          videoCurrentTime: currentTime,
          videoFrames: currentTime * 30,
        };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      sound: true,
      budgetMs: 9000,
      tickMs: 1000,
      onSummary: (s) => {
        summaryOut = {
          speakerConfirmedUnmuted: s.speakerConfirmedUnmuted,
          unmuteClicks: s.unmuteClicks,
        };
      },
    });

    await vi.runAllTimersAsync();
    expect(await watchPromise).toBe('budget');
    expect(speakerClicks).toBe(1);
    expect(summaryOut).toEqual({ speakerConfirmedUnmuted: true, unmuteClicks: 1 });
    // Woke up all 3 mid-playback pauses (old single-wakeup code only woke up 1)
    expect(playCalls).toBe(3);

    // GroupBumperService marks profiles with skipped slow videos (and 0 failed/pending) as COMPLETED
    vi.useRealTimers();
    const idZero = randomUUID();
    const idFour = randomUUID();
    const savedResults = new Map<
      string,
      { state: string; reason: string; failedSteps: number; skippedSteps: number }
    >();
    let resolveBoth!: () => void;
    const bothDone = new Promise<void>((r) => {
      resolveBoth = r;
    });
    const target = mkTarget('12345', 'Target');
    const service = new GroupBumperService(
      {
        targets: () => [target],
        settings: () => BumperSettings.parse({}),
        todayCounts: () => ({}),
        saveProfileResult: (r: {
          profileId: string;
          state: string;
          reason: string;
          failedSteps: number;
          skippedSteps: number;
        }) => {
          savedResults.set(r.profileId, r);
          if (savedResults.size === 2) resolveBoth();
        },
      } as never,
      {
        ready: () => true,
        busy: async () => false,
        hasControl: () => false,
        stop: async () => {},
        run: async (pid, _groups, _pages, _settings, cb) => {
          if (pid === idFour) {
            cb.added(1);
            cb.added(2);
            cb.added(3);
            cb.added(4);
            cb.issue?.({ kind: 'skipped', reason: '视频播放长时间未推进，未执行本帖互动' });
            cb.issue?.({ kind: 'skipped', reason: '视频播放长时间未推进，未执行本帖互动' });
            cb.issue?.({ kind: 'skipped', reason: '视频播放长时间未推进，未执行本帖互动' });
          } else {
            cb.issue?.({ kind: 'skipped', reason: '视频播放长时间未推进，未执行本帖互动' });
          }
        },
      },
      async () => ({ comments: [], total: 0 }),
      () => {},
      undefined,
      0,
    );

    await service.start({
      profileIds: [idZero, idFour],
      groupIds: ['12345'],
      pageIds: ['12345'],
    });
    await bothDone;

    expect(savedResults.get(idZero)).toMatchObject({
      state: 'COMPLETED',
      reason: '已完成 · 本轮 0 次 · 跳过 1 帖（视频加载超时）',
      failedSteps: 0,
      skippedSteps: 1,
    });
    expect(savedResults.get(idFour)).toMatchObject({
      state: 'COMPLETED',
      reason: '已完成 · 本轮 4 次 · 跳过 3 帖（视频加载超时）',
      failedSteps: 0,
      skippedSteps: 3,
    });
  });

  it('Fix 3b: stalled video inside GroupBumperBrowserAdapter.run settles NOT_APPLIED cleanly without BumperSetupUnconfirmed debugger detach/reconnect even after speaker/hover Input.* mutations', async () => {
    vi.useFakeTimers();
    const profileId = randomUUID();
    const epoch = randomUUID();
    const peer: Peer = {
      profileId,
      epoch,
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      send: () => {},
      close: () => {},
    };
    const groupId = '111222';
    const pageId = '61570099';
    const postId = '999888777';
    const videoEl = document.createElement('video');
    document.body.append(videoEl);
    videoEl.getBoundingClientRect = () => ({
      x: 100,
      y: 220,
      left: 100,
      top: 220,
      right: 500,
      bottom: 420,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });
    videoEl.scrollIntoView = vi.fn();
    videoEl.play = vi.fn(async () => {});

    const proof = {
      profileId,
      tabId: 9,
      targetId: 't-9',
      ownershipId: randomUUID(),
      browserSessionEpoch: 'bse-9',
    };
    let connectCount = 0;
    const nativeMutationCalls = { input: 0 };
    const reconciledOutcomes: string[] = [];

    let currentUrl = `https://www.facebook.com/groups/${groupId}/?sorting_setting=CHRONOLOGICAL`;
    const page = {
      on: () => {},
      off: () => {},
      url: () => currentUrl,
      viewportSize: () => ({ width: 1024, height: 768 }),
      goto: async (url: string) => {
        currentUrl = url;
        return null;
      },
      waitForURL: async () => {},
      mouse: {
        move: async () => {
          nativeMutationCalls.input++;
        },
        wheel: async () => {
          nativeMutationCalls.input++;
        },
      },
      locator: () => ({
        first() {
          return this;
        },
        hover: async () => {
          nativeMutationCalls.input++;
        },
        click: async () => {
          nativeMutationCalls.input++;
        },
        evaluate: async (fn: Function, arg?: unknown) => fn(videoEl, arg),
      }),
      evaluate: async (fn: Function, input?: { groupId?: string; targetPostId?: string }) => {
        if (!input) return `${currentUrl}|1000`;
        if (fn.name === 'projectGroupInvitationState') {
          return {
            accountId: '10001',
            ready: true,
            visible: true,
            verificationRequired: false,
          };
        }
        if (typeof input === 'string') return null;
        return {
          url: currentUrl,
          groupIds: [groupId],
          avatarUrl: null,
          pageAvatarUrl: null,
          ready: true,
          visible: true,
          restricted: false,
          loading: false,
          groupEntryCSS: null,
          joinGroupCSS: null,
          welcomeDismissCSS: null,
          posts: [
            {
              postId,
              postUrl: `https://www.facebook.com/groups/${groupId}/posts/${postId}/`,
              authorId: pageId,
              authorName: 'Target Page',
              authorAliases: [],
              authorAvatarUrl: null,
              pinned: false,
              ageHours: 1,
              timeText: '1h',
              feedbackId: 'fb-' + postId,
              liked: false,
              reactionState: 'inactive',
              postCSS: `[data-wb-bumper-post="${postId}"]`,
              likeCSS: `[data-wb-bumper-like="${postId}"]`,
              commentCSS: null,
              commentButtonCSS: null,
              hasVideo: true,
              videoEnded: false,
              videoPaused: false,
              videoReadyState: 2,
              videoCurrentSrc: 'blob:https://www.facebook.com/vid-stalled',
              videoFrames: 0,
              videoCurrentTime: 0,
              videoDuration: 30,
              videoMuted: true,
              videoSpeakerMuted: true,
              videoCSS: `[data-wb-bumper-video="${postId}"]`,
              videoAudioCSS: `[data-wb-bumper-video-audio="${postId}"]`,
              comments: [],
            },
          ],
        };
      },
    };

    const connection = {
      stopRequestId: randomUUID(),
      proof,
      hasPendingCommands: false,
      failureReason: null,
      nativeMutationCalls,
      submissionCalls: { mousePress: 0, enter: 0 },
      revokeInput: () => {},
      browser: { contexts: () => [{ pages: () => [page] }] },
      context: async () => ({
        profileId,
        accountId: '10001',
        connectionEpoch: peer.epoch,
        leaseId: randomUUID(),
        generation: 1,
      }),
      execute: async (b: Binding, work: () => Promise<unknown>) => ({
        binding: b,
        value: await work(),
      }),
      reconcile: async (_b: Binding, res: { outcome: string }) => {
        reconciledOutcomes.push(res.outcome);
      },
      close: async () => ({ requestId: randomUUID(), state: 'stopped' }),
      retryClose: async () => ({ requestId: randomUUID(), state: 'stopped' }),
      stopOnCloseFailure: async () => {},
      closeLocalAfterDisconnect: async () => {},
      confirmReconnectedStop: async () => {},
    };

    const kernelMock = {
      lastSessionFailureReason: () => null,
      withSummary: async (_p: Peer, run: (port: Record<string, unknown>) => Promise<unknown>) =>
        run({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            workspaceMain: proof,
            operations: [],
          }),
          stopCurrent: async (id: string) => ({
            requestId: id,
            connectionEpoch: peer.epoch,
            state: 'stopped',
          }),
        }),
      inspectIdleFacebookPage: async () => ({ actor: { accountId: '10001' }, proof }),
      inspectFacebookIdentity: async () => ({ actor: { accountId: '10001' }, proof }),
      connectFacebook: async () => {
        connectCount++;
        return connection;
      },
    };

    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const issues: Array<{ kind: string; reason: string }> = [];
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernelMock as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0.005,
      );
      const runPromise = adapter.run(
        profileId,
        [mkTarget(groupId, 'Group 111222')],
        [mkTarget(pageId, 'Target Page')],
        {
          ...BumperSettings.parse({}),
          searchMode: 'time_sort',
          enableSound: true,
          likeProbability: 100,
          commentProbability: 0,
          maxPostsPerGroupPage: 1,
        },
        {
          cancelled: () => false,
          status: () => {},
          added: () => {},
          issue: (iss) => issues.push(iss),
        },
      );
      await vi.runAllTimersAsync();
      await runPromise;

      // Connect was only called ONCE (zero unnecessary debugger detach/re-attach cycles!)
      expect(connectCount).toBe(1);
      // Hover/speaker click DID mutate nativeMutationCalls.input during watchBumperVideo
      expect(nativeMutationCalls.input).toBeGreaterThan(0);
      // Watch setup operation settled cleanly as NOT_APPLIED instead of ENDED_UNKNOWN
      expect(reconciledOutcomes).toContain('NOT_APPLIED');
      expect(issues).toEqual([
        expect.objectContaining({
          kind: 'skipped',
          reason: expect.stringMatching(/未推进|未实际播放/),
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
