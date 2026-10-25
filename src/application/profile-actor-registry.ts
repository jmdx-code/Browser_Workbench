import type { Awaitable } from '../domain/persistence.js';
import { mapAsync } from '../shared/async-collections.js';
import type { ManagedProfileSession, GuardedBrowserPort } from '../domain/profile-actor.js';
import type { TaskRepository, RuntimeProfile } from '../domain/tasks.js';
import { terminal } from '../domain/tasks.js';
import type { TaskControlRepository } from '../domain/task-control.js';
import type { SettlementRepository } from '../domain/settlement.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type { Operation, Plan } from '../shared/task-contracts.js';
import {
  ExecutionContext,
  sameExecution,
  type ExecutionSession,
  type Binding,
} from '../shared/task-execution.js';
import {
  SessionStopBinding,
  SessionStopReceipt,
  sameStop,
  type StopBinding,
  type ControlBinding,
} from '../shared/task-control.js';
import { ProfileActor } from './profile-actor.js';
import { ActorBrowserPort } from './actor-browser-port.js';
import { postFailureRequiresEnding } from '../domain/step-failure-policy.js';
import type { TabProof } from '../shared/kernel-state.js';
import { SettlementNotifier } from './settlement-notifier.js';

type Entry = {
  context: ExecutionSession;
  port: ManagedProfileSession;
  actor: ProfileActor;
  state: 'ATTACHED' | 'STOPPING' | 'STOP_UNCONFIRMED';
  stopBinding: StopBinding | null;
  stopping: Promise<void> | null;
  controlBinding: ControlBinding | null;
  retrying: boolean;
  stopInFlight: boolean;
};

