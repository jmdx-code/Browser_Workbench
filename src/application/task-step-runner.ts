import { everyAsync } from '../shared/async-collections.js';
import type { Awaitable } from '../domain/persistence.js';
import type { TaskRepository } from '../domain/tasks.js';
import { stepComplete, terminal, FRIENDS_EXHAUSTED_CURSOR } from '../domain/tasks.js';
import { postFailureRequiresEnding } from '../domain/step-failure-policy.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type {
  BrowseIntentRepository,
  BrowseStepExecutor,
  ExecutionClock,
  TaskCycleRuntime,
} from '../domain/browse-execution.js';
import {
  effectiveBrowseMilliseconds,
  verifiedBrowseProgress,
  type TimedBrowseReading,
} from '../domain/browse-policy.js';
import {
  BrowseDecision,
  BrowseVerdict,
  BrowseReadTimeout,
  BrowsePendingDiagnostic,
} from '../shared/browse-execution.js';
import {
  sameBinding,
  sameExecution,
  type ExecutionSession,
  type Binding,
} from '../shared/task-execution.js';
import {
  facebookBrowseSurface,
  FACEBOOK_REEL_NEXT_CSS,
  FACEBOOK_FRIEND_CONFIRM_CSS,
  FACEBOOK_BROWSE_LIKE_CSS,
} from '../shared/facebook-browse-route.js';
import type { Plan, StepInstance } from '../shared/task-contracts.js';
import type { TabProof } from '../shared/kernel-state.js';
import type { Step } from '../shared/contracts.js';
import { TaskDispatcher } from './task-dispatcher.js';
import type { PostStepAdapter } from '../domain/post-execution.js';
import { PostDecision, PostVerdict } from '../shared/post-execution.js';
import { MaterialPostIntent } from '../shared/material-index.js';
import { taskAdmissionIssue } from '../shared/task-admission-issues.js';
import { taskTimingEligibility } from '../domain/task-timing.js';
import { devDiag } from '../shared/dev-diagnostics.js';

