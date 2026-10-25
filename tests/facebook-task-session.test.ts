import { PresentationRecoveryPermit } from '../src/shared/presentation-recovery.js';
import { KernelStamp } from '../src/shared/kernel-protocol.js';
import test from 'node:test';
import { BROWSE_VISIBILITY_WAIT } from '../src/infrastructure/facebook-browse-visibility.js';
import { FACEBOOK_TASK_DOCUMENT_READ } from '../src/infrastructure/facebook-task-document-ready.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Core } from '../src/bridge/core.js';
import { Store } from '../src/bridge/store.js';
import { WatchTasks } from '../src/bridge/watch.js';
import { KernelBridge } from '../src/infrastructure/kernel-bridge.js';
import { KernelManagedFacebookSession } from '../src/infrastructure/kernel-managed-facebook-session.js';
import { FacebookSubmissionObserver } from '../src/infrastructure/facebook-submission-observer.js';
import { FacebookComposerObserver } from '../src/infrastructure/facebook-composer-observer.js';
import { ExtensionKernelChannel } from '../extension/kernel-channel.js';
import { KernelJournal } from '../src/application/kernel-journal.js';
import { MemoryKernelStorage } from './fixtures/kernel-storage.js';
import { KernelRequest, KernelReply } from '../src/shared/kernel-wire.js';
import { assertKernelSessionCommand, kernelAccessURL } from '../src/shared/kernel-policy.js';
import { guardNativeInput } from '../src/application/native-input-gate.js';
import { ProfileActorRegistry } from '../src/application/profile-actor-registry.js';
import { TaskDispatcher } from '../src/application/task-dispatcher.js';
import { ChromeKernelBackend } from '../extension/kernel-backend.js';
import { WorkspaceStore } from '../src/infrastructure/workspace-store.js';
import type { RuntimeProfile } from '../src/domain/tasks.js';
import type { KernelJsonObject, KernelTarget } from '../src/shared/kernel-protocol.js';
import type { TabProof } from '../src/shared/kernel-state.js';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator } from 'playwright-core';
import { MaterialPostSourceCheck } from '../src/application/material-source-check.js';
import { MaterialUploadPreparation } from '../src/application/material-upload-preparation.js';
import { MaterialFileGrantPreparation } from '../src/application/material-file-grant-preparation.js';
import { MaterialUploadOperationGuard } from '../src/application/material-upload-guard.js';
import { PersistentMaterialUploadStage } from '../src/application/persistent-material-upload-stage.js';
import { FilesystemMaterialScanner } from '../src/infrastructure/material-scanner.js';
import { FilesystemMaterialSourceVerifier } from '../src/infrastructure/material-source-verifier.js';
import { FilesystemMaterialUploadStage } from '../src/infrastructure/material-upload-stage.js';
import { KernelMaterialUpload } from '../src/infrastructure/kernel-material-upload.js';
import { postAction, postReceipt } from './fixtures/material-post.js';
import type { ReservationRequest } from '../src/shared/material-index.js';
import type { FacebookPostTarget } from '../src/infrastructure/kernel-managed-facebook-session.js';
import type { NativeInputGuard } from '../src/application/native-input-gate.js';
import { NativeReviewService } from '../src/application/native-review.js';
import { KernelNativeReview } from '../src/infrastructure/kernel-native-review.js';
import { kernelRequiresOperation } from '../src/shared/kernel-policy.js';
import { projectFacebookBrowsePage } from '../src/infrastructure/facebook-browse-reader.js';

test('home wheel performs one preparation check and one fresh target check per actual native write', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const page = (
      session as unknown as {
        connection: { browser: { contexts(): { pages(): import('playwright-core').Page[] }[] } };
      }
    ).connection.browser
      .contexts()[0]
      ?.pages()[0];
    assert.ok(page);
    const originalEvaluate = page.evaluate.bind(page);
    page.evaluate = (async (expression: unknown) =>
      expression !== projectFacebookBrowsePage &&
      typeof expression === 'function' &&
      expression.toString().includes('document.visibilityState')
        ? true
        : expression !== projectFacebookBrowsePage &&
            typeof expression === 'function' &&
            expression.toString().includes('innerWidth')
          ? { width: 1000, height: 700 }
          : {
              url: 'https://www.facebook.com/',
              timeOrigin: 100,
              ready: true,
              visible: true,
              blocked: false,
              scrollY: 0,
              viewportHeight: 700,
              contentKey: 'generated-visible-post',
              video: null,
            }) as typeof page.evaluate;
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const step = h.workspace.tasks.steps(h.plan.id)[0],
      tab = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(step && tab);
    const op = h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'browseScroll',
      tabId: tab.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      url: 'https://www.facebook.com/',
      timeOrigin: 100,
      fromY: 0,
      deltaY: 400,
    });
    let targetChecks = 0;
    h.authority.assertTarget = async () => {
      targetChecks++;
    };
    const beforeCommands = h.commands.length;
    const beforeTrace = h.kernel.diagnostics(h.profile.id).length;
    await new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id);
    const actualWrites = h.kernel
      .diagnostics(h.profile.id)
      .slice(beforeTrace)
      .filter((row) => row.event.startsWith('rpc:send:'))
      .map((row) => row.event.slice('rpc:send:'.length))
      .filter((method) => kernelRequiresOperation(method, 'facebook-task'));
    assert.equal(actualWrites.includes('Page.bringToFront'), false);
    assert.equal(h.commands.slice(beforeCommands).includes('NativeTabs.activate'), false);
    assert.ok(actualWrites.includes('Input.dispatchMouseEvent'));
    assert.equal(targetChecks, actualWrites.length + 1);
    assert.equal(h.workspace.tasks.findOperation(h.plan.id, op.id)?.status, 'ACKNOWLEDGED');
    assert.equal(h.workspace.tasks.steps(h.plan.id)[0]?.progress.effectiveMilliseconds, 0);
    page.evaluate = originalEvaluate;
    await registry.control(h.plan.id, 'stop');
  } finally {
    await h.close();
  }
});

