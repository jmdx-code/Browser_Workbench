import type { Awaitable } from '../domain/persistence.js';
import type { Core, Peer } from '../bridge/core.js';
import type { TaskRepository, RuntimeProfile } from '../domain/tasks.js';
import type { TaskTabRepository } from '../domain/task-tabs.js';
import type { Plan } from '../shared/task-contracts.js';
import { marketplaceBridgeSupported, marketplaceMinimumBridge } from '../shared/task-features.js';
import { sameTabProof } from '../domain/task-tabs.js';
import type { KernelBridge } from './kernel-bridge.js';
import { KernelProfileInspection } from './kernel-profile-inspection.js';
import { NativeFacebookTaskAuthority } from './facebook-task-authority.js';
import {
  KernelManagedFacebookSession,
  type FacebookMaterialInputs,
} from './kernel-managed-facebook-session.js';

type Bootstrap = NonNullable<Awaited<ReturnType<KernelProfileInspection['readQueuedNativeActor']>>>;
type Admission = { planId: string; peer: Peer; evidence: Bootstrap; consumed: boolean };

// Private admission cache, not a second session/operation ledger. Claiming still occurs in the
// original TaskRepository; the original registry owns the returned managed session and stop.
export class NativeFacebookProfileFactory {
  supportsControlRelease(profileId: string) {
    return (
      this.core.peers.get(profileId)?.capabilities?.includes('kernel-control-release-v1') === true
    );
  }
  private readonly admissions = new Map<string, Admission>();
  private readonly observing = new Map<string, { planId: string; work: Promise<RuntimeProfile> }>();
  private readonly observingPlans = new Map<string, Promise<RuntimeProfile>>();
  private closed = false;
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly tasks: TaskRepository,
    private readonly tabs: TaskTabRepository,
    private readonly materialInputs:
      FacebookMaterialInputs | ((plan: Plan) => Awaitable<FacebookMaterialInputs | undefined>),
    private readonly now = Date.now,
    private readonly inspection: Pick<KernelProfileInspection, 'readQueuedNativeActor'> = {
      readQueuedNativeActor: (planId, connection, guard) =>
        new KernelProfileInspection(kernel, core, tasks).readQueuedCurrentActor(
          planId,
          connection,
          guard,
        ),
    },
    private readonly openSession = KernelManagedFacebookSession.open,
    private readonly storyAuthorized: (plan: Plan) => Awaitable<boolean> = () => false,
  ) {}
  private async guard(planId: string, peer: Peer, state: 'QUEUED' | 'RUNNING') {
    const plan = await this.tasks.get(planId);
    if (
      plan.snapshot.steps.some((step) => step.type === 'marketplace') &&
      !marketplaceBridgeSupported(
        peer.extensionVersion,
        marketplaceMinimumBridge(plan.snapshot.steps),
      )
    )
      throw Error('MARKETPLACE_BRIDGE_UPDATE_REQUIRED');
    const others = await this.tasks.plansForProfile(peer.profileId, [
      'QUEUED',
      'RUNNING',
      'PAUSING',
      'PAUSED',
      'STOPPING',
      'REVIEW',
    ]);
    if (
      this.closed ||
      this.core.peers.get(peer.profileId) !== peer ||
      !peer.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      (await this.core.store.unresolved(peer.profileId)).length ||
      plan.profileId !== peer.profileId ||
      plan.state !== state ||
      others.length !== 1 ||
      others[0]?.id !== planId ||
      (
        (await this.tasks.blockingOperations?.(planId)) ?? (await this.tasks.operations(planId))
      ).some((op) => ['PREPARED', 'DISPATCHING', 'ACKNOWLEDGED', 'UNKNOWN'].includes(op.status))
    )
      throw Error('FACEBOOK_PROFILE_ADMISSION_REVOKED');
    return plan;
  }
  private async fresh(admission: Admission, state: 'QUEUED' | 'RUNNING') {
    const plan = await this.guard(admission.planId, admission.peer, state);
    const { evidence } = admission;
    if (
      admission.peer.epoch !== evidence.connection.connectionEpoch ||
      (plan.accountId && plan.accountId !== evidence.actor.accountId) ||
      this.now() < evidence.actor.checkedAt ||
      this.now() - evidence.actor.checkedAt > 30_000
    )
      throw Error('FACEBOOK_PROFILE_ADMISSION_EXPIRED_OR_CHANGED');
    return plan;
  }
  async profile(profileId: string): Promise<RuntimeProfile | null> {
    const admission = this.admissions.get(profileId);
    if (!admission) return null;
    try {
      const plan = await this.tasks.get(admission.planId);
      if (plan.state !== 'QUEUED' && plan.state !== 'RUNNING') return null;
      await this.fresh(admission, plan.state);
      return {
        id: profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: {
          state: 'logged-in',
          id: admission.evidence.actor.accountId,
          name: admission.evidence.actor.name,
          avatar: null,
        },
      };
    } catch {
      return null;
    }
  }
  observeQueued(planId: string): Promise<RuntimeProfile> {
    const previous = this.observingPlans.get(planId);
    if (previous) return previous;
    if (this.closed) return Promise.reject(Error('FACEBOOK_PROFILE_FACTORY_CLOSED'));
    if (this.observingPlans.size >= 256)
      return Promise.reject(Error('FACEBOOK_ADMISSION_QUEUE_FULL'));
    const work = this.observeQueuedOwned(planId);
    this.observingPlans.set(planId, work);
    void work
      .finally(() => {
        if (this.observingPlans.get(planId) === work) this.observingPlans.delete(planId);
      })
      .catch(() => {});
    return work;
  }
  private async observeQueuedOwned(planId: string): Promise<RuntimeProfile> {
    const plan = await this.tasks.get(planId),
      peer = this.core.peers.get(plan.profileId);
    if (!peer) return Promise.reject(Error('FACEBOOK_PROFILE_OFFLINE'));
    const pending = this.observing.get(peer.profileId);
    if (pending)
      return pending.planId === planId
        ? pending.work
        : Promise.reject(Error('FACEBOOK_PROFILE_ADMISSION_BUSY'));
    const old = this.admissions.get(peer.profileId);
    if (old && old.planId === planId && !old.consumed) {
      try {
        await this.fresh(old, 'QUEUED');
        const profile = await this.profile(peer.profileId);
        if (!profile) throw Error('FACEBOOK_PROFILE_ADMISSION_REVOKED');
        return Promise.resolve(profile);
      } catch {
        return this.forget(peer.profileId).then(() => this.observeQueuedOwned(planId));
      }
    }
    const work = this.observeOnce(planId, peer);
    this.observing.set(peer.profileId, { planId, work });
    void work
      .finally(() => {
        if (this.observing.get(peer.profileId)?.work === work)
          this.observing.delete(peer.profileId);
      })
      .catch(() => {});
    return work;
  }
  private async observeOnce(planId: string, peer: Peer) {
    const epoch = peer.epoch;
    const guard = async () => {
      await this.guard(planId, peer, 'QUEUED');
      if (peer.epoch !== epoch) throw Error('FACEBOOK_PROFILE_CONNECTION_CHANGED');
    };
    await guard();
    this.admissions.delete(peer.profileId);
    const result = await this.inspection.readQueuedNativeActor(
      planId,
      { profileId: peer.profileId, connectionEpoch: epoch },
      guard,
    );
    try {
      await guard();
    } catch (error) {
      if (
        result &&
        'retained' in result &&
        result.retained &&
        result.proof &&
        !('workspaceRetained' in result && result.workspaceRetained)
      )
        await this.kernel.discardAdmissionTab(peer, result.proof);
      throw error;
    }
    if (!result) throw Error('FACEBOOK_CURRENT_NATIVE_BOOTSTRAP_REQUIRED');
    const evidence = structuredClone(result);
    // Also validates closed proof/STOP; no display name or caller-supplied account grants this.
    if (
      evidence.connection.profileId !== peer.profileId ||
      evidence.connection.connectionEpoch !== epoch ||
      (evidence.proof && evidence.proof.profileId !== peer.profileId) ||
      (!('passive' in evidence && evidence.passive) &&
        (evidence.closedRecord?.state !==
          ('retained' in evidence && evidence.retained ? 'READY' : 'CLOSED') ||
          !evidence.closedRecord.proof ||
          !evidence.proof ||
          !sameTabProof(evidence.proof, evidence.closedRecord.proof) ||
          evidence.stop?.state !== 'stopped'))
    )
      throw Error('FACEBOOK_CLOSED_BOOTSTRAP_REQUIRED');
    const admission = { planId, peer, evidence, consumed: false };
    await this.fresh(admission, 'QUEUED');
    evidence.actor.checkedAt = this.now();
    this.admissions.set(peer.profileId, admission);
    const profile = await this.profile(peer.profileId);
    if (!profile) throw Error('FACEBOOK_PROFILE_ADMISSION_REVOKED');
    return profile;
  }
  async openClaimed(planId: string) {
    const plan = await this.tasks.get(planId),
      admission = this.admissions.get(plan.profileId);
    if (!admission || admission.planId !== planId || admission.consumed)
      throw Error('FACEBOOK_UNCONSUMED_ADMISSION_REQUIRED');
    await this.fresh(admission, 'RUNNING');
    admission.consumed = true; // A failed open is never automatically retried or re-owned.
    const openEvidence = structuredClone(admission.evidence);
    openEvidence.actor.checkedAt = this.now();
    const authority = new NativeFacebookTaskAuthority(
      this.core,
      admission.peer,
      this.tasks,
      plan,
      openEvidence,
      this.now,
      undefined,
      this.storyAuthorized,
    );
    try {
      const session = await this.openSession(
        this.kernel,
        admission.peer,
        plan,
        authority,
        this.tasks,
        this.tabs,
        typeof this.materialInputs === 'function'
          ? await this.materialInputs(await structuredClone(plan))
          : this.materialInputs,
      );
      admission.evidence.actor.checkedAt = this.now();
      return session;
    } catch (error) {
      if (
        'retained' in admission.evidence &&
        admission.evidence.retained &&
        !('workspaceRetained' in admission.evidence && admission.evidence.workspaceRetained) &&
        admission.evidence.proof
      )
        try {
          await this.kernel.discardAdmissionTab(admission.peer, admission.evidence.proof);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            error instanceof Error ? error.message : 'FACEBOOK_ADMISSION_OPEN_FAILED',
          );
        }
      throw error;
    }
  }
  async forget(profileId: string) {
    const admission = this.admissions.get(profileId);
    this.admissions.delete(profileId);
    if (
      admission &&
      !admission.consumed &&
      'retained' in admission.evidence &&
      admission.evidence.retained &&
      !('workspaceRetained' in admission.evidence && admission.evidence.workspaceRetained) &&
      admission.evidence.proof
    )
      await this.kernel.discardAdmissionTab(admission.peer, admission.evidence.proof);
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.observingPlans.values());
    await Promise.allSettled([...this.observing.values()].map((row) => row.work));
    await Promise.allSettled([...this.admissions.keys()].map((id) => this.forget(id)));
  }
}
