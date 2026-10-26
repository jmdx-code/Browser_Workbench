import type { Awaitable } from '../domain/persistence.js';
import { mapAsync, findAsync } from '../shared/async-collections.js';
import type { QueuedProfileFactory } from '../domain/profile-actor.js';
import type { TaskCycleRuntime } from '../domain/browse-execution.js';
import type { RuntimeProfile, TaskRepository } from '../domain/tasks.js';
import { terminal } from '../domain/tasks.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import type { SettlementRepository } from '../domain/settlement.js';
import type { TaskControlRepository } from '../domain/task-control.js';
import type { Plan, Operation } from '../shared/task-contracts.js';
import type { Binding, ExecutionSession } from '../shared/task-execution.js';
import { ProfileActorRegistry } from './profile-actor-registry.js';
import { TaskCycleHost } from './task-cycle-host.js';
import { taskTimingEligibility } from '../domain/task-timing.js';
import type { TabProof } from '../shared/kernel-state.js';
import { MAX_CONCURRENT_STARTUPS } from '../shared/task-capacity.js';

// Composition of the original host/registry, not another scheduler. A QUEUED plan first gets
// a finite private native observation; only the original SQL claim grants the account lock.
// Its managed page is then opened and attached once, before the original runner may dispatch.
export class AdmittedTaskRuntime implements TaskCycleRuntime {
  readonly registry: ProfileActorRegistry;
  private readonly host: TaskCycleHost;
  private readonly opening = new Map<string, Promise<TabProof | void>>();
  private readonly openingControls = new Map<string, string>();
  private startupCount = 0;
  private deferredStartups = 0;
  private closed = false;
  constructor(
    private readonly tasks: TaskRepository,
    tabs: TaskTabRepository,
    settlements: SettlementRepository,
    private readonly controls: TaskControlRepository,
    private readonly factory: QueuedProfileFactory,
    private readonly inventory: () => Awaitable<RuntimeProfile[]>,
    private readonly id: () => string,
    private readonly profileInventory?: (
      profileId: string,
    ) => Awaitable<RuntimeProfile | undefined>,
  ) {
    this.registry = new ProfileActorRegistry(
      async () => await this.profiles(),
      tasks,
      settlements,
      controls,
      tabs,
      id,
      async (profileId) => await this.profile(profileId),
    );
    this.host = new TaskCycleHost(this.registry, tabs, {
      currentTaskTab: (plan, context) => this.registry.currentTaskTab(plan, context),
    });
  }
  supportsControlRelease(profileId: string) {
    return this.factory.supportsControlRelease?.(profileId) ?? false;
  }
  hasActiveExecution(): boolean {
    return this.opening.size > 0 || this.startupCount > 0 || this.registry.hasOwners();
  }
  hasOwner(profileId: string) {
    return this.registry.hasOwner(profileId);
  }
  async profiles() {
    return await mapAsync(await this.inventory(), async (raw) => {
      const privateProfile =
        (await this.registry.ownedProfile(raw.id)) ?? (await this.factory.profile(raw.id));
      // The full inventory is retained, including offline/unknown profiles. Private identity
      // cannot resurrect an unhealthy transport or replace its profile identifier.
      const profile =
        privateProfile && raw.online && raw.synced && !raw.unresolved
          ? { ...privateProfile, id: raw.id }
          : { ...raw, dispatchAllowed: false };
      const openingPlan =
        this.opening.has(raw.id) && !this.registry.hasOwner(raw.id)
          ? await findAsync(
              await this.tasks.plansForProfile(raw.id, ['RUNNING']),
              async (plan) =>
                (
                  (await this.tasks.blockingOperations?.(plan.id)) ??
                  (await this.tasks.operations(plan.id))
                ).length === 0,
            )
          : undefined;
      return openingPlan ? { ...profile, openingPlanId: openingPlan.id } : profile;
    });
  }
  async profile(profileId: string) {
    if (!this.profileInventory) return (await this.profiles()).find((row) => row.id === profileId);
    const raw = await this.profileInventory(profileId);
    if (!raw || raw.id !== profileId) return undefined;
    const current =
      (await this.registry.ownedProfile(profileId)) ?? (await this.factory.profile(profileId));
    return current && raw.online && raw.synced && !raw.unresolved
      ? { ...current, id: raw.id }
      : { ...raw, dispatchAllowed: false };
  }
  async schedulingProfiles() {
    const original = await this.host.schedulingProfiles();
    const liveByProfile = new Map<string, Plan[]>();
    for (const plan of await this.tasks.livePlans()) {
      if (terminal(plan.state)) continue;
      const list = liveByProfile.get(plan.profileId);
      if (list) list.push(plan);
      else liveByProfile.set(plan.profileId, [plan]);
    }
    return await mapAsync(original, async (profile) => {
      if (this.registry.hasOwner(profile.id)) return profile;
      const plans = liveByProfile.get(profile.id) ?? [];
      const queued = plans.length === 1 && plans[0]?.state === 'QUEUED';
      const admission = queued ? await this.factory.profile(profile.id) : null;
      return {
        ...profile,
        dispatchAllowed:
          !this.closed &&
          !!admission?.dispatchAllowed &&
          profile.online &&
          profile.synced &&
          !profile.unresolved,
      };
    });
  }
  async session(profileId: string) {
    return await this.host.session(profileId);
  }
  send(operation: Operation & { binding: Binding }) {
    return this.host.send(operation);
  }
  observe(profileId: string): Promise<TabProof | void> {
    if (this.closed) return Promise.reject(Error('TASK_RUNTIME_CLOSED'));
    const pending = this.opening.get(profileId);
    if (pending) return pending;
    const startup = !this.registry.hasOwner(profileId);
    if (startup && this.startupCount >= MAX_CONCURRENT_STARTUPS) {
      this.deferredStartups++;
      return Promise.reject(Error('CONCURRENCY_LIMIT')); // Original runner keeps it QUEUED; no owner or timer is created.
    }
    if (startup) this.startupCount++;
    const work = this.observeOnce(profileId);
    this.opening.set(profileId, work);
    void work
      .finally(() => {
        if (startup) this.startupCount--;
        if (this.opening.get(profileId) === work) this.opening.delete(profileId);
      })
      .catch(() => {});
    return work;
  }
  startupStatus() {
    return {
      active: this.startupCount,
      limit: MAX_CONCURRENT_STARTUPS,
      deferred: this.deferredStartups,
    };
  }
  private readonly queuedAdmissions = new Set<string>();
  private async observeOnce(profileId: string) {
    if (this.registry.hasOwner(profileId)) {
      return this.host.observe(profileId);
    }
    const plans = await this.tasks.plansForProfile(profileId, [
      'QUEUED',
      'RUNNING',
      'PAUSING',
      'PAUSED',
      'STOPPING',
      'REVIEW',
    ]);
    if (plans.length !== 1 || !plans[0]) throw Error('TASK_SINGLE_ORIGINAL_PLAN_REQUIRED');
    const plan = plans[0];
    if (plan.state === 'QUEUED') {
      if (taskTimingEligibility(plan.timing, Date.now(), plan.timingReleased === true) !== 'OPEN')
        return;
      // Admission opens a real inspection page. Apply the existing budget before that IO,
      // rather than inspecting every queued profile and only limiting the later SQL claim.
      // This is an in-flight guard; the original SQL claim remains the account/slot authority.
      const all = await this.tasks.livePlans();
      const active = all.filter(
        (row) =>
          ['RUNNING', 'PAUSING', 'STOPPING'].includes(row.state) ||
          (row.state === 'REVIEW' && !row.controlConfirmed),
      ).length;
      const limit = (await this.tasks.settings()).maxConcurrentProfiles;
      if (active + this.queuedAdmissions.size >= limit) throw Error('CONCURRENCY_LIMIT');
      this.queuedAdmissions.add(profileId);
      try {
        await this.factory.observeQueued(plan.id);
      } finally {
        this.queuedAdmissions.delete(profileId);
      }
      return;
    }
    if (plan.state !== 'RUNNING') throw Error('TASK_EXPLICIT_RECOVERY_REQUIRED');
    let port;
    try {
      port = await this.factory.openClaimed(plan.id);
    } catch (error) {
      await this.factory.forget(profileId);
      if (plan.accountId)
        await this.tasks.reviewFailedAdmission(
          plan.id,
          plan.accountId,
          error instanceof Error ? (error.message.split('\n')[0] ?? 'UNKNOWN') : 'UNKNOWN',
        );
      throw error;
    }
    try {
      if (this.closed || (await this.tasks.get(plan.id)).state !== 'RUNNING')
        throw Error('TASK_RUNTIME_OPEN_REVOKED');
      await this.registry.attach(port);
    } catch (error) {
      const context = await port.current();
      if (!context) throw Error('TASK_RUNTIME_FAILED_OPEN_STOP_REQUIRED');
      const cancelled = await this.tasks.get(plan.id);
      if (
        cancelled.controlRequestId &&
        cancelled.controlMode &&
        ['PAUSING', 'STOPPING'].includes(cancelled.state) &&
        this.openingControls.get(plan.id) === cancelled.controlRequestId
      ) {
        // This explicit control arrived while opening. Bind its actual returned owner,
        // then confirm only that owner's matching native receipt; never invent a receipt
        // for an opening which rejected before returning a session.
        const binding = {
          ...context,
          requestId: cancelled.controlRequestId,
          jobId: plan.id,
          mode: cancelled.controlMode,
        };
        await this.controls.bind(binding);
        await this.controls.confirm(
          binding,
          await port.stop({ ...context, requestId: binding.requestId }),
        );
      } else await port.stop({ ...context, requestId: this.id() });
      throw error;
    }
    await this.factory.forget(profileId);
    return this.host.observe(profileId);
  }
  preparePlan(plan: Plan, context: ExecutionSession, observedProof?: TabProof) {
    return this.host.preparePlan(plan, context, observedProof);
  }
  async control(jobId: string, mode: 'pause' | 'stop', reason?: string) {
    const result = await this.host.control(jobId, mode, reason);
    await this.factory.forget(result.profileId);
    return result;
  }
  async controlFromUser(jobId: string, mode: 'pause' | 'stop', reason?: string) {
    const plan = await this.tasks.get(jobId);
    const opening = this.opening.get(plan.profileId);
    if (opening && !this.registry.hasOwner(plan.profileId)) {
      // Withdraw admission synchronously. Let that same opening release its native owner
      // before a caller attempts a separate summary/ending session on this profile.
      const requested = await this.tasks.requestControl(jobId, mode, reason);
      if (requested.controlRequestId) this.openingControls.set(jobId, requested.controlRequestId);
      try {
        await opening.catch(() => {});
        await this.factory.forget(plan.profileId);
        const current = await this.tasks.get(jobId);
        if (current.controlConfirmed || terminal(current.state) || current.state === 'PAUSED')
          return current;
      } finally {
        this.openingControls.delete(jobId);
      }
    }
    const result = await this.registry.controlFromUser(jobId, mode, reason);
    await this.factory.forget(result.profileId);
    return result;
  }
  detach(profileId: string, expected: ExecutionSession, reason: string) {
    return this.host.detach(profileId, expected, reason);
  }
  async close() {
    this.closed = true;
    await this.factory.close();
    await Promise.allSettled([...this.opening.values()]);
    await this.registry.close();
  }
}