// Real private relay + public SDK + extension backend + SQLite. Chrome APIs and identity are
// simulated; this is software integration evidence, not a Facebook or native Chrome result.
async function harness(
  order: 'event-first' | 'callback-first' | 'removed-first' = 'event-first',
  postDirectory?: string,
  documentFailure?: 'transient' | 'foreign' | 'unknown',
  browseType: 'feed' | 'video' = 'feed',
  sdkFrameDelay = 0,
  remoteOpenDelay = 0,
) {
  const previous = globalThis.chrome;
  const store = new Store(':memory:'),
    core = new Core(store);
  const workspace = await WorkspaceStore.open(':memory:');
  const kernel = new KernelBridge(core, new WatchTasks(core));
  const id = randomUUID(),
    accountId = postDirectory ? '123456' : 'mock-acting-person';
  const journal = new KernelJournal(new MemoryKernelStorage());
  await journal.initialize(id, randomUUID());
  let channel: ExtensionKernelChannel;
  const commands: string[] = [],
    requests: string[] = [];
  const recoveryPermits: unknown[] = [];
  let recoveryStamp: unknown;
  const pendingOpens = new Set<string>();
  let prematureRenew = false;
  const target = {
    id: 'exact-task-target',
    tabId: 42,
    type: 'page',
    url: 'https://www.facebook.com/',
    attached: false,
  };
  let exists = false,
    identities = true,
    documentReads = 0;
  let groupId = -1;
  const localStorage: Record<string, unknown> = {};
  const chromeMock = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: localStorage[key] }),
        set: async (values: object) => Object.assign(localStorage, values),
      },
    },
    tabGroups: { update: async () => ({}) },
    tabs: {
      group: async ({ tabIds }: { tabIds: number[] }) => {
        assert.deepEqual(tabIds, [42]);
        groupId = 7;
        commands.push('NativeTabs.groupMain');
        return groupId;
      },
      get: async (tabId: number) => {
        assert.equal(tabId, 42);
        return { id: tabId, windowId: 8, groupId };
      },
      update: async (tabId: number, changes: { active?: boolean }) => {
        assert.equal(tabId, 42);
        assert.equal(changes.active, true);
        commands.push('NativeTabs.activate');
        return { id: tabId, windowId: 8, active: true };
      },
      query: async () => (exists ? [{ id: 42 }] : []),
      create: async () => {
        exists = true;
        return { id: 42 };
      },
      remove: async (tabId: number) => {
        assert.equal(tabId, 42);
        exists = false;
        const inspector = () =>
          channel.event({ tabId }, 'Inspector.detached', { reason: 'target_closed' });
        if (order === 'event-first') {
          inspector();
          channel.detached(tabId);
          channel.removed(tabId);
        } else if (order === 'callback-first') {
          channel.detached(tabId);
          inspector();
          channel.removed(tabId);
        } else {
          channel.removed(tabId);
          inspector();
          channel.detached(tabId);
        }
      },
    },
    windows: {
      getAll: async () => [{ id: 8, focused: true, type: 'normal' }],
      get: async (windowId: number) => {
        assert.equal(windowId, 8);
        return { id: windowId, state: 'normal' };
      },
      update: async (windowId: number, changes: { focused?: boolean }) => {
        assert.equal(windowId, 8);
        assert.equal(changes.focused, true);
        commands.push('NativeWindow.focus');
        return { id: windowId, state: 'normal', focused: true };
      },
    },
    debugger: {
      getTargets: async () => (exists ? [target] : []),
      attach: async () => {
        target.attached = true;
      },
      detach: async () => {
        target.attached = false;
      },
      sendCommand: async (source: KernelTarget, method: string, params: KernelJsonObject = {}) => {
        commands.push(method);
        if (method === 'Target.setAutoAttach') {
          assert.equal(params.autoAttach, false);
          assert.equal(params.waitForDebuggerOnStart, false);
          assert.deepEqual(params.filter, []);
        }
        if (method === 'Target.getTargetInfo')
          return {
            targetInfo: {
              ...target,
              targetId: target.id,
              title: '',
              browserContextId: 'mock-existing-context',
            },
          };
        if (method === 'Page.getFrameTree') {
          if (sdkFrameDelay) {
            const delay = sdkFrameDelay;
            sdkFrameDelay = 0;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          return {
            frameTree: {
              frame: {
                id: target.id,
                url: target.url,
                loaderId: 'loader',
                securityOrigin: 'https://www.facebook.com',
                mimeType: 'text/html',
                name: '',
              },
            },
          };
        }
        if (method === 'Runtime.evaluate' && params.expression === FACEBOOK_TASK_DOCUMENT_READ) {
          documentReads++;
          if (documentFailure === 'transient' && documentReads === 1)
            throw Error(
              JSON.stringify({ code: -32000, message: 'Cannot find default execution context' }),
            );
          if (documentFailure === 'foreign')
            throw Error(JSON.stringify({ code: -32000, message: 'Unexpected context' }));
          if (documentFailure === 'unknown') throw Error('KERNEL_RPC_RESULT_UNKNOWN');
          return {
            result: {
              type: 'string',
              value: JSON.stringify({ url: target.url, ready: 'complete' }),
            },
          };
        }
        if (method === 'Runtime.evaluate')
          return {
            result: { type: 'string', value: JSON.stringify({ userAgent: 'Chrome/142.0.0.0' }) },
          };
        if (method === 'Runtime.enable')
          channel.event(source, 'Runtime.executionContextCreated', {
            context: {
              id: 1,
              origin: 'https://www.facebook.com',
              name: '',
              auxData: { isDefault: true, frameId: target.id },
            },
          });
        if (method === 'Page.createIsolatedWorld') {
          channel.event(source, 'Runtime.executionContextCreated', {
            context: {
              id: 2,
              origin: '',
              name: params.worldName ?? '',
              auxData: { isDefault: false, frameId: target.id },
            },
          });
          return { executionContextId: 2 };
        }
        return {};
      },
    },
  };
  globalThis.chrome = chromeMock as unknown as typeof chrome;
  const peer = core.connect(
    id,
    (raw) => {
      const permit = PresentationRecoveryPermit.safeParse(raw);
      if (permit.success) {
        recoveryPermits.push(permit.data);
        channel.presentationRecoveryPermit(permit.data);
        return;
      }
      const parsed = KernelRequest.safeParse(raw);
      if (parsed.success) {
        requests.push(parsed.data.kind);
        if (parsed.data.kind === 'open') {
          pendingOpens.add(parsed.data.requestId);
          recoveryStamp = parsed.data.stamp;
        }
        if (parsed.data.kind === 'renew' && pendingOpens.size) prematureRenew = true;
        if (parsed.data.kind === 'open' && remoteOpenDelay) {
          const delay = remoteOpenDelay;
          remoteOpenDelay = 0;
          setTimeout(() => channel.receive(raw), delay);
        } else channel.receive(raw);
      }
    },
    () => {},
  );
  peer.phase = 'PAUSED';
  peer.synced = true;
  peer.capabilities = [
    'facebook-task-kernel-v1',
    'facebook-task-main-frame-v1',
    'kernel-journal-v1',
    'kernel-operation-files-v1',
  ];
  channel = new ExtensionKernelChannel(
    () => ({ profileId: id, epoch: peer.epoch, valid: peer.online }),
    async (reply) => {
      const parsed = KernelReply.safeParse(reply);
      if (parsed.success) pendingOpens.delete(parsed.data.requestId);
      await kernel.message(peer, reply);
    },
    undefined,
    journal,
  );
  const profile: RuntimeProfile = {
    id,
    online: true,
    synced: true,
    unresolved: 0,
    dispatchAllowed: true,
    account: { state: 'logged-in', id: accountId, name: null, avatar: null },
  };
  const saved = workspace.createCombination({
    name: 'Mock session integration',
    note: 'No actual FB',
    steps: postDirectory
      ? [
          {
            id: randomUUID(),
            type: 'post',
            resourceDirectory: postDirectory,
            count: 1,
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: true,
          },
        ]
      : [{ id: randomUUID(), type: browseType, durationMinutes: 1, maxLikes: 0, minLikeCount: 0 }],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  workspace.tasks.assign(
    { requestId: randomUUID(), combinationId: saved.id, version: saved.version, profileIds: [id] },
    [profile],
  );
  const plan = workspace.tasks.claimNext([profile], new Set(['feed', 'video', 'post']));
  assert.ok(plan);
  let retainedPage: TabProof | undefined;
  const authority = {
    admissionTab: () => retainedPage,
    profile: () => profile,
    assertIdentity: (value: string) => {
      if (!identities || value !== accountId) throw Error('MOCK_IDENTITY_CHANGED');
    },
    assertTarget: async () => {},
  };
  return {
    kernel,
    core,
    peer,
    journal,
    requests,
    prematureRenew: () => prematureRenew,
    recoveryPermits,
    recoveryStamp: () => recoveryStamp,
    commands,
    workspace,
    plan,
    profile,
    authority,
    retainPage: (proof: TabProof) => {
      retainedPage = proof;
    },
    event: (method: string, params: KernelJsonObject) =>
      channel.event({ tabId: 42 }, method, params),
    invalidate: () => {
      identities = false;
    },
    unexpectedDetach: () =>
      channel.event({ tabId: 42 }, 'Inspector.detached', { reason: 'canceled_by_user' }),
    close: async () => {
      await kernel.close();
      await core.disconnect(peer);
      await core.shutdown();
      store.close();
      workspace.close();
      globalThis.chrome = previous;
    },
  };
}

test('bounded SDK initialization tolerates a ten-second frame handshake while renewing the same lease, without input or another page', async () => {
  const h = await harness('event-first', undefined, undefined, 'feed', 10_500);
  const heartbeat = setInterval(() => h.kernel.tick(), 1000);
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    assert.ok(await session.current());
    assert.equal(h.requests.filter((value) => value === 'create').length, 1);
    assert.ok(h.requests.includes('renew'));
    assert.equal(
      h.commands.some((value) => value.startsWith('Input.')),
      false,
    );
  } finally {
    clearInterval(heartbeat);
    await h.close();
  }
});

test('remote open acknowledgement precedes lease renewal even when native open takes longer than the heartbeat interval', async () => {
  const h = await harness('event-first', undefined, undefined, 'feed', 0, 1_300);
  const heartbeat = setInterval(() => h.kernel.tick(), 1000);
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    assert.ok(await session.current());
    assert.equal(h.prematureRenew(), false);
    assert.equal(
      h.commands.some((command) => command.startsWith('Input.')),
      false,
    );
  } finally {
    clearInterval(heartbeat);
    await h.close();
  }
});

test('FB task policy isolates fixture/readonly/navigation origins and rejects profile-level commands', () => {
  assert.equal(kernelAccessURL('https://www.facebook.com/watch/', 'facebook-task'), true);
  for (const url of [
    'about:blank',
    'http://127.0.0.1:18767/kernel-fixture',
    'https://facebook.com/',
    'https://www.facebook.com.evil.test/',
    'https://user@www.facebook.com/',
    'https://www.facebook.com:444/',
  ]) {
    assert.equal(kernelAccessURL(url, 'facebook-task'), false);
    assert.throws(() =>
      assertKernelSessionCommand('Page.navigate', { url }, new Set(), 'facebook-task'),
    );
  }
  assert.throws(
    () =>
      assertKernelSessionCommand('Page.navigate', { url: 'https://www.facebook.com/' }, new Set()),
    /URL_REJECTED/,
  );
  assert.throws(
    () => assertKernelSessionCommand('Runtime.evaluate', {}, new Set(), 'facebook-readonly'),
    /READONLY/,
  );
  for (const method of ['Browser.close', 'Storage.clearDataForOrigin', 'Network.setCookie'])
    assert.throws(
      () => assertKernelSessionCommand(method, {}, new Set(), 'facebook-task'),
      /METHOD_REJECTED/,
    );
});

