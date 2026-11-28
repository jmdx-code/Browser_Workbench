import type { GlobalAccountAbnormalReporter } from '../application/account-abnormal-reporter.js';
import type { TaskExecutionPort } from '../application/task-service.js';
import { isWorkAbortError, sleepAbortable, Workboard } from '../application/workboard.js';
import type { Core, Peer } from '../bridge/core.js';
import { hasResource } from '../domain/resource-table.js';
import type { Awaitable } from '../domain/persistence.js';
import { needsResourceTable } from '../domain/resource-material-rules.js';
import { type RuntimeProfile } from '../domain/tasks.js';
import { ProductError, type BrowserProfileSource } from '../domain/workspace.js';
import { devDiag } from '../shared/dev-diagnostics.js';
import type { Profile, Step } from '../shared/contracts.js';
import type { ProfileLifecyclePort } from '../shared/profile-lifecycle.js';
import type { Assignment, Plan, TaskCapabilities, TaskCommand } from '../shared/task-contracts.js';
import type { TaskFeatureId } from '../shared/task-policies.js';
import { TEST_COMBINATION_NOTE } from '../shared/task-tests.js';
import { isAccountAbnormalError, withBrowserSession } from './browser-session-lease.js';
import { executeDirectPostStep } from './facebook-direct-publisher.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { WorkspaceStorePort } from './persistence-port.js';
import { executeBrowseStep } from './active-account-runtime/browse-step-executor.js';
import type { z } from 'zod';
export interface ActiveAccountRuntimeOptions {
  readonly workboard: Workboard;
  readonly store: WorkspaceStorePort;
  readonly core: Core;
  readonly kernel: KernelBridge;
  readonly profileSource: BrowserProfileSource & {
    profile?: (profileId: string) => Awaitable<Profile | undefined>;
  };
  readonly profileLifecycle?: ProfileLifecyclePort | undefined;
  readonly accountAbnormalReporter?: GlobalAccountAbnormalReporter | undefined;
  readonly ensureExtensionReady?: ((peer: Peer) => Promise<void>) | undefined;
  readonly otherModuleBusy?: ((profileId: string) => Awaitable<boolean>) | undefined;
  readonly dataDirectory: string;
  readonly uploadCacheRoot: string;
  readonly executionAcceptance?: {
    feed?: () => boolean;
    video?: () => boolean;
    marketplace?: () => boolean;
    post?: () => boolean;
    story?: () => boolean;
    friends?: () => boolean;
  };
  readonly beforeStart?: () => void;
}
export class ActiveAccountRuntime implements TaskExecutionPort {
  private readonly claimedSourceKeys = new Set<string>();
  private readonly activePlanByProfile = new Map<string, string>();
  private closed = false;
  constructor(private readonly options: ActiveAccountRuntimeOptions) {}
  async close(): Promise<void> {
    this.closed = true;
    this.options.workboard.abortModule('active-accounts', 'SHUTDOWN');
    await this.options.workboard.waitUntilModuleIdle('active-accounts', 8_000);
  }
  hasActiveExecution(): boolean {
    return this.options.workboard.busyCarrierIds('active-accounts').length > 0;
  }
  async waitUntilProfileIdle(profileId: string, timeoutMs = 8_000): Promise<void> {
    await this.options.workboard.waitUntilCarrierIdle(profileId, timeoutMs);
  }
  async currentResourceRevision(combinationId: string): Promise<number | null> {
    try {
      return await this.options.store.resourceTables.revision(combinationId);
    } catch {
      return null;
    }
  }
  revokeForControl(_planId: string, profileId: string, reason: string): void {
    this.options.workboard.abortCarrier(profileId, reason);
  }
  available(): boolean {
    return !this.closed;
  }
  async supportsFeature(id: TaskFeatureId): Promise<boolean> {
    const acc = this.options.executionAcceptance;
    if (!acc) return true;
    const fn = acc[id];
    return fn ? fn() : true;
  }
  async capabilities(): Promise<z.infer<typeof TaskCapabilities>> {
    const types: Step['type'][] = [];
    if (await this.supportsFeature('feed')) types.push('feed');
    if (await this.supportsFeature('video')) types.push('video');
    if (await this.supportsFeature('marketplace')) types.push('marketplace');
    if (!this.options.executionAcceptance?.friends || this.options.executionAcceptance.friends()) {
      types.push('friends');
    }
    const postReady = await this.supportsFeature('post');
    const storyReady = await this.supportsFeature('story');
    if (postReady || storyReady) types.push('post');
    const saved = await this.options.store.combinations();
    const combinations = await Promise.all(
      saved
        .filter(
          (combo): combo is typeof combo & { saved: NonNullable<typeof combo.saved> } =>
            combo.saved !== null && !combo.saved.note.startsWith(TEST_COMBINATION_NOTE),
        )
        .map(async (combo) => {
          const missingType = combo.saved.steps.find((s) => !types.includes(s.type));
          if (missingType) {
            return {
              id: combo.id,
              version: combo.version,
              enabled: false,
              reason: `步骤类型 ${missingType.type} 暂不可用`,
            };
          }
          if (needsResourceTable(combo.saved)) {
            let table = null;
            try {
              table = await this.options.store.resourceTables.read(combo.id);
            } catch {
              table = null;
            }
            const hasRows = Boolean(table?.rows.some(hasResource));
            if (!hasRows) {
              return {
                id: combo.id,
                version: combo.version,
                enabled: false,
                reason: '组合资源表为空',
              };
            }
          }
          return { id: combo.id, version: combo.version, enabled: true, reason: '' };
        }),
    );
    return { types, combinations };
  }
  private async runtimeProfiles(): Promise<RuntimeProfile[]> {
    const list = await this.options.profileSource.profiles();
    return list.map((p) => ({
      id: p.id,
      online: p.online,
      synced: p.synced,
      unresolved: p.unresolved,
      account: p.account,
      dispatchAllowed: p.online,
    }));
  }
  async start(input: Assignment): Promise<Plan[]> {
    this.options.beforeStart?.();
    const profiles = await this.runtimeProfiles();
    const plans = await this.options.store.tasks.assign(input, profiles);
    const seenProfiles = new Set<string>();
    for (const plan of plans) {
      if (seenProfiles.has(plan.profileId)) continue;
      seenProfiles.add(plan.profileId);
      if (plan.state === 'QUEUED') this.spawnSoldier(plan.profileId);
    }
    return plans;
  }
  async stopProfile(profileId: string): Promise<void> {
    this.options.workboard.abortCarrier(profileId, 'USER_STOP');
    const tasks = this.options.store.tasks;
    const stopPlans = Promise.resolve(tasks.plansForProfile(profileId, ['QUEUED', 'RUNNING']))
      .then((ps) =>
        Promise.all(
          ps.map((p) => Promise.resolve(tasks.stopPlanDirect(p.id, 'USER_STOP')).catch(() => {})),
        ),
      )
      .catch(() => {});
    await Promise.all([stopPlans, this.options.workboard.waitUntilCarrierIdle(profileId, 3_000)]);
  }
  async commandPlan(planId: string, _command: TaskCommand['command']): Promise<Plan> {
    const plan = await this.options.store.tasks.get(planId);
    if (['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state)) return plan;
    this.options.workboard.abortCarrier(plan.profileId, 'USER_STOP');
    const stopped = await this.options.store.tasks.stopPlanDirect(plan.id, 'USER_STOP');
    await this.options.workboard.waitUntilCarrierIdle(plan.profileId, 5_000);
    return stopped;
  }
  private spawnSoldier(profileId: string): void {
    if (this.closed || this.options.workboard.isCarrierBusy(profileId)) return;
    void this.options.workboard
      .runSoldier(
        { carrierId: profileId, carrierKind: 'browser', moduleId: 'active-accounts' },
        async (soldier) => {
          await this.runSoldierLoop(profileId, soldier.signal);
        },
      )
      .catch(() => {});
  }
  private async runSoldierLoop(profileId: string, signal: AbortSignal): Promise<void> {
    let busyBackoffMs = 3_000;
    while (!this.closed && !signal.aborted) {
      let waitAfterReleaseMs = 0;
      const releasePermit = await this.options.workboard.acquireCarrierPermit(
        'browser',
        profileId,
        signal,
      );
      let activePlanId: string | null = null;
      let activePlan: Plan | null = null;
      try {
        if (signal.aborted) break;
        const peer = this.options.core.peers.get(profileId);
        let cachedProfile = undefined;
        if (peer?.online && this.options.profileSource.profile) {
          try {
            cachedProfile = await this.options.profileSource.profile(profileId);
          } catch {}
        }
        const initialAccountId =
          cachedProfile?.account.state === 'logged-in' && cachedProfile.account.id
            ? cachedProfile.account.id
            : null;
        const claimed = await this.options.store.tasks.claimPlanForProfile(
          profileId,
          initialAccountId,
        );
        if (!claimed) {
          const queued = await this.options.store.tasks.plansForProfile(profileId, ['QUEUED']);
          if (queued.some((p) => p.reason === 'ACCOUNT_BUSY')) {
            waitAfterReleaseMs = busyBackoffMs;
            busyBackoffMs = Math.min(15_000, Math.round(busyBackoffMs * 1.6));
            continue;
          }
          break;
        }
        busyBackoffMs = 3_000;
        let currentPlan: Plan = claimed;
        activePlan = currentPlan;
        activePlanId = currentPlan.id;
        this.activePlanByProfile.set(profileId, currentPlan.id);
        try {
          await withBrowserSession(
            {
              core: this.options.core,
              kernel: this.options.kernel,
              workboard: this.options.workboard,
              profileLifecycle: this.options.profileLifecycle,
              accountAbnormalReporter: this.options.accountAbnormalReporter,
              ensureExtensionReady: this.options.ensureExtensionReady,
              otherModuleBusy: this.options.otherModuleBusy,
            },
            {
              profileId,
              jobId: currentPlan.id,
              purpose: 'facebook-task',
              expectedAccountId: currentPlan.accountId,
              allowAutoLaunch: true,
              closeBrowserOnFinish: Boolean(currentPlan.closeBrowserOnFinish),
              signal,
            },
            async (lease) => {
              currentPlan = await this.options.store.tasks.bindPlanAccount(
                currentPlan.id,
                lease.accountId,
              );
              activePlan = currentPlan;
              while (!signal.aborted && currentPlan.state === 'RUNNING') {
                lease.guard();
                const step = await this.options.store.tasks.currentStepForPlan(
                  currentPlan.id,
                  currentPlan.round,
                  currentPlan.position,
                );
                if (!step) break;
                lease.setStepId(step.id);
                try {
                  if (step.spec.type === 'post') {
                    const postResult = await executeDirectPostStep({
                      plan: currentPlan,
                      step,
                      lease,
                      store: this.options.store,
                      dataDirectory: this.options.dataDirectory,
                      uploadCacheRoot: this.options.uploadCacheRoot,
                      claimedSourceKeys: this.claimedSourceKeys,
                      onProgress: async (nextProgress) => {
                        try {
                          await this.options.store.tasks.updateStepProgress(
                            currentPlan.id,
                            step.id,
                            nextProgress,
                          );
                        } catch {}
                      },
                    });
                    if (postResult.kind === 'SKIP_EXHAUSTED') {
                      currentPlan = await this.options.store.tasks.skipStepDirect(
                        currentPlan.id,
                        step.id,
                        'RESOURCE_EXHAUSTED',
                      );
                    } else if (postResult.kind === 'FAIL_EXHAUSTED') {
                      currentPlan = await this.options.store.tasks.failStepDirect(
                        currentPlan.id,
                        step.id,
                        'RESOURCE_EXHAUSTED',
                        'NOT_PUBLISHED',
                      );
                    } else {
                      currentPlan = await this.options.store.tasks.completeStepDirect(
                        currentPlan.id,
                        step.id,
                        { ...step.progress, published: postResult.published },
                      );
                    }
                  } else {
                    const browseResult = await executeBrowseStep(
                      this.options.store,
                      currentPlan,
                      step,
                      lease,
                    );
                    if (browseResult.kind === 'SKIPPED') {
                      currentPlan = await this.options.store.tasks.skipStepDirect(
                        currentPlan.id,
                        step.id,
                        browseResult.reason,
                      );
                    } else {
                      currentPlan = await this.options.store.tasks.completeStepDirect(
                        currentPlan.id,
                        step.id,
                        browseResult.progress,
                      );
                    }
                  }
                  activePlan = currentPlan;
                } catch (stepError) {
                  if (isWorkAbortError(stepError) || signal.aborted) throw stepError;
                  const msg =
                    stepError instanceof Error
                      ? stepError.message
                      : String(stepError ?? 'STEP_FAILED');
                  if (
                    isAccountAbnormalError(stepError) ||
                    /ACCOUNT_BUSY|ACCOUNT_CHANGED|FACEBOOK_(?:EXECUTION_CONTEXT_LOST|PAGE_MISSING)|KERNEL_|TARGET_CLOSED|BROWSER_OFFLINE/i.test(
                      msg,
                    ) ||
                    !lease.peer.online
                  ) {
                    throw stepError;
                  }
                  const businessResult =
                    step.spec.type === 'post'
                      ? /PUBLISH_RESULT_UNCONFIRMED|SUBMIT_DISPATCHED|OPERATION_RESULT_UNCONFIRMED|UNKNOWN/i.test(
                          msg,
                        )
                        ? 'UNKNOWN'
                        : 'NOT_PUBLISHED'
                      : 'NOT_APPLICABLE';
                  currentPlan = await this.options.store.tasks.failStepDirect(
                    currentPlan.id,
                    step.id,
                    msg,
                    businessResult,
                  );
                  activePlan = currentPlan;
                }
              }
            },
          );
        } catch (err) {
          const isAccountBusy =
            (err instanceof ProductError && err.code === 'ACCOUNT_BUSY') ||
            (err instanceof Error && /ACCOUNT_BUSY/i.test(err.message));
          if (isAccountBusy && !signal.aborted) {
            try {
              if (this.options.store.tasks.requeueBusyAccountPlan) {
                await this.options.store.tasks.requeueBusyAccountPlan(activePlan.id);
              } else await this.options.store.tasks.noteQueuedWait?.(activePlan.id, 'ACCOUNT_BUSY');
            } catch {}
            waitAfterReleaseMs = busyBackoffMs;
            busyBackoffMs = Math.min(15_000, Math.round(busyBackoffMs * 1.6));
            continue;
          }
          if (isWorkAbortError(err) || signal.aborted) {
            const abortReason =
              typeof signal.reason === 'string' && signal.reason ? signal.reason : 'USER_STOP';
            try {
              await this.options.store.tasks.stopPlanDirect(activePlan.id, abortReason);
            } catch {}
          } else {
            const reason = err instanceof Error ? err.message : String(err ?? 'TASK_FAILED');
            try {
              await this.options.store.tasks.failPlanDirect(activePlan.id, reason);
            } catch {}
            devDiag.emit('ERROR', 'TASK_RUNNER', 'ACTIVE_TASK_FAILED', {
              profileId,
              planId: activePlan.id,
              reason: reason.slice(0, 200),
            });
          }
          break;
        }
      } finally {
        if (activePlanId) this.activePlanByProfile.delete(profileId);
        releasePermit();
      }
      if (waitAfterReleaseMs > 0) await sleepAbortable(waitAfterReleaseMs, signal);
    }
  }
}