// Lifecycle owner only. No discovery, tab creation, automatic resume or business inference.
export class ProfileActorRegistry {
  private readonly entries = new Map<string, Entry>();
  hasOwners(): boolean {
    return this.entries.size > 0;
  }
  hasOwner(profileId: string): boolean {
    return this.entries.has(profileId);
  }
  revokeForControl(planId: string, profileId: string, reason: string): void {
    const entry = this.entries.get(profileId);
    if (!entry || entry.port.ownedPlanId?.() !== planId) return;
    entry.actor.revokeInput(reason);
    entry.port.revokeInput?.(reason);
  }
  constructor(
    private readonly inventory: () => Awaitable<RuntimeProfile[]>,
    private readonly tasks: TaskRepository,
    private readonly settlements: SettlementRepository,
    private readonly controls: TaskControlRepository,
    private readonly tabs: TaskTabRepository,
    private readonly id: () => string,
    private readonly profileInventory?: (
      profileId: string,
    ) => Awaitable<RuntimeProfile | undefined>,
  ) {}
  private native(): GuardedBrowserPort {
    return {
      profiles: async () => await this.inventory(),
      ...(this.profileInventory ? { profile: this.profileInventory } : {}),
      session: async (profileId) => (await this.entries.get(profileId)?.port.current()) ?? null,
      send: async () => {
        throw Error('UNGUARDED_SEND_FORBIDDEN');
      },
      sendGuarded: (operation, guard) => {
        const entry = this.entries.get(operation.binding.profileId);
        if (!entry || entry.state !== 'ATTACHED') throw Error('ACTOR_OWNER_NOT_ATTACHED');
        return entry.port.sendGuarded(operation, guard);
      },
    };
  }
  private browser() {
    return new ActorBrowserPort(
      this.native(),
      [...this.entries.values()]
        .filter((entry) => entry.state === 'ATTACHED')
        .map((entry) => entry.actor),
    );
  }
  async profiles() {
    return await this.inventory();
  }
  async ownedProfile(profileId: string): Promise<RuntimeProfile | null> {
    const entry = this.entries.get(profileId);
    return entry ? await structuredClone(await entry.port.profile()) : null;
  }
  async ownedSession(expected: ExecutionSession): Promise<ManagedProfileSession | null> {
    const entry = this.entries.get(expected.profileId);
    const current = await entry?.port.current();
    return entry?.state === 'ATTACHED' && current && sameExecution(current, expected)
      ? entry.port
      : null;
  }
  async currentTaskTab(plan: Plan, context: ExecutionSession) {
    const entry = this.entries.get(plan.profileId);
    if (!entry) throw Error('ACTOR_TASK_TAB_CONTEXT_CHANGED');
    const assertCurrent = async () => {
      const current = await entry?.port.current(),
        fresh = await this.tasks.get(plan.id);
      if (
        !entry ||
        this.entries.get(plan.profileId) !== entry ||
        entry.state !== 'ATTACHED' ||
        !current ||
        !sameExecution(current, context) ||
        fresh.state !== 'RUNNING' ||
        fresh.accountId !== context.accountId ||
        fresh.profileId !== context.profileId
      )
        throw Error('ACTOR_TASK_TAB_CONTEXT_CHANGED');
    };
    await assertCurrent();
    const originals = (await this.tabs.forPlan(plan.id)).filter((row) =>
      ['READY', 'RECHECK_REQUIRED'].includes(row.state),
    );
    if (originals.length !== 1 || !originals[0]) throw Error('ACTOR_ORIGINAL_TASK_TAB_REQUIRED');
    const proof = originals[0].proof;
    if (
      originals[0].state === 'READY' &&
      originals[0].context &&
      sameExecution(originals[0].context, context) &&
      entry.port.confirmTaskTab
    ) {
      await entry.port.confirmTaskTab(proof);
      await assertCurrent();
      const fresh = await this.tabs.get(proof.ownershipId, plan.id);
      if (
        fresh.state !== 'READY' ||
        !fresh.context ||
        !sameExecution(fresh.context, context) ||
        !sameTabProof(fresh.proof, proof)
      )
        throw Error('ACTOR_NATIVE_TASK_TAB_UNCONFIRMED');
      return structuredClone(proof);
    }
    const inventory = await entry.port.inventory();
    await assertCurrent();
    if (inventory.profileId !== plan.profileId) throw Error('ACTOR_ORIGINAL_TASK_TAB_REQUIRED');
    if (
      !inventory.tabs.some(
        (row) => row.state === 'READY' && row.proof && sameTabProof(row.proof, proof),
      )
    )
      throw Error('ACTOR_NATIVE_TASK_TAB_UNCONFIRMED');
    return structuredClone(proof);
  }
  async schedulingProfiles() {
    return await this.browser().schedulingProfiles();
  }
  async session(profileId: string) {
    return await this.browser().session(profileId);
  }
  send(operation: Operation & { binding: Binding }) {
    return this.browser().send(operation);
  }
  async status() {
    return await mapAsync([...this.entries], async ([profileId, entry]) => ({
      profileId,
      lifecycle: entry.state,
      actor: await entry.actor.status(),
      stopRequestId: entry.stopBinding?.requestId ?? null,
    }));
  }
  async retireReplacedOwner(profileId: string, currentEpoch: string): Promise<boolean> {
    const entry = this.entries.get(profileId);
    if (
      !entry ||
      entry.state === 'ATTACHED' ||
      entry.context.connectionEpoch === currentEpoch ||
      (await entry.port.current())
    )
      return false;
    await entry.actor.invalidate('OLD_CONNECTION_OWNER_RETIRED');
    this.entries.delete(profileId);
    // Local retirement is not the original STOP receipt. Tabs, account locks and UNKNOWN
    // remain until the existing ending coordinator obtains a new actual stop and disposition.
    return true;
  }
  // Caller must be the matched parent STOPPED hook, after the private SDK is revoked.
  // This retires the local cancellation owner, never confirms its historical STOP.
  async retireParentStoppedOwner(profileId: string, connectionEpoch: string): Promise<boolean> {
    const entry = this.entries.get(profileId);
    if (
      !entry ||
      entry.state === 'ATTACHED' ||
      entry.context.connectionEpoch !== connectionEpoch ||
      (await entry.port.current())
    )
      return false;
    await entry.actor.invalidate('CONFIRMED_PARENT_STOP_OWNER_RETIRED');
    this.entries.delete(profileId);
    return true;
  }
  async attach(port: ManagedProfileSession): Promise<void> {
    if (this.entries.has(port.profileId)) throw Error('PROFILE_ACTOR_ALREADY_OWNED');
    const context = ExecutionContext.parse(await port.current());
    const profile = (await this.inventory()).find((row) => row.id === port.profileId);
    if (
      context.profileId !== port.profileId ||
      !profile ||
      profile.account.state !== 'logged-in' ||
      profile.account.id !== context.accountId ||
      !profile.online ||
      !profile.synced ||
      profile.unresolved ||
      !profile.dispatchAllowed
    )
      throw Error('PROFILE_ACTOR_AUTHENTICATED_SESSION_REQUIRED');
    const owner: Entry = {
      context,
      port,
      actor: new ProfileActor(port, this.tasks, this.settlements),
      state: 'ATTACHED',
      stopBinding: null,
      stopping: null,
      controlBinding: null,
      retrying: false,
      stopInFlight: false,
    };
    this.entries.set(port.profileId, owner);
    try {
      await port.setFailureHandler(async (reason) => {
        // SDK cancellation itself rejects outstanding queries. Their error callbacks must not
        // replace an existing user control, nor act on a replacement owner after release.
        if (this.entries.get(port.profileId) !== owner || owner.state !== 'ATTACHED') return;
        await this.detach(port.profileId, context, reason);
      });
    } catch (error) {
      this.entries.delete(port.profileId);
      throw error;
    }
  }
  async observe(profileId: string): Promise<TabProof | void> {
    const entry = this.entries.get(profileId);
    if (!entry || entry.state !== 'ATTACHED') throw Error('ACTOR_OWNER_NOT_ATTACHED');
    const current = await entry.actor.session(),
      plan = await this.activePlan(profileId);
    // A healthy reconciled owner needs fresh scope, not a history transfer, while
    // observing a browse-only plan. Operation/result boundaries retain full reconciliation.
    if (
      current &&
      plan?.state === 'RUNNING' &&
      (await entry.actor.status()).state === 'READY' &&
      entry.port.confirmTaskTab &&
      plan.snapshot.steps.every(
        (step) =>
          step.type !== 'post' && (step.maxLikes === 0 || ['feed', 'video'].includes(step.type)),
      ) &&
      !(
        (await this.tasks.blockingOperations?.(plan.id)) ?? (await this.tasks.operations(plan.id))
      ).some(
        (op) =>
          ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status) &&
          !op.disposition,
      ) &&
      (await this.settlements.list(profileId)).every((notice) => notice.state === 'DELIVERED')
    ) {
      try {
        const proof = await this.currentTaskTab(plan, current);
        const after = await entry.actor.session();
        if (!after || !sameExecution(after, current)) throw Error('ACTOR_TASK_TAB_CONTEXT_CHANGED');
        return proof;
      } catch (error) {
        await entry.actor.invalidate(
          error instanceof Error ? error.message.slice(0, 200) : 'ACTOR_TASK_SCOPE_FAILED',
        );
        throw error;
      }
    }
    const observed = await entry.actor.observe();
    const after = await entry.actor.session();
    const fresh = plan && (await this.tasks.get(plan.id));
    // Transfer this round's independently reconciled proof, never a cached inventory.
    // The runner and host still recheck the original context and SQL ownership.
    if (
      observed &&
      after &&
      sameExecution(after, entry.context) &&
      fresh?.state === 'RUNNING' &&
      fresh.accountId === after.accountId &&
      fresh.snapshot.steps.every(
        (step) =>
          step.type !== 'post' && (step.maxLikes === 0 || ['feed', 'video'].includes(step.type)),
      )
    ) {
      const rows = (await this.tabs.forPlan(fresh.id)).filter((row) =>
        ['READY', 'RECHECK_REQUIRED'].includes(row.state),
      );
      const row = rows[0];
      if (
        rows.length === 1 &&
        row?.state === 'READY' &&
        row.context &&
        sameExecution(row.context, after) &&
        observed.profileId === fresh.profileId &&
        observed.tabs.some(
          (tab) => tab.state === 'READY' && tab.proof && sameTabProof(tab.proof, row.proof),
        )
      )
        return structuredClone(row.proof);
    }
  }
  private stopEntry(
    entry: Entry,
    binding: StopBinding,
    control: ControlBinding | null,
    reason: string,
  ): Promise<void> {
    if (!sameExecution(entry.context, binding)) throw Error('ACTOR_STOP_CONTEXT_MISMATCH');
    // Revoke synchronously, before asynchronous SDK cancellation or a reply can race an Input.
    entry.actor.revokeInput(reason);
    entry.port.revokeInput?.(reason);
    if (entry.stopBinding && !sameStop(entry.stopBinding, binding)) {
      entry.state = 'STOP_UNCONFIRMED';
      throw Error('ACTOR_STOP_REQUEST_CONFLICT');
    }
    entry.state = 'STOPPING';
    if (entry.stopping) return entry.stopping;
    entry.stopBinding = binding;
    entry.controlBinding = control;
    entry.stopInFlight = true;
    const work = (async () => {
      try {
        await entry.actor.invalidate(reason);
        for (const tab of await this.tabs.activeForProfile(binding.profileId)) {
          if (tab.state === 'READY' && tab.context && sameExecution(tab.context, entry.context))
            await this.tabs.requireRecheck(
              tab.proof.ownershipId,
              tab.revision,
              'SDK_OWNER_STOP_REQUESTED',
              tab.jobId,
            );
        }

        // Input is already revoked. Deliver only previously decided durable results
        // before retaining a clean session; a verification is not its native delivery.
        if (
          control &&
          !(
            (await this.tasks.blockingOperations?.(control.jobId)) ??
            (await this.tasks.operations(control.jobId))
          ).some(
            (op) =>
              ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status) &&
              !op.disposition,
          )
        ) {
          const notifier = new SettlementNotifier(this.settlements);
          const count = Math.min(
            4,
            (await this.settlements.list(binding.profileId)).filter(
              (notice) => notice.state !== 'DELIVERED' && sameExecution(notice.binding, binding),
            ).length,
          );
          for (let index = 0; index < count; index++) {
            if (!(await notifier.flushOne(entry.port))) break;
          }
        }
        const receipt = SessionStopReceipt.parse(await entry.port.stop(binding));
        if (!sameStop(binding, receipt)) throw Error('ACTOR_STOP_RECEIPT_MISMATCH');
        if (this.entries.get(binding.profileId) !== entry) throw Error('ACTOR_STOP_OWNER_CHANGED');
        if (control) await this.controls.confirm(control, receipt);
        // Delete only this owner, after its exact native receipt and any plan confirmation commit.
        if (this.entries.get(binding.profileId) === entry) this.entries.delete(binding.profileId);
      } catch (error) {
        entry.state = 'STOP_UNCONFIRMED';
        throw error;
      } finally {
        entry.stopInFlight = false;
      }
    })();
    entry.stopping = work;
    return work;
  }
  retryStop(input: StopBinding): Promise<void> {
    const binding = SessionStopBinding.parse(input),
      entry = this.entries.get(binding.profileId);
    if (!entry || !entry.stopBinding || !sameStop(entry.stopBinding, binding))
      return Promise.reject(Error('ACTOR_STOP_RETRY_BINDING_MISMATCH'));
    if (entry.state === 'STOPPING' && entry.retrying && entry.stopping) return entry.stopping;
    if (entry.stopInFlight) return Promise.reject(Error('ACTOR_STOP_RETRY_IN_FLIGHT'));
    if (entry.state !== 'STOP_UNCONFIRMED' || !entry.port.retryStop)
      return Promise.reject(Error('ACTOR_STOP_RETRY_UNAVAILABLE'));
    const control = entry.controlBinding;
    entry.state = 'STOPPING';
    entry.retrying = true;
    entry.stopInFlight = true;
    const retry = entry.port.retryStop.bind(entry.port);
    const work = (async () => {
      try {
        if (control) {
          const plan = await this.tasks.get(control.jobId);
          if (
            plan.controlRequestId !== control.requestId ||
            plan.controlMode !== control.mode ||
            plan.accountId !== control.accountId ||
            plan.profileId !== control.profileId ||
            plan.controlConfirmed ||
            !['PAUSING', 'STOPPING'].includes(plan.state)
          )
            throw Error('ACTOR_STOP_RETRY_CONTROL_CHANGED');
        }

        const receipt = SessionStopReceipt.parse(await retry(binding));
        if (!sameStop(binding, receipt)) throw Error('ACTOR_STOP_RECEIPT_MISMATCH');
        if (this.entries.get(binding.profileId) !== entry) throw Error('ACTOR_STOP_OWNER_CHANGED');
        if (control) await this.controls.confirm(control, receipt);
        this.entries.delete(binding.profileId);
      } catch (error) {
        entry.state = 'STOP_UNCONFIRMED';
        throw error;
      } finally {
        entry.retrying = false;
        entry.stopInFlight = false;
      }
    })();
    entry.stopping = work;
    return work;
  }
  private async activePlan(profileId: string): Promise<Plan | null> {
    const plans = await this.tasks.plansForProfile(profileId, [
      'RUNNING',
      'PAUSING',
      'STOPPING',
      'REVIEW',
    ]);
    if (plans.length > 1) throw Error('MULTIPLE_ACTIVE_PROFILE_PLANS');
    return plans[0] ?? null;
  }
  async controlFromUser(
    jobId: string,
    mode: 'pause' | 'stop',
    reason = 'USER_REQUEST',
  ): Promise<Plan> {
    const plan = await this.tasks.get(jobId),
      entry = this.entries.get(plan.profileId);
    // Explicit user action only. The ordinary runner never retries physical cancellation.
    // Retain the original STOP request; after its receipt a pause may become a final stop.
    if (
      entry &&
      (entry.state === 'STOP_UNCONFIRMED' || (entry.state === 'STOPPING' && entry.retrying))
    ) {
      if (
        !entry.stopBinding ||
        entry.controlBinding?.jobId !== jobId ||
        entry.stopBinding.requestId !== plan.controlRequestId
      )
        throw Error('ACTOR_STOP_RETRY_CONTROL_CHANGED');
      await this.retryStop(entry.stopBinding);
    }
    return this.control(jobId, mode, reason);
  }
  private readonly controlling = new Map<string, { mode: 'pause' | 'stop'; work: Promise<Plan> }>();
  control(jobId: string, mode: 'pause' | 'stop', reason = 'USER_REQUEST'): Promise<Plan> {
    const pending = this.controlling.get(jobId);
    if (pending?.mode === mode) return pending.work;
    const work = pending
      ? pending.work.then(() => this.controlOwned(jobId, mode, reason))
      : this.controlOwned(jobId, mode, reason);
    this.controlling.set(jobId, { mode, work });
    void work
      .finally(() => {
        if (this.controlling.get(jobId)?.work === work) this.controlling.delete(jobId);
      })
      .catch(() => {});
    return work;
  }
  private async controlOwned(jobId: string, mode: 'pause' | 'stop', reason: string): Promise<Plan> {
    const before = await this.tasks.get(jobId);
    const previous = this.entries.get(before.profileId);
    // Pause -> stop from the service waits for the same physical cancellation. A rejected
    // cancellation stays rejected; it cannot be replaced with a guessed successful receipt.
    if (previous?.stopping && previous.stopBinding?.requestId === before.controlRequestId) {
      await previous.stopping;
      const completed = await this.tasks.get(jobId);
      if (completed.controlMode === mode) return completed;
    }
    const plan = await this.tasks.requestControl(jobId, mode, reason);
    if (terminal(plan.state) || plan.state === 'PAUSED' || plan.controlConfirmed) return plan;
    const entry = this.entries.get(plan.profileId);
    if (!entry || !plan.controlRequestId || !plan.controlMode)
      throw Error('ACTOR_STOP_OWNER_REQUIRED');
    const binding: ControlBinding = {
      ...entry.context,
      jobId: plan.id,
      requestId: plan.controlRequestId,
      mode: plan.controlMode,
    };
    await this.controls.bind(binding);
    await this.stopEntry(
      entry,
      SessionStopBinding.parse({
        ...entry.context,
        requestId: binding.requestId,
      }),
      binding,
      reason,
    );
    return await this.tasks.get(jobId);
  }
  async detach(profileId: string, expected: ExecutionSession, reason: string): Promise<void> {
    const entry = this.entries.get(profileId);
    if (!entry || !sameExecution(entry.context, expected)) throw Error('STALE_ACTOR_DETACH');
    const plan = await this.activePlan(profileId);
    if (plan) {
      const step = (await this.tasks.steps(plan.id, plan.round)).find(
        (step) => step.position === plan.position && step.status === 'ACTIVE',
      );
      if (step?.spec.type === 'post' && postFailureRequiresEnding(reason))
        await this.tasks.noteStepFailure?.(plan.id, step.id, reason);
      const profile = (await this.inventory()).find((row) => row.id === profileId);
      const changed =
        profile?.account.state === 'logged-in' && profile.account.id !== plan.accountId;
      await this.control(plan.id, changed ? 'stop' : (plan.controlMode ?? 'pause'), reason);
    } else {
      await this.stopEntry(entry, { ...entry.context, requestId: this.id() }, null, reason);
    }
  }
  async reconcileOwners(): Promise<void> {
    // Start independent retirements without serially waiting for a slow/failed profile.
    const results = await Promise.allSettled(
      [...this.entries].map(async ([profileId, entry]) => {
        if (entry.state !== 'ATTACHED') return;
        const current = await entry.port.current(),
          profile = (await this.inventory()).find((row) => row.id === profileId);
        if (
          !current ||
          !sameExecution(current, entry.context) ||
          !profile?.online ||
          !profile.synced ||
          profile.unresolved ||
          !profile.dispatchAllowed ||
          profile.account.state !== 'logged-in' ||
          profile.account.id !== entry.context.accountId
        )
          await this.detach(profileId, entry.context, 'ACTOR_TRANSPORT_OR_IDENTITY_CHANGED');
      }),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'ACTOR_STOP_UNCONFIRMED',
      );
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries].map(([profileId, entry]) =>
        this.detach(profileId, entry.context, 'SOFTWARE_SHUTDOWN'),
      ),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'ACTOR_SHUTDOWN_UNCONFIRMED',
      );
  }
}