test('FB native page mutations run resource/current checks after waits without changing fixture semantics', async () => {
  for (const method of [
    'Page.navigate',
    'Page.reload',
    'Page.bringToFront',
    'DOM.scrollIntoViewIfNeeded',
    'Page.handleJavaScriptDialog',
  ]) {
    let active = true,
      inspections = 0;
    await assert.rejects(
      guardNativeInput(
        { target: { tabId: 42 }, method, params: {} },
        () => {
          if (!active) throw Error('ACTOR_REVOKED');
        },
        async () => {
          inspections++;
          await Promise.resolve();
          active = false;
        },
        'facebook-task',
      ),
      /ACTOR_REVOKED/,
    );
    assert.equal(inspections, 1);
  }
});

test('SDK teardown retains the original transport failure instead of replacing it with a later close error', async () => {
  const h = await harness();
  try {
    const connection = await h.kernel.connectFacebook(h.peer, h.plan.accountId!, () => {});
    assert.equal(connection.failureReason, null);
    h.kernel.disconnected(h.peer);
    assert.equal(connection.failureReason, 'KERNEL_CONNECTION_LOST');
    h.peer.online = false;
    await connection.close().catch(() => {});
    assert.equal(connection.failureReason, 'KERNEL_CONNECTION_LOST');
  } finally {
    await h.close();
  }
});

test('managed FB session uses real software actor/tab lifecycle; closed proof and stop are distinct from business result', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    assert.equal(h.commands.includes('Page.bringToFront'), false);
    const row = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(row);
    assert.equal(row.proof.targetId, 'exact-task-target');
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    assert.ok(await registry.session(h.profile.id));
    await registry.control(h.plan.id, 'stop');
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'STOPPED');
    assert.equal(h.workspace.taskTabs.get(row.proof.ownershipId).state, 'CLOSED');
    assert.equal(h.workspace.taskControls.list()[0]?.receipt?.state, 'stopped');
    assert.equal((await registry.status()).length, 0);
    assert.equal(
      h.commands.some((method) => method.startsWith('Input.')),
      false,
    );
  } finally {
    await h.close();
  }
});

test('task main-page owner survives excluded blank and foreign iframe navigation on both native and relay channels', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const context = (await registry.session(h.profile.id))!;
    const row = h.workspace.taskTabs.forPlan(h.plan.id)[0]!;
    for (const url of ['about:blank', 'https://embedded.example/widget']) {
      const params = { frame: { id: 'excluded-child', parentId: 'exact-task-target', url } };
      h.event('Page.frameNavigated', params);
      // Existing extensions can still relay the event; the controller must also ignore it.
      await h.kernel.message(h.peer, {
        type: 'KERNEL_EVENT',
        connectionEpoch: h.peer.epoch,
        leaseId: context.leaseId,
        source: { tabId: row.proof.tabId },
        method: 'Page.frameNavigated',
        params,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(await session.current(), context);
      assert.equal(h.workspace.tasks.get(h.plan.id).state, 'RUNNING');
    }
    await registry.control(h.plan.id, 'stop');
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'STOPPED');
    assert.equal(h.workspace.taskTabs.get(row.proof.ownershipId).state, 'CLOSED');
    assert.equal(
      h.commands.some((method) => method.startsWith('Input.')),
      false,
    );
  } finally {
    await h.close();
  }
});

test('task main-frame escape still fences the owner rather than adopting the foreign page', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    h.event('Page.frameNavigated', {
      frame: { id: 'exact-task-target', url: 'https://outside.example/' },
    });
    h.kernel.tick();
    for (let n = 0; n < 20 && (await session.current()); n++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await session.current(), null);
    assert.equal(
      h.commands.some((method) => method.startsWith('Input.')),
      false,
    );
  } finally {
    await h.close();
  }
});

test('missing task capability or unavailable acting identity cannot create a FB session', async () => {
  const h = await harness();
  try {
    h.peer.capabilities = ['kernel-journal-v1'];
    await assert.rejects(
      h.kernel.connectFacebook(h.peer, h.profile.account.id ?? '', () => {}),
      /UPDATE_REQUIRED/,
    );
    assert.equal(h.requests.length, 0);
    h.invalidate();
    await assert.rejects(
      KernelManagedFacebookSession.open(
        h.kernel,
        h.peer,
        h.plan,
        h.authority,
        h.workspace.tasks,
        h.workspace.taskTabs,
      ),
      /IDENTITY_CHANGED/,
    );
    assert.equal(h.requests.length, 0);
  } finally {
    await h.close();
  }
});

test('a failed initial current native identity read closes the new SDK page and never sends input', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      KernelManagedFacebookSession.open(
        h.kernel,
        h.peer,
        h.plan,
        {
          ...h.authority,
          bindPage: async () => {
            throw Error('TEST_NATIVE_ACTOR_CHANGED');
          },
        },
        h.workspace.tasks,
        h.workspace.taskTabs,
      ),
      /TEST_NATIVE_ACTOR_CHANGED/,
    );
    assert.equal(
      h.commands.some(
        (method) => method.startsWith('Input.') || method === 'DOM.setFileInputFiles',
      ),
      false,
    );
    assert.equal((await h.journal.snapshot()).tabs[0]?.state, 'CLOSED');
  } finally {
    await h.close();
  }
});
test('transient missing default execution context waits only on fixed reads before creating the SDK', async () => {
  const h = await harness('event-first', undefined, 'transient');
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    assert.equal(
      h.commands.some((method) => method.startsWith('Input.')),
      false,
    );
    assert.equal(h.requests.filter((kind) => kind === 'create').length, 1);
    await session.stop({
      requestId: randomUUID(),
      profileId: h.peer.profileId,
      accountId: h.plan.accountId!,
      connectionEpoch: h.peer.epoch,
      leaseId: (await session.current())!.leaseId,
      generation: (await session.current())!.generation,
    });
  } finally {
    await h.close();
  }
});
test('nontransient setup error closes only new pre-input proof; unknown outcome keeps original target for review', async () => {
  for (const failure of ['foreign', 'unknown'] as const) {
    const h = await harness('event-first', undefined, failure);
    try {
      await assert.rejects(
        KernelManagedFacebookSession.open(
          h.kernel,
          h.peer,
          h.plan,
          h.authority,
          h.workspace.tasks,
          h.workspace.taskTabs,
        ),
      );
      assert.equal(
        (await h.journal.snapshot()).tabs[0]?.state,
        failure === 'foreign' ? 'CLOSED' : 'READY',
      );
      assert.equal(h.requests.filter((kind) => kind === 'create').length, 1);
      assert.equal(
        h.commands.some((method) => method.startsWith('Input.')),
        false,
      );
    } finally {
      await h.close();
    }
  }
});

test('identity change fences an established SDK before native mutation and original owner can still close', async () => {
  const h = await harness();
  try {
    const connection = await h.kernel.connectFacebook(h.peer, h.profile.account.id ?? '', () =>
      h.authority.assertIdentity('mock-acting-person'),
    );
    assert.equal(await connection.context('different-account'), null);
    const page = connection.browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    h.invalidate();
    assert.equal(await connection.context('mock-acting-person'), null);
    await assert.rejects(page.bringToFront(), /IDENTITY_CHANGED/);
    assert.equal(h.commands.includes('Page.bringToFront'), false);
    assert.equal((await connection.close()).state, 'stopped');
    assert.equal(connection.closedInventory?.tabs[0]?.state, 'CLOSED');
  } finally {
    await h.close();
  }
});

test('SDK cannot activate outside a binding or create extra FB task pages; native backend independently rejects unbound mutations', async () => {
  const h = await harness();
  try {
    const connection = await h.kernel.connectFacebook(h.peer, 'mock-acting-person', () => {});
    const page = connection.browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    await assert.rejects(page.bringToFront(), /BOUND_INPUT_INACTIVE/);
    await assert.rejects(
      connection.browser.contexts()[0]?.newPage() ?? Promise.resolve(),
      /TASK_TAB_CREATION_REJECTED/,
    );
    assert.ok(connection.proof);
    const context = await connection.context('mock-acting-person');
    assert.ok(context);
    await assert.rejects(
      connection.navigateBoundPage(
        {
          ...context,
          jobId: h.plan.id,
          stepId: randomUUID(),
          operationId: randomUUID(),
          actionDigest: 'a'.repeat(64),
        },
        { kind: 'browseNavigate', tabId: connection.tabId, url: 'https://www.facebook.com/reels/' },
        'https://www.facebook.com/',
      ),
      /ORIGINAL_OPERATION_REQUIRED/,
    );
    assert.equal(h.commands.includes('Page.navigate'), false);
    const native = new ChromeKernelBackend(
      h.journal,
      () => false,
      'facebook-task',
      () => true,
    );
    await native.adopt(connection.proof);
    await native.attach(connection.tabId);
    for (const method of [
      'Page.bringToFront',
      'Page.reload',
      'DOM.scrollIntoViewIfNeeded',
      'Page.handleJavaScriptDialog',
    ])
      await assert.rejects(
        native.send({ tabId: connection.tabId }, method, {}),
        /OPERATION_REQUIRED/,
      );
    await assert.rejects(
      native.send({ tabId: connection.tabId }, 'Page.navigate', {
        url: 'https://www.facebook.com/',
      }),
      /OPERATION_REQUIRED/,
    );
    assert.equal(h.commands.includes('Page.bringToFront'), false);
    assert.equal((await h.journal.snapshot()).operations.length, 0);
    await connection.close();
  } finally {
    await h.close();
  }
});

