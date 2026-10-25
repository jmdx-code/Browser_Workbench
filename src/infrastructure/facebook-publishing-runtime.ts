import type { Awaitable } from '../domain/persistence.js';
import { filterAsync, mapAsync, everyAsync } from '../shared/async-collections.js';
import { randomUUID } from 'node:crypto';
import type { Core, Peer } from '../bridge/core.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import { AdmittedTaskRuntime } from '../application/admitted-task-runtime.js';
import { TaskStepRunner, type CycleResult } from '../application/task-step-runner.js';
import { KernelManagedFacebookSession } from './kernel-managed-facebook-session.js';
import { NativeFacebookProfileFactory } from './facebook-profile-factory.js';
import { FacebookPublishingAdapters } from './facebook-publishing-adapters.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import { FacebookBrowseStepExecutor } from './facebook-browse-step-executor.js';
import type { Step } from '../shared/contracts.js';
import type { Combination } from '../shared/contracts.js';
import {
  AssignTasks,
  type Assignment,
  type TaskCommand,
  type Plan,
} from '../shared/task-contracts.js';
import { ProductError } from '../domain/workspace.js';
import { TaskEndingCoordinator } from './task-ending-coordinator.js';
import type { StepExecution } from '../domain/browse-execution.js';
import type { BrowsePage } from './facebook-browse-reader.js';
import type { FacebookSubmissionAudiencePolicy } from './facebook-native-submission-wire.js';
import type { PostUploadDiagnostic } from './facebook-post-business-observer.js';
import type { PostSubmissionDiagnostic } from './facebook-submission-network.js';
import {
  marketplaceBridgeSupported,
  marketplaceMinimumBridge,
  STORY_MIN_BRIDGE,
  type TaskFeatureId,
} from '../shared/task-features.js';
import { taskTimingEligibility } from '../domain/task-timing.js';
import {
  publicationAssignmentAllowed,
  publicationPlanAllowed,
  publicationOriginalAllowed,
  type PublicationScope,
} from './publication-acceptance-scope.js';

export type FacebookExecutionAcceptance = Partial<Record<TaskFeatureId | 'friends', () => boolean>>;

