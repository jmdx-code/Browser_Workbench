import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceStore } from '../../src/infrastructure/workspace-store.js';
import { FilesystemMaterialScanner } from '../../src/infrastructure/material-scanner.js';
import {
  DirectoryMaterialPostIntent,
  type Catalog,
  type ReservationRequest,
} from '../../src/shared/material-index.js';
import type { RuntimeProfile } from '../../src/domain/tasks.js';
import type { VerifiedPostReceipt, PreparePost } from '../../src/shared/material-post.js';
import { settlementFixture } from './settlement.js';
import { DatabaseSync } from 'node:sqlite';
import type { Step } from '../../src/shared/contracts.js';
export const directoryIntent = (store: WorkspaceStore, attemptId: string) =>
  DirectoryMaterialPostIntent.parse(store.materials.reservation(attemptId).intent);

export async function postFixture(
  work: (store: WorkspaceStore, file: string, catalog: Catalog) => void | Promise<void>,
  historicalArchive = true,
) {
  await settlementFixture(async (store, file) => {
    // These fixtures retain historical archive transaction/IO regressions. Product defaults
    // are source-retaining; new policy tests explicitly use that production default.
    const legacy = new DatabaseSync(file);
    if (historicalArchive)
      legacy.exec("UPDATE material_usage_policy SET file_policy='archive-test' WHERE id=1");
    legacy.close();
    const root = path.join(path.dirname(file), 'generated-post-materials');
    await mkdir(root);
    await writeFile(path.join(root, 'text.txt'), '生成发布事务测试正文');
    await writeFile(path.join(root, 'copy.txt'), '生成发布事务测试正文');
    await writeFile(path.join(root, 'other.txt'), '不同内容');
    const catalog = store.materials.index(
      await new FilesystemMaterialScanner().scan(root),
      randomUUID(),
    );
    await work(store, file, catalog);
  });
}
export function postRequest(
  store: WorkspaceStore,
  catalog: Catalog,
  options: {
    accountId?: string;
    allowRepeat?: boolean;
    source?: string;
    count?: number;
    followingSteps?: Step[];
    destination?: 'post' | 'story';
    audience?: 'preserve-current' | 'self' | 'friends';
  } = {},
): ReservationRequest {
  const id = randomUUID(),
    accountId = options.accountId ?? 'fixture-post-account-' + randomUUID(),
    profile: RuntimeProfile = {
      id,
      online: true,
      synced: true,
      unresolved: 0,
      dispatchAllowed: true,
      account: { state: 'logged-in', id: accountId, name: null, avatar: null },
    };
  const saved = store.createCombination({
    name: '发布事务隔离测试',
    note: '模拟身份与页面证据，无浏览器输入',
    steps: [
      {
        id: randomUUID(),
        type: 'post',
        ...(options.destination ? { destination: options.destination } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
        resourceDirectory: catalog.directory,
        count: options.count ?? 1,
        allowRepeat: options.allowRepeat ?? false,
        forbidSameAccountRepeat: true,
        archivePublished: true,
      },
      ...(options.followingSteps ?? []),
    ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  });
  store.tasks.assign(
    { requestId: randomUUID(), combinationId: saved.id, version: 1, profileIds: [id] },
    [profile],
  );
  const plan = store.tasks.claimNext([profile], new Set(['post', 'feed', 'video', 'marketplace']));
  assert.ok(plan);
  const step = store.tasks.steps(plan.id)[0],
    source = catalog.sources.find((row) => row.snapshot.source === (options.source ?? 'text.txt'));
  assert.ok(step && source);
  const context = {
      profileId: id,
      accountId,
      connectionEpoch: randomUUID(),
      leaseId: randomUUID(),
      generation: 0,
    },
    proof = {
      profileId: id,
      ownershipId: randomUUID(),
      browserSessionEpoch: randomUUID(),
      tabId: 42,
      targetId: randomUUID(),
    };
  store.taskTabs.register(plan.id, proof, context);
  return {
    attemptId: randomUUID(),
    jobId: plan.id,
    stepId: step.id,
    expectedProgressRevision: 0,
    catalogId: catalog.id,
    sourceId: source.id,
    context,
    proof,
  };
}
export function postAction(
  store: WorkspaceStore,
  r: ReservationRequest,
  purpose: PreparePost['purpose'] = 'SUBMIT',
): PreparePost {
  const intent = store.materials.reservation(r.attemptId).intent,
    fields = {
      tabId: r.proof.tabId,
      documentEpoch: 0,
      routeEpoch: 0,
      target: { css: '#fixture-' + purpose },
    };
  return {
    attemptId: r.attemptId,
    operationId: randomUUID(),
    purpose,
    action:
      purpose === 'PREPARE_HOME'
        ? { kind: 'browseNavigate', tabId: r.proof.tabId, url: 'https://www.facebook.com/' }
        : purpose === 'SET_TEXT'
          ? { kind: 'typeText', ...fields, text: intent.snapshot.text }
          : purpose === 'UPLOAD_MEDIA'
            ? {
                kind: 'uploadMedia',
                ...fields,
                attemptId: intent.attemptId,
                fingerprint: intent.fingerprint,
              }
            : { kind: 'click', ...fields },
  };
}
export function dispatchedPost(
  store: WorkspaceStore,
  r: ReservationRequest,
  purpose: PreparePost['purpose'] = 'SUBMIT',
) {
  const prepared = postAction(store, r, purpose);
  store.materialPosts.prepare(prepared);
  const operation = store.tasks.takeBoundOperation(r.context);
  assert.ok(operation?.binding);
  assert.equal(operation.id, prepared.operationId);
  return { prepared, binding: operation.binding };
}
export function postReceipt(
  store: WorkspaceStore,
  r: ReservationRequest,
  operation: ReturnType<typeof dispatchedPost>,
  outcome: VerifiedPostReceipt['evidence']['outcome'] = operation.prepared.purpose === 'SUBMIT'
    ? 'PUBLISHED'
    : 'APPLIED',
): VerifiedPostReceipt {
  const snapshot = store.materials.reservation(r.attemptId).intent.snapshot;
  return {
    binding: operation.binding,
    evidence: {
      kind: 'material-post-verification',
      independent: true,
      attemptId: r.attemptId,
      fingerprint: store.materials.reservation(r.attemptId).intent.fingerprint,
      purpose: operation.prepared.purpose,
      proof: r.proof,
      observedAccountId: r.context.accountId,
      observationId: randomUUID(),
      checkedAt: new Date().toISOString(),
      outcome,
      basis:
        outcome === 'PUBLISHED'
          ? 'own-post-observed'
          : outcome === 'NOT_PUBLISHED'
            ? 'submission-confirmed-not-published'
            : outcome === 'APPLIED'
              ? operation.prepared.purpose === 'UPLOAD_MEDIA'
                ? 'media-upload-observed'
                : operation.prepared.purpose === 'PREPARE_HOME'
                  ? 'page-preparation-observed'
                  : 'composer-effect-observed'
              : 'verified-action-not-applied',
      postId: outcome === 'PUBLISHED' ? 'fixture-post-' + randomUUID() : null,
      ...(operation.prepared.purpose === 'UPLOAD_MEDIA' &&
      outcome === 'APPLIED' &&
      snapshot.format !== 'text'
        ? {
            media: {
              ready: true as const,
              format: snapshot.format,
              count: snapshot.files.filter((file) => file.role !== 'text').length,
            },
          }
        : {}),
    },
  };
}
export function deliverPostNotices(store: WorkspaceStore, profileId: string) {
  let notice = store.tasks.settlements.claim(profileId);
  while (notice) {
    assert.ok(notice.claimToken);
    store.tasks.settlements.delivered(notice.binding.operationId, notice.claimToken, {
      binding: notice.binding,
      resolution: notice.resolution,
    });
    notice = store.tasks.settlements.claim(profileId);
  }
}
