import type { Awaitable } from '../domain/persistence.js';
import { BusinessResolution } from '../shared/settlement.js';
import type { ManagedProfileSession } from '../domain/profile-actor.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import type { Operation } from '../shared/task-contracts.js';
import { sameExecution, type Binding } from '../shared/task-execution.js';
import {
  SessionStopBinding,
  SessionStopReceipt,
  type StopBinding,
} from '../shared/task-control.js';
import type { Resolution } from '../shared/settlement.js';
import { KernelFixtureTaskPort, type KernelConnection } from './kernel-fixture-task-port.js';

// Fixture scope remains explicit; this is not a Facebook session or an identity probe.
export class KernelManagedFixtureSession implements ManagedProfileSession {
  private readonly adapter: KernelFixtureTaskPort;
  private failure: ((reason: string) => Promise<void>) | null = null;
  constructor(
    private readonly context: NonNullable<Awaited<ReturnType<KernelConnection['context']>>>,
    private readonly connection: KernelConnection,
    private readonly runtime: RuntimeProfile,
    taskTabs: TaskTabRepository,
  ) {
    this.adapter = new KernelFixtureTaskPort(connection, runtime, taskTabs, async (reason) => {
      if (!this.failure) throw Error('MANAGED_LIFECYCLE_OWNER_REQUIRED');
      await this.failure(reason);
    });
  }
  static async open(
    connection: KernelConnection,
    runtime: RuntimeProfile,
    taskTabs: TaskTabRepository,
  ) {
    const context = runtime.account.id ? await connection.context(runtime.account.id) : null;
    if (!context || context.profileId !== runtime.id)
      throw Error('MANAGED_SESSION_CONTEXT_REQUIRED');
    return new KernelManagedFixtureSession(context, connection, runtime, taskTabs);
  }
  get profileId() {
    return this.runtime.id;
  }
  profile() {
    return this.runtime;
  }
  async current() {
    return await this.connection.context(this.context.accountId);
  }
  inventory() {
    return this.connection.inventory();
  }
  notify(binding: Binding, resolution: Resolution) {
    return this.connection.reconcile(binding, BusinessResolution.parse(resolution));
  }
  setFailureHandler(handler: (reason: string) => Promise<void>) {
    if (this.failure) throw Error('MANAGED_SESSION_ALREADY_OWNED');
    this.failure = handler;
  }
  sendGuarded(operation: Operation & { binding: Binding }, guard: () => Awaitable<void>) {
    if (!this.failure) throw Error('MANAGED_LIFECYCLE_OWNER_REQUIRED');
    return this.adapter.sendGuarded(operation, guard);
  }
  async stop(input: StopBinding) {
    const binding = SessionStopBinding.parse(input);
    if (!sameExecution(binding, this.context)) throw Error('MANAGED_STOP_CONTEXT_MISMATCH');
    const receipt = await this.connection.close(binding.requestId);
    if (receipt.requestId !== binding.requestId || receipt.state !== 'stopped')
      throw Error('MANAGED_STOP_RECEIPT_MISMATCH');
    return SessionStopReceipt.parse({ ...binding, state: receipt.state });
  }
  async retryStop(input: StopBinding) {
    const binding = SessionStopBinding.parse(input);
    if (!sameExecution(binding, this.context)) throw Error('MANAGED_STOP_CONTEXT_MISMATCH');
    const receipt = await this.connection.retryClose(binding.requestId);
    if (receipt.requestId !== binding.requestId || receipt.state !== 'stopped')
      throw Error('MANAGED_STOP_RECEIPT_MISMATCH');
    return SessionStopReceipt.parse({ ...binding, state: receipt.state });
  }
}