// Composes the existing runner/registry and per-plan observers. The server owns tick/close;
// no second scheduler, native session registry or publication/material ledger is introduced.
export class FacebookPublishingRuntime {
  hasActiveExecution(): boolean {
    return this.runtime.hasActiveExecution();
  }
  private readonly timingControls = new Map<string, Promise<void>>();
  readonly runtime: AdmittedTaskRuntime;
  readonly adapters: FacebookPublishingAdapters;
  private readonly runner: TaskStepRunner;
  private readonly endingRecoveries = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private readonly ending: TaskEndingCoordinator;
  private readonly lastSlowRead = new Map<string, number>();
  private readonly lastBrowseInterval = new Map<string, number>();
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly store: WorkspaceStore,
    directory: string,
    inventory: () => Awaitable<RuntimeProfile[]>,
    private readonly accepted: (() => boolean) | FacebookExecutionAcceptance = {},
    browseObserver?: (execution: StepExecution, page: BrowsePage) => void,
    audiencePolicy: FacebookSubmissionAudiencePolicy = 'preserve-current',
    uploadDiagnostic?: (value: PostUploadDiagnostic) => void,
    submissionDiagnostic?: (value: PostSubmissionDiagnostic) => void,
    private readonly assertTaskLaunchAllowed: () => Awaitable<void> = () => {},
    private readonly publicationAcceptanceScope: PublicationScope | null = null,
    uploadCacheRoot?: string,
    profileInventory?: (profileId: string) => Awaitable<RuntimeProfile | undefined>,
  ) {
    this.ending = new TaskEndingCoordinator(kernel, core, store);
    this.adapters = new FacebookPublishingAdapters(
      store,
      directory,
      async (execution) => {
        const owner = await this.runtime.registry.ownedSession(execution.session);
        return owner instanceof KernelManagedFacebookSession ? owner : null;
      },
      () =>
        this.featureAvailable('post') ||
        this.featureAvailable('story') ||
        this.publicationAcceptanceScope !== null,
      audiencePolicy,
      uploadDiagnostic,
      submissionDiagnostic,
      async (original) => {
        if (
          this.publicationAcceptanceScope?.submitDisabled &&
          original.link.purpose === 'SUBMIT' &&
          (await this.store.tasks.get(original.intent.jobId)).batchId ===
            this.publicationAcceptanceScope.id
        )
          throw Error('PUBLICATION_ACCEPTANCE_SUBMIT_DISABLED');
        const plan = await this.store.tasks.get(original.intent.jobId);
        const step = (await this.store.tasks.steps(plan.id)).find(
          (row) => row.id === original.intent.stepId,
        );
        if (
          plan.batchId !== this.publicationAcceptanceScope?.id &&
          step &&
          this.publicStepAllowed(step.spec) &&
          (await this.executionAllowed(plan))
        )
          return;
        if (
          !this.publicationAcceptanceScope ||
          !(await this.executionAllowed(plan)) ||
          !publicationOriginalAllowed(this.publicationAcceptanceScope, plan, original)
        )
          throw Error('PUBLICATION_ACCEPTANCE_CONTENT_REQUIRED');
      },
      async (execution) => {
        if (
          execution.plan.batchId !== this.publicationAcceptanceScope?.id &&
          this.publicStepAllowed(execution.step.spec) &&
          (await this.executionAllowed(execution.plan))
        )
          return undefined;
        const scope = this.publicationAcceptanceScope;
        if (!scope || !(await this.executionAllowed(execution.plan)))
          throw Error('PUBLICATION_ACCEPTANCE_SCOPE_REQUIRED');
        if (scope.submitDisabled) return undefined;
        const posts = (await this.store.tasks.steps(execution.plan.id)).filter(
          (step) => step.spec.type === 'post',
        );
        const expected = scope.resources[posts.findIndex((step) => step.id === execution.step.id)];
        const catalog = await this.adapters.catalogs.current(execution);
        const source =
          catalog && 'combinationId' in catalog
            ? catalog.sources.find((row) => row.origin.row.id === expected?.rowId)
            : undefined;
        if (!source) throw Error('PUBLICATION_ACCEPTANCE_RESOURCE_REQUIRED');
        return source.id;
      },
      uploadCacheRoot,
      async (plan) => await this.storyAllowed(plan),
      (plan) =>
        !(
          this.publicationAcceptanceScope?.submitDisabled &&
          plan.batchId === this.publicationAcceptanceScope.id
        ),
    );
    const factory = new NativeFacebookProfileFactory(
      kernel,
      core,
      store.tasks,
      store.taskTabs,
      async (plan) => {
        if (!(await this.executionAllowed(plan)))
          throw Error('PUBLICATION_ACCEPTANCE_SCOPE_REQUIRED');
        return plan.snapshot.steps.some((step) => step.type === 'post')
          ? this.adapters.inputsFor(plan, true)
          : undefined;
      },
      undefined,
      undefined,
      undefined,
      async (plan) => await this.storyAllowed(plan),
    );
    this.runtime = new AdmittedTaskRuntime(
      store.tasks,
      store.taskTabs,
      store.tasks.settlements,
      store.taskControls,
      factory,
      inventory,
      randomUUID,
      profileInventory,
    );
    this.runner = new TaskStepRunner(
      store.tasks,
      store.browseIntents,
      store.taskTabs,
      this.runtime,
      (['feed', 'video', 'marketplace', 'friends'] as const).map(
        (type) =>
          new FacebookBrowseStepExecutor(
            type,
            {
              foregroundAllowed: async (execution, guard) => {
                const owner = await this.runtime.registry.ownedSession(execution.session);
                if (!(owner instanceof KernelManagedFacebookSession))
                  throw Error('FACEBOOK_BROWSE_ORIGINAL_OWNER_REQUIRED');
                return await owner.foregroundAllowed(execution, guard);
              },
              canPresentTaskPage: async (execution, guard) => {
                const owner = await this.runtime.registry.ownedSession(execution.session);
                if (!(owner instanceof KernelManagedFacebookSession))
                  throw Error('FACEBOOK_BROWSE_ORIGINAL_OWNER_REQUIRED');
                return await owner.canPresentTaskPage(execution, guard);
              },
              read: async (execution, guard) => {
                const owner = await this.runtime.registry.ownedSession(execution.session);
                if (!(owner instanceof KernelManagedFacebookSession))
                  throw Error('FACEBOOK_BROWSE_ORIGINAL_OWNER_REQUIRED');
                const startedAt = performance.now();
                const value = await owner.readBrowsePage(execution, guard);
                const finishedAt = performance.now();
                if (
                  process.env.WORKBENCH_TRACE_TIMING === '1' &&
                  finishedAt - startedAt > 2500 &&
                  finishedAt - (this.lastSlowRead.get(execution.plan.profileId) ?? -Infinity) >=
                    30_000
                ) {
                  this.lastSlowRead.set(execution.plan.profileId, finishedAt);
                  try {
                    console.warn(
                      JSON.stringify({
                        event: 'BROWSE_SLOW_READ',
                        profileId: execution.plan.profileId,
                        jobId: execution.plan.id,
                        type,
                        milliseconds: Math.round(finishedAt - startedAt),
                        visible: value.page.visible,
                        ready: value.page.ready,
                        blocked: value.page.blocked,
                        hasContent: !!value.page.contentKey,
                        rpc: kernel
                          .diagnostics(execution.plan.profileId)
                          .filter((row) => row.event.startsWith('rpc-finished:'))
                          .slice(-24),
                      }),
                    );
                  } catch {
                    // Timing output is not an execution authority or business result.
                  }
                }
                return value;
              },
            },
            () => this.featureAvailable(type),
            undefined,
            browseObserver,
            async (accountId, contentId) =>
              (await this.store.browseIntents.hasAccountLiked?.(accountId, contentId)) ?? false,
          ),
      ),
      { nowMilliseconds: () => performance.now() },
      randomUUID,
      this.adapters.post,
      async (plan) => await this.executionAllowed(plan),
      (sample) => {
        const at = performance.now();
        if (
          !['1', 'full'].includes(process.env.WORKBENCH_TRACE_TIMING ?? '') ||
          (process.env.WORKBENCH_TRACE_TIMING !== 'full' &&
            at - (this.lastBrowseInterval.get(sample.profileId) ?? -Infinity) < 30_000)
        )
          return;
        this.lastBrowseInterval.set(sample.profileId, at);
        console.warn(JSON.stringify({ event: 'BROWSE_INTERVAL', ...sample }));
      },
    );
  }
  private featureAvailable(type: TaskFeatureId | 'friends') {
    return (
      !this.closed &&
      (typeof this.accepted === 'function'
        ? type === 'post' && this.accepted()
        : this.accepted[type]?.() === true)
    );
  }
  async supportsFeature(type: TaskFeatureId | 'friends') {
    return (
      this.featureAvailable(type) &&
      (!['post', 'story'].includes(type) || (await this.adapters.post.executor.available()))
    );
  }
  private publicStepAllowed(step: Step) {
    return step.type === 'post'
      ? step.destination === 'story'
        ? this.featureAvailable('story') && step.audience === 'friends'
        : this.featureAvailable('post')
      : this.featureAvailable(step.type);
  }
  private async privatePlanAllowed(plan: Plan) {
    return (
      this.publicationAcceptanceScope !== null &&
      (await publicationPlanAllowed(this.store, this.publicationAcceptanceScope, plan))
    );
  }
  async supportedTypes() {
    return await filterAsync(
      ['feed', 'video', 'post', 'marketplace', 'friends'] as const,
      async (type) =>
        type === 'post'
          ? (await this.supportsFeature('post')) || (await this.supportsFeature('story'))
          : await this.supportsFeature(type),
    );
  }
  private async executionAllowed(plan: Plan): Promise<boolean> {
    if (plan.batchId === this.publicationAcceptanceScope?.id)
      return await this.privatePlanAllowed(plan);
    return plan.snapshot.steps.every((step) => this.publicStepAllowed(step));
  }
  private async storyAllowed(plan: Plan): Promise<boolean> {
    const scope = this.publicationAcceptanceScope;
    if (plan.batchId !== scope?.id)
      return (
        this.featureAvailable('story') &&
        (await this.executionAllowed(plan)) &&
        plan.snapshot.steps.some((step) => step.type === 'post' && step.destination === 'story')
      );
    return (
      scope !== null &&
      scope !== undefined &&
      [4, 6].includes(scope.version) &&
      plan.accountId === scope.accountId &&
      (await publicationPlanAllowed(this.store, scope, plan))
    );
  }
  async unavailableReason(combination: Combination, privatePost = false): Promise<string> {
    if (
      combination.steps.some((step) => step.type === 'post' && step.destination === 'story') &&
      !(await this.supportsFeature('story')) &&
      !(
        privatePost &&
        this.publicationAcceptanceScope &&
        [4, 6].includes(this.publicationAcceptanceScope.version)
      )
    )
      return '快拍编辑、上传及最终发布尚未完成验收；不会使用普通帖子执行器代发';
    if (
      combination.steps.some(
        (step) =>
          step.type === 'post' && step.destination === 'story' && step.audience !== 'friends',
      )
    )
      return '快拍当前支持好友范围，请明确选择好友；不会替换保持当前或仅自己的设置';
    const names = {
      feed: '首页浏览',
      video: '视频浏览',
      post: '发布内容',
      marketplace: '商城浏览',
      friends: '接受好友请求',
    };
    const missing = [
      ...new Set(
        combination.steps
          .filter((step) => !this.publicStepAllowed(step) && !(step.type === 'post' && privatePost))
          .map((step) => step.type),
      ),
    ];
    if (missing.length) return missing.map((type) => names[type]).join('、') + '尚未完成真实验收';
    if (
      combination.steps.some(
        (step) =>
          step.type !== 'post' && !['feed', 'video'].includes(step.type) && step.maxLikes > 0,
      )
    )
      return '点赞执行仅支持首页浏览与视频浏览';
    return '';
  }
  async start(input: Assignment) {
    const request = AssignTasks.parse(input);
    // A repeated request only returns its original batch, even if current feature availability
    // or saved heads changed. Repository checks exact parameters before returning existing plans.
    if (await this.store.tasks.batchExists(request.requestId))
      return await this.store.tasks.assign(request, []);
    const row = (await this.store.combinations()).find(
      (value) => value.id === request.combinationId,
    );
    if (!row?.saved || row.version !== request.version)
      throw new ProductError('COMBINATION_VERSION_CHANGED', '组合保存版本已变化，请重新读取', 409);
    const privatePost =
      this.publicationAcceptanceScope !== null &&
      (await publicationAssignmentAllowed(
        this.store,
        this.publicationAcceptanceScope,
        request,
        row.saved,
      ));
    const reason = await this.unavailableReason(row.saved, privatePost);
    if (reason) throw new ProductError('COMBINATION_EXECUTOR_UNAVAILABLE', reason, 409);
    const minimumBridge = marketplaceMinimumBridge(row.saved.steps);
    if (
      row.saved.steps.some((step) => step.type === 'post' && step.destination === 'story') &&
      request.profileIds.some(
        (id) =>
          !marketplaceBridgeSupported(this.core.peers.get(id)?.extensionVersion, STORY_MIN_BRIDGE),
      )
    )
      throw new ProductError(
        'STORY_BRIDGE_UPDATE_REQUIRED',
        '快拍任务需要插件' + STORY_MIN_BRIDGE + '或更新版本，请先刷新所选浏览器中的插件',
        409,
      );
    if (
      row.saved.steps.some((step) => step.type === 'marketplace') &&
      request.profileIds.some(
        (id) =>
          !marketplaceBridgeSupported(this.core.peers.get(id)?.extensionVersion, minimumBridge),
      )
    )
      throw new ProductError(
        'MARKETPLACE_BRIDGE_UPDATE_REQUIRED',
        '商城任务需要插件' + minimumBridge + '或更新版本，请先刷新所选浏览器中的插件',
        409,
      );
    await this.store.tasks.releaseErroredPausedPlans(request.profileIds);
    return await this.store.tasks.assign(request, await this.runtime.profiles());
  }
  async capabilities() {
    return {
      types: await this.supportedTypes(),
      combinations: await mapAsync(await this.store.combinations(), async (row) => {
        const reason = row.saved ? await this.unavailableReason(row.saved) : '请先保存任务组合';
        return { id: row.id, version: row.version, enabled: !reason, reason };
      }),
    };
  }
  async stopProfile(profileId: string) {
    const live = await this.store.tasks.plansForProfile(profileId, [
      'QUEUED',
      'RUNNING',
      'PAUSING',
      'PAUSED',
      'STOPPING',
      'REVIEW',
    ]);
    for (const plan of live) {
      const stopped = await this.commandPlan(plan.id, 'stop');
      if (stopped.state !== 'STOPPED' && !stopped.controlConfirmed)
        throw Error('浏览器尚未确认停止，请保留原任务并核对');
    }
  }
  async commandPlan(planId: string, command: TaskCommand['command']) {
    try {
      return await this.controlPlan(planId, command);
    } catch (error) {
      const current = await this.store.tasks.get(planId);
      const peer = this.core.peers.get(current.profileId);
      const reason = error instanceof Error ? error.message.split('\n')[0] : '';
      const code =
        error instanceof ProductError
          ? error.code
          : reason && /^[A-Z][A-Z0-9_:-]{0,199}$/.test(reason)
            ? reason
            : 'TASK_CONTROL_FAILED';
      try {
        console.warn(
          JSON.stringify({
            event: 'TASK_CONTROL_FAILED',
            planId,
            profileId: current.profileId,
            command,
            code,
            rpc: this.kernel
              .diagnostics(current.profileId)
              .filter((row) => /^rpc-finished:|^rpc-error:[A-Z_]+$/.test(row.event))
              .slice(-16),
          }),
        );
      } catch {
        /* Diagnostics must not change stop recovery. */
      }
      if (
        command !== 'stop' ||
        !peer?.online ||
        ['COMPLETED', 'FAILED', 'STOPPED'].includes(current.state)
      )
        throw error;
      // Explicit STOP may interrupt a stuck SDK owner through the original parent bridge.
      // Its matching STOPPED receipt releases that owner; the original ending coordinator
      // still confirms physical closure and retains every UNKNOWN business result.
      await this.core.stop(current.profileId);
      return await this.store.tasks.get(planId);
    }
  }
  revokeForControl(planId: string, profileId: string, reason: string): void {
    this.runtime.registry.revokeForControl(planId, profileId, reason);
  }
  private async controlPlan(planId: string, command: TaskCommand['command']) {
    const plan = await this.store.tasks.get(planId);
    if (command !== 'resume') await this.store.tasks.cancelStepContinuation(planId);
    if (command === 'resume') {
      if (taskTimingEligibility(plan.timing, Date.now(), plan.timingReleased === true) !== 'OPEN')
        throw new ProductError(
          'SCHEDULE_NOT_OPEN',
          '当前不在任务允许运行的时间，请到下一时间窗再继续',
          409,
        );
      const reason = await this.unavailableReason(
        plan.snapshot,
        await this.privatePlanAllowed(plan),
      );
      if (reason) throw new ProductError('COMBINATION_EXECUTOR_UNAVAILABLE', reason, 409);
      // Resume the original immutable version and progress. Original SQL rejects REVIEW,
      // unknown operations and held material; admission will recheck identity before input.
      return await this.store.tasks.resume(plan.id);
    }
    if (
      command === 'stop' &&
      ['REVIEW', 'PAUSING', 'STOPPING'].includes(plan.state) &&
      !this.runtime.registry.hasOwner(plan.profileId)
    )
      return this.ending.end(plan.id);
    let result;
    try {
      result = await this.runtime.controlFromUser(
        plan.id,
        command,
        'USER_' + command.toUpperCase(),
      );
    } catch (error) {
      // A restarted runtime has no original SDK owner. A new current STOP can end the task,
      // but cannot impersonate the original historical STOP or bypass a still-live owner.
      if (command !== 'stop' || this.runtime.registry.hasOwner(plan.profileId)) throw error;
      return this.ending.end(plan.id);
    }
    if (command === 'stop' && result.state === 'REVIEW') return this.ending.end(plan.id);
    if (
      !['PAUSED', 'STOPPED', 'COMPLETED', 'FAILED'].includes(result.state) &&
      !result.controlConfirmed
    )
      throw Error('浏览器尚未确认停止控制，请保留原任务并核对');
    return result;
  }
  async available() {
    return (
      !this.closed &&
      ((await this.supportedTypes()).length > 0 || this.publicationAcceptanceScope !== null)
    );
  }
  async canRecoverConnectionForEnding(profileId: string): Promise<boolean> {
    if (this.closed || this.runtime.registry.hasOwner(profileId)) return false;
    const pending = await this.store.tasks.plansForProfile(profileId, [
      'QUEUED',
      'RUNNING',
      'PAUSING',
      'PAUSED',
      'STOPPING',
      'REVIEW',
    ]);
    return (
      pending.length > 0 &&
      (await everyAsync(
        pending,
        async (plan) =>
          ['STOPPING', 'REVIEW', 'PAUSING'].includes(plan.state) &&
          (await this.store.tasks.endingId(plan.id)) !== null,
      ))
    );
  }
  async parentControlStopped(peer: Peer): Promise<void> {
    if (
      this.closed ||
      this.core.peers.get(peer.profileId) !== peer ||
      !peer.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED'
    )
      return;
    await this.runtime.registry.retireParentStoppedOwner(peer.profileId, peer.epoch);
  }
  private ticking?: Promise<CycleResult[]>;
  tick(): Promise<CycleResult[]> {
    if (this.ticking) return this.ticking;
    const work = this.tickOnce();
    this.ticking = work;
    void work
      .finally(() => {
        if (this.ticking === work) this.ticking = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async tickOnce(): Promise<CycleResult[]> {
    // Construction/startup cannot claim or reconcile business plans before acceptance.
    if (this.closed) return Promise.resolve([]);
    try {
      await this.assertTaskLaunchAllowed();
    } catch {
      return Promise.resolve([]);
    }
    await this.store.tasks.releaseScheduled();
    for (const plan of await this.store.tasks.livePlans()) {
      if (plan.timing?.mode !== 'window' || this.timingControls.has(plan.id)) continue;
      const open = taskTimingEligibility(plan.timing, Date.now(), true) === 'OPEN';
      if (
        plan.state === 'PAUSED' &&
        plan.reason === 'SCHEDULE_WINDOW_CLOSED' &&
        plan.controlConfirmed &&
        open
      ) {
        try {
          await this.store.tasks.resume(plan.id); // Only an uninterrupted controller's confirmed window pause.
        } catch (error) {
          if (!(error instanceof ProductError) || error.code !== 'TASK_RESUME_REJECTED')
            throw error;
          // An unresolved operation retains its pause without blocking other profiles.
        }
      } else if (plan.state === 'RUNNING' && !open) {
        if (
          (await this.runner.isAdvancing(plan.id)) ||
          (await this.store.tasks.blockingOperations(plan.id)).some((op) =>
            ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status),
          )
        )
          continue;
        const work = this.runtime
          .control(plan.id, 'pause', 'SCHEDULE_WINDOW_CLOSED')
          .then(() => {})
          .catch(() => {})
          .finally(() => this.timingControls.delete(plan.id));
        this.timingControls.set(plan.id, work);
      }
    }
    // Stop/disposition recovery can wait on one browser. It must not hold up the other
    // original actors; their own guards still enforce account locks and current control.
    for (const peer of this.core.peers.values()) {
      if (
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED' ||
        this.endingRecoveries.has(peer.profileId)
      )
        continue;
      const work = this.recoverEndings(peer.profileId);
      this.endingRecoveries.set(peer.profileId, work);
      void work
        .finally(() => {
          if (this.endingRecoveries.get(peer.profileId) === work)
            this.endingRecoveries.delete(peer.profileId);
        })
        .catch(() => {});
    }
    return Promise.resolve((await this.available()) ? await this.runner.poll() : []);
  }
  private async recoverEndings(profileId: string): Promise<void> {
    for (const peer of this.core.peers.values()) {
      if (peer.profileId !== profileId) continue;
      if (!peer.online || !peer.synced || peer.phase !== 'PAUSED') continue;
      await this.runtime.registry.retireReplacedOwner(peer.profileId, peer.epoch);
      if (this.runtime.registry.hasOwner(peer.profileId)) continue;
      for (const plan of await this.store.tasks.plansForProfile(peer.profileId, [
        'PAUSING',
        'STOPPING',
        'REVIEW',
      ])) {
        const scope = await this.store.tasks.stepEnding(plan.id);
        try {
          if (scope && !(await this.store.tasks.endingId(plan.id)))
            await this.store.tasks.requestStepEnd(plan.id, scope.stepId, scope.reason);
          await this.ending.end(plan.id);
        } catch {}
      }
    }
    for (const plan of await this.store.tasks.plansForProfile(profileId, ['PAUSED', 'REVIEW'])) {
      const scope = await this.store.tasks.stepEnding(plan.id);
      if (
        !scope ||
        (await this.store.tasks.endingId(plan.id)) ||
        !plan.controlConfirmed ||
        !['PAUSED', 'REVIEW'].includes(plan.state) ||
        plan.controlMode !== 'pause' ||
        this.runtime.registry.hasOwner(plan.profileId)
      )
        continue;
      try {
        await this.store.tasks.requestStepEnd(plan.id, scope.stepId, scope.reason);
      } catch {}
    }
    await this.ending.resumePending(profileId);
    if (this.closed) return;
    for (const plan of (await this.store.tasks.plansForProfile(profileId, ['REVIEW'])).filter(
      (p) => p.controlConfirmed,
    )) {
      if (!this.runtime.registry.hasOwner(plan.profileId))
        await this.ending.end(plan.id).catch(() => {});
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lastSlowRead.clear();
    this.lastBrowseInterval.clear();
    this.closing = (async () => {
      // Revoke observations and stop original owners before waiting for SDK reads.
      const results = await Promise.allSettled([
        this.runner.close(),
        this.adapters.close(),
        this.runtime.close(),
      ]);
      await Promise.allSettled(this.endingRecoveries.values());
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.closing;
  }
}
