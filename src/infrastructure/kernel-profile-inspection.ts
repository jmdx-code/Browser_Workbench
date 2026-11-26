import { prepareFacebookWorkspace } from './facebook-workspace-preparation.js';
import type { Awaitable } from '../domain/persistence.js';
import type { Core, Peer } from '../bridge/core.js';
import type { ProfileInspectionPort, InspectionConnection } from '../domain/system-ports.js';
import type { TaskRepository } from '../domain/tasks.js';
import type { KernelBridge } from './kernel-bridge.js';
import { facebookDisplayInspectionProjection } from './facebook-read-adapter.js';
import { FacebookNativeActor } from '../shared/facebook-native-identity.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { kernelOperationPending } from '../shared/kernel-state.js';
import { marketplaceBridgeSupported } from '../shared/task-policies.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateProjection } from '../shared/page-read.js';
export class KernelProfileInspection implements ProfileInspectionPort {
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly tasks: TaskRepository,
  ) {}
  connection(profileId: string) {
    const peer = this.core.peers.get(profileId);
    return peer?.online ? { profileId, connectionEpoch: peer.epoch } : null;
  }
  private async peer(connection: InspectionConnection, queuedPlanId?: string): Promise<Peer> {
    const peer = this.core.peers.get(connection.profileId);
    if (
      !peer?.online ||
      peer.epoch !== connection.connectionEpoch ||
      !peer.synced ||
      peer.phase !== 'PAUSED'
    )
      throw Error('INSPECTION_PROFILE_NOT_IDLE');
    if (!peer.capabilities?.includes('facebook-readonly-v2'))
      throw Error('INSPECTION_EXTENSION_UPDATE_REQUIRED');
    const pending = await this.tasks.plansForProfile(peer.profileId, ['QUEUED', 'RUNNING']);
    if (
      queuedPlanId &&
      (pending.length !== 1 ||
        pending[0]?.id !== queuedPlanId ||
        !['QUEUED', 'RUNNING'].includes(pending[0]?.state ?? ''))
    )
      throw Error('INSPECTION_QUEUED_BOOTSTRAP_REVOKED');
    if (!queuedPlanId && pending.length) throw Error('INSPECTION_PLAN_PENDING');
    if ((await this.core.store.unresolved(peer.profileId)).length)
      throw Error('INSPECTION_OPERATION_PENDING');
    return peer;
  }
  async assertIdle(connection: InspectionConnection) {
    await this.assertNativeIdle(connection);
  }
  private async assertNativeIdle(connection: InspectionConnection, queuedPlanId?: string) {
    const peer = await this.peer(connection, queuedPlanId);
    const { inventory } = await prepareFacebookWorkspace(
      this.kernel,
      peer,
      undefined,
      async () => {
        await this.peer(connection, queuedPlanId);
      },
      undefined,
      true,
    );
    await this.peer(connection, queuedPlanId);
    if (inventory.operations.some(kernelOperationPending)) {
      throw Error('INSPECTION_NATIVE_REVIEW_REQUIRED');
    }
  }
  async read(connection: InspectionConnection, assertCurrent: () => Awaitable<void>) {
    return (await this.readPublicPage(connection, assertCurrent, false)).page;
  }
  async readDisplay(connection: InspectionConnection, assertCurrent: () => Awaitable<void>) {
    const p = await this.peer(connection),
      guard = async () => {
        await this.peer(connection);
        await assertCurrent();
      };
    if (p.capabilities?.includes('kernel-workspace-main-proof-v1')) {
      const { inventory: native } = await prepareFacebookWorkspace(
        this.kernel,
        p,
        undefined,
        guard,
        undefined,
        true,
      );
      await guard();
      if (native.workspaceMain) {
        if (native.operations.some(kernelOperationPending))
          throw Error('INSPECTION_NATIVE_REVIEW_REQUIRED');
        return this.kernel.inspectRetainedFacebookDisplay(
          await this.peer(connection),
          native.workspaceMain,
          guard,
        );
      }
    }
    if (p.capabilities?.includes('facebook-existing-display-v1')) {
      const existing = await this.readExisting(connection, assertCurrent);
      if (!existing) throw Error('INSPECTION_DOCUMENT_NOT_READY');
      return existing;
    }
    if (marketplaceBridgeSupported(p.extensionVersion, '0.3.21')) {
      await guard();
      const result = await this.kernel.inspectFacebookDisplay(await this.peer(connection), guard);
      await guard();
      return result;
    }
    const capture = p.capabilities?.includes('facebook-native-identity-v1') === true,
      result = await this.readPublicPage(connection, assertCurrent, capture);
    return {
      page: result.page,
      actor: FacebookNativeActor.nullable().parse(result.nativeIdentity),
    };
  }
  private async readPublicPage(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
    capture: boolean,
  ) {
    await assertCurrent();
    const result = await this.kernel.readFacebookPage(
      await this.peer(connection),
      facebookDisplayInspectionProjection,
      'home',
      async () => {
        await this.peer(connection);
        await assertCurrent();
      },
      capture,
    );
    await assertCurrent();
    if (
      result.connectionEpoch !== connection.connectionEpoch ||
      !result.closed ||
      result.stop.state !== 'stopped' ||
      result.inputRPCs !== 0
    )
      throw Error('INSPECTION_READ_RELEASE_UNCONFIRMED');
    return result;
  }
  // Private bootstrap observation for the future task factory. The public inspection result
  // and its unknown/action-unverified semantics stay unchanged until that factory is wired.
  async readNativeActor(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
    observeDecision: (decision: {
      reason: string;
      nativeActorObserved: boolean;
      transport: 'native-response' | 'document-preload' | null;
      ready: string;
      composers: number;
      profileLinks: number;
    }) => void = () => {},
  ) {
    return this.readActor(connection, assertCurrent, observeDecision);
  }
  // Internal task admission only. Public display inspection still rejects every pending plan.
  // No claim/input is authorized here; queued state and original outbox are checked across awaits.
  async readQueuedNativeActor(
    planId: string,
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
  ) {
    return (await this.peer(connection, planId)).capabilities?.includes(
      'facebook-existing-display-v1',
    )
      ? this.readQueuedCurrentActor(planId, connection, assertCurrent)
      : this.readActor(connection, assertCurrent, () => {}, planId);
  }
  async readQueuedCurrentActor(
    planId: string,
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
  ) {
    const guard = async () => {
      await this.peer(connection, planId);
      await assertCurrent();
    };
    await guard();
    const plan = await this.tasks.get(planId);
    const step = (await this.tasks.steps(planId)).find(
      (row) => row.round === plan.round && row.position === plan.position,
    );
    const storyAdmission = step?.spec.type === 'post' && step.spec.destination === 'story';
    const browseAdmission = Boolean(step && (step.spec.type !== 'post' || storyAdmission));
    const peer = await this.peer(connection, planId);
    const prepared = await prepareFacebookWorkspace(
      this.kernel,
      peer,
      undefined,
      guard,
      undefined,
      true,
    );
    if (prepared.inventory.operations.some(kernelOperationPending))
      throw Error('FACEBOOK_IDENTITY_NATIVE_REVIEW_REQUIRED');
    const idle = peer.capabilities?.includes('kernel-page-quiesce-v1')
      ? await this.kernel.inspectIdleFacebookPage(peer, guard, storyAdmission)
      : null;
    if (idle) return idle;
    if (prepared.proof)
      return this.kernel.inspectFacebookIdentity(
        peer,
        guard,
        true,
        prepared.proof,
        browseAdmission,
        storyAdmission,
      );
    if (
      (await this.peer(connection, planId)).capabilities?.includes('facebook-existing-display-v1')
    ) {
      const existing = await this.readExisting(connection, guard, planId);
      if (existing?.actor) {
        const { composers, links, href, creatorUrl } = inspectCreatorNodes(existing.page);
        if (
          composers.length === 1 &&
          links.length === 1 &&
          Boolean(href) &&
          isMatchedHomeCreator(creatorUrl, existing.actor.accountId)
        )
          return {
            actor: existing.actor,
            transport: 'document-preload' as const,
            connection: { ...connection },
            proof: null,
            closedRecord: null,
            stop: null,
            page: existing.page,
            passive: true as const,
          };
      }
    }
    const evidence = await this.kernel.inspectFacebookIdentity(
      await this.peer(connection, planId),
      guard,
      true,
      undefined,
      browseAdmission,
      storyAdmission,
    );
    await guard();
    if (evidence.connection.connectionEpoch !== connection.connectionEpoch)
      throw Error('INSPECTION_READ_RELEASE_UNCONFIRMED');
    return evidence;
  }
  private async ensureCurrent(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
    queuedPlanId?: string,
  ) {
    await this.peer(connection, queuedPlanId);
    await assertCurrent();
  }
  private async readExisting(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
    queuedPlanId?: string,
  ) {
    await this.ensureCurrent(connection, assertCurrent, queuedPlanId);
    const row = await this.core.run({
      profileId: connection.profileId,
      operationId: randomUUID(),
      action: { kind: 'readFacebookDisplay', projection: facebookDisplayInspectionProjection },
    });
    await this.ensureCurrent(connection, assertCurrent, queuedPlanId);
    if (row.status !== 'VERIFIED' || !row.result) throw Error('INSPECTION_FAILED');
    const data = z
      .object({
        evidence: z.object({
          available: z.boolean(),
          page: z.unknown().optional(),
          identity: z.unknown().optional(),
        }),
      })
      .parse(JSON.parse(row.result)).evidence;
    if (!data.available) return null;
    const page = validateProjection(facebookDisplayInspectionProjection, data.page);
    const identity = z
      .object({
        url: z.string().refine(kernelFacebookReadURL),
        ready: z.enum(['interactive', 'complete']),
        actor: FacebookNativeActor.nullable(),
      })
      .parse(data.identity);
    if (page.url !== identity.url || !['interactive', 'complete'].includes(page.ready))
      throw Error('INSPECTION_DOCUMENT_CHANGED');
    await this.kernel.observeProjectedAccount?.(connection.profileId, page, identity.actor);
    return { page, actor: identity.actor };
  }
  private async readActor(
    connection: InspectionConnection,
    assertCurrent: () => Awaitable<void>,
    observeDecision: Parameters<KernelProfileInspection['readNativeActor']>[2] = () => {},
    queuedPlanId?: string,
  ) {
    await this.assertNativeIdle(connection, queuedPlanId);
    await assertCurrent();
    const result = await this.kernel.readFacebookPage(
      await this.peer(connection, queuedPlanId),
      facebookDisplayInspectionProjection,
      'home',
      () => this.ensureCurrent(connection, assertCurrent, queuedPlanId),
      true,
    );
    await this.ensureCurrent(connection, assertCurrent, queuedPlanId);
    if (
      result.connectionEpoch !== connection.connectionEpoch ||
      !result.closed ||
      result.stop.state !== 'stopped' ||
      result.inputRPCs !== 0
    )
      throw Error('INSPECTION_READ_RELEASE_UNCONFIRMED');
    const actor = FacebookNativeActor.nullable().parse(result.nativeIdentity),
      { composers, links, href, creatorUrl } = inspectCreatorNodes(result.page),
      decision = (reason: string) =>
        observeDecision({
          reason,
          nativeActorObserved: actor !== null,
          transport: result.nativeIdentityTransport,
          ready: result.page.ready,
          composers: composers.length,
          profileLinks: links.length,
        });
    if (
      !actor ||
      result.page.url !== 'https://www.facebook.com/' ||
      result.page.ready !== 'complete'
    )
      return (decision(actor ? 'HOME_DOCUMENT_UNCONFIRMED' : 'NATIVE_ACTOR_ABSENT'), null);
    if (
      composers.length !== 1 ||
      !composers[0]?.visible ||
      links.length !== 1 ||
      !links[0]?.visible
    )
      return (decision('HOME_CREATOR_AMBIGUOUS'), null);
    if (!href) return (decision('HOME_CREATOR_LINK_ABSENT'), null);
    if (!isMatchedHomeCreator(creatorUrl, actor.accountId))
      return (decision('HOME_CREATOR_ACTOR_MISMATCH'), null);
    decision('CURRENT_ACTOR_AND_CREATOR_MATCHED');
    return {
      actor,
      transport: result.nativeIdentityTransport,
      connection: { ...connection },
      proof: result.proof,
      closedRecord: result.closedRecord,
      stop: { requestId: String(result.stop.requestId), state: 'stopped' as const },
      page: result.page,
    };
  }
}
function inspectCreatorNodes(page: Awaited<ReturnType<typeof validateProjection>>) {
  const composers = page.rows.find((r) => r.key === 'homeComposers')?.nodes ?? [],
    links = page.rows.find((r) => r.key === 'composerProfileLinks')?.nodes ?? [],
    href = links[0]?.attributes.href;
  let creatorUrl: URL | null = null;
  if (href) {
    try {
      creatorUrl = new URL(href, page.url);
    } catch {}
  }
  return { composers, links, href, creatorUrl };
}
function isMatchedHomeCreator(url: URL | null, accountId: string) {
  return (
    url?.origin === 'https://www.facebook.com' &&
    url.pathname === '/profile.php' &&
    url.searchParams.get('id') === accountId
  );
}