test('bound activation passes actor/outbox/native journal; ACK does not advance progress and stop retains unresolved ownership', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const row = h.workspace.taskTabs.forPlan(h.plan.id)[0],
      step = h.workspace.tasks.steps(h.plan.id)[0];
    assert.ok(row);
    assert.ok(step);
    const op = h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'activateTab',
      tabId: row.proof.tabId,
    });
    const dispatcher = new TaskDispatcher(h.workspace.tasks, registry);
    assert.equal(await dispatcher.flushOne(h.profile.id), true);
    assert.equal(h.workspace.tasks.operations(h.plan.id)[0]?.status, 'ACKNOWLEDGED');
    assert.equal(h.workspace.tasks.steps(h.plan.id)[0]?.progress.effectiveMilliseconds, 0);
    assert.equal(h.commands.filter((method) => method === 'NativeTabs.activate').length, 1);
    assert.equal(h.commands.filter((method) => method === 'NativeWindow.focus').length, 1);
    assert.equal((await h.journal.snapshot()).operations[0]?.binding.operationId, op.id);
    await registry.control(h.plan.id, 'stop');
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'REVIEW');
    assert.equal(h.workspace.tasks.operations(h.plan.id)[0]?.status, 'UNKNOWN');
    assert.equal(h.workspace.taskTabs.get(row.proof.ownershipId).state, 'RECHECK_REQUIRED');
    assert.equal((await h.journal.snapshot()).tabs[0]?.state, 'CLOSED');
    assert.equal(h.workspace.taskControls.list()[0]?.receipt?.state, 'stopped');
    assert.equal(await dispatcher.flushOne(h.profile.id), false);
    assert.equal(h.commands.filter((method) => method === 'NativeTabs.activate').length, 1);
    assert.equal(h.commands.filter((method) => method === 'NativeWindow.focus').length, 1);
  } finally {
    await h.close();
  }
});

test('existing UNKNOWN native page blocks a new task session without adopting or creating it', async () => {
  const h = await harness();
  try {
    await h.journal.prepareTab(randomUUID(), 'https://www.facebook.com/');
    await assert.rejects(
      h.kernel.connectFacebook(h.peer, 'mock-acting-person', () => {}),
      /NATIVE_REVIEW_REQUIRED/,
    );
    assert.equal(h.requests.includes('create'), false);
    assert.equal(h.requests.includes('adopt'), false);
    assert.equal(h.requests.includes('remove'), false);
  } finally {
    await h.close();
  }
});

test('a bound browse visibility wait keeps the original operation and user stop cancels before native input', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const step = h.workspace.tasks.steps(h.plan.id)[0],
      tab = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(step && tab);
    const op = h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'browseScroll',
      tabId: tab.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      url: 'https://www.facebook.com/',
      timeOrigin: 100,
      fromY: 0,
      deltaY: 400,
    });
    let checked: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      checked = resolve;
    });
    h.authority.assertTarget = async () => {
      checked();
      throw Error(BROWSE_VISIBILITY_WAIT);
    };
    const dispatch = new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id);
    await waiting;
    assert.equal(h.workspace.tasks.findOperation(h.plan.id, op.id)?.status, 'DISPATCHING');
    assert.equal(h.commands.includes('Page.bringToFront'), false);
    assert.equal(
      h.commands.some((command) => command.startsWith('Input.')),
      false,
    );
    await registry.control(h.plan.id, 'stop');
    await dispatch;
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.commands.includes('Page.bringToFront'), false);
    assert.equal(
      h.commands.some((command) => command.startsWith('Input.')),
      false,
    );
    assert.equal(h.workspace.tasks.steps(h.plan.id)[0]?.progress.effectiveMilliseconds, 0);
  } finally {
    await h.close();
  }
});

test('explicit same-stop retry accepts the exact retained READY main after a local endpoint failure without removing it', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const step = h.workspace.tasks.steps(h.plan.id)[0],
      tab = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(step && tab);
    const op = h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'activateTab',
      tabId: tab.proof.tabId,
    });
    await new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id);
    assert.equal(h.workspace.tasks.findOperation(h.plan.id, op.id)?.status, 'ACKNOWLEDGED');
    const rpc = (
      h.kernel as unknown as { sessions: Map<string, { endpoint?: { close(): Promise<unknown> } }> }
    ).sessions.get(h.profile.id);
    assert.ok(rpc?.endpoint);
    const close = rpc.endpoint.close.bind(rpc.endpoint);
    rpc.endpoint.close = async () => {
      await close();
      throw Error('GENERATED_LOCAL_ENDPOINT_FAILURE');
    };
    await assert.rejects(registry.control(h.plan.id, 'stop'), /GENERATED_LOCAL_ENDPOINT_FAILURE/);
    assert.equal((await registry.status())[0]?.lifecycle, 'STOP_UNCONFIRMED');
    const requestId = h.workspace.tasks.get(h.plan.id).controlRequestId;
    assert.ok(requestId);
    assert.equal((await h.journal.snapshot()).tabs[0]?.state, 'READY');
    await registry.controlFromUser(h.plan.id, 'stop');
    assert.equal(h.workspace.tasks.get(h.plan.id).controlRequestId, requestId);
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.workspace.tasks.findOperation(h.plan.id, op.id)?.status, 'UNKNOWN');
    assert.equal((await registry.status()).length, 0);
    assert.equal((await h.journal.snapshot()).tabs[0]?.state, 'READY');
    assert.equal(h.requests.includes('remove'), false);
  } finally {
    await h.close();
  }
});

test('already resumed playback acknowledges without toggling video or crediting browsing time', async () => {
  const h = await harness('event-first', undefined, undefined, 'video');
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const step = h.workspace.tasks.steps(h.plan.id)[0];
    const tab = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(step && tab);
    const op = h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'browsePlay',
      tabId: tab.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      url: 'https://www.facebook.com/reel/123',
      timeOrigin: 100,
      css: 'video',
      source: 'mock-video',
    });
    h.authority.assertTarget = async () => {
      throw Error('FACEBOOK_BROWSE_PLAY_ALREADY_RUNNING');
    };
    await new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id);
    assert.equal(h.workspace.tasks.findOperation(h.plan.id, op.id)?.status, 'ACKNOWLEDGED');
    assert.equal(
      h.commands.some((command) => command.startsWith('Input.')),
      false,
    );
    assert.equal(h.commands.includes('Page.bringToFront'), false);
    assert.equal(h.workspace.tasks.steps(h.plan.id)[0]?.progress.effectiveMilliseconds, 0);
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'RUNNING');
  } finally {
    await h.close();
  }
});

test('stop during an unbound SDK read confirms its original control and retains the main without regranting a cancelled read session', async () => {
  const h = await harness();
  let release = () => {};
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const connection = (
      session as unknown as {
        connection: Awaited<ReturnType<KernelBridge['connectFacebook']>>;
      }
    ).connection;
    const page = connection.browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = (async (target, method, params) => {
      if (
        method === 'Runtime.callFunctionOn' &&
        JSON.stringify(params).includes('workbench-pending-read')
      ) {
        entered();
        await gate;
      }
      return send(target, method, params);
    }) as typeof send;
    const read = page.evaluate("'workbench-pending-read'").catch(() => undefined);
    await started;
    const before = h.requests.length;
    const stopped = registry.control(h.plan.id, 'stop');
    const settled = stopped.then(
      () => {},
      () => {},
    );
    const deadline = Date.now() + 2000;
    while (!h.requests.slice(before).some((kind) => ['quiesce', 'stop', 'detach'].includes(kind))) {
      assert.ok(Date.now() < deadline, 'STOP_REQUEST_NOT_DISPATCHED');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await read;
    await stopped;
    await settled;
    assert.equal(h.requests.slice(before).includes('quiesce'), false);
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'STOPPED');
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.workspace.taskTabs.forPlan(h.plan.id)[0]?.state, 'RELEASED');
    assert.equal(h.requests.includes('remove'), false);
    assert.equal(h.workspace.tasks.operations(h.plan.id).length, 0);
  } finally {
    release();
    await h.close();
  }
});

test('parking fences a late SDK read while an existing renewal drains', async () => {
  const h = await harness();
  let release = () => {};
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const connection = (
      session as unknown as {
        connection: Awaited<ReturnType<KernelBridge['connectFacebook']>>;
      }
    ).connection;
    const page = connection.browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    const send = h.peer.send;
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    h.peer.send = (raw) => {
      const parsed = KernelRequest.safeParse(raw);
      if (!held && parsed.success && parsed.data.kind === 'renew') {
        held = true;
        entered();
        void gate.then(() => send(raw));
      } else send(raw);
    };
    h.kernel.tick();
    await started;
    const stopped = registry.control(h.plan.id, 'stop');
    const reads = h.commands.filter((method) => method === 'Runtime.callFunctionOn').length;
    await assert.rejects(
      page.evaluate("'workbench-late-read'"),
      /KERNEL_SESSION_PARKING|Execution context was destroyed/,
    );
    assert.equal(h.commands.filter((method) => method === 'Runtime.callFunctionOn').length, reads);
    release();
    await stopped;
    h.peer.send = send;
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'STOPPED');
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.workspace.taskTabs.forPlan(h.plan.id)[0]?.state, 'RELEASED');
    assert.equal(h.requests.includes('remove'), false);
    assert.equal(h.requests.includes('detach'), false);
  } finally {
    release();
    await h.close();
  }
});

