import { someAsync } from '../shared/async-collections.js';
import type { WorkspaceStorePort } from './persistence-port.js';
import type { Awaitable } from '../domain/persistence.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { KernelBridge } from './kernel-bridge.js';
import type { Peer } from '../bridge/core.js';
import { WorkspaceStore } from './workspace-store.js';
import { sameBinding, sameExecution } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { FacebookPostEffects } from '../shared/facebook-post-observation.js';
import { observedMediaUpload } from '../domain/facebook-post-effects.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';

// Only this newly authorized single-image diagnostic is eligible. Re-evaluate the
// independently captured pre-close DOM after fixing the cleared-FileList predicate.
// This port never opens a page, uploads, inputs, releases another plan or retries a post.
export async function recoverSingleImageDraft(
  kernel: KernelBridge,
  peer: Peer,
  output: string,
  guard: () => Awaitable<void>,
) {
  const target = path.join(output, 'facebook-single-image-draft-reviewed-0312.json');
  await writeFile(target, JSON.stringify({ state: 'RUNNING', newPosts: 0 }), { flag: 'wx' });
  let store: WorkspaceStorePort | null = null;
  const evidence: Record<string, unknown> = {};
  let failure: string | null = null;
  try {
    const sourceBytes = await readFile(
      path.join(output, 'facebook-managed-remaining-media-drafts-0312-live.json'),
    );
    const source = z
      .object({
        state: z.literal('FAILED_OR_BLOCKED'),
        reason: z.literal('DRAFT_INDEPENDENT_EFFECT_REQUIRED:UPLOAD_MEDIA'),
        batchId: z.literal('bb7a4a03-c2cd-49f9-a67d-c54c00c6a413'),
        profileId: z.literal('2b32bd78-51d0-4576-a12b-252c4d3c2d9b'),
        accountId: z.literal('10000000000001'),
        extensionVersion: z.literal('0.3.12'),
        scope: z.literal('draft-only'),
        newPosts: z.literal(0),
        directory: z.string(),
        cases: z
          .array(
            z.object({
              ordinal: z.literal(2),
              format: z.literal('single-image'),
              planId: z.literal('7b4eb202-e5f5-4a88-8d6a-3ccf540e872b'),
              attemptId: z.literal('7e37f0eb-ae99-4403-b51f-309ce77d78e9'),
              lastMediaObservation: z
                .object({
                  checkedAt: z.string().datetime(),
                  url: z.literal('https://www.facebook.com/post/create'),
                  timeOrigin: FacebookPostEffects.shape.timeOrigin,
                  ready: z.literal('complete'),
                  composer: FacebookPostEffects.shape.composer,
                })
                .strict(),
            }),
          )
          .length(1),
      })
      .parse(JSON.parse(sourceBytes.toString('utf8')));
    const item = source.cases[0];
    if (
      !item ||
      peer.profileId !== source.profileId ||
      path.dirname(source.directory) !== path.resolve(output) ||
      !path.basename(source.directory).startsWith('facebook-draft-isolated-')
    )
      throw Error('SINGLE_DRAFT_EXACT_SCOPE_REQUIRED');
    store = await WorkspaceStore.open(path.join(source.directory, 'workspace.sqlite'));
    const workspace = store;
    const plan = await workspace.tasks.get(item.planId);
    const operations = await workspace.tasks.operations(plan.id);
    const operation = operations[2];
    const tab = (await workspace.taskTabs.forPlan(plan.id))[0];
    const control = (await workspace.taskControls.list()).find(
      (row) => row.binding.jobId === plan.id,
    );
    if (
      operations.length !== 3 ||
      (await someAsync(
        operations,
        async (op, i) =>
          op.id !==
            [
              '273982c2-a5dc-46c1-998b-7404d1b66317',
              'f7fcbd22-5a22-4cb8-884f-0bb5065942e2',
              'e29024c0-dc92-4244-8bd1-0ad737d60c82',
            ][i] ||
          op.status !== (i === 2 ? 'UNKNOWN' : 'VERIFIED') ||
          (await workspace.materialPosts.link(op.id)).purpose !==
            ['OPEN_COMPOSER', 'SET_TEXT', 'UPLOAD_MEDIA'][i],
      )) ||
      !operation?.binding ||
      operation.action.kind !== 'uploadMedia' ||
      !tab ||
      (await workspace.taskTabs.forPlan(plan.id)).length !== 1 ||
      tab.proof.tabId !== 274921810 ||
      !control?.receipt ||
      control.receipt.state !== 'stopped' ||
      !plan.controlConfirmed ||
      plan.state !== 'REVIEW' ||
      control.receipt.requestId !== plan.controlRequestId ||
      !sameExecution(control.receipt, operation.binding) ||
      Date.parse(item.lastMediaObservation.checkedAt) < operation.createdAt
    )
      throw Error('SINGLE_DRAFT_ORIGINAL_OPERATIONS_AND_STOP_REQUIRED');
    const binding = operation.binding;
    const held = await workspace.materials.reservation(item.attemptId);
    if (
      (await workspace.materialPosts.link(operation.id)).attemptId !== item.attemptId ||
      held.intent.snapshot.format !== 'single-image' ||
      held.intent.context.accountId !== source.accountId ||
      !sameTabProof(held.intent.proof, tab.proof)
    )
      throw Error('SINGLE_DRAFT_ORIGINAL_RESERVATION_REQUIRED');
    const stage = (await workspace.uploadStages.list()).find(
      (row) =>
        row.state === 'READY' &&
        row.owner.attemptId === item.attemptId &&
        sameBinding(row.owner.binding, binding),
    );
    const manifest = stage?.manifest;
    if (!manifest) throw Error('SINGLE_DRAFT_ORIGINAL_STAGE_REQUIRED');
    await workspace.uploadStages.assertReady(manifest);
    const reading = item.lastMediaObservation;
    const media = observedMediaUpload(
      FacebookPostEffects.parse({
        url: reading.url,
        timeOrigin: reading.timeOrigin,
        ready: reading.ready,
        composer: reading.composer,
        posts: [],
      }),
      held.intent,
      manifest,
    );
    if (
      !media ||
      !item.lastMediaObservation.composer ||
      item.lastMediaObservation.composer.files.length !== 0
    )
      throw Error('SINGLE_DRAFT_INDEPENDENT_DECODED_STAGE_NAME_REQUIRED');
    await guard();
    await kernel.withSummary(peer, async (summary) => {
      await guard();
      const inventory = await summary.inventory();
      await guard();
      const native = inventory.operations.filter((op) => op.binding.jobId === plan.id);
      if (
        native.length !== 3 ||
        operations.some(
          (op) =>
            !op.binding ||
            !native.some(
              (row) =>
                sameBinding(row.binding, op.binding ?? binding) &&
                row.state === (op.id === operation.id ? 'ACKNOWLEDGED' : 'RECONCILED'),
            ),
        ) ||
        !inventory.tabs.some(
          (row) => row.state === 'CLOSED' && row.proof && sameTabProof(row.proof, tab.proof),
        )
      )
        throw Error('SINGLE_DRAFT_CURRENT_NATIVE_CLOSED_AND_ORIGINAL_ACK_REQUIRED');
      evidence.sourceReportSha256 = createHash('sha256').update(sourceBytes).digest('hex');
      evidence.originalStop = control;
      evidence.nativeClosed = inventory.tabs.find(
        (row) => row.proof && sameTabProof(row.proof, tab.proof),
      );
      evidence.independentPreCloseMedia = item.lastMediaObservation;
      await workspace.materialPosts.reconcile({
        binding,
        evidence: {
          kind: 'material-post-verification',
          independent: true,
          attemptId: held.intent.attemptId,
          fingerprint: held.intent.fingerprint,
          purpose: 'UPLOAD_MEDIA',
          proof: tab.proof,
          observedAccountId: binding.accountId,
          observationId: randomUUID(),
          checkedAt: item.lastMediaObservation.checkedAt,
          outcome: 'APPLIED',
          basis: 'media-upload-observed',
          postId: null,
          media,
        },
      });
      await new SettlementNotifier(workspace.tasks.settlements).flushOne(summary);
      await guard();
      if (
        (await workspace.tasks.settlements.list(peer.profileId)).some(
          (n) => n.state !== 'DELIVERED',
        )
      )
        throw Error('SINGLE_DRAFT_ORIGINAL_NOTIFICATION_REQUIRED');
      const fresh = await summary.inventory();
      await guard();
      await workspace.taskTabs.confirmClosed(tab.proof.ownershipId, tab.revision, fresh);
      await workspace.materialPosts.resolveNotPublished({
        kind: 'material-post-verification',
        independent: true,
        attemptId: held.intent.attemptId,
        fingerprint: held.intent.fingerprint,
        proof: tab.proof,
        observedAccountId: binding.accountId,
        observationId: randomUUID(),
        checkedAt: new Date().toISOString(),
        outcome: 'NOT_PUBLISHED',
        basis: 'independently-verified-not-published',
      });
      evidence.operations = await workspace.tasks.operations(plan.id);
      evidence.plan = await workspace.tasks.get(plan.id);
      evidence.tabs = await workspace.taskTabs.forPlan(plan.id);
      evidence.reservation = await workspace.materials.reservation(item.attemptId);
      evidence.notifications = await workspace.tasks.settlements.list(peer.profileId);
      if ((await workspace.tasks.get(plan.id)).state !== 'STOPPED')
        throw Error('SINGLE_DRAFT_ORIGINAL_STOPPED_REQUIRED');
    });
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 200) : 'SINGLE_DRAFT_REVIEW_FAILED';
  } finally {
    await store?.close();
  }
  await writeFile(
    target,
    JSON.stringify(
      {
        state: failure ? 'FAILED_OR_BLOCKED' : 'PASSED',
        reason: failure,
        evidence,
        inputRPCs: 0,
        uploadsReplayed: false,
        newPosts: 0,
        oldUnknownModified: false,
        oldTextControlAndLockModified: false,
        managedPublisherAcceptance: false,
      },
      null,
      2,
    ),
  );
  if (failure) throw Error(failure);
}
