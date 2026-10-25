import { mapAsync } from '../shared/async-collections.js';
import type { GuardedBrowserPort } from '../domain/profile-actor.js';
import type { TaskBrowserPort } from '../domain/tasks.js';
import type { Operation } from '../shared/task-contracts.js';
import { sameExecution, type Binding, type ExecutionReceipt } from '../shared/task-execution.js';
import type { ProfileActor } from './profile-actor.js';

export class ActorBrowserPort implements TaskBrowserPort {
  private readonly actors: ReadonlyMap<string, ProfileActor>;
  constructor(
    private readonly browser: GuardedBrowserPort,
    actors: readonly ProfileActor[],
  ) {
    this.actors = new Map(actors.map((actor) => [actor.profileId, actor]));
    if (this.actors.size !== actors.length) throw Error('DUPLICATE_PROFILE_ACTOR');
  }
  // Transport health is separate from temporary input backpressure: do not pause an active plan
  // merely because its business verification or settlement notification is pending.
  async profiles() {
    return await this.browser.profiles();
  }
  async schedulingProfiles() {
    return await mapAsync(await this.profiles(), async (profile) => ({
      ...profile,
      dispatchAllowed:
        profile.dispatchAllowed && (await this.actors.get(profile.id)?.status())?.state === 'READY',
    }));
  }
  async session(profileId: string) {
    const actor = await this.actors.get(profileId)?.session(),
      native = await this.browser.session(profileId);
    return actor && native && sameExecution(actor, native) ? actor : null;
  }
  async send(operation: Operation & { binding: Binding }): Promise<ExecutionReceipt> {
    const actor = this.actors.get(operation.binding.profileId);
    if (!actor) throw Error('PROFILE_ACTOR_REQUIRED');
    return await actor.execute(operation, async (assertCurrent) => {
      const guard = async () => {
        await assertCurrent();
        const native = await this.browser.session(operation.binding.profileId);
        const profile = this.browser.profile
          ? await this.browser.profile(operation.binding.profileId)
          : (await this.browser.profiles()).find((row) => row.id === operation.binding.profileId);
        if (
          !native ||
          !sameExecution(native, operation.binding) ||
          profile?.id !== operation.binding.profileId ||
          !profile?.online ||
          !profile.synced ||
          profile.unresolved ||
          !profile.dispatchAllowed ||
          profile.account.state !== 'logged-in' ||
          profile.account.id !== operation.binding.accountId
        )
          throw Error('ACTOR_BROWSER_CONTEXT_CHANGED');
      };
      await guard();
      const receipt = await this.browser.sendGuarded(operation, guard);
      await guard();
      return receipt;
    });
  }
}