test('stop delivers an already verified durable result before retaining its native session', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const row = h.workspace.taskTabs.forPlan(h.plan.id)[0],
      step = h.workspace.tasks.steps(h.plan.id)[0];
    assert.ok(row && step);
    h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'activateTab',
      tabId: row.proof.tabId,
    });
    const dispatcher = new TaskDispatcher(h.workspace.tasks, registry);
    await dispatcher.flushOne(h.profile.id);
    const op = h.workspace.tasks.operations(h.plan.id)[0];
    assert.ok(op?.binding);
    assert.equal(op.status, 'ACKNOWLEDGED');
    await dispatcher.verify(
      { binding: op.binding, evidence: { generatedTestEffect: true } },
      'VERIFIED',
      { ...step.progress, revision: step.progress.revision + 1 },
    );
    assert.notEqual(h.workspace.tasks.settlements.list(h.profile.id)[0]?.state, 'DELIVERED');
    assert.notEqual((await h.journal.snapshot()).operations[0]?.state, 'RECONCILED');
    await registry.control(h.plan.id, 'stop');
    assert.equal(h.workspace.tasks.settlements.list(h.profile.id)[0]?.state, 'DELIVERED');
    assert.equal((await h.journal.snapshot()).operations[0]?.state, 'RECONCILED');
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'STOPPED');
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.requests.includes('remove'), false);
    assert.equal(h.requests.includes('detach'), false);
    assert.equal(h.commands.filter((method) => method === 'NativeTabs.activate').length, 1);
  } finally {
    await h.close();
  }
});

test('healthy main page and SDK survive stop and a later plan; a late old stop cannot revoke the new task', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const proof = h.workspace.taskTabs.forPlan(h.plan.id)[0]?.proof;
    assert.ok(proof);
    const creates = h.requests.filter((kind) => kind === 'create').length;
    const attaches = h.requests.filter((kind) => kind === 'attach').length;
    const originalContext = await session.current();
    assert.ok(originalContext);
    await registry.control(h.plan.id, 'stop');
    const oldStop = h.workspace.taskControls.list()[0]?.binding;
    assert.ok(oldStop);
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.workspace.taskTabs.get(proof.ownershipId, h.plan.id).state, 'RELEASED');
    assert.equal(h.requests.includes('remove'), false);
    assert.equal(h.requests.includes('detach'), false);
    const retainedInventory = await h.kernel.withSummary(h.peer, (port) => port.inventory());
    assert.equal(retainedInventory.tabs[0]?.state, 'READY');
    const retainedStop = await h.kernel.withSummary(h.peer, async (port) => port.stopCurrent);
    const diagnostics = new NativeReviewService(
      new KernelNativeReview(h.kernel, h.core),
      h.workspace.tasks,
    );
    const report = await diagnostics.read({ profileId: h.profile.id }, '2');
    assert.equal(report.activeTabCount, 1);
    assert.equal(report.blockingCount, 0);
    assert.equal(report.tabs?.[0]?.reason, 'WORKSPACE_MAIN_IDLE');
    assert.deepEqual(await diagnostics.releaseIdle({ profileId: h.profile.id }), {
      released: 0,
      endedOperations: 0,
    });
    assert.equal(h.requests.includes('remove'), false);
    const saved = h.workspace.combinations().find((row) => row.id === h.plan.combinationId);
    assert.ok(saved?.saved);
    h.workspace.tasks.assign(
      {
        requestId: randomUUID(),
        combinationId: saved.id,
        version: saved.version,
        profileIds: [h.profile.id],
      },
      [h.profile],
    );
    const next = h.workspace.tasks.claimNext([h.profile], new Set(['feed']));
    assert.ok(next);
    h.retainPage(proof);
    const replacement = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      next,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    await registry.attach(replacement);
    await registry.observe(h.profile.id);
    const current = await replacement.current();
    assert.ok(current);
    const beforeLateStop = h.requests.length;
    await assert.rejects(retainedStop(randomUUID()), /KERNEL_RETAINED_PAGE_CONNECTION_CHANGED/);
    await session.stop({ ...originalContext, requestId: oldStop.requestId });
    assert.equal(h.requests.length, beforeLateStop);
    assert.deepEqual(await replacement.current(), current);
    assert.equal(h.workspace.tasks.get(next.id).state, 'RUNNING');
    assert.equal(h.requests.filter((kind) => kind === 'create').length, creates);
    assert.equal(h.requests.filter((kind) => kind === 'attach').length, attaches);
    assert.deepEqual(h.workspace.taskTabs.forPlan(next.id)[0]?.proof, proof);
    const step = h.workspace.tasks.steps(next.id)[0];
    assert.ok(step);
    h.workspace.tasks.prepareOperation(next.id, step.id, randomUUID(), {
      kind: 'activateTab',
      tabId: proof.tabId,
    });
    await new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id);
    assert.equal(h.workspace.tasks.operations(next.id)[0]?.status, 'ACKNOWLEDGED');
    assert.equal(h.commands.filter((method) => method === 'NativeTabs.activate').length, 1);
  } finally {
    await h.close();
  }
});

test('ending a parked main retires its SDK and confirms the exact stop without closing the page', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    await registry.control(h.plan.id, 'stop');
    const before = await h.kernel.withSummary(h.peer, (port) => port.inventory());
    const commands = h.commands.length;
    const creates = h.requests.filter((kind) => kind === 'create').length;
    const requestId = randomUUID();
    const stop = await h.kernel.withSummary(h.peer, (port) => port.stopCurrent(requestId));
    assert.equal(stop.requestId, requestId);
    assert.equal(stop.profileId, h.profile.id);
    assert.equal(stop.connectionEpoch, h.peer.epoch);
    assert.equal(stop.state, 'stopped');
    const after = await h.kernel.withSummary(h.peer, (port) => port.inventory());
    assert.equal(after.tabs[0]?.state, 'READY');
    assert.deepEqual(after.tabs[0]?.proof, before.tabs[0]?.proof);
    assert.equal(h.commands.length, commands);
    assert.equal(h.requests.filter((kind) => kind === 'create').length, creates);
    assert.equal(h.requests.includes('remove'), false);
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
  } finally {
    await h.close();
  }
});

test('pause and explicit resume preserve the same page and progress while issuing a new input context', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const original = await session.current(),
      tab = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(original && tab);
    const originalAttachCount = h.requests.filter((kind) => kind === 'attach').length;
    const step = h.workspace.tasks.steps(h.plan.id)[0];
    assert.ok(step);
    h.workspace.tasks.checkpoint(h.plan.id, step.id, step.progress.revision, {
      ...step.progress,
      revision: step.progress.revision + 1,
      effectiveMilliseconds: 10_000,
    });
    await registry.control(h.plan.id, 'pause');
    const progress = h.workspace.tasks.steps(h.plan.id)[0]?.progress;
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'PAUSED');
    h.workspace.tasks.resume(h.plan.id);
    const resumed = h.workspace.tasks.claimNext([h.profile], new Set(['feed']));
    assert.equal(resumed?.id, h.plan.id);
    assert.ok(resumed);
    h.retainPage(tab.proof);
    const next = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      resumed,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    assert.equal((await next.current())?.generation, original.generation + 1);
    assert.deepEqual(h.workspace.taskTabs.forPlan(h.plan.id)[0]?.proof, tab.proof);
    assert.equal(h.workspace.taskTabs.forPlan(h.plan.id)[0]?.state, 'READY');
    assert.deepEqual(h.workspace.tasks.steps(h.plan.id)[0]?.progress, progress);
    assert.equal(h.requests.filter((kind) => kind === 'create').length, 1);
    assert.equal(h.requests.filter((kind) => kind === 'attach').length, originalAttachCount);
  } finally {
    await h.close();
  }
});

test('revoked pre-registry admission stops its native owner without falsely matching an unbound formal pause', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const context = await session.current();
    assert.ok(context);
    const paused = h.workspace.tasks.requestControl(
      h.plan.id,
      'pause',
      'GENERATED_ADMISSION_REVOKED',
    );
    const requestId = randomUUID();
    assert.notEqual(requestId, paused.controlRequestId);
    const stopped = await session.stop({ ...context, requestId });
    assert.equal(stopped.state, 'stopped');
    assert.equal(await session.current(), null);
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, false);
    assert.equal(h.workspace.taskControls.list().length, 0);
    assert.equal(h.workspace.taskTabs.forPlan(h.plan.id)[0]?.state, 'READY');
    assert.equal(h.requests.includes('remove'), false);
  } finally {
    await h.close();
  }
});

