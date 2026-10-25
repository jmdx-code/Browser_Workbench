import { filterAsync } from '../shared/async-collections.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Plan, Assignment } from '../shared/task-contracts.js';
import type { Combination } from '../shared/contracts.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import type { ResourceRowValue } from '../shared/resource-table.js';
import type { FacebookPostOriginal } from '../domain/facebook-post-execution.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const media = z
  .object({
    source: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => path.isAbsolute(value)),
    role: z.enum(['image', 'video']),
    digest,
    bytes: z.number().int().positive(),
  })
  .strict();
const resource = z
  .object({
    rowId: z.uuid(),
    textSha256: digest,
    format: z.enum(['text', 'single-image', 'multi-image', 'video']),
    media: z.array(media).max(20),
  })
  .strict()
  .refine((value) => {
    const roles = value.media.map((file) => file.role);
    return value.format === 'text'
      ? roles.length === 0
      : value.format === 'video'
        ? roles.length === 1 && roles[0] === 'video'
        : roles.every((role) => role === 'image') &&
          (value.format === 'single-image' ? roles.length === 1 : roles.length >= 2);
  }, 'FORMAT_MEDIA_MISMATCH');

// A finite test authorization, not a task/publication ledger. Original batch idempotency,
// fixed resources, actors and SUBMIT uniqueness still own all execution and consumption.
export const PublicationAcceptanceScope = z
  .object({
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
    ]),
    id: z.uuid(),
    profileId: z.uuid(),
    combinationId: z.uuid(),
    combinationVersion: z.number().int().positive(),
    resourceRevision: z.number().int().positive(),
    audience: z.enum(['SELF', 'FRIENDS']),
    background: z.literal('color').optional(),
    accountId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
    maximumPublications: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    submitDisabled: z.literal(true).optional(),
    previousPlanId: z.uuid().optional(),
    previousSingleImagePlanId: z.uuid().optional(),
    resources: z.array(resource).min(1).max(4),
  })
  .strict()
  .refine(
    (value) =>
      value.resources.length === value.maximumPublications &&
      new Set(value.resources.map((row) => row.rowId)).size === value.resources.length &&
      (value.version === 7
        ? value.audience === 'SELF' &&
          value.accountId !== undefined &&
          value.background === undefined &&
          value.previousPlanId === undefined &&
          value.previousSingleImagePlanId === undefined &&
          new Set(value.resources.map((row) => row.format)).size === value.maximumPublications
        : value.version === 5
          ? value.audience === 'SELF' &&
            value.accountId !== undefined &&
            value.background === 'color' &&
            value.maximumPublications === 1 &&
            value.resources[0]?.format === 'text' &&
            value.previousPlanId === undefined &&
            value.previousSingleImagePlanId === undefined
          : value.background === undefined &&
            (value.version === 4 || value.version === 6
              ? value.audience === 'FRIENDS' &&
                value.accountId !== undefined &&
                value.maximumPublications === 1 &&
                (value.version === 4
                  ? value.resources[0]?.format === 'text'
                  : ['single-image', 'video'].includes(value.resources[0]?.format ?? '')) &&
                value.previousPlanId === undefined &&
                value.previousSingleImagePlanId === undefined
              : value.audience === 'SELF' &&
                value.accountId === undefined &&
                (value.version === 3
                  ? value.maximumPublications === 2 &&
                    value.previousPlanId !== undefined &&
                    value.previousSingleImagePlanId !== undefined &&
                    value.previousPlanId !== value.previousSingleImagePlanId &&
                    value.resources[0]?.format === 'multi-image' &&
                    value.resources[1]?.format === 'video'
                  : value.version === 2
                    ? value.maximumPublications === 3 &&
                      value.previousPlanId !== undefined &&
                      value.previousSingleImagePlanId === undefined &&
                      new Set(value.resources.map((row) => row.format)).size === 3 &&
                      value.resources.every((row) => row.format !== 'text')
                    : value.previousPlanId === undefined &&
                      value.previousSingleImagePlanId === undefined &&
                      (value.maximumPublications === 1
                        ? value.resources[0]?.format === 'text'
                        : value.maximumPublications === 4 &&
                          new Set(value.resources.map((row) => row.format)).size === 4)))),
    'FINITE_AUTHORIZATION_INVALID',
  );
