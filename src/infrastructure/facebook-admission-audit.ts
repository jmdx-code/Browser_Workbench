import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import { WorkspaceStore } from './workspace-store.js';
import { createFacebookMaterialInputs } from './facebook-material-inputs.js';
import { FacebookSubmissionObserver } from './facebook-submission-observer.js';
import { NativeFacebookProfileFactory } from './facebook-profile-factory.js';
import { AdmittedTaskRuntime } from '../application/admitted-task-runtime.js';
import type { KernelManagedFacebookSession } from './kernel-managed-facebook-session.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import { sameExecution } from '../shared/task-execution.js';
import { auditEmptyFacebookComposer } from './facebook-empty-composer-audit.js';
import { recoverUndispatchedEmptyComposer } from './facebook-empty-composer-recovery-audit.js';
import { z } from 'zod';

const AdmissionSubject = z
  .object({
    profileId: z.uuid(),
    accountId: z.string().regex(/^\d{1,30}$/),
    extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    reportName: z.string().regex(/^[a-z0-9-]+\.json$/),
  })
  .strict();
type AdmissionSubject = z.infer<typeof AdmissionSubject>;

// A single opt-in real Chrome admission test. It creates no browser operation and reads only
// the owned HOME page. Isolated SQL plan/control records are not production task acceptance.
export class FacebookAdmissionAudit {
  private attempted = false;
  private disabled = false;
  private work: Promise<void> | null = null;
  private runtime: AdmittedTaskRuntime | null = null;
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly output: string,
    private readonly emptyComposer = false,
    private readonly recoverNoInputOpen = false,
    private readonly subject?: AdmissionSubject,
  ) {
    if (subject) AdmissionSubject.parse(subject);
    if (subject && recoverNoInputOpen) throw Error('NEW_SUBJECT_OLD_RECOVERY_FORBIDDEN');
  }
  tick() {
    const peer = this.core.peers.get(
      this.subject?.profileId ?? '2b32bd78-51d0-4576-a12b-252c4d3c2d9b',
    );
    if (
      this.attempted ||
      this.disabled ||
      !peer?.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      peer.extensionVersion !== (this.subject?.extensionVersion ?? '0.3.11')
    )
      return;
    this.attempted = true;
    this.work = this.run(peer).catch((error) =>
      console.error('Admission audit report failed', error),
    );
  }
  async close() {
    this.disabled = true;
    await this.runtime?.close();
    await this.work;
  }
  private async run(peer: Peer) {
    await mkdir(this.output, { recursive: true });
    const report = path.join(
      this.output,
      this.subject?.reportName ??
        (this.recoverNoInputOpen
          ? 'facebook-managed-empty-composer-0311-painted-live.json'
          : this.emptyComposer
            ? 'facebook-managed-empty-composer-0311-live.json'
            : 'facebook-managed-admission-0311-sdk-bootstrap-live.json'),
    );
    const base = {
      startedAt: new Date().toISOString(),
      profileId: peer.profileId,
      connectionEpoch: peer.epoch,
      extensionVersion: peer.extensionVersion,
      readonlyScope: !this.emptyComposer,
      emptyComposerScope: this.emptyComposer,
      newPosts: 0,
      managedPublisherAcceptance: false,
      formalTasksCreated: 0,
      oldUnknownAdopted: false,
    };
    try {
      await writeFile(report, JSON.stringify({ ...base, state: 'RUNNING' }, null, 2), {
        flag: 'wx',
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
    const directory = path.join(this.output, 'facebook-admission-isolated-' + randomUUID());
    await mkdir(directory);
    const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
    let session: KernelManagedFacebookSession | null = null;
    let runtime: AdmittedTaskRuntime | null = null;
    let currentExecution: Parameters<typeof auditEmptyFacebookComposer>[3] | null = null;
    const evidence: Record<string, unknown> = {};
    let failure: string | null = null;
    try {
      const epoch = peer.epoch;
      const guard = () => {
        if (
          this.disabled ||
          this.core.peers.get(peer.profileId) !== peer ||
          peer.epoch !== epoch ||
          !peer.online ||
          !peer.synced ||
          peer.phase !== 'PAUSED'
        )
          throw Error('ADMISSION_AUDIT_REVOKED');
      };
      guard();
      if (this.recoverNoInputOpen) {
        await recoverUndispatchedEmptyComposer(this.kernel, this.core, peer, this.output);
        guard();
      }
      const inputs = createFacebookMaterialInputs(
        store,
        directory,
        new FacebookSubmissionObserver(store.submissionObservations),
      );
      const factory = new NativeFacebookProfileFactory(
        this.kernel,
        this.core,
        store.tasks,
        store.taskTabs,
        inputs,
      );
      const originalOpen = factory.openClaimed.bind(factory);
      factory.openClaimed = async (planId) => {
        session = await originalOpen(planId);
        return session;
      };
      const raw = async (): Promise<RuntimeProfile[]> => [
        {
          id: peer.profileId,
          online: peer.online,
          synced: peer.synced,
          unresolved: (await this.core.store.unresolved(peer.profileId)).length,
          dispatchAllowed: false,
          account: { state: 'unknown', id: null, name: null, avatar: null },
        },
      ];
      runtime = this.runtime = new AdmittedTaskRuntime(
        store.tasks,
        store.taskTabs,
        store.tasks.settlements,
        store.taskControls,
        factory,
        raw,
        randomUUID,
      );
      const combination = store.createCombination({
        name: '真实只读原actor接入检查',
        note: '不填写、不上传、不发布',
        steps: [
          {
            id: randomUUID(),
            type: 'post',
            resourceDirectory: path.join(directory, 'unaccessed-resources'),
            count: 1,
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: true,
          },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      const [queued] = store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: combination.id,
          version: combination.version,
          profileIds: [peer.profileId],
        },
        await raw(),
      );
      if (!queued) throw Error('ADMISSION_AUDIT_PLAN_REQUIRED');
      evidence.planId = queued.id;
      await runtime.observe(peer.profileId);
      guard();
      const profile = (await runtime.schedulingProfiles())[0];
      if (
        profile?.account.state !== 'logged-in' ||
        profile.account.id !== (this.subject?.accountId ?? '10000000000001') ||
        !profile.dispatchAllowed
      )
        throw Error('ADMISSION_AUDIT_CONFIRMED_SUBJECT_REQUIRED');
      evidence.nativeAccount = profile.account;
      const plan = store.tasks.claimNext(await runtime.schedulingProfiles(), new Set(['post']));
      if (!plan || plan.id !== queued.id) throw Error('ADMISSION_AUDIT_ORIGINAL_CLAIM_REQUIRED');
      await runtime.observe(peer.profileId);
      guard();
      const context = await runtime.session(peer.profileId),
        step = store.tasks.steps(plan.id).find((row) => row.status === 'ACTIVE');
      if (!context || !step || !session) throw Error('ADMISSION_AUDIT_ORIGINAL_ACTOR_REQUIRED');
      await runtime.preparePlan(plan, context);
      guard();
      // openClaimed is an async captured assignment; TypeScript cannot infer it from await.
      const managed = session as KernelManagedFacebookSession;
      const owner = runtime;
      currentExecution = { plan, step, session: context };
      const reading = await managed.readPostPage({ plan, step, session: context }, async () => {
        guard();
        const fresh = await owner.session(peer.profileId);
        if (!fresh || !sameExecution(fresh, context))
          throw Error('ADMISSION_AUDIT_SESSION_CHANGED');
      });
      guard();
      if (
        reading.url !== 'https://www.facebook.com/' ||
        reading.observedAccountId !== context.accountId ||
        !reading.opener ||
        reading.surface !== null
      )
        throw Error('ADMISSION_AUDIT_EMPTY_HOME_REQUIRED');
      evidence.context = context;
      evidence.home = {
        url: reading.url,
        locale: reading.locale,
        observedAccountId: reading.observedAccountId,
        opener: reading.opener,
        composer: reading.surface,
      };
      if (this.emptyComposer) {
        evidence.emptyComposerAudit = await auditEmptyFacebookComposer(
          store,
          owner,
          managed,
          { plan, step, session: context },
          guard,
        );
      } else {
        const stopped = await runtime.control(plan.id, 'stop', 'READONLY_ADMISSION_AUDIT_COMPLETE');
        evidence.plan = stopped;
        evidence.control = store.taskControls.list();
        evidence.tabs = store.taskTabs.forPlan(plan.id);
        evidence.operations = store.tasks.operations(plan.id);
        if (
          stopped.state !== 'STOPPED' ||
          !stopped.controlConfirmed ||
          store.tasks.operations(plan.id).length ||
          store.taskTabs.forPlan(plan.id).some((row) => row.state !== 'CLOSED') ||
          (await runtime.registry.status()).length
        )
          throw Error('ADMISSION_AUDIT_NATIVE_RELEASE_UNCONFIRMED');
      }
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 200) : 'ADMISSION_AUDIT_FAILED';
      // Capture the actual current surface before owner shutdown. No retrying the entry or
      // content action: this differentiates an unopened editor from a reader/identity failure.
      if (session && currentExecution) {
        const managed = session as KernelManagedFacebookSession;
        try {
          evidence.failedSurface = await managed.readEmptyPostStructure(currentExecution, () => {
            if (this.disabled || this.core.peers.get(peer.profileId) !== peer || !peer.online)
              throw Error('ADMISSION_FAILURE_READ_REVOKED');
          });
        } catch (readError) {
          evidence.failedSurfaceReadError =
            readError instanceof Error ? readError.message.slice(0, 200) : 'READ_FAILED';
        }
        evidence.operations = store.tasks.operations(currentExecution.plan.id);
      }
    } finally {
      if (session)
        evidence.nativeMutationCalls = (
          session as KernelManagedFacebookSession
        ).nativeMutationCalls;
      try {
        await runtime?.close();
      } catch (error) {
        failure ??= error instanceof Error ? error.message.slice(0, 200) : 'ADMISSION_CLOSE_FAILED';
      }
      if (currentExecution) {
        evidence.plan = store.tasks.get(currentExecution.plan.id);
        evidence.tabs = store.taskTabs.forPlan(currentExecution.plan.id);
        evidence.control = store.taskControls.list();
      }
      this.runtime = null;
      store.close();
    }
    const trace = this.kernel.diagnostics(peer.profileId);
    const recordedInputs = trace.filter((row) =>
      /^rpc:send:(Input\.|DOM\.setFileInputFiles)/.test(row.event),
    ).length;
    const calls = evidence.nativeMutationCalls as Record<string, number> | undefined;
    const inputs = calls
      ? Object.entries(calls)
          .filter(([method]) => /^(Input\.|DOM\.setFileInputFiles)/.test(method))
          .reduce((sum, [, count]) => sum + count, 0)
      : recordedInputs;
    if (!this.emptyComposer && inputs) failure ??= 'ADMISSION_AUDIT_UNEXPECTED_INPUT';
    if (
      this.emptyComposer &&
      (calls
        ? Object.keys(calls).some((method) =>
            /^(Input\.(?!dispatchMouseEvent|dispatchKeyEvent)|DOM\.setFileInputFiles)/.test(method),
          )
        : trace.some((row) =>
            /^rpc:send:(Input\.(?!dispatchMouseEvent|dispatchKeyEvent)|DOM\.setFileInputFiles)/.test(
              row.event,
            ),
          ))
    )
      failure ??= 'EMPTY_COMPOSER_AUDIT_UNEXPECTED_CONTENT_INPUT';
    await writeFile(
      report,
      JSON.stringify(
        {
          ...base,
          finishedAt: new Date().toISOString(),
          state: failure ? 'FAILED_OR_BLOCKED' : 'PASSED',
          reason: failure,
          directory,
          inputRPCs: inputs,
          traceSaturated: trace.length === 512,
          recordedInputRPCs: recordedInputs,
          evidence,
          trace,
        },
        null,
        2,
      ),
    );
  }
}
