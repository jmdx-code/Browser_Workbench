import type { Awaitable } from '../domain/persistence.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import type { Core, Peer } from '../bridge/core.js';
import type { KernelBridge } from './kernel-bridge.js';
import { WorkspaceStore } from './workspace-store.js';
import { NativeFacebookProfileFactory } from './facebook-profile-factory.js';
import { createFacebookMaterialInputs } from './facebook-material-inputs.js';
import { AdmittedTaskRuntime } from '../application/admitted-task-runtime.js';
import { TaskDispatcher } from '../application/task-dispatcher.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import { FilesystemMaterialScanner } from './material-scanner.js';
import { checkKnownFacebookVideo } from './video-metadata.js';
import { FacebookPostStepExecutor } from './facebook-post-step-executor.js';
import { DOMFacebookPostBusinessObserver } from './facebook-post-business-observer.js';
import { readFacebookPostEffects } from './facebook-post-effect-reader.js';
import { recoverSingleImageDraft } from './facebook-single-image-draft-recovery.js';
import { FacebookDraftUploadTrace } from './facebook-draft-upload-trace.js';
import type { KernelManagedFacebookSession } from './kernel-managed-facebook-session.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import type { StepExecution } from '../domain/browse-execution.js';
import type { PostIntent, Catalog } from '../shared/material-index.js';
import { sameExecution } from '../shared/task-execution.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { DispatchBinding } from '../shared/task-execution.js';
import { OwnedTabProof } from '../shared/kernel-state.js';
import { FacebookVideoUploadObserver } from './facebook-video-upload-observer.js';

const batchId = 'bb7a4a03-c2cd-49f9-a67d-c54c00c6a413';
const profileId = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
const accountId = '10000000000001';
const DraftCase = z
  .object({
    ordinal: z.number().int().min(1).max(4),
    format: z.enum(['text', 'single-image', 'multi-image', 'video']),
    marker: z.string(),
    text: z.string(),
    directory: z.string(),
    files: z.array(
      z
        .object({ path: z.string(), name: z.string(), bytes: z.number(), sha256: z.string() })
        .strict(),
    ),
  })
  .strict();
const Review = z
  .object({
    version: z.literal(1),
    batchId: z.uuid(),
    profileId: z.uuid(),
    accountId: z.string().regex(/^\d{1,30}$/),
    accountName: z.string().min(1).max(150),
    scope: z.literal('draft-only'),
    allowedPurposes: z.tuple([
      z.literal('OPEN_COMPOSER'),
      z.literal('SET_TEXT'),
      z.literal('UPLOAD_MEDIA'),
    ]),
    publish: z.literal(false),
    changeAudience: z.literal(false),
    newPosts: z.literal(0),
    cases: z.array(DraftCase).length(4),
    authorization: z.literal('PENDING_USER'),
  })
  .strict();
type Case = z.infer<typeof DraftCase>;
const DraftSubject = z
  .object({
    batchId: z.uuid(),
    profileId: z.uuid(),
    accountId: z.string().regex(/^\d{1,30}$/),
    accountName: z.string().min(1).max(150),
    extensionVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    reportName: z.string().regex(/^[a-z0-9-]+\.json$/),
    userAnswer: z.string().min(1).max(200),
  })
  .strict();
type DraftSubject = z.infer<typeof DraftSubject>;

