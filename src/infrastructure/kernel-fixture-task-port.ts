import type { Awaitable } from '../domain/persistence.js';
import type { TaskBrowserPort, RuntimeProfile } from '../domain/tasks.js';
import type { Operation } from '../shared/task-contracts.js';
import type { Binding, ExecutionReceipt } from '../shared/task-execution.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import type { GuardedBrowserPort } from '../domain/profile-actor.js';

export type KernelConnection = Awaited<ReturnType<KernelBridge['connect']>>;
// Diagnostic adapter ONLY. No Facebook identities or production actions are synthesized here.
export class KernelFixtureTaskPort implements TaskBrowserPort, GuardedBrowserPort {
  constructor(
    private readonly connection: KernelConnection,
    private readonly runtime: RuntimeProfile,
    private readonly taskTabs: TaskTabRepository,
    private readonly failureStop?: (reason: string) => Promise<void>,
  ) {}
  profiles(): RuntimeProfile[] {
    return [this.runtime];
  }
  async session(profileId: string) {
    if (
      profileId !== this.runtime.id ||
      this.runtime.account.state !== 'logged-in' ||
      !this.runtime.account.id
    )
      return null;
    return await this.connection.context(this.runtime.account.id);
  }
  async send(operation: Operation & { binding: Binding }): Promise<ExecutionReceipt> {
    return await this.sendGuarded(operation, () => {});
  }
  async sendGuarded(
    operation: Operation & { binding: Binding },
    assertCurrent: () => Awaitable<void>,
  ): Promise<ExecutionReceipt> {
    const action = operation.action;
    if (
      !this.connection.proof ||
      action.kind !== 'click' ||
      action.tabId !== this.connection.tabId ||
      action.documentEpoch !== 0 ||
      action.routeEpoch !== 0 ||
      action.target.scope ||
      action.target.text ||
      !['#counter', '#never-present'].includes(action.target.css)
    )
      throw Error('FIXTURE_ACTION_REJECTED');
    const page = this.connection.browser.contexts()[0]?.pages()[0];
    if (!page || page.url() !== 'http://127.0.0.1:18767/kernel-fixture')
      throw Error('FIXTURE_PAGE_NOT_READY');
    await this.taskTabs.assertForInput(operation.binding, this.connection.proof);
    await assertCurrent();
    const result = await this.connection.execute(
      operation.binding,
      async () => {
        await page.locator(action.target.css).click({ timeout: 15_000 });
      },
      assertCurrent,
      this.failureStop,
    );
    return {
      binding: result.binding,
      evidence: { sdkReturned: true, ownedTab: this.connection.proof },
    };
  }
}
