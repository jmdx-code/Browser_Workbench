import { bumperNativeEvents } from './fixtures/bumper-native-events.js';
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { observeBridgeIncomingMessage } from '../src/bridge/server.js';
import { inspectOutgoingExtensionMessage } from '../extension/worker.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { Core, type Peer } from '../src/bridge/core.js';
import { FacebookGroupSessionHelper } from '../src/infrastructure/facebook-group-session.js';
import { GroupBumperBrowserAdapter } from '../src/infrastructure/group-bumper-runner.js';
import { GroupPosterBrowserAdapter } from '../src/infrastructure/group-poster-runner.js';
import { SqliteGroupBumperRepository } from '../src/infrastructure/group-bumper-store.js';
import { BumperSettings, type BumperTarget } from '../src/shared/group-bumper.js';
import { devDiag } from '../src/shared/dev-diagnostics.js';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WO-BUMPER-STABILITY-20261109: 11 Mandatory Stability & Recovery Scenarios', () => {
  it('Scenario 1: Bridge large message protection, dual-end UTF-8 diagnostics, and facebook-task requestWillBeSent truncation', async () => {
    const recordSpy = vi.spyOn(devDiag, 'record').mockImplementation(() => {});

    // 1a. Server observeBridgeIncomingMessage (> 2 MiB UTF-8 triggers BRIDGE_LARGE_MESSAGE_OBSERVED)
    const multibytePayload = '中'.repeat(750_000); // ~2.25 MiB in UTF-8
    const parsedIncoming = {
      type: 'KERNEL_EVENT',
      event: { method: 'Network.requestWillBeSent' },
      requestId: 'req-1',
    };
    const rawBuffer = Buffer.from(
      JSON.stringify({ ...parsedIncoming, body: multibytePayload }),
      'utf8',
    );
    const observedIn = observeBridgeIncomingMessage(rawBuffer, parsedIncoming, 'prof-1');
    expect(observedIn.observed).toBe(true);
    expect(observedIn.utf8Bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'BRIDGE_WS',
        event: 'BRIDGE_LARGE_MESSAGE_OBSERVED',
        profileId: 'prof-1',
        data: expect.objectContaining({
          type: 'KERNEL_EVENT',
          method: 'Network.requestWillBeSent',
          requestId: 'req-1',
        }),
      }),
    );

    // 1b. Extension inspectOutgoingExtensionMessage (> 1 MiB UTF-8 triggers structured diagnostic)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outMsg = {
      type: 'KERNEL_EVENT',
      event: { method: 'Network.requestWillBeSent', payload: '中'.repeat(400_000) },
    };
    const diagOut = inspectOutgoingExtensionMessage(outMsg);
    expect(diagOut.observed).toBe(true);
    expect(diagOut.utf8Bytes).toBeGreaterThan(1_048_576);
    expect(diagOut.type).toBe('KERNEL_EVENT');
    expect(diagOut.method).toBe('Network.requestWillBeSent');
    expect(warnSpy).toHaveBeenCalled();

    // 1c. ExtensionKernelChannel facebook-task Network.requestWillBeSent truncation
    const sentMessages: Array<Record<string, unknown>> = [];
    const channel = new ExtensionKernelChannel(
      () => ({ profileId: randomUUID(), epoch: randomUUID(), valid: true }),
      (msg) => sentMessages.push(msg as Record<string, unknown>),
    );
    Reflect.set(channel, 'access', 'facebook-task');
    Reflect.set(channel, 'executor', {
      acceptsEvent: () => true,
      noteFrameNavigated: () => {},
    });
    const emitEvent = (requestObj: Record<string, unknown>) => {
      sentMessages.length = 0;
      (
        channel as unknown as {
          event: (
            source: { tabId: number },
            method: string,
            value: Record<string, unknown>,
          ) => void;
        }
      ).event({ tabId: 1 }, 'Network.requestWillBeSent', {
        requestId: 'net-1',
        request: requestObj,
      });
      const topParams = sentMessages[0]?.params as Record<string, unknown> | undefined;
      return topParams?.request as Record<string, unknown>;
    };

    // Case A: Small postData (e.g. GraphQL variables) is 100% untouched
    const smallGraphql = 'fb_api_req_friendly_name=CometUFIFeedbackReactMutation&variables=%7B%7D';
    const resSmall = emitEvent({
      url: 'https://www.facebook.com/api/graphql/',
      method: 'POST',
      postData: smallGraphql,
    });
    expect(resSmall.postData).toBe(smallGraphql);
    expect(resSmall.__wbPostDataTruncated).toBeUndefined();

    // Case B: Small postDataEntries ONLY (no postData) is 100% untouched
    const smallEntries = [{ bytes: 'c21hbGwtZW50cnk=' }];
    const resSmallEntries = emitEvent({
      url: 'https://www.facebook.com/api/graphql/',
      method: 'POST',
      postDataEntries: smallEntries,
    });
    expect(resSmallEntries.postDataEntries).toEqual(smallEntries);
    expect(resSmallEntries.__wbPostDataEntriesTruncated).toBeUndefined();

    // Case C: Large postData (> 512 KiB) is truncated to 16_384 chars with markers
    const hugePostData = 'x'.repeat(600_000);
    const resHugePost = emitEvent({
      url: 'https://upload.facebook.com/ajax/bz',
      method: 'POST',
      postData: hugePostData,
    });
    expect(typeof resHugePost.postData).toBe('string');
    expect((resHugePost.postData as string).length).toBe(16_384);
    expect(resHugePost.__wbPostDataTruncated).toBe(true);
    expect(resHugePost.originalPostDataBytes).toBe(600_000);

    // Case D: Large postDataEntries ONLY (> 512 KiB, no postData) removes postDataEntries and sets markers
    const hugeEntries = [{ bytes: 'y'.repeat(600_000) }];
    const resHugeEntries = emitEvent({
      url: 'https://upload.facebook.com/video_upload',
      method: 'POST',
      postDataEntries: hugeEntries,
    });
    expect(resHugeEntries.postDataEntries).toBeUndefined();
    expect(resHugeEntries.__wbPostDataEntriesTruncated).toBe(true);
    expect(resHugeEntries.originalPostDataEntriesBytes).toBeGreaterThan(524_288);
  });

  it('Scenario 2: Close tolerance when tab state is LOST (and inspectOwnedFacebookPage / GroupPosterBrowserAdapter.stop close fallback)', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      // 2a. GroupPosterBrowserAdapter.stop falls back to stopOnCloseFailure + retryClose on close failure
      const calls: string[] = [];
      const posterProfileId = randomUUID();
      const runner = new GroupPosterBrowserAdapter(
        repo,
        () => undefined,
        () => undefined,
      );
      const stopPosterId = randomUUID();
      const fakeConn = {
        stopRequestId: stopPosterId,
        close: async (id?: string) => {
          calls.push(`close:${id}`);
          throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
        },
        stopOnCloseFailure: async () => {
          calls.push('stopOnCloseFailure');
        },
        retryClose: async (id?: string) => {
          calls.push(`retryClose:${id}`);
        },
      };
      Reflect.get(runner, 'connections').set(posterProfileId, fakeConn);
      await runner.stop(posterProfileId);
      expect(calls).toEqual([
        `close:${stopPosterId}`,
        'stopOnCloseFailure',
        `retryClose:${stopPosterId}`,
      ]);
      expect(Reflect.get(runner, 'connections').has(posterProfileId)).toBe(false);

      // 2b. GroupBumperBrowserAdapter.stop falls back to stopOnCloseFailure + retryClose on same-epoch close failure and clears connections/closing
      const bumperCalls: string[] = [];
      const bumperProfileId = randomUUID();
      const stopBumperId = randomUUID();
      const epochId = randomUUID();
      const peer: Peer = {
        profileId: bumperProfileId,
        epoch: epochId,
        online: true,
        synced: true,
        paused: true,
        phase: 'PAUSED',
        send: () => {},
        close: () => {},
      };
      const bumperConn = {
        stopRequestId: stopBumperId,
        revokeInput: (r: string) => bumperCalls.push(`revoke:${r}`),
        close: async (id?: string) => {
          bumperCalls.push(`close:${id}`);
          throw Error('CLOSE_FIRST_ATTEMPT_TIMEOUT');
        },
        stopOnCloseFailure: async () => {
          bumperCalls.push('stopOnCloseFailure');
        },
        retryClose: async (id?: string) => {
          bumperCalls.push(`retryClose:${id}`);
        },
      };
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () => undefined,
        () => ({ peers: new Map([[bumperProfileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
      );
      Reflect.get(adapter, 'connections').set(bumperProfileId, bumperConn);
      Reflect.get(adapter, 'closing').set(bumperProfileId, {
        id: stopBumperId,
        failed: false,
        accountId: '10001',
        peerEpoch: epochId,
        leaseId: randomUUID(),
        ownershipId: randomUUID(),
        connection: bumperConn,
      });
      await adapter.stop(bumperProfileId);
      expect(bumperCalls).toEqual([
        'revoke:BUMPER_STOP',
        'revoke:BUMPER_STOP',
        `close:${stopBumperId}`,
        'stopOnCloseFailure',
        `retryClose:${stopBumperId}`,
      ]);
      expect(adapter.hasControl(bumperProfileId)).toBe(false);

      // 2c. KernelBridge.inspectOwnedFacebookPage accepts tab state 'LOST' when keepPage === false and falls back to stopOnCloseFailure + retryClose when first close throws
      let closeAttempt = 0;
      const inspectProfileId = randomUUID();
      const inspectEpoch = randomUUID();
      const inspectProof = {
        ownershipId: randomUUID(),
        profileId: inspectProfileId,
        browserSessionEpoch: randomUUID(),
        tabId: 77,
        targetId: 't-77',
      };
      const inspectPeer: Peer = {
        profileId: inspectProfileId,
        epoch: inspectEpoch,
        online: true,
        synced: true,
        paused: true,
        phase: 'PAUSED',
        capabilities: ['facebook-task-kernel-v1', 'facebook-task-main-frame-v1'],
        send: () => {},
        close: () => {},
      };
      const { KernelBridge } = await import('../src/infrastructure/kernel-bridge.js');
      const fakeBridge = {
        idlePages: new Map(),
        usesExposedWindowLayout: () => true,
        connectOwned: async () => ({
          proof: inspectProof,
          stopRequestId: randomUUID(),
          browser: {
            contexts: () => [{ pages: () => [{ url: () => 'https://www.facebook.com/' }] }],
          },
          get closedInventory() {
            return {
              tabs: [
                {
                  ownershipId: inspectProof.ownershipId,
                  proof: inspectProof,
                  state: 'LOST',
                  url: 'https://www.facebook.com/',
                  reason: 'TARGET_CRASHED',
                },
              ],
              operations: [],
            };
          },
          close: async (id?: string) => {
            closeAttempt++;
            if (closeAttempt === 1) throw Error('FACEBOOK_TASK_CLOSE_UNCONFIRMED');
            return { requestId: id ?? randomUUID(), state: 'stopped' as const };
          },
          stopOnCloseFailure: async () => {
            closeAttempt++;
          },
          retryClose: async (id?: string) => {
            closeAttempt++;
            return { requestId: id ?? randomUUID(), state: 'stopped' as const };
          },
        }),
      };
      const inspectMethod = Reflect.get(KernelBridge.prototype, 'inspectOwnedFacebookPage') as (
        peer: Peer,
        assertAllowed: () => void,
        initialUrl: string,
        read: () => Promise<string>,
        foreground: boolean,
        retainForTask: boolean,
        existingTab: undefined,
        readOptions: { noWorkspaceCleanup: boolean; disableOuterTimeout: boolean },
      ) => Promise<{ reading: string; closedRecord: { state: string } }>;
      const inspectRes = await inspectMethod.call(
        fakeBridge,
        inspectPeer,
        () => {},
        'https://www.facebook.com/',
        async () => 'ok-value',
        false,
        false,
        undefined,
        { noWorkspaceCleanup: true, disableOuterTimeout: true },
      );
      expect(inspectRes.reading).toBe('ok-value');
      expect(inspectRes.closedRecord.state).toBe('LOST');
      expect(closeAttempt).toBe(3); // close (throws) -> stopOnCloseFailure -> retryClose
    } finally {
      db.close();
    }
  });

  it('Scenario 3: Retry close self-healing when first close fails before setting closedPageState, and offline finishStop isolation', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const profileId = randomUUID();
      const oldEpoch = randomUUID();
      const newEpoch = randomUUID();
      const stopReqId = randomUUID();
      const peer: Peer = {
        profileId,
        epoch: oldEpoch,
        online: false,
        synced: false,
        paused: true,
        phase: 'OFFLINE',
        send: () => {},
        close: () => {},
      };
      const connCalls: string[] = [];
      const conn = {
        stopRequestId: stopReqId,
        revokeInput: (r: string) => connCalls.push(`revoke:${r}`),
        closeLocalAfterDisconnect: async () => {
          connCalls.push('closeLocalAfterDisconnect');
        },
        confirmReconnectedStop: async () => {
          connCalls.push('confirmReconnectedStop');
        },
        close: async () => {
          connCalls.push('close');
        },
        retryClose: async () => {
          connCalls.push('retryClose');
        },
        stopOnCloseFailure: async () => {
          connCalls.push('stopOnCloseFailure');
        },
      };
      const kernel = {
        withSummary: async (_p: Peer, fn: (port: Record<string, unknown>) => Promise<unknown>) =>
          fn({
            inventory: async () => ({ tabs: [], operations: [] }),
            stopCurrent: async (id: string) => ({
              requestId: id,
              connectionEpoch: peer.epoch,
              state: 'stopped',
            }),
          }),
      };
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernel as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
      );
      Reflect.get(adapter, 'connections').set(profileId, conn);
      Reflect.get(adapter, 'closing').set(profileId, {
        id: stopReqId,
        failed: false,
        accountId: '10001',
        peerEpoch: oldEpoch,
        leaseId: randomUUID(),
        ownershipId: randomUUID(),
        connection: conn,
      });

      // Step 1: While offline, stop() must call closeLocalAfterDisconnect, throw BUMPER_STOP_AWAITING_RECONNECT, and KEEP closing/connections
      await expect(adapter.stop(profileId)).rejects.toThrow('BUMPER_STOP_AWAITING_RECONNECT');
      expect(connCalls).toContain('closeLocalAfterDisconnect');
      expect(adapter.hasControl(profileId)).toBe(true);

      // Step 2: Peer reconnects with new epoch -> stop() completes summary stop and clears connections/closing
      peer.online = true;
      peer.synced = true;
      peer.phase = 'PAUSED';
      peer.epoch = newEpoch;
      await adapter.stop(profileId);
      expect(connCalls).toContain('confirmReconnectedStop');
      expect(adapter.hasControl(profileId)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('Scenario 4: Core.inspectKernelProfileIdle and reconcileRecoveringPeerIfPossible (auto-abandon legacyFixture=1, auto-sync RECOVERING, block UNRESOLVED_BRIDGE_COMMANDS)', async () => {
    const profileId = randomUUID();
    const unresolvedRows: Array<{ commandId: string; legacyFixture: 0 | 1 }> = [
      { commandId: 'cmd-legacy-1', legacyFixture: 1 },
    ];
    const reviewedIds: string[] = [];
    const fakeStore = {
      unresolved: async () => [...unresolvedRows],
      get: async (commandId: string) => ({ commandId, profileId }),
      review: async (commandId: string) => {
        reviewedIds.push(commandId);
        const idx = unresolvedRows.findIndex((r) => r.commandId === commandId);
        if (idx >= 0) unresolvedRows.splice(idx, 1);
      },
      cancelPrepared: async () => {},
    };
    const core = new Core(fakeStore as unknown as ConstructorParameters<typeof Core>[0]);
    const sent: unknown[] = [];
    const peer = core.connect(
      profileId,
      (m) => sent.push(m),
      () => {},
    );
    peer.synced = true;
    peer.phase = 'RECOVERING';

    // 4a. Legacy fixture is reported as UNRESOLVED_LEGACY_FIXTURE even when peer.phase === 'RECOVERING'
    const insp1 = await core.inspectKernelProfileIdle(profileId);
    expect(insp1.idle).toBe(false);
    expect(insp1.reason).toBe('UNRESOLVED_LEGACY_FIXTURE');
    expect(insp1.legacyFixtureCount).toBe(1);

    // Reconcile automatically abandons legacyFixture === 1 and transitions peer to PAUSED
    const reconciled1 = await core.reconcileRecoveringPeerIfPossible(profileId);
    expect(reconciled1).toBe(true);
    expect(reviewedIds).toEqual(['cmd-legacy-1']);
    expect(peer.phase).toBe('PAUSED');
    const inspAfter1 = await core.inspectKernelProfileIdle(profileId);
    expect(inspAfter1.idle).toBe(true);

    // 4b. Real unresolved bridge command (legacyFixture === 0) is NEVER auto-abandoned and waitKernelProfileIdle fails immediately
    unresolvedRows.push({ commandId: 'cmd-real-write', legacyFixture: 0 });
    peer.phase = 'RECOVERING';
    const insp2 = await core.inspectKernelProfileIdle(profileId);
    expect(insp2.reason).toBe('UNRESOLVED_BRIDGE_COMMANDS');
    const reconciled2 = await core.reconcileRecoveringPeerIfPossible(profileId);
    expect(reconciled2).toBe(false);
    await expect(
      FacebookGroupSessionHelper.waitKernelProfileIdle({
        inspectIdle: () => core.inspectKernelProfileIdle(profileId),
        reconcileRecovering: () => core.reconcileRecoveringPeerIfPossible(profileId),
        guard: () => {},
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('UNRESOLVED_BRIDGE_COMMANDS');

    // 4c. RECOVERING_CONTROL_OR_SYNC (e.g. STOP_CONFIRMATION_TIMEOUT with 0 unresolved rows) triggers core.sync(peer)
    unresolvedRows.length = 0;
    peer.synced = false;
    peer.phase = 'RECOVERING';
    peer.error = 'STOP_CONFIRMATION_TIMEOUT';
    const insp3 = await core.inspectKernelProfileIdle(profileId);
    expect(insp3.reason).toBe('RECOVERING_CONTROL_OR_SYNC');
    const reconciled3 = await core.reconcileRecoveringPeerIfPossible(profileId);
    expect(reconciled3).toBe(true);
    expect(peer.phase).toBe('SYNCING');
    expect(sent.some((m) => (m as { type?: string }).type === 'SYNC')).toBe(true);
  });

  it('Scenario 5: Startup preparation stage encounters transient disconnect -> waits for reconnect + idle -> succeeds and completes bumping', async () => {
    let nowMs = 1_000;
    const clock = {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    };
    const profileId = randomUUID();
    const postId = '90001';
    const author = '61570001';
    const liked = new Set<string>();
    let currentUrl = 'https://www.facebook.com/groups/111/?sorting_setting=CHRONOLOGICAL';
    const nativeEvents = bumperNativeEvents();
    const page = {
      on: nativeEvents.on,
      off: nativeEvents.off,
      url: () => currentUrl,
      goto: async (u: string) => {
        currentUrl = u;
        return null;
      },
      evaluate: async () => ({
        url: currentUrl,
        ready: true,
        visible: true,
        accountId: '10001',
        verificationRequired: false,
        restricted: false,
        restrictionReason: null,
        loading: false,
        groupTitle: 'Group 111',
        avatarUrl: null,
        pageAvatarUrl: null,
        groupIds: ['111'],
        pageIds: [author],
        blockingDialog: false,
        groupJoinState: 'member',
        groupEntryCSS: null,
        joinGroupCSS: null,
        welcomeDismissCSS: null,
        posts: [
          {
            postId,
            postUrl: `https://www.facebook.com/groups/111/posts/${postId}/`,
            authorId: author,
            authorName: 'PageAuthor',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: 'fb-' + postId,
            liked: liked.has(postId),
            reactionState: liked.has(postId) ? 'active' : 'inactive',
            postCSS: `[data-post="${postId}"]`,
            likeCSS: `[data-like="${postId}"]`,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: false,
            videoEnded: false,
            videoPaused: true,
            videoReadyState: 0,
            videoCurrentSrc: null,
            videoFrames: 0,
            videoCurrentTime: 0,
            videoDuration: 0,
            videoCSS: null,
            comments: [],
          },
        ],
      }),
      locator: () => ({
        first() {
          return this;
        },
        evaluate: async () => false,
        hover: async () => {},
        click: async () => {
          liked.add(postId);
          nativeEvents.like('10001', 'fb-' + postId);
        },
      }),
    };
    const proof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: randomUUID(),
      tabId: 1,
      targetId: 't-1',
    };
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      send: () => {},
      close: () => {},
    };
    let prepareAttempts = 0;
    const connection = {
      stopRequestId: randomUUID(),
      proof,
      revokeInput: () => {},
      browser: { contexts: () => [{ pages: () => [page] }] },
      context: async () => ({
        profileId,
        accountId: '10001',
        connectionEpoch: peer.epoch,
        leaseId: randomUUID(),
        generation: 1,
      }),
      execute: async (binding: Binding, work: () => Promise<unknown>) => ({
        binding,
        value: await work(),
      }),
      reconcile: async () => {},
      nativeMutationCalls: { input: 0 },
      close: async () => {},
      retryClose: async () => {},
      stopOnCloseFailure: async () => {},
    };
    const kernel = {
      withSummary: async (_p: Peer, run: (port: Record<string, unknown>) => Promise<unknown>) =>
        run({
          inventory: async () => ({
            tabs: [{ state: 'READY', proof }],
            workspaceMain: proof,
            operations: [],
          }),
        }),
      inspectIdleFacebookPage: async () => {
        prepareAttempts++;
        if (prepareAttempts === 1) {
          peer.epoch = randomUUID();
          throw Error('KERNEL_CONNECTION_LOST');
        }
        return { actor: { accountId: '10001' }, proof };
      },
      inspectFacebookIdentity: async () => ({ actor: { accountId: '10001' }, proof }),
      connectFacebook: async () => connection,
    };
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernel as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
        undefined,
        clock,
      );
      let addedCount = 0;
      await adapter.run(
        profileId,
        [mkTarget('111', '111')],
        [mkTarget(author, 'PageAuthor')],
        {
          ...BumperSettings.parse({}),
          useLongPressReaction: false,
          likeProbability: 100,
          commentProbability: 0,
          maxPostsPerGroupPage: 1,
        },
        {
          cancelled: () => false,
          status: () => {},
          added: (n) => {
            addedCount = n;
          },
        },
      );
      expect(prepareAttempts).toBe(2);
      expect(addedCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('Scenarios 6 & 7: Runtime disconnect before submit_like vs after submit_like before submit_comment (action-granular resume without duplicate like or double-counting)', async () => {
    for (const mode of ['before_like', 'after_like_before_comment'] as const) {
      let nowMs = 10_000;
      const clock = {
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      };
      const profileId = randomUUID();
      const postId = mode === 'before_like' ? '91001' : '91002';
      const author = '61570002';
      let liked = false;
      let likeClicks = 0;
      let commentSubmits = 0;
      let disconnectedOnce = false;
      const submissionCalls = { mousePress: 0, enter: 0 };

      const peer: Peer = {
        profileId,
        epoch: randomUUID(),
        online: true,
        synced: true,
        paused: true,
        phase: 'PAUSED',
        send: () => {},
        close: () => {},
      };
      const proof = {
        ownershipId: randomUUID(),
        profileId,
        browserSessionEpoch: randomUUID(),
        tabId: 1,
        targetId: 't-1',
      };

      let currentUrl = 'https://www.facebook.com/groups/111/?sorting_setting=CHRONOLOGICAL';
      const nativeEvents = bumperNativeEvents();
      const page = {
        on: nativeEvents.on,
        off: nativeEvents.off,
        url: () => currentUrl,
        goto: async (u: string) => {
          currentUrl = u;
          return null;
        },
        evaluate: async (fn: Function) => {
          const src = fn.toString();
          if (src.includes('innerText')) return 'Great post!';
          return {
            url: currentUrl,
            ready: true,
            visible: true,
            accountId: '10001',
            verificationRequired: false,
            restricted: false,
            restrictionReason: null,
            loading: false,
            groupTitle: 'Group 111',
            avatarUrl: null,
            pageAvatarUrl: null,
            groupIds: ['111'],
            pageIds: [author],
            blockingDialog: false,
            groupJoinState: 'member',
            groupEntryCSS: null,
            joinGroupCSS: null,
            welcomeDismissCSS: null,
            posts: [
              {
                postId,
                postUrl: `https://www.facebook.com/groups/111/posts/${postId}/`,
                authorId: author,
                authorName: 'PageAuthor',
                authorAliases: [],
                authorAvatarUrl: null,
                pinned: false,
                ageHours: 1,
                timeText: '1h',
                feedbackId: 'fb-' + postId,
                liked,
                reactionState: liked ? 'active' : 'inactive',
                postCSS: `[data-post="${postId}"]`,
                likeCSS: `[data-like="${postId}"]`,
                commentCSS: `[data-comment="${postId}"]`,
                commentButtonCSS: `[data-comment-btn="${postId}"]`,
                hasVideo: false,
                videoEnded: false,
                videoPaused: true,
                videoReadyState: 0,
                videoCurrentSrc: null,
                videoFrames: 0,
                videoCurrentTime: 0,
                videoDuration: 0,
                videoCSS: null,
                comments: [],
              },
            ],
          };
        },
        keyboard: {
          type: async () => {},
          insertText: async () => {},
        },
        locator: (sel: string) => ({
          first() {
            return this;
          },
          evaluate: async () => false,
          innerText: async () => 'Great post!',
          click: async () => {
            if (sel === `[data-like="${postId}"]`) {
              if (mode === 'before_like' && !disconnectedOnce) {
                disconnectedOnce = true;
                peer.epoch = randomUUID();
                throw Error('KERNEL_CONNECTION_LOST');
              }
              likeClicks++;
              submissionCalls.mousePress++;
              liked = true;
              nativeEvents.like('10001', 'fb-' + postId);
            }
          },
          press: async (key: string) => {
            if (key === 'Enter' && sel === `[data-comment="${postId}"]`) {
              if (mode === 'after_like_before_comment' && !disconnectedOnce) {
                disconnectedOnce = true;
                peer.epoch = randomUUID();
                throw Error('KERNEL_CONNECTION_LOST');
              }
              commentSubmits++;
              submissionCalls.enter++;
              nativeEvents.comment('10001', 'fb-' + postId, 'Great post!');
            }
          },
        }),
      };

      const makeConnection = () => ({
        stopRequestId: randomUUID(),
        proof,
        submissionCalls,
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
        execute: async (binding: Binding, work: () => Promise<unknown>) => ({
          binding,
          value: await work(),
        }),
        reconcile: async () => {},
        close: async () => {},
        retryClose: async () => {},
        stopOnCloseFailure: async () => {},
        closeLocalAfterDisconnect: async () => {},
        confirmReconnectedStop: async () => {},
      });

      const kernel = {
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
        connectFacebook: async () => makeConnection(),
      };

      const db = new DatabaseSync(':memory:');
      try {
        const repo = new SqliteGroupBumperRepository(db);
        repo.saveComments(
          { texts: ['Great post!'], consumeCommentOnUse: false, scope: 'group' },
          'group',
        );
        const adapter = new GroupBumperBrowserAdapter(
          repo,
          () =>
            kernel as unknown as ReturnType<
              ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
            >,
          () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
          async () => false,
          0,
          undefined,
          clock,
        );
        const addedNotifications: number[] = [];
        await adapter.run(
          profileId,
          [mkTarget('111', '111')],
          [mkTarget(author, 'PageAuthor')],
          {
            ...BumperSettings.parse({}),
            useLongPressReaction: false,
            likeProbability: 100,
            commentProbability: 100,
            maxPostsPerGroupPage: 1,
          },
          {
            cancelled: () => false,
            status: () => {},
            added: (today) => addedNotifications.push(today),
          },
        );

        expect(disconnectedOnce).toBe(true);
        expect(likeClicks).toBe(1);
        expect(commentSubmits).toBe(1);
        expect(addedNotifications).toEqual([1]);
        const logs = repo.logs('', 10, undefined, '\uffff', 'group');
        expect(logs).toHaveLength(1);
        expect(logs[0]?.liked).toBe(true);
        expect(logs[0]?.commentText).toBe('Great post!');
      } finally {
        db.close();
      }
    }
  });

  it('Scenario 8: Submission dispatched (mousePress incremented) then disconnected -> marked review / UNKNOWN, never re-dispatched after recovery', async () => {
    let nowMs = 20_000;
    const clock = {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    };
    const profileId = randomUUID();
    const postId = '92001';
    const author = '61570003';
    let likeClicks = 0;
    const submissionCalls = { mousePress: 0, enter: 0 };
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      send: () => {},
      close: () => {},
    };
    const proof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: randomUUID(),
      tabId: 1,
      targetId: 't-u',
    };
    let currentUrl = 'https://www.facebook.com/groups/111/?sorting_setting=CHRONOLOGICAL';
    const page = {
      on: () => {},
      off: () => {},
      url: () => currentUrl,
      goto: async (u: string) => {
        currentUrl = u;
        return null;
      },
      evaluate: async () => ({
        url: currentUrl,
        ready: true,
        visible: true,
        accountId: '10001',
        verificationRequired: false,
        restricted: false,
        restrictionReason: null,
        loading: false,
        groupTitle: 'Group 111',
        avatarUrl: null,
        pageAvatarUrl: null,
        groupIds: ['111'],
        pageIds: [author],
        blockingDialog: false,
        groupJoinState: 'member',
        groupEntryCSS: null,
        joinGroupCSS: null,
        welcomeDismissCSS: null,
        posts: [
          {
            postId,
            postUrl: `https://www.facebook.com/groups/111/posts/${postId}/`,
            authorId: author,
            authorName: 'PageAuthor',
            authorAliases: [],
            authorAvatarUrl: null,
            pinned: false,
            ageHours: 1,
            timeText: '1h',
            feedbackId: 'fb-' + postId,
            liked: false,
            reactionState: 'inactive',
            postCSS: `[data-post="${postId}"]`,
            likeCSS: `[data-like="${postId}"]`,
            commentCSS: null,
            commentButtonCSS: null,
            hasVideo: false,
            videoEnded: false,
            videoPaused: true,
            videoReadyState: 0,
            videoCurrentSrc: null,
            videoFrames: 0,
            videoCurrentTime: 0,
            videoDuration: 0,
            videoCSS: null,
            comments: [],
          },
        ],
      }),
      locator: (sel: string) => ({
        first() {
          return this;
        },
        evaluate: async () => false,
        click: async () => {
          if (sel === `[data-like="${postId}"]`) {
            likeClicks++;
            submissionCalls.mousePress++;
            peer.epoch = randomUUID();
            throw Error('KERNEL_CONNECTION_LOST');
          }
        },
      }),
    };
    const makeConnection = () => ({
      stopRequestId: randomUUID(),
      proof,
      submissionCalls,
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
      execute: async (binding: Binding, work: () => Promise<unknown>) => ({
        binding,
        value: await work(),
      }),
      reconcile: async () => {},
      close: async () => {},
      retryClose: async () => {},
      stopOnCloseFailure: async () => {},
      closeLocalAfterDisconnect: async () => {},
      confirmReconnectedStop: async () => {},
    });
    const kernel = {
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
      connectFacebook: async () => makeConnection(),
    };
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernel as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
        undefined,
        clock,
      );
      const issues: Array<{ kind: string; reason: string }> = [];
      await adapter.run(
        profileId,
        [mkTarget('111', '111')],
        [mkTarget(author, 'PageAuthor')],
        {
          ...BumperSettings.parse({}),
          useLongPressReaction: false,
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
      // Must only click once — never re-click after uncertain submission
      expect(likeClicks).toBe(1);
      expect(issues.some((i) => i.kind === 'pending')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('Scenario 9: Browser window closed (browserWindowCount === 0) or browser restarted (browserSessionEpoch changed) terminates immediately with clear error', async () => {
    let nowMs = 30_000;
    const clock = {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    };
    const profileId = randomUUID();
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      browserWindowCount: 1,
      send: () => {},
      close: () => {},
    };
    let currentSessionEpoch = randomUUID();
    const makeProof = () => ({
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: currentSessionEpoch,
      tabId: 1,
      targetId: 't-1',
    });
    const page = {
      on: () => {},
      off: () => {},
      url: () => 'https://www.facebook.com/groups/111/',
      goto: async () => {
        currentSessionEpoch = randomUUID();
        peer.epoch = randomUUID();
        throw Error('KERNEL_CONNECTION_LOST');
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
    const makeConnection = () => {
      const p = makeProof();
      return {
        stopRequestId: randomUUID(),
        proof: p,
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
        execute: async (binding: Binding, work: () => Promise<unknown>) => ({
          binding,
          value: await work(),
        }),
        reconcile: async () => {},
        close: async () => {},
        retryClose: async () => {},
        stopOnCloseFailure: async () => {},
        closeLocalAfterDisconnect: async () => {},
        confirmReconnectedStop: async () => {},
      };
    };
    const kernel = {
      withSummary: async (_p: Peer, run: (port: Record<string, unknown>) => Promise<unknown>) =>
        run({
          inventory: async () => ({
            browserSessionEpoch: currentSessionEpoch,
            tabs: [{ state: 'READY', proof: makeProof() }],
            workspaceMain: makeProof(),
            operations: [],
          }),
          stopCurrent: async (id: string) => ({
            requestId: id,
            connectionEpoch: peer.epoch,
            state: 'stopped',
          }),
        }),
      inspectIdleFacebookPage: async () => ({
        actor: { accountId: '10001' },
        proof: makeProof(),
      }),
      inspectFacebookIdentity: async () => ({
        actor: { accountId: '10001' },
        proof: makeProof(),
      }),
      connectFacebook: async () => makeConnection(),
    };
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernel as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
        undefined,
        clock,
      );
      await expect(
        adapter.run(
          profileId,
          [mkTarget('111', '111')],
          [mkTarget('61570009', 'Target')],
          BumperSettings.parse({}),
          { cancelled: () => false, status: () => {}, added: () => {} },
        ),
      ).rejects.toThrow('浏览器已重启，当前任务已停止');

      // Also verify browserWindowCount === 0 stops immediately
      currentSessionEpoch = randomUUID();
      peer.browserWindowCount = 0;
      page.goto = async () => {
        peer.epoch = randomUUID();
        throw Error('KERNEL_CONNECTION_LOST');
      };
      await expect(
        adapter.run(
          profileId,
          [mkTarget('111', '111')],
          [mkTarget('61570009', 'Target')],
          BumperSettings.parse({}),
          { cancelled: () => false, status: () => {}, added: () => {} },
        ),
      ).rejects.toThrow('浏览器窗口已关闭，当前任务已停止');
    } finally {
      db.close();
    }
  });

  it('Scenario 10: Wait for browser reconnect timeout (15s) or consecutive 2 no-progress recoveries terminates with explicit message', async () => {
    let nowMs = 50_000;
    const clock = {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    };
    const profileId = randomUUID();
    const peer: Peer = {
      profileId,
      epoch: randomUUID(),
      online: true,
      synced: true,
      paused: true,
      phase: 'PAUSED',
      send: () => {},
      close: () => {},
    };
    const proof = {
      ownershipId: randomUUID(),
      profileId,
      browserSessionEpoch: randomUUID(),
      tabId: 1,
      targetId: 't-t',
    };
    let disconnectMode: 'stay_offline' | 'always_disconnect' = 'always_disconnect';
    const page = {
      on: () => {},
      off: () => {},
      url: () => 'https://www.facebook.com/groups/111/',
      goto: async () => {
        if (disconnectMode === 'stay_offline') {
          peer.online = false;
          peer.synced = false;
          peer.phase = 'OFFLINE';
        } else {
          peer.epoch = randomUUID();
        }
        throw Error('KERNEL_CONNECTION_LOST');
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
    const makeConnection = () => ({
      stopRequestId: randomUUID(),
      proof,
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
      execute: async (binding: Binding, work: () => Promise<unknown>) => ({
        binding,
        value: await work(),
      }),
      reconcile: async () => {},
      close: async () => {},
      retryClose: async () => {},
      stopOnCloseFailure: async () => {},
      closeLocalAfterDisconnect: async () => {},
      confirmReconnectedStop: async () => {},
    });
    const kernel = {
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
      connectFacebook: async () => makeConnection(),
    };
    const db = new DatabaseSync(':memory:');
    try {
      const repo = new SqliteGroupBumperRepository(db);
      const adapter = new GroupBumperBrowserAdapter(
        repo,
        () =>
          kernel as unknown as ReturnType<
            ConstructorParameters<typeof GroupBumperBrowserAdapter>[1]
          >,
        () => ({ peers: new Map([[profileId, peer]]) }) as unknown as Core,
        async () => false,
        0,
        undefined,
        clock,
      );

      // 10a. Consecutive 2 no-progress recoveries
      await expect(
        adapter.run(
          profileId,
          [mkTarget('111', '111')],
          [mkTarget('61570010', 'Target')],
          BumperSettings.parse({}),
          { cancelled: () => false, status: () => {}, added: () => {} },
        ),
      ).rejects.toThrow(/连续 2 次中断恢复无实质进展/);

      // 10b. Offline > 15s timeout
      disconnectMode = 'stay_offline';
      await expect(
        adapter.run(
          profileId,
          [mkTarget('111', '111')],
          [mkTarget('61570010', 'Target')],
          BumperSettings.parse({}),
          { cancelled: () => false, status: () => {}, added: () => {} },
        ),
      ).rejects.toThrow('等待浏览器重连超时，已停止顶贴');
    } finally {
      db.close();
    }
  });

  it('Scenario 11: Concurrent claimFixtureKernel race — only one caller succeeds and no await gap exists between admission check and owner set', async () => {
    const fakeStore = {
      unresolved: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return [];
      },
      cancelPrepared: async () => {},
    };
    const core = new Core(fakeStore as unknown as ConstructorParameters<typeof Core>[0]);
    const peer = core.connect(
      randomUUID(),
      () => {},
      () => {},
    );
    peer.synced = true;
    peer.phase = 'PAUSED';

    const results = await Promise.allSettled([
      core.claimFixtureKernel(peer, 'owner-A'),
      core.claimFixtureKernel(peer, 'owner-B'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      core.hasFixtureKernelOwner(peer, 'owner-A') !== core.hasFixtureKernelOwner(peer, 'owner-B'),
    ).toBe(true);
  });
});