// A finite, explicitly authorized diagnostic. No general runner is started: SUBMIT,
// ADVANCE, audience changes and subsequent drafts cannot reach prepare or dispatch.
export class FacebookDraftAudit {
  private attempted = false;
  private disabled = false;
  private work: Promise<void> | null = null;
  private runtime: AdmittedTaskRuntime | null = null;
  constructor(
    private readonly kernel: KernelBridge,
    private readonly core: Core,
    private readonly output: string,
    private readonly remainingMedia = false,
    private readonly lastTwo = false,
    private readonly videoOnly = false,
    private readonly additionalVideo = false,
    private readonly subject?: DraftSubject,
  ) {
    if (subject) DraftSubject.parse(subject);
    if (subject && (remainingMedia || lastTwo || videoOnly || additionalVideo))
      throw Error('NEW_DRAFT_SUBJECT_OLD_RECOVERY_FORBIDDEN');
  }
  tick() {
    const peer = this.core.peers.get(this.subject?.profileId ?? profileId);
    if (
      this.attempted ||
      this.disabled ||
      !peer?.online ||
      !peer.synced ||
      peer.phase !== 'PAUSED' ||
      peer.extensionVersion !==
        (this.subject?.extensionVersion ?? (this.videoOnly ? '0.3.13' : '0.3.12'))
    )
      return;
    this.attempted = true;
    this.work = this.run(peer).catch((error) => console.error('Draft audit report failed', error));
  }
  async close() {
    this.disabled = true;
    await this.runtime?.close();
    await this.work;
  }
  private assertContent(intent: Pick<PostIntent, 'snapshot'>, item: Case) {
    const snapshot = intent.snapshot;
    const media = snapshot.files.filter((f) => f.role !== 'text');
    if (
      snapshot.format !== item.format ||
      snapshot.text !== item.text ||
      media.length !== item.files.length ||
      media.some((file, i) => {
        const allowed = item.files[i];
        return (
          !allowed ||
          path.basename(file.relativePath) !== allowed.name ||
          file.bytes !== allowed.bytes ||
          file.digest !== allowed.sha256
        );
      })
    )
      throw Error('AUTHORIZED_DRAFT_CONTENT_MISMATCH');
  }
  private async run(peer: Peer) {
    const { batchId, profileId, accountId, accountName } = this.subject ?? {
      batchId: 'bb7a4a03-c2cd-49f9-a67d-c54c00c6a413',
      profileId: '2b32bd78-51d0-4576-a12b-252c4d3c2d9b',
      accountId: '10000000000001',
      accountName: 'Nway Myint',
    };
    const report = path.join(
      this.output,
      this.subject?.reportName ??
        (this.videoOnly
          ? 'facebook-managed-video-draft-0313-live.json'
          : this.lastTwo
            ? 'facebook-managed-last-two-drafts-0312-live.json'
            : this.remainingMedia
              ? 'facebook-managed-remaining-media-drafts-0312-live.json'
              : 'facebook-managed-four-drafts-0311-live.json'),
    );
    const base = {
      batchId,
      profileId,
      accountId,
      startedAt: new Date().toISOString(),
      extensionVersion: peer.extensionVersion,
      scope: 'draft-only',
      newPosts: 0,
      managedPublisherAcceptance: false,
      formalTasksCreated: 0,
      textReplayed: false,
      additionalVideo: this.additionalVideo,
    };
    try {
      await writeFile(report, JSON.stringify({ ...base, state: 'RESERVED' }, null, 2), {
        flag: 'wx',
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
    const directory = path.join(this.output, 'facebook-draft-isolated-' + randomUUID());
    await mkdir(directory);
    const store = await WorkspaceStore.open(path.join(directory, 'workspace.sqlite'));
    const cases: Record<string, unknown>[] = [];
    let failure: string | null = null;
    const persist = async () =>
      writeFile(
        report,
        JSON.stringify(
          {
            ...base,
            directory,
            state: failure ? 'FAILED_OR_BLOCKED' : 'RUNNING',
            reason: failure,
            cases,
          },
          null,
          2,
        ),
      );
    const epoch = peer.epoch;
    const guard = () => {
      if (
        this.disabled ||
        this.core.peers.get(profileId) !== peer ||
        peer.epoch !== epoch ||
        !peer.online ||
        !peer.synced ||
        peer.phase !== 'PAUSED'
      )
        throw Error('DRAFT_AUDIT_REVOKED');
    };
    try {
      const reviewDir = path.join(this.output, 'managed-draft-content-' + batchId);
      const bytes = await readFile(path.join(reviewDir, 'review.json'));
      const review = Review.parse(JSON.parse(bytes.toString('utf8')));
      if (
        review.batchId !== batchId ||
        review.profileId !== profileId ||
        review.accountId !== accountId ||
        review.accountName !== accountName
      )
        throw Error('DRAFT_EXACT_SUBJECT_REVIEW_REQUIRED');
      const authorization = z
        .object({
          batchId: z.literal(batchId),
          reviewSha256: z.string(),
          userAnswer: z.literal(
            this.subject?.userAnswer ??
              (this.additionalVideo ? '允许新增视频草稿，不发布' : '允许测试四类草稿，不发布'),
          ),
          publish: z.literal(false),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(path.join(reviewDir, 'authorization.json'), 'utf8')));
      if (authorization.reviewSha256 !== createHash('sha256').update(bytes).digest('hex'))
        throw Error('DRAFT_REVIEW_AUTHORIZATION_CHANGED');
      if (this.additionalVideo && !this.videoOnly) throw Error('ADDITIONAL_VIDEO_ONLY_REQUIRED');
      // Validate all exact local packages before opening any Facebook window.
      const catalogs: Catalog[] = [];
      for (const [i, item] of review.cases.entries()) {
        if (
          item.ordinal !== i + 1 ||
          item.format !== ['text', 'single-image', 'multi-image', 'video'][i] ||
          !item.text.includes(item.marker) ||
          !item.marker.endsWith('-' + (i + 1))
        )
          throw Error('DRAFT_CASE_SCOPE');
        const scan = await new FilesystemMaterialScanner(undefined, checkKnownFacebookVideo).scan(
          item.directory,
        );
        if (!scan.complete || scan.issues.length || scan.packages.length !== 1 || !scan.packages[0])
          throw Error('DRAFT_EXACT_PACKAGE_REQUIRED');
        this.assertContent({ snapshot: scan.packages[0] }, item);
        for (const file of item.files) {
          if (
            path.resolve(file.path) !==
            path.resolve(item.directory, scan.packages[0].source, file.name)
          )
            throw Error('DRAFT_FILE_PATH_MISMATCH');
        }
        catalogs.push(store.materials.index(scan, randomUUID()));
      }
      guard();
      if (this.videoOnly) {
        // Prior image settlements are complete; never rerun their one-shot diagnostics.
        z.object({ state: z.literal('PASSED') }).parse(
          JSON.parse(
            await readFile(
              path.join(this.output, 'facebook-multi-image-draft-settled-0312.json'),
              'utf8',
            ),
          ),
        );
        z.object({
          state: z.literal('ORIGINAL_UPLOAD_NOT_APPLIED'),
          binding: z.object({ operationId: z.literal('ecd1fd17-45db-4e58-b30c-c98ae91b3297') }),
          originalControlConfirmed: z.literal(false),
          originalAccountLockReleased: z.literal(false),
          protectedOldUnknownModified: z.literal(false),
          uploadsReplayed: z.literal(false),
        }).parse(
          JSON.parse(
            await readFile(path.join(this.output, 'facebook-video-not-applied-0313.json'), 'utf8'),
          ),
        );
      } else if (this.lastTwo) await recoverSingleImageDraft(this.kernel, peer, this.output, guard);
      else if (this.remainingMedia) await this.assertPreviousTextClosed(peer, guard);
      for (const [i, item] of review.cases.entries()) {
        if (this.videoOnly && i < 3) continue;
        if (this.lastTwo && i < 2) continue;
        if (this.remainingMedia && i === 0) continue;
        const evidence: Record<string, unknown> = {
          ordinal: item.ordinal,
          format: item.format,
          state: 'RUNNING',
          newPosts: 0,
        };
        cases.push(evidence);
        await persist();
        let managed: KernelManagedFacebookSession | null = null;
        const uploadTrace = new FacebookDraftUploadTrace(async () => {
          evidence.uploadResponses = uploadTrace.records;
          await persist();
        });
        const videoUploads = new FacebookVideoUploadObserver();
        const runtime = (this.runtime = new AdmittedTaskRuntime(
          store.tasks,
          store.taskTabs,
          store.tasks.settlements,
          store.taskControls,
          new NativeFacebookProfileFactory(
            this.kernel,
            this.core,
            store.tasks,
            store.taskTabs,
            createFacebookMaterialInputs(
              store,
              directory,
              {
                prepare: async () => {
                  throw Error('DRAFT_SUBMISSION_FORBIDDEN');
                },
                assert: async () => {
                  throw Error('DRAFT_SUBMISSION_FORBIDDEN');
                },
              },
              item.format === 'video'
                ? async (page, binding, manifest, g, enableBuffers) => {
                    await uploadTrace.start(page, binding, manifest, g, enableBuffers);
                    if (!this.subject) return;
                    const intent = store.materials.reservation(manifest.attemptId).intent;
                    const readGuard = async () => {
                      guard();
                      const plan = store.tasks.get(intent.jobId),
                        operation = store.tasks
                          .operations(intent.jobId)
                          .find((op) => op.id === binding.operationId),
                        tab = store.taskTabs
                          .forPlan(intent.jobId)
                          .find((row) => sameTabProof(row.proof, intent.proof)),
                        context = await managed?.current();
                      if (
                        plan.state !== 'RUNNING' ||
                        !operation?.binding ||
                        !sameBinding(operation.binding, binding) ||
                        !['DISPATCHING', 'ACKNOWLEDGED'].includes(operation.status) ||
                        tab?.state !== 'READY' ||
                        !context ||
                        !sameExecution(context, binding)
                      )
                        throw Error('DRAFT_ORIGINAL_VIDEO_OBSERVATION_REVOKED');
                      store.uploadStages.assertReady(manifest);
                    };
                    await videoUploads.begin(
                      page,
                      binding,
                      manifest,
                      intent,
                      readGuard,
                      enableBuffers,
                    );
                    await g();
                  }
                : undefined,
            ),
            Date.now,
            undefined,
            async (...args) => {
              const { KernelManagedFacebookSession } =
                await import('./kernel-managed-facebook-session.js');
              managed = await KernelManagedFacebookSession.open(...args);
              return managed;
            },
          ),
          async (): Promise<RuntimeProfile[]> => [
            {
              id: profileId,
              online: peer.online,
              synced: peer.synced,
              unresolved: (await this.core.store.unresolved(profileId)).length,
              dispatchAllowed: false,
              account: { state: 'unknown', id: null, name: null, avatar: null },
            },
          ],
          randomUUID,
        ));
        let planId: string | null = null;
        try {
          const combination = store.createCombination({
            name: '明确授权草稿-' + item.format,
            note: '仅填写上传，不发布',
            steps: [
              {
                id: randomUUID(),
                type: 'post',
                resourceDirectory: item.directory,
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
              profileIds: [profileId],
            },
            await runtime.profiles(),
          );
          if (!queued) throw Error('DRAFT_PLAN_REQUIRED');
          planId = queued.id;
          evidence.planId = planId;
          await runtime.observe(profileId);
          guard();
          const subject = (await runtime.schedulingProfiles())[0];
          if (subject?.account.id !== accountId || !subject.dispatchAllowed)
            throw Error('DRAFT_CURRENT_ACCOUNT_REQUIRED');
          const plan = store.tasks.claimNext(await runtime.schedulingProfiles(), new Set(['post']));
          if (plan?.id !== planId) throw Error('DRAFT_ORIGINAL_CLAIM_REQUIRED');
          await runtime.observe(profileId);
          guard();
          const session = await runtime.session(profileId),
            step = store.tasks.steps(planId).find((s) => s.status === 'ACTIVE');
          if (!session || !step || !managed) throw Error('DRAFT_ORIGINAL_ACTOR_REQUIRED');
          await runtime.preparePlan(plan, session);
          const owner = managed as KernelManagedFacebookSession;
          const claimedId = plan.id;
          const catalog = catalogs[i];
          if (!catalog) throw Error('DRAFT_VALIDATED_CATALOG_REQUIRED');
          const current = async (): Promise<StepExecution> => {
            guard();
            const owned = await owner.current();
            if (
              !owned ||
              !sameExecution(owned, session) ||
              store.tasks.get(claimedId).state !== 'RUNNING'
            )
              throw Error('DRAFT_OWNER_CHANGED');
            const fresh = store.tasks.steps(claimedId).find((s) => s.id === step.id);
            if (!fresh || fresh.status !== 'ACTIVE') throw Error('DRAFT_STEP_CHANGED');
            return { plan: store.tasks.get(claimedId), step: fresh, session };
          };
          const business = new DOMFacebookPostBusinessObserver(
            store.submissionObservations,
            store.uploadStages,
            {
              ready: () => false,
              read: async () => {
                throw Error('DRAFT_SUBMISSION_RESULT_FORBIDDEN');
              },
            },
            randomUUID,
            async (page, assertCurrent) => {
              const reading = await readFacebookPostEffects(page, assertCurrent);
              // Keep only this authorized composer's current effects, never feed or account posts.
              evidence.lastMediaObservation = {
                checkedAt: new Date().toISOString(),
                url: reading.url,
                timeOrigin: reading.timeOrigin,
                ready: reading.ready,
                composer: reading.composer,
              };
              if (item.format === 'video') {
                evidence.mediaSurface = await page.evaluate(() => {
                  const roots = document.querySelectorAll(
                    '[role="dialog"]:has(form [role="textbox"][contenteditable="true"])',
                  );
                  const root = roots.length === 1 ? roots[0] : null;
                  if (!root) return null;
                  const visible = (element: Element) => {
                    const r = element.getBoundingClientRect();
                    return (
                      r.width > 0 &&
                      r.height > 0 &&
                      getComputedStyle(element).visibility !== 'hidden'
                    );
                  };
                  return {
                    buttons: Array.from(root.querySelectorAll('[role="button"]'))
                      .filter(visible)
                      .slice(0, 30)
                      .map((element) => ({
                        label: element.getAttribute('aria-label')?.slice(0, 200) ?? null,
                        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
                        disabled:
                          element.getAttribute('aria-disabled') === 'true' ||
                          element.hasAttribute('disabled'),
                      })),
                    videos: Array.from(root.querySelectorAll('video'))
                      .slice(0, 3)
                      .map((video) => ({
                        visible: visible(video),
                        readyState: video.readyState,
                        width: video.videoWidth,
                        height: video.videoHeight,
                        errorCode: video.error?.code ?? null,
                        sourceKind: video.currentSrc.startsWith('blob:')
                          ? 'blob'
                          : video.currentSrc.startsWith('https:')
                            ? 'https'
                            : 'empty-or-other',
                      })),
                  };
                });
                await assertCurrent();
              }
              await persist();
              await assertCurrent();
              return reading;
            },
            this.subject ? videoUploads : undefined,
          );
          const executor = new FacebookPostStepExecutor(
            store.tasks,
            store.materialPosts,
            {
              ready: () => true, // Finite draft source, never registered as a production adapter.
              catalogId: () => catalog.id,
              read: async (e, g) => {
                const reading = await owner.readPostPage(e, g);
                await g();
                // Save the bounded current-composer projection before an uncertain OPEN is
                // stopped. Exclude homepage/feed/name/avatar rows and never infer an effect.
                evidence.lastPostObservation = {
                  checkedAt: new Date().toISOString(),
                  url: reading.url,
                  timeOrigin: reading.timeOrigin,
                  locale: reading.locale ?? null,
                  ready: reading.ready,
                  surface: reading.surface,
                  text: reading.text,
                  rows: reading.composerProjection,
                };
                await persist();
                await g();
                return reading;
              },
              verifyBusiness: (e, op, original, g) => {
                if (original.link.purpose !== 'UPLOAD_MEDIA')
                  throw Error('DRAFT_BUSINESS_PURPOSE_FORBIDDEN');
                return owner.verifyPostBusiness(e, op, original, business, g);
              },
            },
            randomUUID,
          );
          const first = await executor.decide(await current(), [], guard);
          if (first.kind !== 'reserve-next') throw Error('DRAFT_RESERVATION_REQUIRED');
          const held = store.materials.reserveNext(first.request);
          this.assertContent(held.intent, item);
          evidence.attemptId = held.intent.attemptId;
          const purposes =
            item.format === 'text'
              ? ['OPEN_COMPOSER', 'SET_TEXT']
              : ['OPEN_COMPOSER', 'SET_TEXT', 'UPLOAD_MEDIA'];
          for (const purpose of purposes) {
            const decision = await executor.decide(
              await current(),
              [store.materials.reservation(held.intent.attemptId)],
              guard,
            );
            if (
              decision.kind !== 'action' ||
              decision.operation.purpose !== purpose ||
              !review.allowedPurposes.includes(
                decision.operation.purpose as (typeof review.allowedPurposes)[number],
              )
            )
              throw Error('DRAFT_PURPOSE_SEQUENCE_FORBIDDEN');
            this.assertContent(held.intent, item);
            if (
              purpose === 'SET_TEXT' &&
              (decision.operation.action.kind !== 'typeText' ||
                decision.operation.action.text !== item.text)
            )
              throw Error('DRAFT_TEXT_AUTHORIZATION_CHANGED');
            const prepared = store.materialPosts.prepare(decision.operation);
            await new TaskDispatcher(store.tasks, runtime).flushOne(profileId);
            const operation = store.tasks.operations(planId).find((o) => o.id === prepared.id);
            if (operation?.status !== 'ACKNOWLEDGED' || !operation.binding)
              throw Error('DRAFT_ACK_REQUIRED:' + purpose);
            let verdict = await executor.verify(
              await current(),
              { ...operation, binding: operation.binding },
              { intent: held.intent, link: store.materialPosts.link(operation.id) },
              guard,
            );
            const deadline = Date.now() + (purpose === 'UPLOAD_MEDIA' ? 90_000 : 20_000);
            while (verdict.kind === 'wait' && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              guard();
              verdict = await executor.verify(
                await current(),
                { ...operation, binding: operation.binding },
                { intent: held.intent, link: store.materialPosts.link(operation.id) },
                guard,
              );
            }
            if (verdict.kind !== 'verified' || verdict.receipt.evidence.outcome !== 'APPLIED') {
              evidence.unconfirmedVerdict = verdict;
              store.tasks.markBoundUnknown(
                operation.binding,
                'DRAFT_EFFECT_UNCONFIRMED:' + purpose,
              );
              throw Error('DRAFT_INDEPENDENT_EFFECT_REQUIRED:' + purpose);
            }
            store.materialPosts.verify(verdict.receipt);
            evidence.operations = store.tasks.operations(planId);
            await new SettlementNotifier(store.tasks.settlements).flushOne(owner);
            if (store.tasks.settlements.list(profileId).some((n) => n.state !== 'DELIVERED'))
              throw Error('DRAFT_NOTIFICATION_REQUIRED');
            await runtime.observe(profileId);
            await persist();
          }
          const reading = await owner.readPostPage(await current(), guard);
          if (!reading.surface || reading.text !== item.text)
            throw Error('DRAFT_FINAL_EXACT_CONTENT_REQUIRED');
          evidence.finalDraft = {
            url: reading.url,
            locale: reading.locale,
            text: reading.text,
            surface: reading.surface,
          };
          await persist();
          const stopped = await runtime.control(planId, 'stop', 'AUTHORIZED_DRAFT_AUDIT_COMPLETE');
          const operations = store.tasks.operations(planId),
            tabs = store.taskTabs.forPlan(planId);
          if (
            operations.length !== purposes.length ||
            operations.some(
              (o) =>
                o.status !== 'VERIFIED' ||
                !purposes.includes(store.materialPosts.link(o.id).purpose),
            ) ||
            !['REVIEW', 'STOPPED'].includes(stopped.state) ||
            !stopped.controlConfirmed ||
            tabs.length !== 1 ||
            tabs[0]?.state !== 'CLOSED'
          )
            throw Error('DRAFT_EXACT_STOP_CLOSE_REQUIRED');
          store.materialPosts.resolveNotPublished({
            kind: 'material-post-verification',
            independent: true,
            attemptId: held.intent.attemptId,
            fingerprint: held.intent.fingerprint,
            proof: reading.proof,
            observedAccountId: accountId,
            observationId: randomUUID(),
            checkedAt: new Date().toISOString(),
            outcome: 'NOT_PUBLISHED',
            basis: 'independently-verified-not-published',
          });
          if (store.tasks.get(planId).state !== 'STOPPED')
            throw Error('DRAFT_FINAL_STOPPED_REQUIRED');
          evidence.state = 'PASSED';
          evidence.reservation = store.materials.reservation(held.intent.attemptId);
          evidence.plan = store.tasks.get(planId);
          evidence.tabs = tabs;
        } catch (error) {
          evidence.state = 'FAILED_OR_BLOCKED';
          evidence.reason =
            error instanceof Error ? error.message.slice(0, 200) : 'DRAFT_CASE_FAILED';
          failure = String(evidence.reason);
          if (planId) {
            for (const op of store.tasks.operations(planId))
              if (op.binding && ['DISPATCHING', 'ACKNOWLEDGED'].includes(op.status))
                store.tasks.markBoundUnknown(op.binding, 'DRAFT_DIAGNOSTIC_FAILED_NO_REPLAY');
            try {
              evidence.failureControl = await runtime.control(
                planId,
                'stop',
                'DRAFT_DIAGNOSTIC_FAILED_NO_REPLAY',
              );
            } catch {
              evidence.failureControl = 'UNCONFIRMED';
            }
          }
          throw error;
        } finally {
          videoUploads.stop();
          await uploadTrace.close();
          if (item.format === 'video') evidence.uploadResponses = uploadTrace.records;
          if (managed)
            evidence.nativeMutationCalls = (
              managed as KernelManagedFacebookSession
            ).nativeMutationCalls;
          if (managed)
            evidence.executionFailure = (managed as KernelManagedFacebookSession).executionFailure;
          if (planId) {
            evidence.operations = store.tasks.operations(planId);
            evidence.tabs = store.taskTabs.forPlan(planId);
          }
          try {
            await runtime.close();
          } catch (error) {
            evidence.closeFailure =
              error instanceof Error ? error.message.slice(0, 200) : 'DRAFT_CLOSE_UNCONFIRMED';
            failure ??= String(evidence.closeFailure);
          }
          this.runtime = null;
          await persist();
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 200) : 'DRAFT_AUDIT_FAILED';
    } finally {
      try {
        await this.runtime?.close();
      } catch (error) {
        failure ??=
          error instanceof Error ? error.message.slice(0, 200) : 'DRAFT_FINAL_CLOSE_UNCONFIRMED';
      }
      this.runtime = null;
      store.close();
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          ...base,
          directory,
          finishedAt: new Date().toISOString(),
          state: failure ? 'FAILED_OR_BLOCKED' : 'PASSED',
          reason: failure,
          cases,
          trace: this.kernel.diagnostics(profileId),
        },
        null,
        2,
      ),
    );
  }
  private async assertPreviousTextClosed(peer: Peer, guard: () => Awaitable<void>) {
    const previous = z
      .object({
        directory: z.string(),
        cases: z
          .array(
            z
              .object({
                ordinal: z.literal(1),
                planId: z.literal('82987f34-5453-48b3-a08c-5a136e120b40'),
              })
              .passthrough(),
          )
          .length(1),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(
            path.join(this.output, 'facebook-managed-four-drafts-0311-live.json'),
            'utf8',
          ),
        ),
      );
    const manual = z
      .object({
        userAnswer: z.literal('测试页已关闭'),
        tabId: z.literal(274921806),
        checkedAbsentThroughBrowserInventory: z.literal(true),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(
            path.join(this.output, 'managed-draft-content-' + batchId, 'manual-text-close.json'),
            'utf8',
          ),
        ),
      );
    if (
      !manual ||
      path.dirname(previous.directory) !== path.resolve(this.output) ||
      !path.basename(previous.directory).startsWith('facebook-draft-isolated-')
    )
      throw Error('PREVIOUS_DRAFT_SCOPE');
    // Read the previous diagnostic without migration, recovery or releasing its original lock.
    const db = new DatabaseSync(path.join(previous.directory, 'workspace.sqlite'), {
      readOnly: true,
    });
    let bindings: ReturnType<typeof DispatchBinding.parse>[] = [];
    let proof: ReturnType<typeof OwnedTabProof.parse>;
    try {
      const planId = previous.cases[0]?.planId;
      if (!planId) throw Error('PREVIOUS_DRAFT_PLAN_REQUIRED');
      const rows = db
        .prepare(
          'SELECT o.id,o.status,b.body AS binding,p.purpose FROM task_outbox o JOIN task_dispatch_bindings b ON b.operation_id=o.id JOIN material_post_operations p ON p.operation_id=o.id WHERE o.job_id=? ORDER BY o.created_at,o.rowid',
        )
        .all(planId);
      if (
        rows.length !== 2 ||
        rows.some(
          (row, i) =>
            row.status !== 'VERIFIED' ||
            row.id !==
              ['e661cd35-c9e3-4d80-b239-ed081e4096ec', '7ffed89c-e7aa-4dab-b0b7-39c6e326be3b'][i] ||
            row.purpose !== ['OPEN_COMPOSER', 'SET_TEXT'][i],
        )
      )
        throw Error('PREVIOUS_DRAFT_VERIFIED_OPERATIONS_REQUIRED');
      bindings = rows.map((row) => DispatchBinding.parse(JSON.parse(String(row.binding))));
      const tabs = db.prepare('SELECT proof FROM task_tab_ownership WHERE job_id=?').all(planId);
      if (tabs.length !== 1) throw Error('PREVIOUS_DRAFT_SINGLE_PROOF_REQUIRED');
      proof = OwnedTabProof.parse(JSON.parse(String(tabs[0]?.proof)));
      if (
        proof.tabId !== 274921806 ||
        bindings.some((b) => b.profileId !== profileId || b.accountId !== accountId)
      )
        throw Error('PREVIOUS_DRAFT_BINDING_SCOPE');
    } finally {
      db.close();
    }
    await this.kernel.withSummary(peer, async (summary) => {
      await guard();
      const inventory = await summary.inventory();
      await guard();
      if (
        !inventory.tabs.some(
          (t) => t.state === 'CLOSED' && t.proof && sameTabProof(t.proof, proof),
        ) ||
        bindings.some(
          (b) =>
            !inventory.operations.some(
              (op) => op.state === 'RECONCILED' && sameBinding(op.binding, b),
            ),
        )
      )
        throw Error('PREVIOUS_TEXT_NATIVE_CLOSED_AND_SETTLED_REQUIRED');
      await writeFile(
        path.join(this.output, 'facebook-text-draft-independent-close-0312.json'),
        JSON.stringify(
          {
            state: 'PASSED',
            proof,
            bindings,
            nativeClosed: inventory.tabs.find((t) => t.proof && sameTabProof(t.proof, proof)),
            originalControlNotPromoted: true,
            originalAccountLockPreserved: true,
            newPosts: 0,
            inputs: 0,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    });
  }
}