test('completed task releases input without closing its healthy main page or manufacturing a manual stop receipt', async () => {
  const h = await harness();
  try {
    h.peer.capabilities?.push('kernel-page-quiesce-v1');
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const context = await session.current();
    assert.ok(context);
    const step = h.workspace.tasks.steps(h.plan.id)[0];
    assert.ok(step);
    h.workspace.tasks.checkpoint(h.plan.id, step.id, step.progress.revision, {
      ...step.progress,
      revision: step.progress.revision + 1,
      effectiveMilliseconds: 60_000,
    });
    h.workspace.tasks.completeStep(h.plan.id, step.id);
    await registry.detach(h.profile.id, context, 'TASK_COMPLETED');
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'COMPLETED');
    assert.equal(h.workspace.taskTabs.forPlan(h.plan.id)[0]?.state, 'RELEASED');
    assert.equal(h.workspace.taskControls.list().length, 0);
    assert.equal(h.requests.includes('remove'), false);
    assert.equal(h.requests.includes('detach'), false);
  } finally {
    await h.close();
  }
});

test('long SDK failure preserves original UNKNOWN cause while the original actor receives a bounded reason and confirms real stop', async () => {
  const h = await harness();
  try {
    const session = await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    const step = h.workspace.tasks.steps(h.plan.id)[0],
      tab = h.workspace.taskTabs.forPlan(h.plan.id)[0];
    assert.ok(step && tab);
    const prepared = h.workspace.tasks.prepareOperation(h.plan.id, step.id, randomUUID(), {
      kind: 'activateTab',
      tabId: tab.proof.tabId,
    });
    h.authority.assertTarget = async () => {
      throw Error('SDK_TARGET_TIMEOUT\n' + 'detailed diagnostic '.repeat(100));
    };
    await new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id);
    const op = h.workspace.tasks.operations(h.plan.id).find((row) => row.id === prepared.id);
    assert.equal(op?.status, 'UNKNOWN');
    assert.ok(JSON.stringify(op?.receipt).includes('SDK_TARGET_TIMEOUT'));
    assert.equal(session.executionFailure?.binding.operationId, prepared.id);
    assert.ok((session.executionFailure?.message.length ?? 0) > 200);
    assert.equal(h.workspace.tasks.get(h.plan.id).state, 'REVIEW');
    assert.equal(h.workspace.tasks.get(h.plan.id).controlConfirmed, true);
    assert.equal(h.workspace.taskControls.list()[0]?.receipt?.state, 'stopped');
    assert.equal((await h.journal.snapshot()).tabs[0]?.state, 'CLOSED');
    assert.equal(h.commands.includes('Page.bringToFront'), false);
  } finally {
    await h.close();
  }
});

for (const order of ['callback-first', 'removed-first'] as const)
  test(`expected native close tolerates ${order} event order without fencing the transport`, async () => {
    const h = await harness(order);
    try {
      const conn = await h.kernel.connectFacebook(h.peer, 'mock-acting-person', () => {});
      assert.equal((await conn.close()).state, 'stopped');
      assert.equal(conn.closedInventory?.tabs[0]?.state, 'CLOSED');
      assert.equal(
        h.kernel
          .diagnostics(h.profile.id)
          .some((entry) => entry.event === 'event:Inspector.detached'),
        false,
      );
    } finally {
      await h.close();
    }
  });

test('unexpected inspector detach still revokes the owner and never fabricates native close or stopped', async () => {
  const h = await harness();
  try {
    const conn = await h.kernel.connectFacebook(h.peer, 'mock-acting-person', () => {});
    h.unexpectedDetach();
    assert.equal(await conn.context('mock-acting-person'), null);
    await assert.rejects(conn.close(), /KERNEL_DEBUGGER_DETACHED/);
    assert.equal(conn.closedInventory, null);
    assert.equal(h.requests.includes('remove'), false);
    assert.equal((await h.journal.snapshot()).tabs[0]?.state, 'READY');
  } finally {
    await h.close();
  }
});

// The relay, actor, journal, source bytes and database are real here. The SDK locator receiver,
// acting account and independent effect evidence are simulated; no native FB input occurs.
async function materialSessionFixture(
  source: 'text.txt' | 'image.png' | 'album' | 'video.mp4',
  run: (value: Awaited<ReturnType<typeof createMaterialSession>>) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-facebook-material-session-'));
  let value: Awaited<ReturnType<typeof createMaterialSession>> | undefined;
  try {
    value = await createMaterialSession(dir, source);
    await run(value);
  } finally {
    await value?.h.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.ok(path.basename(dir).startsWith('wb-facebook-material-session-'));
    await rm(dir, { recursive: true, force: true });
  }
}
async function createMaterialSession(
  dir: string,
  source: 'text.txt' | 'image.png' | 'album' | 'video.mp4',
) {
  const root = path.join(dir, 'sources');
  await mkdir(root);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fZYAAAAASUVORK5CYII=',
    'base64',
  );
  if (source === 'album') {
    await mkdir(path.join(root, source));
    await writeFile(path.join(root, source, '2.png'), png);
    await writeFile(path.join(root, source, '10.png'), png);
  } else
    await writeFile(
      path.join(root, source),
      source === 'text.txt'
        ? '明确正文\n第二行 <字面内容>'
        : source === 'video.mp4'
          ? await readFile('public/sample.mp4')
          : png,
    );
  const h = await harness('event-first', root);
  try {
    const catalog = h.workspace.materials.index(
        await new FilesystemMaterialScanner().scan(root),
        randomUUID(),
      ),
      check = new MaterialPostSourceCheck(
        h.workspace.materials,
        h.workspace.materialPosts,
        h.workspace.taskTabs,
        new FilesystemMaterialSourceVerifier(),
      ),
      cache = new PersistentMaterialUploadStage(
        h.workspace.uploadStages,
        new FilesystemMaterialUploadStage(path.join(dir, 'cache')),
      ),
      inputs = {
        source: check,
        // This relay test simulates the DOM; actual phase/content checks have separate tests.
        composer: {
          assert: async () => {},
          assertRelease: new FacebookComposerObserver().assertRelease,
        },
        // Simulated page only; exercise the real pre-input capture and original durable store.
        submission: new FacebookSubmissionObserver(
          h.workspace.submissionObservations,
          async (_page, guard) => {
            await guard();
            const operation = h.workspace.tasks
              .operations(h.plan.id)
              .find((op) => op.status === 'DISPATCHING');
            assert.ok(operation?.binding);
            const post = await check.current(operation.binding, guard);
            return {
              url: 'https://www.facebook.com/post/create',
              timeOrigin: 100,
              ready: 'complete',
              posts: [],
              composer: {
                text: post.intent.snapshot.text,
                files: [],
                media: [],
                uploaded: false,
                busy: false,
                submitEnabled: true,
              },
            };
          },
        ),
        upload: new KernelMaterialUpload(
          new MaterialUploadPreparation(check, cache),
          new MaterialFileGrantPreparation(check, cache),
          new MaterialUploadOperationGuard(check, cache),
        ),
      };
    let inspect: NativeInputGuard | undefined, fence: (() => void) | undefined;
    const received: {
      method: string;
      value: string | string[];
      selector: string;
      type?: string;
    }[] = [];
    let onNativeInput = (_type: string | undefined) => {};
    const connect = h.kernel.connectFacebook.bind(h.kernel);
    h.kernel.connectFacebook = async (...args) => {
      const connection = await connect(...args),
        page = connection.browser.contexts()[0]?.pages()[0];
      assert.ok(page);
      const execute = connection.execute;
      connection.execute = async (binding, work, assertCurrent, stop, guard) => {
        fence = assertCurrent;
        inspect = guard;
        try {
          return await execute(binding, work, assertCurrent, stop, guard);
        } finally {
          fence = undefined;
          inspect = undefined;
        }
      };
      page.locator = (selector: string) => {
        const send = async (method: string, value: string | string[], type?: string) => {
          assert.ok(fence);
          await guardNativeInput(
            {
              target: { tabId: connection.tabId },
              method,
              params: Array.isArray(value)
                ? { files: value }
                : { text: value, ...(type ? { type, key: value } : {}) },
            },
            fence,
            inspect,
            'facebook-task',
          );
          received.push({ method, value, selector, type });
          onNativeInput(type);
        };
        const locator = {
          locator: (css: string) => page.locator(selector + ' ' + css),
          isVisible: async () => true,
          isEnabled: async () => true,
          press: async (key: string) => {
            await send('Input.dispatchKeyEvent', key, 'keyDown');
            await send('Input.dispatchKeyEvent', key, 'keyUp');
          },
          filter: ({ hasText }: { hasText: RegExp }) => {
            assert.ok(hasText instanceof RegExp);
            assert.ok(hasText.source.startsWith('^') && hasText.source.endsWith('$'));
            return locator;
          },
          click: () => send('Input.dispatchMouseEvent', ''),
          fill: (text: string) => send('Input.insertText', text),
          setInputFiles: (files: string[]) => send('DOM.setFileInputFiles', files),
        };
        return locator as unknown as Locator;
      };
      return connection;
    };
    const targets: FacebookPostTarget[] = [];
    let onTarget: (post: FacebookPostTarget) => void | Promise<void> = () => {};
    const authority = {
        ...h.authority,
        refreshIdentity: async (_page: unknown, guard: () => void) => {
          guard();
        },
        assertPostTarget: async (_action: unknown, post: FacebookPostTarget) => {
          targets.push(post);
          await onTarget(post);
        },
      },
      session = await KernelManagedFacebookSession.open(
        h.kernel,
        h.peer,
        h.plan,
        authority,
        h.workspace.tasks,
        h.workspace.taskTabs,
        inputs,
      ),
      context = await session.current(),
      tab = h.workspace.taskTabs.forPlan(h.plan.id)[0],
      step = h.workspace.tasks.steps(h.plan.id)[0],
      member = catalog.sources.find((item) => item.snapshot.source === source);
    assert.ok(context && tab && step && member);
    const request: ReservationRequest = {
      attemptId: randomUUID(),
      jobId: h.plan.id,
      stepId: step.id,
      expectedProgressRevision: 0,
      catalogId: catalog.id,
      sourceId: member.id,
      context,
      proof: tab.proof,
    };
    h.workspace.materials.reserve(request);
    const registry = new ProfileActorRegistry(
      () => [h.profile],
      h.workspace.tasks,
      h.workspace.tasks.settlements,
      h.workspace.taskControls,
      h.workspace.taskTabs,
      randomUUID,
    );
    await registry.attach(session);
    await registry.observe(h.profile.id);
    return {
      h,
      session,
      request,
      root,
      inputs,
      registry,
      received,
      targets,
      setTarget: (callback: typeof onTarget) => {
        onTarget = callback;
      },
      setNativeInput: (callback: typeof onNativeInput) => {
        onNativeInput = callback;
      },
      dispatch: async (purpose: Parameters<typeof postAction>[2]) => {
        const prepared = await postAction(h.workspace, request, purpose);
        h.workspace.materialPosts.prepare(prepared);
        assert.equal(
          await new TaskDispatcher(h.workspace.tasks, registry).flushOne(h.profile.id),
          true,
        );
        const operation = h.workspace.tasks
          .operations(h.plan.id)
          .find((op) => op.id === prepared.operationId);
        assert.ok(operation?.binding);
        return { prepared, binding: operation.binding };
      },
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}

test('managed post actor sends exact original text, independently settles each effect and does not consume on SDK acknowledgement', async () => {
  await materialSessionFixture('text.txt', async (f) => {
    for (const purpose of ['OPEN_COMPOSER', 'SET_TEXT', 'SUBMIT'] as const) {
      const operation = await f.dispatch(purpose);
      assert.equal(f.h.workspace.tasks.operations(f.h.plan.id).at(-1)?.status, 'ACKNOWLEDGED');
      assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId), null);
      assert.equal(f.h.workspace.tasks.steps(f.h.plan.id)[0]?.progress.published, 0);
      assert.equal(f.h.workspace.materialPosts.archives().length, 0);
      if (purpose === 'SUBMIT')
        assert.equal(
          f.h.workspace.submissionObservations.get(operation.binding.operationId)?.attemptId,
          f.request.attemptId,
        );
      f.h.workspace.materialPosts.verify(await postReceipt(f.h.workspace, f.request, operation));
      await f.registry.observe(f.h.profile.id);
      assert.equal((await f.h.journal.snapshot()).operations.at(-1)?.state, 'RECONCILED');
    }
    assert.deepEqual(
      f.received.filter((input) => input.method === 'Input.insertText').map((input) => input.value),
      ['明确正文\n第二行 <字面内容>'],
    );
    assert.equal(f.h.workspace.materials.reservation(f.request.attemptId).state, 'PUBLISHED');
    assert.equal(f.h.workspace.tasks.steps(f.h.plan.id)[0]?.progress.published, 1);
    assert.equal(f.h.workspace.materialPosts.archives().length, 0);
    assert.equal(f.h.workspace.materialUsage.snapshot().published, 1);
    assert.ok(f.targets.every((post) => post.intent.attemptId === f.request.attemptId));
    assert.equal(
      f.h.workspace.tasks.settlements
        .list(f.h.profile.id)
        .every((notice) => notice.state === 'DELIVERED'),
      true,
    );
  });
});