export type CycleResult = { jobId: string; profileId: string; status: string; reason: string };
export type BrowseIntervalDiagnostic = {
  phase: 'observe' | 'verification';
  stepId: string;
  profileId: string;
  jobId: string;
  type: 'feed' | 'video' | 'marketplace' | 'friends';
  readMilliseconds: number;
  previousReadMilliseconds: number | null;
  gapMilliseconds: number | null;
  creditedMilliseconds: number;
  visible: boolean | null;
  ready: boolean | null;
};
export class TaskStepRunner {
  private readonly active = new Map<string, { jobId: string; work: Promise<CycleResult> }>();
  private readonly advancingJobs = new Map<string, Promise<CycleResult>>();
  private scheduling?: Promise<Promise<CycleResult>[]>;
  private readonly samples = new Map<string, TimedBrowseReading>();
  private readonly postWaits = new Map<string, number>();
  private readonly browseWaits = new Map<
    string,
    {
      binding: Binding;
      at: number;
      elapsed: number;
      foreground: boolean;
      foregroundElapsed: number;
    }
  >();
  private readonly executors: ReadonlyMap<
    'video' | 'feed' | 'marketplace' | 'friends',
    BrowseStepExecutor
  >;
  private readonly dispatcher: TaskDispatcher;
  private readonly cycles = new Map<string, Promise<CycleResult>>();
  private completedCycles: CycleResult[] = [];
  private closed = false;
  constructor(
    private readonly tasks: TaskRepository,
    private readonly intents: BrowseIntentRepository,
    private readonly tabs: TaskTabRepository,
    private readonly runtime: TaskCycleRuntime,
    executors: readonly BrowseStepExecutor[],
    private readonly clock: ExecutionClock,
    private readonly id: () => string,
    private readonly post?: PostStepAdapter,
    private readonly executionAllowed: (plan: Plan) => Awaitable<boolean> = () => true,
    private readonly onBrowseInterval?: (sample: BrowseIntervalDiagnostic) => void,
  ) {
    this.executors = new Map(executors.map((executor) => [executor.type, executor]));
    if (this.executors.size !== executors.length) throw Error('DUPLICATE_STEP_EXECUTOR');
    this.dispatcher = new TaskDispatcher(tasks, runtime);
  }
  private async supported() {
    const result = new Set<Step['type']>(
      [...this.executors.values()].filter((e) => e.available()).map((e) => e.type),
    );
    if (await this.post?.executor.available()) result.add('post');
    return result;
  }
  private result(plan: Plan, status: string, reason = ''): CycleResult {
    return { jobId: plan.id, profileId: plan.profileId, status, reason };
  }
  async tick(): Promise<CycleResult[]> {
    const results = await Promise.all(await this.schedule());
    const delivered = new Set(results);
    this.completedCycles = this.completedCycles.filter((result) => !delivered.has(result));
    return results;
  }
  // The product heartbeat collects completed cycles without waiting for the slowest actor.
  // Each profile still uses the original advance/dispatcher/SQL claim and one in-flight cycle.
  async poll(): Promise<CycleResult[]> {
    await this.schedule();
    const completed = this.completedCycles;
    this.completedCycles = [];
    return completed;
  }
  async close() {
    this.closed = true;
    if (this.scheduling) await this.scheduling.catch(() => []);
    await Promise.allSettled(this.advancingJobs.values());
    await Promise.allSettled([
      ...this.cycles.values(),
      ...[...this.active.values()].map((row) => row.work),
    ]);
    this.samples.clear();
    this.postWaits.clear();
    this.browseWaits.clear();
    this.completedCycles = [];
  }
  private schedule(): Promise<Promise<CycleResult>[]> {
    if (this.scheduling) return this.scheduling;
    const work = this.scheduleOnce();
    this.scheduling = work;
    void work
      .finally(() => {
        if (this.scheduling === work) this.scheduling = undefined;
      })
      .catch(() => {});
    return work;
  }
  private async scheduleOnce(): Promise<Promise<CycleResult>[]> {
    if (this.closed) return [];
    await this.tasks.reconcileRuntime(await this.runtime.profiles());
    const plans = await this.tasks.livePlans();
    if (this.closed) return [];
    return plans
      .filter(
        (p) =>
          ['RUNNING', 'QUEUED', 'PAUSING', 'STOPPING'].includes(p.state) ||
          (p.state === 'REVIEW' &&
            !p.controlConfirmed &&
            !p.reason.startsWith('INITIAL_SESSION_FAILED:')),
      )
      .map((plan) => {
        const previous = this.cycles.get(plan.profileId);
        if (previous) return previous;
        const work = this.cycle(plan).catch(async (error) =>
          this.result(await this.tasks.get(plan.id), 'CYCLE_FAILED', this.reason(error)),
        );
        this.cycles.set(plan.profileId, work);
        void work.then((result) => {
          if (this.cycles.get(plan.profileId) === work) this.cycles.delete(plan.profileId);
          if (!this.closed) this.completedCycles.push(result);
        });
        return work;
      });
  }
  private async cycle(plan: Plan): Promise<CycleResult> {
    if (this.closed) return this.result(plan, 'WAITING', 'STEP_RUNNER_CLOSED');
    if (plan.state !== 'RUNNING' && plan.state !== 'QUEUED') {
      try {
        const next = await this.runtime.control(plan.id, plan.controlMode ?? 'pause', plan.reason);
        return this.result(next, 'CONTROL_CONFIRMED');
      } catch (error) {
        return this.result(
          await this.tasks.get(plan.id),
          'CONTROL_UNCONFIRMED',
          this.reason(error),
        );
      }
    }
    if (plan.state === 'RUNNING') return this.advance(plan.id);
    if (!(await this.executionAllowed(plan)))
      return this.result(plan, 'WAITING', 'EXECUTOR_REQUIRED');
    if (
      !(await everyAsync(plan.snapshot.steps, async (step) =>
        (await this.supported()).has(step.type),
      ))
    )
      return this.result(plan, 'WAITING', 'EXECUTOR_REQUIRED');
    const observeStartedAt = Date.now();
    try {
      await this.runtime.observe(plan.profileId);
      if (this.closed)
        return this.result(await this.tasks.get(plan.id), 'WAITING', 'STEP_RUNNER_CLOSED');
      const claimed = await this.tasks.claimNext(
        await this.runtime.schedulingProfiles(),
        await this.supported(),
        {
          resourceTables:
            this.post !== undefined &&
            (await this.post.executor.available()) === true &&
            this.post.resourceTablesAvailable?.() === true,
          profileId: plan.profileId,
        },
      );
      if (claimed) {
        devDiag.clearWait(`queued:${plan.id}`);
        devDiag.record({
          level: 'INFO',
          category: 'TASK_RUNNER',
          event: 'TASK_CLAIMED_RUNNING',
          profileId: claimed.profileId,
          planId: claimed.id,
          durationMs: Date.now() - observeStartedAt,
          data: {
            combinationName: claimed.snapshot.name,
            round: claimed.round,
            position: claimed.position,
          },
        });
        return await this.advance(claimed.id);
      }
      const latestPlan = await this.tasks.get(plan.id);
      const schedProfile = (await this.runtime.schedulingProfiles()).find(
        (p) => p.id === plan.profileId,
      );
      devDiag.recordWait(
        `queued:${plan.id}`,
        {
          level: 'WAIT',
          category: 'TASK_RUNNER',
          event: 'TASK_QUEUED_NOT_CLAIMED',
          profileId: plan.profileId,
          planId: plan.id,
          reason: latestPlan.reason || 'SCHEDULER_CONCURRENCY_OR_ELIGIBILITY',
          data: {
            online: schedProfile?.online ?? false,
            synced: schedProfile?.synced ?? false,
            unresolved: schedProfile?.unresolved ?? -1,
            dispatchAllowed: schedProfile?.dispatchAllowed ?? false,
            accountState: schedProfile?.account.state ?? 'unknown',
          },
        },
        10_000,
      );
      return this.result(latestPlan, 'WAITING');
    } catch (error) {
      const reason = this.reason(error);
      // A completed admission read failure needs user attention, not another automatic
      // inspection page on every tick. Keep the original plan and native evidence; this
      // does not certify page cleanup or settle any browser operation.
      if (
        (await this.tasks.get(plan.id)).state === 'QUEUED' &&
        taskAdmissionIssue(reason)?.disposition === 'pause'
      ) {
        devDiag.record({
          level: 'WARN',
          category: 'TASK_RUNNER',
          event: 'TASK_ADMISSION_PAUSED',
          profileId: plan.profileId,
          planId: plan.id,
          reason,
          durationMs: Date.now() - observeStartedAt,
        });
        const next = await this.runtime.control(plan.id, 'pause', reason);
        return this.result(next, 'ADMISSION_PAUSED', reason);
      }
      devDiag.recordWait(
        `queued:${plan.id}`,
        {
          level: 'WARN',
          category: 'TASK_RUNNER',
          event: 'TASK_ADMISSION_WAIT',
          profileId: plan.profileId,
          planId: plan.id,
          reason,
          durationMs: Date.now() - observeStartedAt,
        },
        8_000,
      );
      await this.tasks.noteQueuedWait?.(plan.id, reason);
      return this.result(await this.tasks.get(plan.id), 'WAITING', reason);
    }
  }
  advance(jobId: string): Promise<CycleResult> {
    if (this.closed)
      return Promise.resolve(this.tasks.get(jobId)).then((plan) =>
        this.result(plan, 'WAITING', 'STEP_RUNNER_CLOSED'),
      );
    const previous = this.advancingJobs.get(jobId);
    if (previous) return previous;
    if (this.advancingJobs.size >= 256) return Promise.reject(Error('STEP_RUNNER_QUEUE_FULL'));
    const work = this.advanceOwned(jobId);
    this.advancingJobs.set(jobId, work);
    void work
      .finally(() => {
        if (this.advancingJobs.get(jobId) === work) this.advancingJobs.delete(jobId);
      })
      .catch(() => {});
    return work;
  }
  private async advanceOwned(jobId: string): Promise<CycleResult> {
    const plan = await this.tasks.get(jobId),
      old = this.active.get(plan.profileId);
    if (this.closed) return Promise.resolve(this.result(plan, 'WAITING', 'STEP_RUNNER_CLOSED'));
    if (old) {
      if (old.jobId !== jobId) return Promise.reject(Error('PROFILE_STEP_RUNNER_BUSY'));
      return old.work;
    }
    const work = this.advanceOnce(jobId);
    this.active.set(plan.profileId, { jobId, work });
    void work
      .finally(() => {
        if (this.active.get(plan.profileId)?.work === work) this.active.delete(plan.profileId);
      })
      .catch(() => {});
    return work;
  }
  async isAdvancing(jobId: string) {
    const profileId = (await this.tasks.get(jobId)).profileId;
    return this.cycles.has(profileId) || this.active.has(profileId);
  }
  private windowClosed(plan: Plan) {
    return (
      plan.timing?.mode === 'window' &&
      taskTimingEligibility(plan.timing, Date.now(), true) !== 'OPEN'
    );
  }
  private async waitForWindow(plan: Plan) {
    this.samples.delete(plan.profileId);
    await this.tasks.noteRunningWait?.(plan.id, 'SCHEDULE_WINDOW_CLOSED');
    return this.result(await this.tasks.get(plan.id), 'WAITING', 'SCHEDULE_WINDOW_CLOSED');
  }
  private reason(error: unknown) {
    if (!(error instanceof Error)) return 'STEP_EXECUTION_FAILED';
    const trimmed = error.message.trimStart();
    if (error.name === 'ZodError' || trimmed.startsWith('[')) {
      if (trimmed.includes('FACEBOOK_BROWSE_ROUTE_REQUIRED'))
        return 'FACEBOOK_BROWSE_ROUTE_REQUIRED';
      return 'FACEBOOK_IDENTITY_UNCONFIRMED';
    }
    return error.message.slice(0, 200);
  }
  private async step(plan: Plan): Promise<StepInstance> {
    const step = (await this.tasks.steps(plan.id, plan.round)).find(
      (row) => row.position === plan.position,
    );
    if (!step || step.status !== 'ACTIVE') throw Error('ACTIVE_STEP_REQUIRED');
    return step;
  }
  private guard(plan: Plan, step: StepInstance, session: ExecutionSession): () => Awaitable<void> {
    return async () => {
      const current = await this.runtime.session(plan.profileId),
        fresh = await this.tasks.get(plan.id);
      const profile = this.runtime.profile
        ? await this.runtime.profile(plan.profileId)
        : (await this.runtime.profiles()).find((row) => row.id === plan.profileId);
      const currentStep = await this.step(fresh);
      if (
        this.closed ||
        !(await this.executionAllowed(fresh)) ||
        fresh.state !== 'RUNNING' ||
        fresh.accountId !== session.accountId ||
        fresh.round !== plan.round ||
        fresh.position !== plan.position ||
        currentStep.id !== step.id ||
        currentStep.progress.revision !== step.progress.revision ||
        !current ||
        !sameExecution(current, session) ||
        !profile?.online ||
        !profile.synced ||
        profile.unresolved ||
        !profile.dispatchAllowed ||
        profile.account.state !== 'logged-in' ||
        profile.account.id !== session.accountId
      )
        throw Error('STEP_EXECUTION_CONTEXT_CHANGED');
    };
  }
  private async proof(plan: Plan, context: ExecutionSession, proof: TabProof) {
    if (
      !(await this.tabs.forPlan(plan.id)).some(
        (row) =>
          row.state === 'READY' &&
          row.context &&
          sameExecution(row.context, context) &&
          sameTabProof(row.proof, proof),
      )
    )
      throw Error('STEP_OWNED_TAB_REQUIRED');
  }
  private async advanceOnce(jobId: string): Promise<CycleResult> {
    let plan = await this.tasks.get(jobId);
    let observedScope:
      | { stepId: string; session: ExecutionSession; assertCurrent: () => Awaitable<void> }
      | undefined;
    if (plan.state !== 'RUNNING') {
      this.samples.delete(plan.profileId);
      this.clearBrowseWaits(plan.profileId);
      return this.result(plan, 'WAITING', plan.reason);
    }
    try {
      // Finish independent verification of dispatched work, but never begin another
      // input/read budget after the window closes. The runtime pauses at this checkpoint.
      if (
        this.windowClosed(plan) &&
        !(
          (await this.tasks.blockingOperations?.(plan.id)) ?? (await this.tasks.operations(plan.id))
        ).some((op) => ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status))
      )
        return await this.waitForWindow(plan);
      if (!(await this.executionAllowed(plan))) throw Error('EXECUTOR_REQUIRED');
      if (
        !(await everyAsync(plan.snapshot.steps, async (step) =>
          (await this.supported()).has(step.type),
        ))
      )
        throw Error('EXECUTOR_REQUIRED');
      let observedProof: TabProof | void;
      try {
        observedProof = await this.runtime.observe(plan.profileId);
      } catch (error) {
        // Admission and opening the claimed actor share the bounded startup
        // pool. A claimed RUNNING plan can briefly have no startup slot; this
        // is backpressure before dispatch, not a failed browser operation.
        if (this.reason(error) !== 'CONCURRENCY_LIMIT') throw error;
        const waiting = await this.tasks.get(jobId);
        if (waiting.state === 'RUNNING')
          await this.tasks.noteRunningWait?.(jobId, 'CONCURRENCY_LIMIT');
        return this.result(await this.tasks.get(jobId), 'WAITING', 'CONCURRENCY_LIMIT');
      }
      plan = await this.tasks.get(jobId);
      if (plan.state !== 'RUNNING') return this.result(plan, 'WAITING', plan.reason);
      const step = await this.step(plan),
        session = await this.runtime.session(plan.profileId);
      if (!session) {
        this.samples.delete(plan.profileId);
        return this.result(plan, 'WAITING', 'ACTOR_BACKPRESSURE');
      }
      const assertCurrent = this.guard(plan, step, session);
      await assertCurrent();
      observedScope = { stepId: step.id, session, assertCurrent };
      await this.runtime.preparePlan(plan, session, observedProof || undefined);
      await assertCurrent();
      if (step.spec.type === 'post') {
        this.samples.delete(plan.profileId);
        return await this.advancePost(plan, step, session, assertCurrent);
      }
      const executor = this.executors.get(step.spec.type);
      if (!executor?.available()) throw Error('EXECUTOR_REQUIRED');
      const pending = (
        (await this.tasks.blockingOperations?.(plan.id)) ?? (await this.tasks.operations(plan.id))
      ).find((op) => ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status));
      this.clearBrowseWaits(plan.profileId, pending?.id);
      if (pending) {
        this.samples.delete(plan.profileId);
        if (pending.stepId !== step.id) throw Error('OPERATION_STEP_MISMATCH');
        if (pending.status === 'PREPARED') {
          if (this.windowClosed(plan)) return await this.waitForWindow(plan);
          await this.intents.get(pending.id); // Legacy/unknown intent cannot be promoted to business work.
          await this.dispatcher.flushOne(plan.profileId);
          return this.result(await this.tasks.get(plan.id), 'DISPATCHED');
        }
        if (pending.status !== 'ACKNOWLEDGED' || !pending.binding)
          return this.result(plan, 'WAITING', 'OPERATION_UNRESOLVED');
        const intent = (await this.intents.get(pending.id)).intent,
          binding = pending.binding;
        const resumableBrowseTimeout =
          intent.kind === 'like' ||
          (intent.kind === 'auxiliary' &&
            (['activateTab', 'browsePlay', 'browseNavigate'].includes(pending.action.kind) ||
              (pending.action.kind === 'click' &&
                pending.action.target.css === FACEBOOK_REEL_NEXT_CSS &&
                pending.action.target.scope === undefined &&
                pending.action.target.text === undefined)));
        const dispatchReceipt = pending.receipt;
        const dispatchEvidence =
          dispatchReceipt && typeof dispatchReceipt === 'object' && !Array.isArray(dispatchReceipt)
            ? dispatchReceipt.evidence
            : undefined;
        if (
          dispatchEvidence &&
          typeof dispatchEvidence === 'object' &&
          'resultCode' in dispatchEvidence &&
          dispatchEvidence.resultCode === 'TARGET_UNAVAILABLE_BEFORE_INPUT'
        ) {
          await this.dispatcher.verify({ binding, evidence: dispatchEvidence }, 'NOT_APPLIED');
          await this.tasks.noteRunningWait?.(plan.id, 'TARGET_UNAVAILABLE_BEFORE_INPUT');
          return this.result(
            await this.tasks.get(plan.id),
            'WAITING',
            'TARGET_UNAVAILABLE_BEFORE_INPUT',
          );
        }
        const verificationStartedAt = this.clock.nowMilliseconds();
        const verdict = BrowseVerdict.parse(
          await executor.verify(
            { plan, step, session },
            { ...pending, binding },
            intent,
            assertCurrent,
          ),
        );
        const verificationFinishedAt = this.clock.nowMilliseconds();
        await assertCurrent();
        try {
          this.onBrowseInterval?.({
            phase: 'verification',
            stepId: step.id,
            profileId: plan.profileId,
            jobId: plan.id,
            type: step.spec.type,
            readMilliseconds: verificationFinishedAt - verificationStartedAt,
            previousReadMilliseconds: null,
            gapMilliseconds: null,
            creditedMilliseconds: 0,
            visible: verdict.outcome === 'VERIFIED' ? (verdict.observation?.visible ?? null) : null,
            ready: verdict.outcome === 'VERIFIED' ? (verdict.observation?.ready ?? null) : null,
          });
        } catch {
          // Diagnostics do not settle an operation or grant browsing progress.
        }
        if (!sameBinding(binding, verdict.receipt.binding))
          throw Error('BUSINESS_VERDICT_BINDING_MISMATCH');
        if (verdict.outcome === 'WAIT') {
          const evidence = verdict.receipt.evidence;
          const diagnostic = BrowsePendingDiagnostic.safeParse(
            evidence &&
              typeof evidence === 'object' &&
              !Array.isArray(evidence) &&
              'pending' in evidence
              ? evidence.pending
              : null,
          );
          const foreground =
            verdict.reason === 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' &&
            diagnostic.success &&
            diagnostic.data.ready &&
            !diagnostic.data.blocked &&
            !diagnostic.data.visible &&
            facebookBrowseSurface(diagnostic.data.url) === step.spec.type &&
            ((intent.kind === 'auxiliary' &&
              (pending.action.kind === 'activateTab' ||
                (step.spec.type === 'video' &&
                  intent.purpose === 'advance' &&
                  pending.action.kind === 'click' &&
                  pending.action.target.css === FACEBOOK_REEL_NEXT_CSS &&
                  pending.action.target.scope === undefined &&
                  pending.action.target.text === undefined) ||
                (step.spec.type === 'friends' &&
                  step.spec.maxLikes === 0 &&
                  intent.purpose === 'acceptFriend' &&
                  pending.action.kind === 'click' &&
                  pending.action.target.css === FACEBOOK_FRIEND_CONFIRM_CSS &&
                  pending.action.target.scope === undefined &&
                  pending.action.target.text === undefined) ||
                ((pending.action.kind === 'browseScroll' || pending.action.kind === 'browsePlay') &&
                  diagnostic.data.url === pending.action.url &&
                  diagnostic.data.timeOrigin === pending.action.timeOrigin))) ||
              (intent.kind === 'like' &&
                (step.spec.type === 'feed' || step.spec.type === 'video') &&
                pending.action.kind === 'click' &&
                pending.action.target.css === FACEBOOK_BROWSE_LIKE_CSS &&
                pending.action.target.scope === undefined &&
                pending.action.target.text === undefined));
          const at = this.clock.nowMilliseconds();
          const previous = this.browseWaits.get(pending.id);
          if (
            !Number.isFinite(at) ||
            at < 0 ||
            (previous && (at < previous.at || !sameBinding(previous.binding, binding)))
          )
            throw Error('BROWSE_VERIFICATION_CLOCK_OR_BINDING_CHANGED');
          const elapsed = previous
            ? previous.elapsed + (previous.foreground || foreground ? 0 : at - previous.at)
            : foreground
              ? 0
              : Math.max(0, Date.now() - pending.updatedAt);
          const foregroundElapsed = foreground
            ? (previous?.foregroundElapsed ?? 0) + (previous?.foreground ? at - previous.at : 0)
            : 0;
          this.browseWaits.set(pending.id, {
            binding: structuredClone(binding),
            at,
            elapsed,
            foreground,
            foregroundElapsed,
          });
          if (
            foreground ||
            (await this.tasks.get(plan.id)).reason === 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED'
          )
            await this.tasks.noteRunningWait?.(
              plan.id,
              foreground ? 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED' : '',
            );
          if (foreground ? foregroundElapsed < 30_000 : elapsed < 30_000) {
            devDiag.recordWait(
              `verify:${pending.id}`,
              {
                level: 'WAIT',
                category: 'TASK_RUNNER',
                event: 'BROWSE_VERIFY_WAIT',
                profileId: plan.profileId,
                planId: plan.id,
                stepId: step.id,
                stepType: step.spec.type,
                operationId: pending.id,
                actionKind: pending.action.kind,
                reason: verdict.reason,
                data: {
                  elapsedMs: Math.round(foreground ? foregroundElapsed : elapsed),
                  foreground,
                  pendingDiagnostic: diagnostic.success ? diagnostic.data : null,
                },
              },
              6_000,
            );
            return this.result(await this.tasks.get(plan.id), 'WAITING', verdict.reason);
          }
          this.browseWaits.delete(pending.id);
          devDiag.clearWait(`verify:${pending.id}`);
          const timeoutReason = foreground
            ? 'FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT'
            : 'BROWSE_EFFECT_TIMEOUT';
          devDiag.record({
            level: 'ERROR',
            category: 'TASK_RUNNER',
            event: 'BROWSE_EFFECT_TIMEOUT',
            profileId: plan.profileId,
            planId: plan.id,
            stepId: step.id,
            stepType: step.spec.type,
            operationId: pending.id,
            actionKind: pending.action.kind,
            reason: verdict.reason,
            data: {
              elapsedMs: Math.round(foreground ? foregroundElapsed : elapsed),
              pendingDiagnostic: diagnostic.success ? diagnostic.data : null,
            },
          });
          if (
            pending.action.kind === 'browseScroll' &&
            intent.kind === 'auxiliary' &&
            this.tasks.releaseBrowseControl &&
            this.runtime.supportsControlRelease?.(plan.profileId)
          ) {
            await this.tasks.releaseBrowseControl({
              ...verdict.receipt,
              evidence: {
                observed: verdict.receipt.evidence,
                reason: timeoutReason,
                scrollEffectConfirmed: false,
                creditedMilliseconds: 0,
              },
            });
            this.samples.delete(plan.profileId);
            await this.tasks.noteRunningWait?.(plan.id, verdict.reason);
            return this.result(await this.tasks.get(plan.id), 'WAITING', verdict.reason);
          }
          if (resumableBrowseTimeout) {
            await this.dispatcher.verify(verdict.receipt, 'NOT_APPLIED');
            this.samples.delete(plan.profileId);
            await this.tasks.noteRunningWait?.(plan.id, timeoutReason);
            return this.result(await this.tasks.get(plan.id), 'WAITING', timeoutReason);
          }
          await this.tasks.markBoundUnknown(binding, timeoutReason, verdict.receipt);
          await this.runtime.control(plan.id, 'pause', timeoutReason);
          return this.result(await this.tasks.get(plan.id), 'BUSINESS_UNKNOWN', timeoutReason);
        }
        this.browseWaits.delete(pending.id);
        devDiag.clearWait(`verify:${pending.id}`);
        if (verdict.outcome === 'UNKNOWN') {
          devDiag.record({
            level: 'ERROR',
            category: 'TASK_RUNNER',
            event: 'BROWSE_VERIFY_UNKNOWN',
            profileId: plan.profileId,
            planId: plan.id,
            stepId: step.id,
            stepType: step.spec.type,
            operationId: pending.id,
            actionKind: pending.action.kind,
            reason: verdict.reason,
          });
          if (
            pending.action.kind === 'browseScroll' &&
            intent.kind === 'auxiliary' &&
            this.tasks.releaseBrowseControl &&
            this.runtime.supportsControlRelease?.(plan.profileId)
          ) {
            await this.tasks.releaseBrowseControl({
              ...verdict.receipt,
              evidence: {
                observed: verdict.receipt.evidence,
                reason: verdict.reason,
                scrollEffectConfirmed: false,
                creditedMilliseconds: 0,
              },
            });
            this.samples.delete(plan.profileId);
            return this.result(await this.tasks.get(plan.id), 'WAITING', verdict.reason);
          }
          if (
            resumableBrowseTimeout &&
            ['FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT', 'BROWSE_EFFECT_TIMEOUT'].includes(
              verdict.reason,
            )
          ) {
            await this.dispatcher.verify(verdict.receipt, 'NOT_APPLIED');
            this.samples.delete(plan.profileId);
            await this.tasks.noteRunningWait?.(plan.id, verdict.reason);
            return this.result(await this.tasks.get(plan.id), 'WAITING', verdict.reason);
          }
          await this.tasks.markBoundUnknown(binding, verdict.reason, verdict.receipt);
          await this.runtime.control(plan.id, 'pause', verdict.reason);
          return this.result(await this.tasks.get(plan.id), 'BUSINESS_UNKNOWN', verdict.reason);
        }
        await this.dispatcher.verify(
          verdict.receipt,
          verdict.outcome,
          verdict.outcome === 'VERIFIED'
            ? verifiedBrowseProgress(step, intent, verdict)
            : undefined,
        );
        if (
          verdict.outcome === 'VERIFIED' &&
          verdict.observation &&
          verdict.observation.type === step.spec.type &&
          sameTabProof(verdict.observation.proof, intent.proof)
        ) {
          // Seed only: never credit dispatch/verification time. The next independent
          // reading may measure continuous browsing from this newly verified endpoint.
          const fresh = await this.tasks.get(plan.id);
          // Business notification is pending after settlement; it is not fresh input
          // permission. Keep only a timing endpoint, then let the next cycle recheck
          // the complete actor/profile guard before it can credit or dispatch anything.
          if (
            !this.closed &&
            fresh.state === 'RUNNING' &&
            !fresh.controlMode &&
            fresh.round === plan.round &&
            fresh.position === plan.position
          )
            this.samples.set(plan.profileId, {
              reading: verdict.observation,
              context: session,
              stepId: step.id,
              startedAt: verificationStartedAt,
              finishedAt: verificationFinishedAt,
            });
        }
        return this.result(await this.tasks.get(plan.id), 'VERIFIED', verdict.outcome);
      }
      if (this.windowClosed(plan)) return await this.waitForWindow(plan);
      if (stepComplete(step.spec, step.progress)) {
        this.samples.delete(plan.profileId);
        const next = await this.tasks.completeStep(plan.id, step.id);
        devDiag.record({
          level: 'INFO',
          category: 'TASK_RUNNER',
          event: 'STEP_COMPLETED',
          profileId: plan.profileId,
          planId: plan.id,
          stepId: step.id,
          stepType: step.spec.type,
          data: {
            nextPlanState: next.state,
            effectiveMs: step.progress.effectiveMilliseconds,
          },
        });
        if (terminal(next.state))
          await this.runtime.detach(plan.profileId, session, 'TASK_COMPLETED');
        return this.result(next, 'STEP_COMPLETED');
      }
      const startedAt = this.clock.nowMilliseconds();
      const decision = BrowseDecision.parse(
        await executor.decide({ plan, step, session }, assertCurrent),
      );
      const finishedAt = this.clock.nowMilliseconds();
      await assertCurrent();
      if (this.windowClosed(plan)) return await this.waitForWindow(plan);
      if (decision.kind === 'wait') {
        this.samples.delete(plan.profileId);
        await this.tasks.noteRunningWait?.(plan.id, decision.reason);
        return this.result(plan, 'WAITING', decision.reason);
      }
      await this.tasks.noteRunningWait?.(plan.id, '');
      if (decision.kind === 'action' && !decision.observation) {
        this.samples.delete(plan.profileId);
        await this.proof(plan, session, decision.intent.proof);
        await this.intents.prepare(plan.id, step.id, this.id(), decision.action, decision.intent);
        await this.dispatcher.flushOne(plan.profileId);
        return this.result(await this.tasks.get(plan.id), 'DISPATCHED');
      }
      const reading = decision.observation;
      if (!reading) throw Error('BROWSE_OBSERVATION_REQUIRED');
      if (reading.type !== step.spec.type) throw Error('BROWSE_OBSERVATION_TYPE_MISMATCH');
      await this.proof(plan, session, reading.proof);
      if (
        !Number.isFinite(startedAt) ||
        !Number.isFinite(finishedAt) ||
        startedAt < 0 ||
        finishedAt < startedAt
      )
        throw Error('EXECUTION_CLOCK_INVALID');
      const sample: TimedBrowseReading = {
        reading,
        context: session,
        stepId: step.id,
        startedAt,
        finishedAt,
      };
      const previous = this.samples.get(plan.profileId);
      const milliseconds = Math.min(
        effectiveBrowseMilliseconds(previous, sample),
        Math.max(0, step.spec.durationMinutes * 60_000 - step.progress.effectiveMilliseconds),
      );
      try {
        this.onBrowseInterval?.({
          phase: 'observe',
          stepId: step.id,
          profileId: plan.profileId,
          jobId: plan.id,
          type: reading.type,
          readMilliseconds: finishedAt - startedAt,
          previousReadMilliseconds: previous ? previous.finishedAt - previous.startedAt : null,
          gapMilliseconds: previous ? finishedAt - previous.finishedAt : null,
          creditedMilliseconds: milliseconds,
          visible: reading.visible,
          ready: reading.ready,
        });
      } catch {
        // Diagnostics cannot change the original progress or input decision.
      }
      if (
        milliseconds > 0 ||
        (reading.type === 'friends' &&
          reading.contentId === FRIENDS_EXHAUSTED_CURSOR &&
          step.progress.cursor !== FRIENDS_EXHAUSTED_CURSOR)
      ) {
        const progress = {
          ...step.progress,
          revision: step.progress.revision + 1,
          effectiveMilliseconds: step.progress.effectiveMilliseconds + milliseconds,
          cursor: reading.contentId,
        };
        if (this.tasks.checkpointAsync)
          await this.tasks.checkpointAsync(plan.id, step.id, step.progress.revision, progress);
        else await this.tasks.checkpoint(plan.id, step.id, step.progress.revision, progress);
        step.progress = progress; // The current guard follows our acknowledged checkpoint only.
        const current = await this.tasks.get(plan.id);
        if (current.state !== 'RUNNING') {
          this.samples.delete(plan.profileId);
          return this.result(current, 'WAITING', 'CONTROL_CHANGED_AFTER_CHECKPOINT');
        }
      }
      this.samples.set(plan.profileId, sample);
      if (decision.kind === 'action') {
        this.samples.delete(plan.profileId);
        const current = await this.tasks.get(plan.id);
        const updated = (await this.tasks.steps(plan.id, current.round)).find(
          (s) => s.id === step.id,
        );
        if (current.state !== 'RUNNING' || !updated || stepComplete(updated.spec, updated.progress))
          return this.result(current, 'OBSERVED', 'BROWSE_BUDGET_OR_CONTROL_CHANGED');
        await assertCurrent();
        await this.proof(plan, session, decision.intent.proof);
        await this.intents.prepare(plan.id, step.id, this.id(), decision.action, decision.intent);
        await this.dispatcher.flushOne(plan.profileId);
        return this.result(await this.tasks.get(plan.id), 'DISPATCHED');
      }
      return this.result(
        await this.tasks.get(plan.id),
        'OBSERVED',
        milliseconds > 0 ? 'EFFECTIVE_TIME_SAVED' : 'INTERVAL_NOT_CREDITED',
      );
    } catch (error) {
      this.samples.delete(plan.profileId);
      this.clearBrowseWaits(plan.profileId);
      const current = await this.tasks.get(jobId),
        reason = this.reason(error);
      if (terminal(current.state)) return this.result(current, 'OWNER_RELEASE_UNCONFIRMED', reason);
      if (error instanceof BrowseReadTimeout && current.state === 'RUNNING' && observedScope) {
        // Diagnostic failure or revocation must not prevent the original control stop.
        try {
          await observedScope.assertCurrent();
          await this.tasks.noteBrowseReadFailure(
            jobId,
            observedScope.stepId,
            observedScope.session,
            reason,
            error.diagnostic,
          );
        } catch {}
      }
      const operation = (await this.tasks.operations(jobId)).find((op) =>
        ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status),
      );
      const failedStep = (await this.tasks.steps(jobId, current.round)).find(
        (step) => step.position === current.position,
      );
      devDiag.record({
        level: 'ERROR',
        category: 'TASK_RUNNER',
        event: 'STEP_RUNNER_ERROR',
        profileId: current.profileId,
        planId: jobId,
        stepId: failedStep?.id,
        stepType: failedStep?.spec.type,
        operationId: operation?.id,
        actionKind: operation?.action.kind,
        reason,
        data: {
          planState: current.state,
          operationStatus: operation?.status ?? null,
          browseDiagnostic: error instanceof BrowseReadTimeout ? error.diagnostic : undefined,
        },
      });
      if (
        (failedStep?.spec.type === 'post' && postFailureRequiresEnding(reason)) ||
        (failedStep?.spec.type === 'marketplace' && reason === 'FACEBOOK_MARKETPLACE_UNAVAILABLE')
      )
        await this.tasks.noteStepFailure?.(jobId, failedStep.id, reason);
      if (operation?.binding) await this.tasks.markBoundUnknown(operation.binding, reason);
      if (current.state === 'REVIEW' && current.reason.startsWith('INITIAL_SESSION_FAILED:')) {
        return this.result(current, 'PAUSED_OR_REVIEW', current.reason);
      }
      try {
        await this.runtime.control(jobId, current.controlMode ?? 'pause', reason);
      } catch (stopError) {
        return this.result(
          await this.tasks.get(jobId),
          'CONTROL_UNCONFIRMED',
          this.reason(stopError),
        );
      }
      return this.result(await this.tasks.get(jobId), 'PAUSED_OR_REVIEW', reason);
    }
  }
  private clearBrowseWaits(profileId: string, except?: string) {
    for (const [id, wait] of this.browseWaits)
      if (wait.binding.profileId === profileId && id !== except) this.browseWaits.delete(id);
  }
  private async advancePost(
    plan: Plan,
    step: StepInstance,
    session: ExecutionSession,
    assertCurrent: () => Awaitable<void>,
  ) {
    const adapter = this.post;
    if (!adapter || !(await adapter.executor.available())) throw Error('EXECUTOR_REQUIRED');
    const pending = (
      (await this.tasks.blockingOperations?.(plan.id)) ?? (await this.tasks.operations(plan.id))
    ).find((op) => ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status));
    if (pending) {
      if (pending.stepId !== step.id) throw Error('OPERATION_STEP_MISMATCH');
      const link = await adapter.posts.link(pending.id),
        held = await adapter.materials.reservation(link.attemptId),
        intent = MaterialPostIntent.parse(held.intent);
      await this.assertPostIntent(plan, step, session, intent);
      if (pending.status === 'PREPARED') {
        if (this.windowClosed(plan)) return await this.waitForWindow(plan);
        await assertCurrent();
        await this.dispatcher.flushOne(plan.profileId);
        return this.result(await this.tasks.get(plan.id), 'DISPATCHED');
      }
      // UNKNOWN is never retried or automatically promoted by the ordinary verification loop.
      if (pending.status !== 'ACKNOWLEDGED' || !pending.binding)
        return this.result(plan, 'WAITING', 'OPERATION_UNRESOLVED');
      const verdict = PostVerdict.parse(
        await adapter.executor.verify(
          { plan, step, session },
          { ...pending, binding: pending.binding },
          { intent, link },
          assertCurrent,
        ),
      );
      await assertCurrent();
      if (verdict.kind === 'wait') {
        const now = this.clock.nowMilliseconds();
        const started = this.postWaits.get(pending.id) ?? now;
        this.postWaits.set(pending.id, started);
        const limit =
          link.purpose === 'UPLOAD_MEDIA'
            ? intent.snapshot.format === 'video'
              ? 600_000
              : 120_000
            : link.purpose === 'SUBMIT'
              ? 180_000
              : 30_000;
        if (now - started < limit) {
          await this.tasks.noteRunningWait?.(plan.id, verdict.reason);
          return this.result(plan, 'WAITING', verdict.reason);
        }
        // A timeout ends this attempt through the original unknown/control path. It does
        // not imply that the input failed, release content or permit an automatic replay.
        const reason = `POST_EFFECT_TIMEOUT:${link.purpose}:${verdict.reason}`.slice(0, 200);
        this.postWaits.delete(pending.id);
        await this.tasks.noteStepFailure?.(plan.id, step.id, reason);
        await this.tasks.markBoundUnknown(pending.binding, reason);
        await this.runtime.control(plan.id, 'pause', reason);
        return this.result(await this.tasks.get(plan.id), 'BUSINESS_UNKNOWN', reason);
      }
      this.postWaits.delete(pending.id);
      if (verdict.kind === 'unknown') {
        await this.tasks.noteStepFailure?.(plan.id, step.id, verdict.reason);
        await this.tasks.markBoundUnknown(pending.binding, verdict.reason);
        await this.runtime.control(plan.id, 'pause', verdict.reason);
        return this.result(await this.tasks.get(plan.id), 'BUSINESS_UNKNOWN', verdict.reason);
      }
      if (!sameBinding(pending.binding, verdict.receipt.binding))
        throw Error('BUSINESS_VERDICT_BINDING_MISMATCH');
      await adapter.posts.verify(verdict.receipt); // Sole original business/consumption/checkpoint transaction.
      await this.tasks.noteRunningWait?.(plan.id, '');
      return this.result(
        await this.tasks.get(plan.id),
        'VERIFIED',
        verdict.receipt.evidence.outcome,
      );
    }
    if (this.windowClosed(plan)) return await this.waitForWindow(plan);
    if (stepComplete(step.spec, step.progress)) {
      const next = await this.tasks.completeStep(plan.id, step.id);
      if (terminal(next.state))
        await this.runtime.detach(plan.profileId, session, 'TASK_COMPLETED');
      return this.result(next, 'STEP_COMPLETED');
    }
    const decision = PostDecision.parse(
      await adapter.executor.decide(
        { plan, step, session },
        (await adapter.materials.forPlan(plan.id)).filter((row) => row.intent.stepId === step.id),
        assertCurrent,
      ),
    );
    await assertCurrent();
    if (this.windowClosed(plan)) return await this.waitForWindow(plan);
    if (decision.kind === 'wait') {
      await this.tasks.noteRunningWait?.(plan.id, decision.reason);
      return this.result(plan, 'WAITING', decision.reason);
    }
    if (decision.kind === 'reserve' || decision.kind === 'reserve-next') {
      const request = decision.request;
      if (
        request.jobId !== plan.id ||
        request.stepId !== step.id ||
        request.expectedProgressRevision !== step.progress.revision ||
        !sameExecution(request.context, session)
      )
        throw Error('POST_RESERVATION_EXECUTION_MISMATCH');
      await this.proof(plan, session, request.proof);
      try {
        if (decision.kind === 'reserve-next') await adapter.materials.reserveNext(decision.request);
        else await adapter.materials.reserve(decision.request);
      } catch (error) {
        if (error instanceof Error && error.message === 'MATERIAL_NO_ELIGIBLE_RESOURCE') {
          await this.tasks.noteStepFailure?.(plan.id, step.id, error.message);
          await this.runtime.control(plan.id, 'pause', error.message);
          return this.result(await this.tasks.get(plan.id), 'MATERIAL_EXHAUSTED', error.message);
        }
        throw error;
      }
      await this.tasks.noteRunningWait?.(plan.id, '');
      return this.result(await this.tasks.get(plan.id), 'MATERIAL_RESERVED');
    }
    const intent = MaterialPostIntent.parse(
      (await adapter.materials.reservation(decision.operation.attemptId)).intent,
    );
    await this.assertPostIntent(plan, step, session, intent);
    await this.proof(plan, session, intent.proof);
    await adapter.posts.prepare(decision.operation);
    await this.tasks.noteRunningWait?.(plan.id, '');
    await assertCurrent();
    await this.dispatcher.flushOne(plan.profileId);
    return this.result(await this.tasks.get(plan.id), 'DISPATCHED');
  }
  private async assertPostIntent(
    plan: Plan,
    step: StepInstance,
    session: ExecutionSession,
    intent: import('../shared/material-index.js').PostIntent,
  ) {
    if (
      intent.jobId !== plan.id ||
      intent.stepId !== step.id ||
      !sameExecution(intent.context, session) ||
      intent.ordinal !== step.progress.published + 1
    )
      throw Error('POST_INTENT_EXECUTION_MISMATCH');
    await this.proof(plan, session, intent.proof);
  }
}
