import { fetchAndLocalizeAccountAvatar } from './group-bumper-avatar.js';
import { recoverBumperOperations } from './group-bumper-recovery.js';
import { recoverPosterOperations } from './group-poster-runner.js';
import { isLocalAvatar } from '../shared/group-bumper.js';
import { WindowLayoutService } from '../application/window-layout.js';
import { defaultWindowLayout, type LayoutDisplayValue } from '../shared/window-layout.js';
import type { ExecutionAcceptance } from './server-config.js';
import { KernelBridge } from './kernel-bridge.js';
import { ProfileInspectionService } from '../application/profile-inspection.js';
import { KernelProfileInspection } from './kernel-profile-inspection.js';
import { ActiveAccountRuntime } from './active-account-runtime.js';
import { BridgeProfileSource } from './browser-source.js';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridgeHooks } from '../bridge/server.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import type { PersistenceClient } from './persistence-client.js';
import type { Workboard } from '../application/workboard.js';
import type { LocalBrowserLabels } from './local-browser-labels.js';
import type { GraphAvatar } from './graph-avatar.js';
import type { ExtensionUpdates } from './extension-updates.js';
import type { FeatureExecutionRegistry } from '../application/feature-execution-registry.js';
import type { WorkspaceBackupService } from '../application/workspace-backup-service.js';
import type { DataCleanupService } from '../application/data-cleanup.js';
import type { SoftwareUpdateService } from '../application/software-update-service.js';
import type { GlobalAccountAbnormalReporter } from '../application/account-abnormal-reporter.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { WorkspaceEventHub } from '../application/workspace-event-hub.js';
export interface KernelWiringRefs {
  getLayoutDisplays: () => LayoutDisplayValue[];
  setWindowLayout: (layout: WindowLayoutService) => void;
  setMainKernel: (kernel: KernelBridge) => void;
  setInspection: (service: ProfileInspectionService) => void;
  getInspection: () => ProfileInspectionService | undefined;
  setActiveRuntime: (runtime: ActiveAccountRuntime) => void;
  getActiveRuntime: () => ActiveAccountRuntime | undefined;
  getProfileLifecycle: () => ProfileLifecyclePort | undefined;
  getAccountAbnormalReporter: () => GlobalAccountAbnormalReporter | undefined;
  getExtensionUpdates: () => ExtensionUpdates | undefined;
  getFeatureExecution: () => FeatureExecutionRegistry | undefined;
  getDataCleanup: () => DataCleanupService | undefined;
  getBackups: () => WorkspaceBackupService | undefined;
  getSoftwareUpdate: () => SoftwareUpdateService | undefined;
  getScheduleOfflineHygiene: () => ((profileId: string) => void) | undefined;
}
export function buildServerKernelHooks({
  core,
  repository,
  persistence,
  workboard,
  browserLabels,
  graphAvatar,
  dataDir,
  uploadCacheRoot,
  executionAcceptance,
  eventHub,
  refs,
}: {
  core: Core;
  repository: WorkspaceStore;
  persistence: PersistenceClient;
  workboard: Workboard;
  browserLabels: LocalBrowserLabels;
  graphAvatar: GraphAvatar;
  dataDir: string;
  uploadCacheRoot: string;
  executionAcceptance: ExecutionAcceptance;
  eventHub: WorkspaceEventHub;
  refs: KernelWiringRefs;
}): KernelBridgeHooks {
  const kernel = new KernelBridge(core);
  kernel.recoverBumperWorkspace = (peer, guard) =>
    recoverBumperOperations(kernel, peer, repository.groupBumper, guard);
  kernel.recoverPosterWorkspace = (peer, guard) =>
    recoverPosterOperations(kernel, peer, repository.groupPoster, guard);
  const layout = new WindowLayoutService(
    refs.getLayoutDisplays,
    {
      read: (id) => kernel.taskWindow(id),
      move: (id, expected, rect, exposed, deadline, focus) =>
        kernel.taskWindow(id, expected, rect, exposed, deadline, focus),
    },
    async () => (await repository.preferences()).windowLayout ?? defaultWindowLayout,
    async (value) => {
      const saved = await repository.preferences();
      const { version: _version, revision, ...values } = saved;
      await repository.updatePreferences({
        expectedRevision: revision,
        values: { ...values, windowLayout: value },
      });
    },
    process.env.WORKBENCH_TRACE_TIMING === '1'
      ? (data) => console.error(JSON.stringify({ event: 'WINDOW_LAYOUT_TRIAL', data }))
      : undefined,
    () => {
      let bestId: string | null = null;
      let bestAt = 0;
      for (const peer of core.peers.values()) {
        if (!peer.online) continue;
        const at = peer.focusedWindowAt ?? 0;
        if (at > bestAt) {
          bestAt = at;
          bestId = peer.profileId;
        }
      }
      return bestId;
    },
  );
  kernel.setWindowLayoutHook(
    (id, guard) => layout.arrange(id, guard),
    () => layout.isEnabled(),
    undefined,
    (id, at) => layout.visible(id, at),
  );
  refs.setWindowLayout(layout);
  void layout.snapshot().catch(() => {});
  const localizeAvatar = (url: string, key: string) =>
    fetchAndLocalizeAccountAvatar(url, undefined, key).catch(() => null);
  kernel.setAccountObserver({
    shouldRefreshAvatar: async (profileId, accountId) => {
      const cached = (await repository.profileAccountCache()).get(profileId);
      return (
        !isLocalAvatar(cached?.avatar) ||
        cached?.id !== accountId ||
        Date.now() - (cached?.avatarUpdatedAt ?? 0) >= 6 * 3600_000
      );
    },
    onObserved: async (profileId, account) => {
      const previous = (await repository.profileAccountCache()).get(profileId);
      let resolvedAvatar = account.avatar;
      if (resolvedAvatar && !isLocalAvatar(resolvedAvatar)) {
        const localized = await localizeAvatar(resolvedAvatar, `${profileId}:${account.id ?? ''}`);
        if (localized) resolvedAvatar = localized;
        else if (isLocalAvatar(previous?.avatar) && previous?.id === account.id)
          resolvedAvatar = previous?.avatar ?? null;
      }
      await repository.updateProfileAccountCache(profileId, {
        ...account,
        ...(resolvedAvatar !== undefined ? { avatar: resolvedAvatar } : {}),
      });
      const latest = (await repository.profileAccountCache()).get(profileId);
      const effectiveAvatar =
        latest?.avatar ??
        (resolvedAvatar !== undefined
          ? resolvedAvatar
          : previous?.id === account.id
            ? previous?.avatar
            : null);
      refs.getInspection()?.syncExternalObservation(profileId, {
        ...account,
        ...(effectiveAvatar !== undefined ? { avatar: effectiveAvatar } : {}),
      });
      const staleAvatar =
        !isLocalAvatar(previous?.avatar) ||
        previous?.id !== account.id ||
        Date.now() - (previous?.avatarUpdatedAt ?? 0) >= 6 * 3600_000;
      if (
        account.state === 'logged-in' &&
        account.id &&
        !isLocalAvatar(effectiveAvatar) &&
        staleAvatar
      ) {
        const accountId = account.id;
        void graphAvatar
          .lookup(accountId)
          .then(async (url) => {
            if (!url) return;
            const finalAvatar = (await localizeAvatar(url, `${profileId}:${accountId}`)) ?? url;
            await repository.updateProfileAccountCache(profileId, {
              state: 'logged-in',
              id: accountId,
              avatar: finalAvatar,
              liveConfirmedLoggedIn: true,
            });
            refs.getInspection()?.syncExternalObservation(profileId, {
              state: 'logged-in',
              id: accountId,
              avatar: finalAvatar,
            });
            eventHub.emit(['workspace', 'inspections'], 'avatar-updated');
          })
          .catch(() => {});
      }
    },
  });
  refs.setMainKernel(kernel);
  persistence.setFailureHandler((error) => {
    kernel.revokeInputs('PERSISTENCE_UNAVAILABLE');
    for (const peer of core.peers.values()) {
      if (peer.online) void core.stop(peer.profileId).catch(() => {});
    }
    console.error('Persistence worker failed; input authority revoked:', error);
  });
  const inspection = new ProfileInspectionService(
    new KernelProfileInspection(kernel, core, repository.tasks),
    Date.now,
    (accountId) => graphAvatar.lookup(accountId),
    async (profileId, account) => {
      let resolvedAvatar =
        account.state === 'logged-out'
          ? null
          : ['restricted', 'verification'].includes(account.state)
            ? undefined
            : account.avatar
              ? account.avatar
              : undefined;
      if (resolvedAvatar && !isLocalAvatar(resolvedAvatar)) {
        const localized = await localizeAvatar(resolvedAvatar, `${profileId}:${account.id ?? ''}`);
        if (localized) resolvedAvatar = localized;
      }
      await repository.updateProfileAccountCache(profileId, {
        state: account.state,
        ...(account.id ? { id: account.id } : {}),
        ...(account.name ? { name: account.name } : {}),
        ...(resolvedAvatar !== undefined ? { avatar: resolvedAvatar } : {}),
        liveConfirmedLoggedIn: account.state === 'logged-in',
      });
      if (resolvedAvatar && isLocalAvatar(resolvedAvatar)) {
        refs.getInspection()?.syncExternalObservation(profileId, {
          state: account.state,
          id: account.id,
          name: account.name,
          avatar: resolvedAvatar,
        });
      }
      eventHub.emit(['workspace', 'inspections'], 'inspection-updated');
    },
  );
  refs.setInspection(inspection);
  if (process.env.WORKBENCH_DIAGNOSTICS !== '1') {
    refs.setActiveRuntime(
      new ActiveAccountRuntime({
        workboard,
        store: repository,
        core,
        kernel,
        profileSource: new BridgeProfileSource(core, core.store),
        get profileLifecycle() {
          return refs.getProfileLifecycle();
        },
        accountAbnormalReporter: (event) =>
          refs.getAccountAbnormalReporter()?.(event) ?? Promise.resolve(false),
        ensureExtensionReady: (peer) =>
          refs.getExtensionUpdates()?.automatic(peer) ?? Promise.resolve(),
        otherModuleBusy: (profileId) =>
          refs.getFeatureExecution()?.isProfileBusy(profileId, 'active-accounts') ?? false,
        dataDirectory: dataDir,
        uploadCacheRoot,
        executionAcceptance: {
          feed: () => executionAcceptance.feed,
          video: () => executionAcceptance.video,
          marketplace: () => executionAcceptance.marketplace,
          post: () => executionAcceptance.post,
          story: () => executionAcceptance.story,
          friends: () => executionAcceptance.friends,
        },
        beforeStart: () => {
          refs.getDataCleanup()?.assertNotResetting();
          refs.getBackups()?.assertIdle();
          refs.getSoftwareUpdate()?.assertIdle();
        },
      }),
    );
  }
  return {
    message: async (peer: Peer, value: unknown) => await kernel.message(peer, value),
    disconnected: (peer: Peer) => {
      kernel.disconnected(peer);
      refs.getScheduleOfflineHygiene()?.(peer.profileId);
      eventHub.emit(['workspace', 'inspections', 'runtime-summary'], 'peer-disconnected');
    },
    controlStopped: async (peer: Peer, requestId?: string) => {
      kernel.controlStopped(peer, requestId);
      eventHub.emit(['tasks', 'runtime-summary'], 'control-stopped');
    },
    tick: async () => {
      kernel.tick();
      void (async () => {
        const ids = (await core.store.profileList()).map((row) => String(row.profileId));
        const newlyBound = await browserLabels.refresh(ids);
        if (newlyBound.length > 0) {
          await repository.upsertProfileLaunchBindings(newlyBound);
        }
      })().catch(() => {});
    },
    close: async () => {
      const settling = refs.getInspection()?.close();
      await refs.getActiveRuntime()?.close();
      await kernel.close();
      await settling;
    },
  };
}