test('managed post settings use guarded keyboard activation while submit retains pointer actionability', async () => {
  await materialSessionFixture('text.txt', async (f) => {
    for (const purpose of [
      'OPEN_COMPOSER',
      'OPEN_AUDIENCE',
      'CONFIRM_AUDIENCE',
      'SET_TEXT',
      'SUBMIT',
    ] as const) {
      const operation = await f.dispatch(purpose);
      assert.equal(f.h.workspace.tasks.operations(f.h.plan.id).at(-1)?.status, 'ACKNOWLEDGED');
      if (['OPEN_COMPOSER', 'OPEN_AUDIENCE', 'CONFIRM_AUDIENCE'].includes(purpose))
        assert.equal(f.received.at(-1)?.method, 'Input.dispatchKeyEvent');
      if (purpose === 'SUBMIT') assert.equal(f.received.at(-1)?.method, 'Input.dispatchMouseEvent');
      f.h.workspace.materialPosts.verify(await postReceipt(f.h.workspace, f.request, operation));
      await f.registry.observe(f.h.profile.id);
    }
  });
});

test('settings activation cannot send input after the original asynchronous target guard is revoked', async () => {
  await materialSessionFixture('text.txt', async (f) => {
    f.setTarget(() => {
      throw Error('SETTINGS_OWNER_REVOKED');
    });
    await f.dispatch('OPEN_AUDIENCE');
    assert.equal(f.received.length, 0);
    assert.equal(f.h.workspace.tasks.operations(f.h.plan.id).at(-1)?.status, 'UNKNOWN');
  });
});

test('paired settings key release accepts the observed phase change without repeating the old target precondition', async () => {
  await materialSessionFixture('text.txt', async (f) => {
    let changed = false;
    f.setNativeInput((type) => {
      if (type === 'keyDown') changed = true;
    });
    f.setTarget(() => {
      if (changed) throw Error('POST_AUDIENCE_ACTION_UNCONFIRMED');
    });
    await f.dispatch('OPEN_AUDIENCE');
    assert.equal(f.h.workspace.tasks.operations(f.h.plan.id).at(-1)?.status, 'ACKNOWLEDGED');
    assert.deepEqual(
      f.received.map((row) => row.type),
      ['keyDown', 'keyUp'],
    );
    assert.equal(f.h.workspace.materials.reservation(f.request.attemptId).state, 'RESERVED');
    assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId), null);
  });
});

test('user stop between settings key down and key up cannot borrow completion permission', async () => {
  await materialSessionFixture('text.txt', async (f) => {
    f.setNativeInput((type) => {
      if (type === 'keyDown') f.h.workspace.tasks.requestControl(f.h.plan.id, 'stop', 'USER_STOP');
    });
    await f.dispatch('OPEN_AUDIENCE');
    assert.deepEqual(
      f.received.map((row) => row.type),
      ['keyDown'],
    );
    assert.equal(f.h.workspace.tasks.operations(f.h.plan.id).at(-1)?.status, 'UNKNOWN');
  });
});

test('managed actor routes all media formats through original persistent stage, exact file grant and independent upload verdict before submit', async () => {
  for (const source of ['image.png', 'album', 'video.mp4'] as const)
    await materialSessionFixture(source, async (f) => {
      const upload = await f.dispatch('UPLOAD_MEDIA'),
        input = f.received.find((item) => item.method === 'DOM.setFileInputFiles');
      assert.ok(input && Array.isArray(input.value));
      const original = f.h.workspace.materials.reservation(f.request.attemptId).intent.snapshot;
      assert.equal(
        input.value.length,
        original.files.filter((file) => file.role !== 'text').length,
      );
      for (const [index, file] of input.value.entries()) {
        const member = original.files.filter((item) => item.role !== 'text')[index];
        assert.ok(member);
        assert.deepEqual(
          await readFile(file),
          await readFile(path.join(f.root, member.relativePath)),
        );
      }
      assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId), null);
      await assert.rejects(
        async () => f.h.workspace.materialPosts.prepare(await postAction(f.h.workspace, f.request)),
        /POST_MEDIA_UPLOAD_NOT_VERIFIED|POST_SETTLEMENT_NOTICE_PENDING/,
      );
      f.h.workspace.materialPosts.verify(await postReceipt(f.h.workspace, f.request, upload));
      await f.registry.observe(f.h.profile.id);
      assert.equal(f.h.workspace.tasks.steps(f.h.plan.id)[0]?.progress.published, 0);
      const advance = await f.dispatch('ADVANCE_COMPOSER');
      assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId), null);
      f.h.workspace.materialPosts.verify(await postReceipt(f.h.workspace, f.request, advance));
      await f.registry.observe(f.h.profile.id);
      assert.equal(f.h.workspace.tasks.steps(f.h.plan.id)[0]?.progress.published, 0);
      assert.equal(f.h.workspace.materialPosts.archives().length, 0);
      const submit = await f.dispatch('SUBMIT');
      assert.equal(f.h.workspace.materials.reservation(f.request.attemptId).state, 'RESERVED');
      f.h.workspace.materialPosts.verify(await postReceipt(f.h.workspace, f.request, submit));
      await f.registry.observe(f.h.profile.id);
      assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId)?.outcome, 'PUBLISHED');
      assert.equal(f.h.workspace.tasks.steps(f.h.plan.id)[0]?.progress.published, 1);
      assert.equal(f.h.workspace.materialPosts.archives().length, 0);
      assert.equal(f.h.workspace.materialUsage.snapshot().published, 1);
    });
});

