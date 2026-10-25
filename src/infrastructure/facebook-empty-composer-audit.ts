import type { Awaitable } from '../domain/persistence.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StepExecution } from '../domain/browse-execution.js';
import type { AdmittedTaskRuntime } from '../application/admitted-task-runtime.js';
import { TaskDispatcher } from '../application/task-dispatcher.js';
import { SettlementNotifier } from '../application/settlement-notifier.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import type { KernelManagedFacebookSession } from './kernel-managed-facebook-session.js';
import { FilesystemMaterialScanner } from './material-scanner.js';
import { FacebookPostStepExecutor } from './facebook-post-step-executor.js';

// Explicit diagnostic scope: one original OPEN_COMPOSER operation, then independent
// empty-window verification, original notification and exact owner shutdown. No runner
// is started: the next SET_TEXT decision must never reach the native transport.
export async function auditEmptyFacebookComposer(
  store: WorkspaceStore,
  runtime: AdmittedTaskRuntime,
  managed: KernelManagedFacebookSession,
  execution: StepExecution,
  guard: () => Awaitable<void>,
) {
  if (execution.step.spec.type !== 'post') throw Error('EMPTY_COMPOSER_POST_STEP_REQUIRED');
  await guard();
  const directory = execution.step.spec.resourceDirectory;
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'readonly-preparation.txt'),
    '仅用于原素材事务准备，不填写、不上传、不发布。',
    { flag: 'wx' },
  );
  await guard();
  const catalog = await store.materials.index(
    await new FilesystemMaterialScanner().scan(directory),
    randomUUID(),
  );
  await guard();
  const executor = new FacebookPostStepExecutor(
    store.tasks,
    store.materialPosts,
    {
      // This finite diagnostic supports only OPEN. It does not advertise a production
      // business observer or grant any upload/submission capability.
      ready: () => true,
      catalogId: () => catalog.id,
      read: (current, assertCurrent) => managed.readPostPage(current, assertCurrent),
      verifyBusiness: async () => {
        throw Error('EMPTY_COMPOSER_BUSINESS_INPUT_FORBIDDEN');
      },
    },
    randomUUID,
  );
  const first = await executor.decide(execution, [], guard);
  if (first.kind !== 'reserve-next') throw Error('EMPTY_COMPOSER_RESERVATION_REQUIRED');
  const held = await store.materials.reserveNext(first.request);
  const next = await executor.decide(execution, [held], guard);
  if (
    next.kind !== 'action' ||
    next.operation.purpose !== 'OPEN_COMPOSER' ||
    next.operation.action.kind !== 'click'
  )
    throw Error('EMPTY_COMPOSER_OPEN_ONLY');
  if ((await store.tasks.operations(execution.plan.id)).length)
    throw Error('EMPTY_COMPOSER_EXISTING_OPERATION');
  const prepared = await store.materialPosts.prepare(next.operation);
  const dispatched = await new TaskDispatcher(store.tasks, runtime).flushOne(
    execution.plan.profileId,
  );
  await guard();
  const operation = (await store.tasks.operations(execution.plan.id)).find(
    (op) => op.id === prepared.id,
  );
  if (!dispatched || operation?.status !== 'ACKNOWLEDGED' || !operation.binding)
    throw Error('EMPTY_COMPOSER_OPEN_ACK_REQUIRED');
  let verdict = await executor.verify(
    execution,
    { ...operation, binding: operation.binding },
    { link: await store.materialPosts.link(operation.id), intent: held.intent },
    guard,
  );
  for (let i = 0; verdict.kind === 'wait' && i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await guard();
    verdict = await executor.verify(
      execution,
      { ...operation, binding: operation.binding },
      { link: await store.materialPosts.link(operation.id), intent: held.intent },
      guard,
    );
  }
  if (
    verdict.kind !== 'verified' ||
    verdict.receipt.evidence.purpose !== 'OPEN_COMPOSER' ||
    verdict.receipt.evidence.outcome !== 'APPLIED'
  )
    throw Error('EMPTY_COMPOSER_EFFECT_UNCONFIRMED');
  await store.materialPosts.verify(verdict.receipt);
  const reading = await managed.readPostPage(
    {
      ...execution,
      step:
        (await store.tasks.steps(execution.plan.id)).find((s) => s.id === execution.step.id) ??
        execution.step,
    },
    guard,
  );
  if (!reading.surface || reading.text !== '') throw Error('EMPTY_COMPOSER_NOT_EMPTY');
  const structure = await managed.readEmptyPostStructure(execution, guard);
  if (
    structure.url !== reading.url ||
    structure.timeOrigin !== reading.timeOrigin ||
    structure.roots !== 1 ||
    structure.truncated
  )
    throw Error('EMPTY_COMPOSER_STRUCTURE_DOCUMENT_CHANGED');
  await new SettlementNotifier(store.tasks.settlements).flushOne(managed);
  await guard();
  if (
    (await store.tasks.settlements.list(execution.plan.profileId)).some(
      (n) => n.state !== 'DELIVERED',
    )
  )
    throw Error('EMPTY_COMPOSER_SETTLEMENT_UNCONFIRMED');
  const stopped = await runtime.control(execution.plan.id, 'stop', 'EMPTY_COMPOSER_AUDIT_COMPLETE');
  const tabs = await store.taskTabs.forPlan(execution.plan.id);
  if (!stopped.controlConfirmed || tabs.length !== 1 || tabs[0]?.state !== 'CLOSED')
    throw Error('EMPTY_COMPOSER_EXACT_NATIVE_CLOSE_REQUIRED');
  // This is a new isolated diagnostic attempt, not an old UNKNOWN. Independent empty
  // observation + sole verified OPEN + exact CLOSED/STOP proves no content was submitted.
  const operations = await store.tasks.operations(execution.plan.id);
  if (
    operations.length !== 1 ||
    operations[0]?.id !== operation.id ||
    operations[0].status !== 'VERIFIED'
  )
    throw Error('EMPTY_COMPOSER_UNEXPECTED_WRITE_OPERATION');
  await store.materialPosts.resolveNotPublished({
    kind: 'material-post-verification',
    independent: true,
    attemptId: held.intent.attemptId,
    fingerprint: held.intent.fingerprint,
    proof: reading.proof,
    observedAccountId: reading.observedAccountId,
    observationId: randomUUID(),
    checkedAt: new Date().toISOString(),
    outcome: 'NOT_PUBLISHED',
    basis: 'independently-verified-not-published',
  });
  return {
    emptyComposer: {
      url: reading.url,
      locale: reading.locale,
      surface: reading.surface,
      text: reading.text,
      structure,
    },
    operations: await store.tasks.operations(execution.plan.id),
    independentOpenVerdict: verdict.receipt,
    notifications: await store.tasks.settlements.list(execution.plan.profileId),
    reservation: await store.materials.reservation(held.intent.attemptId),
    attemptResult: await store.materialPosts.result(held.intent.attemptId),
    plan: await store.tasks.get(execution.plan.id),
    tabs,
    control: await store.taskControls.list(),
    newPosts: 0,
    contentInputs: 0,
    uploads: 0,
  };
}