export type PublicationScope = z.infer<typeof PublicationAcceptanceScope>;
function combinationAllowed(scope: PublicationScope, snapshot: Combination) {
  const posts = snapshot.steps.filter((step) => step.type === 'post');
  return (
    snapshot.loop.mode === 'finite' &&
    snapshot.loop.rounds === 1 &&
    !snapshot.randomOrder &&
    posts.length === scope.maximumPublications &&
    snapshot.steps.length <= posts.length + 1 &&
    posts.every(
      (step) =>
        step.count === 1 &&
        step.audience === ([4, 6].includes(scope.version) ? 'friends' : 'self') &&
        step.resourceMode === 'table' &&
        ([4, 6].includes(scope.version)
          ? step.destination === 'story'
          : step.destination !== 'story') &&
        !step.allowRepeat,
    ) &&
    snapshot.steps.every(
      (step) =>
        step.type === 'post' ||
        (![4, 6].includes(scope.version) &&
          step.type === 'feed' &&
          step.durationMinutes <= 2 &&
          step.maxLikes === 0),
    )
  );
}
const textDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
async function predecessorAllowed(
  store: WorkspaceStore,
  scope: PublicationScope,
  accountId?: string | null,
) {
  if ([1, 4, 5, 6, 7].includes(scope.version)) return true;
  if (!scope.previousPlanId) return false;
  const previous = await store.tasks.get(scope.previousPlanId);
  if (
    previous.profileId !== scope.profileId ||
    previous.state !== 'FAILED' ||
    !previous.controlConfirmed ||
    !(await store.tasks.endingId(previous.id)) ||
    !previous.accountId ||
    (accountId && accountId !== previous.accountId) ||
    !previous.snapshot.steps.every((step) => step.type === 'post')
  )
    return false;
  const submitted = await filterAsync(
    await store.tasks.operations(previous.id),
    async (operation) => (await store.materialPosts.link(operation.id)).purpose === 'SUBMIT',
  );
  if (submitted.length !== 1) return false;
  const operation = submitted[0];
  if (!operation?.binding || operation.binding.profileId !== scope.profileId) return false;
  const link = await store.materialPosts.link(operation.id),
    intent = (await store.materials.reservation(link.attemptId)).intent;
  const textAllowed =
    intent.snapshot.format === 'text' &&
    intent.context.accountId === previous.accountId &&
    scope.resources.every((row) => row.textSha256 === textDigest(intent.snapshot.text));
  if (!textAllowed || scope.version !== 3) return textAllowed;
  if (!scope.previousSingleImagePlanId) return false;
  const single = await store.tasks.get(scope.previousSingleImagePlanId);
  if (
    single.profileId !== scope.profileId ||
    single.accountId !== previous.accountId ||
    single.state !== 'FAILED' ||
    single.reason !== 'PUBLISH_RESULT_UNCONFIRMED' ||
    !(await store.tasks.endingId(single.id)) ||
    !single.snapshot.steps.every((step) => step.type === 'post')
  )
    return false;
  const singleSubmits = await filterAsync(
    await store.tasks.operations(single.id),
    async (operation) => (await store.materialPosts.link(operation.id)).purpose === 'SUBMIT',
  );
  if (singleSubmits.length !== 1 || !singleSubmits[0]?.binding) return false;
  const singleLink = await store.materialPosts.link(singleSubmits[0].id);
  const held = await store.materials.reservation(singleLink.attemptId);
  return (
    held.state === 'REVIEW' &&
    held.intent.snapshot.format === 'single-image' &&
    held.intent.context.profileId === scope.profileId &&
    held.intent.context.accountId === previous.accountId &&
    textDigest(held.intent.snapshot.text) === textDigest(intent.snapshot.text)
  );
}
function rowAllowed(
  expected: PublicationScope['resources'][number],
  row: ResourceRowValue,
  story = false,
  background: 'plain' | 'color' = 'plain',
) {
  return (
    row.id === expected.rowId &&
    row.background === background &&
    (story ? row.purpose === 'story' : row.purpose !== 'story') &&
    textDigest(row.text) === expected.textSha256 &&
    row.media.length === expected.media.length &&
    row.media.every(
      (file, index) =>
        file.kind === 'local' &&
        file.source === expected.media[index]?.source &&
        file.mediaType === expected.media[index]?.role,
    )
  );
}
async function resourceAllowed(store: WorkspaceStore, scope: PublicationScope) {
  const table = await store.resourceTables.readVersion(scope.combinationId, scope.resourceRevision);
  return (
    table.rows.length === scope.resources.length &&
    table.rows.every((row, index) => {
      const expected = scope.resources[index];
      return (
        expected !== undefined &&
        rowAllowed(expected, row, [4, 6].includes(scope.version), scope.background)
      );
    })
  );
}
export async function publicationAssignmentAllowed(
  store: WorkspaceStore,
  scope: PublicationScope,
  request: Assignment,
  snapshot: Combination,
) {
  return (
    request.requestId === scope.id &&
    request.profileIds.length === 1 &&
    request.profileIds[0] === scope.profileId &&
    request.combinationId === scope.combinationId &&
    request.version === scope.combinationVersion &&
    request.expectedResourceRevision === scope.resourceRevision &&
    !request.timing &&
    (await predecessorAllowed(store, scope)) &&
    combinationAllowed(scope, snapshot) &&
    (await resourceAllowed(store, scope))
  );
}
export async function publicationPlanAllowed(
  store: WorkspaceStore,
  scope: PublicationScope,
  plan: Plan,
) {
  const binding = await store.tasks.resources.binding(plan.id);
  return (
    plan.batchId === scope.id &&
    plan.profileId === scope.profileId &&
    (!scope.accountId || plan.accountId === null || plan.accountId === scope.accountId) &&
    plan.combinationId === scope.combinationId &&
    plan.version === scope.combinationVersion &&
    binding?.resourceRevision === scope.resourceRevision &&
    (await predecessorAllowed(store, scope, plan.accountId)) &&
    combinationAllowed(scope, plan.snapshot) &&
    (await resourceAllowed(store, scope))
  );
}
export function publicationOriginalAllowed(
  scope: PublicationScope,
  plan: Plan,
  original: FacebookPostOriginal,
) {
  const intent = original.intent;
  if (scope.submitDisabled && original.link.purpose === 'SUBMIT') return false;
  if (
    intent.directory !== null ||
    intent.jobId !== plan.id ||
    intent.context.profileId !== scope.profileId ||
    (scope.accountId !== undefined && intent.context.accountId !== scope.accountId) ||
    intent.resource.combinationId !== scope.combinationId ||
    intent.resource.revision !== scope.resourceRevision ||
    intent.allowRepeat
  )
    return false;
  const expected = scope.resources.find((row) => row.rowId === intent.resource.row.id);
  const postIndex =
    plan.snapshot.steps.slice(0, plan.position + 1).filter((step) => step.type === 'post').length -
    1;
  if (scope.resources[postIndex]?.rowId !== expected?.rowId) return false;
  if (
    !expected ||
    !rowAllowed(expected, intent.resource.row, [4, 6].includes(scope.version), scope.background) ||
    intent.snapshot.format !== expected.format ||
    textDigest(intent.snapshot.text) !== expected.textSha256 ||
    (intent.snapshot.downloads?.length ?? 0) !== 0
  )
    return false;
  const files = intent.snapshot.files.filter((file) => file.role !== 'text');
  return (
    files.length === expected.media.length &&
    files.every(
      (file, index) =>
        file.role === expected.media[index]?.role &&
        file.digest === expected.media[index]?.digest &&
        file.bytes === expected.media[index]?.bytes,
    )
  );
}