test('managed text input refuses a changed original source and keeps unknown attempt instead of resending', async () => {
  await materialSessionFixture('text.txt', async (f) => {
    await writeFile(path.join(f.root, 'text.txt'), 'changed source');
    const operation = await f.dispatch('SET_TEXT');
    assert.equal(f.received.length, 0);
    assert.equal(f.h.workspace.tasks.operations(f.h.plan.id)[0]?.status, 'UNKNOWN');
    assert.equal(f.h.workspace.materials.reservation(f.request.attemptId).state, 'REVIEW');
    assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId), null);
    assert.equal(f.h.workspace.tasks.steps(f.h.plan.id)[0]?.progress.published, 0);
    assert.equal(
      await new TaskDispatcher(f.h.workspace.tasks, f.registry).flushOne(f.h.profile.id),
      false,
    );
    assert.equal(
      f.h.workspace.tasks.operations(f.h.plan.id)[0]?.binding?.operationId,
      operation.binding.operationId,
    );
  });
});

test('post target change after async cache checks fences the file grant and retains original unresolved actor binding', async () => {
  await materialSessionFixture('image.png', async (f) => {
    let checks = 0;
    f.setTarget(async () => {
      await Promise.resolve();
      if (++checks === 2) f.h.invalidate();
    });
    await f.dispatch('UPLOAD_MEDIA');
    assert.equal(f.received.length, 0);
    assert.equal(f.h.requests.includes('grantOperationFiles'), false);
    assert.equal(f.h.workspace.tasks.operations(f.h.plan.id)[0]?.status, 'UNKNOWN');
    assert.equal(f.h.workspace.materials.reservation(f.request.attemptId).state, 'REVIEW');
    assert.equal(f.h.workspace.materialPosts.result(f.request.attemptId), null);
    assert.equal(f.h.workspace.materialPosts.archives().length, 0);
    assert.equal(await f.session.current(), null);
  });
});

test('post session requires explicit material dependencies and purpose-aware target observer before creating native page', async () => {
  const h = await harness('event-first', 'generated-no-read-directory');
  try {
    await assert.rejects(
      KernelManagedFacebookSession.open(
        h.kernel,
        h.peer,
        h.plan,
        h.authority,
        h.workspace.tasks,
        h.workspace.taskTabs,
      ),
      /MATERIAL_INPUTS_OR_TARGET_OBSERVER_REQUIRED/,
    );
    assert.equal(h.requests.includes('create'), false);
    assert.equal((await h.journal.snapshot()).tabs.length, 0);
  } finally {
    await h.close();
  }
});

test('controller grants foreground recovery only for the current task proof, epoch and lease, then rate limits and rejects stopped owners', async () => {
  const h = await harness();
  h.peer.capabilities?.push('task-presentation-recovery-v1');
  try {
    await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const stamp = KernelStamp.parse(h.recoveryStamp());
    assert.ok(h.requests.includes('armTaskPresentation'));
    const owned = (await h.journal.snapshot()).tabs.find((t) => t.state === 'READY')?.proof;
    assert.ok(owned);
    const monitor = {
      type: 'KERNEL_EVENT',
      connectionEpoch: stamp.connectionEpoch,
      leaseId: stamp.leaseId,
      source: { tabId: owned.tabId },
      method: 'Workbench.presentation',
      params: { phase: 'CHECK', windowFocused: false, visibility: 'hidden', probePending: true },
    };
    assert.equal(await h.kernel.message(h.peer, monitor), true);
    assert.equal(h.kernel.presentationStatus(h.peer.profileId)?.active, true);
    assert.equal(h.kernel.presentationStatus(h.peer.profileId)?.visibility, 'hidden');
    assert.equal(h.kernel.presentationStatus(h.peer.profileId)?.windowFocused, false);
    await assert.rejects(
      h.kernel.message(h.peer, {
        ...monitor,
        params: { ...monitor.params, pageText: 'forbidden' },
      }),
    );
    assert.equal(
      await h.kernel.message(h.peer, {
        ...monitor,
        source: { tabId: 999 },
        params: { phase: 'INVALID' },
      }),
      true,
    );
    const base = {
      type: 'PRESENTATION_RECOVERY_REQUEST',
      requestId: randomUUID(),
      connectionEpoch: stamp.connectionEpoch,
      leaseId: stamp.leaseId,
      generation: stamp.generation,
      proof: owned,
    };
    for (const change of [
      { leaseId: randomUUID() },
      { connectionEpoch: randomUUID() },
      { proof: { ...owned, tabId: 999 } },
      { generation: stamp.generation + 1 },
    ]) {
      assert.equal(
        await h.kernel.message(h.peer, { ...base, ...change, requestId: randomUUID() }),
        true,
      );
      assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, false);
    }
    await h.kernel.message(h.peer, base);
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, true);
    await h.kernel.message(h.peer, { ...base, requestId: randomUUID() });
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, false);
    h.kernel.controlStopped(h.peer);
    assert.notEqual(h.kernel.presentationStatus(h.peer.profileId)?.active, true);
    await h.kernel.message(h.peer, { ...base, requestId: randomUUID() });
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, false);
    assert.equal(
      h.commands.some((c) => c.startsWith('Input.')),
      false,
    );
  } finally {
    await h.close();
  }
});

test('exposed recovery requires fresh hidden evidence, repositions under the live lease and cancels after STOP', async () => {
  const h = await harness();
  h.peer.capabilities?.push(
    'task-presentation-recovery-v1',
    'task-window-occlusion-recovery-v1',
    'task-window-occlusion-focus-v1',
  );
  try {
    await KernelManagedFacebookSession.open(
      h.kernel,
      h.peer,
      h.plan,
      h.authority,
      h.workspace.tasks,
      h.workspace.taskTabs,
    );
    const stamp = KernelStamp.parse(h.recoveryStamp());
    const owned = (await h.journal.snapshot()).tabs.find((t) => t.state === 'READY')?.proof;
    assert.ok(owned);
    let calls = 0,
      visible = 0,
      hold = false;
    let exhausted = false;
    let resume!: () => void;
    h.kernel.setWindowLayoutHook(
      async () => {},
      () => true,
      async (id, guard, deadline) => {
        assert.equal(id, h.peer.profileId);
        assert.ok(deadline > Date.now());
        calls++;
        guard();
        if (exhausted) throw Error('WINDOW_LAYOUT_RECOVERY_EXHAUSTED');
        if (hold) await new Promise<void>((r) => (resume = r));
        guard();
      },
      () => {
        visible++;
      },
    );
    const monitor = (visibility: 'hidden' | 'visible') =>
      h.kernel.message(h.peer, {
        type: 'KERNEL_EVENT',
        connectionEpoch: stamp.connectionEpoch,
        leaseId: stamp.leaseId,
        source: { tabId: owned.tabId },
        method: 'Workbench.presentation',
        params: { phase: 'CHECK', visibility, visibilityAt: Date.now(), windowFocused: false },
      });
    const request = () => ({
      type: 'PRESENTATION_RECOVERY_REQUEST',
      requestId: randomUUID(),
      connectionEpoch: stamp.connectionEpoch,
      leaseId: stamp.leaseId,
      generation: stamp.generation,
      proof: owned,
      positionOnly: true,
    });
    await monitor('visible');
    await h.kernel.message(h.peer, request());
    assert.equal(calls, 0);
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, false);
    assert.equal(visible, 1);
    await monitor('hidden');
    await h.kernel.message(h.peer, request());
    assert.equal(calls, 1);
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, true);
    // A new controller gate is used to exercise a pending native-recovery owner,
    // without advancing wall-clock freshness or waiting for cooldown in this test.
    const originalGate = Reflect.get(h.kernel, 'positionRecoveryGate');
    Reflect.set(h.kernel, 'positionRecoveryGate', { request: () => true, cancel: () => {} });
    exhausted = true;
    await h.kernel.message(h.peer, request());
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, false);
    assert.equal(
      PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).focusFallback,
      undefined,
    );
    assert.equal(
      h.kernel.presentationStatus(h.peer.profileId)?.error,
      'WINDOW_LAYOUT_RECOVERY_EXHAUSTED',
    );
    await monitor('hidden');
    assert.equal(
      h.kernel.presentationStatus(h.peer.profileId)?.error,
      'WINDOW_LAYOUT_RECOVERY_EXHAUSTED',
    );
    exhausted = false;
    hold = true;
    const pending = h.kernel.message(h.peer, request());
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(calls, 3);
    h.kernel.controlStopped(h.peer);
    resume();
    await pending;
    assert.equal(PresentationRecoveryPermit.parse(h.recoveryPermits.at(-1)).granted, false);
    Reflect.set(h.kernel, 'positionRecoveryGate', originalGate);
    assert.equal(
      h.commands.some((c) => c.startsWith('Input.')),
      false,
    );
  } finally {
    await h.close();
  }
});
