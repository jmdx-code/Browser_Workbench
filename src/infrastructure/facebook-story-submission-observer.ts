import { orderedNetworkEvents } from './ordered-network-events.js';
import type { Awaitable } from '../domain/persistence.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Page, Request, Response } from 'playwright-core';
import type { FacebookSubmissionInputObserver } from './facebook-submission-observer.js';
import type { FacebookPostBusinessObserver } from './facebook-managed-post-source.js';
import type { FacebookSubmissionObservationRepository } from '../domain/facebook-submission-observations.js';
import type {
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from '../domain/facebook-post-execution.js';
import { sameBinding, sameExecution } from '../shared/task-execution.js';
import { canonicalAction } from '../shared/browser-actions.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { readFacebookStoryPage } from './facebook-story-page-reader.js';
import type { PostExecutionVerdict } from '../shared/post-execution.js';
import { PostReceipt } from '../shared/material-post.js';
import {
  isNativeTextStoryRequest,
  isNativeMediaStoryRequest,
  parseNativeStoryCreation,
  readStoryPublishedNotice,
  nativeStoryResultURL,
  type NativeStoryCreation,
} from './facebook-story-native-result.js';
import { matchesOriginalStoryMedia } from '../domain/facebook-story-media.js';
import { matchesDerivedStoryCaption } from '../domain/facebook-story-video.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
// Diagnostic projection only, never publication evidence. Bodies, credentials, audience
// members and tracking strings are not logged. Only exact IDs, enum values and text hashes.
export function describeStoryNativeValue(value: unknown, depth = 0): unknown {
  if (depth > 7) return { type: 'depth-limit' };
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string')
    return { type: 'string', length: value.length, sha256: hash(value) };
  if (Array.isArray(value))
    return {
      length: value.length,
      items: value.slice(0, 4).map((item) => describeStoryNativeValue(item, depth + 1)),
    };
  if (!value || typeof value !== 'object') return { type: typeof value };
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (
      !/^[a-zA-Z_][a-zA-Z_\d]{0,63}$/.test(key) ||
      /auth|token|cookie|credential|dtsg|lsd|tracking|email|phone|picture/i.test(key)
    )
      continue;
    output[key] =
      typeof item === 'string' &&
      ((/^(?:id|.*_id)$/.test(key) && /^[a-zA-Z0-9+/=:._-]{1,200}$/.test(item)) ||
        (['__typename', 'base_state', 'type', 'source', 'privacy_type', 'publishing_flow'].includes(
          key,
        ) &&
          /^[A-Z_a-z]{1,64}$/.test(item)))
        ? item
        : describeStoryNativeValue(item, depth + 1);
  }
  return output;
}
function exactTextPaths(value: unknown, text: string): string[] {
  const found: string[] = [];
  let budget = 0;
  const visit = (input: unknown, path: string, depth: number) => {
    if (++budget > 500 || depth > 8 || found.length >= 4) return;
    if (input === text) {
      found.push(path);
      return;
    }
    if (Array.isArray(input))
      input.slice(0, 20).forEach((item, i) => visit(item, path + '.' + i, depth + 1));
    else if (input && typeof input === 'object')
      for (const [key, item] of Object.entries(input).slice(0, 60))
        if (/^[a-zA-Z_][a-zA-Z_\d]{0,63}$/.test(key) && !/auth|token|cookie|dtsg|lsd/i.test(key))
          visit(item, path + '.' + key, depth + 1);
  };
  visit(value, 'variables', 0);
  return found;
}
export function matchStoryResearchRequest(
  body: string,
  original: FacebookPostOriginal,
  expectedVideoId?: string,
) {
  if (
    body.length > 512 * 1024 ||
    original.link.purpose !== 'SUBMIT' ||
    !['text', 'single-image', 'video'].includes(original.intent.snapshot.format)
  )
    return null;
  try {
    const params = new URLSearchParams(body);
    if (
      ['av', 'variables', 'fb_api_req_friendly_name'].some(
        (key) => params.getAll(key).length !== 1,
      ) ||
      params.get('av') !== original.intent.context.accountId
    )
      return null;
    const name = params.get('fb_api_req_friendly_name') ?? '';
    if (!/^[A-Za-z_]{1,120}Mutation$/.test(name)) return null;
    const variables: unknown = JSON.parse(params.get('variables') ?? '');
    const paths = exactTextPaths(variables, original.intent.snapshot.text);
    const format = original.intent.snapshot.format;
    if (format !== 'text' && name !== 'StoriesCreateMutation') return null;
    if (format === 'text' && !paths.length) return null;
    return {
      name,
      accountId: original.intent.context.accountId,
      textSha256: hash(original.intent.snapshot.text),
      exactTextPaths: paths,
      variables: describeStoryNativeValue(variables),
      nativeStory:
        format === 'single-image' || format === 'video'
          ? isNativeMediaStoryRequest(
              body,
              original.intent.context.accountId,
              original.intent.snapshot.text,
              format,
              expectedVideoId,
            )
          : isNativeTextStoryRequest(
              body,
              original.intent.context.accountId,
              original.intent.snapshot.text,
            ),
    };
  } catch {
    return null;
  }
}

// One original submit: native creation correlation and its fresh final UI notice are both
// required. No response status, input ACK or own-story text alone can settle publication.
export class FacebookStorySubmissionObserver
  implements FacebookSubmissionInputObserver, FacebookPostBusinessObserver
{
  private active: {
    page: Page;
    operation: FacebookPostBoundOperation;
    original: FacebookPostOriginal;
    guard: () => Awaitable<void>;
    requests: Map<Request, ReturnType<typeof matchStoryResearchRequest>>;
    request: (request: Request) => Awaitable<void>;
    response: (response: Response) => Awaitable<void>;
    count: number;
    bytes: number;
    pending: Set<Promise<void>>;
    accepted: NativeStoryCreation | null;
    conflicting: boolean;
    timeOrigin: number;
    videoId: string | null;
  } | null = null;
  constructor(
    private readonly observations: FacebookSubmissionObservationRepository,
    private readonly diagnostic: (value: unknown) => void = () => {},
    private readonly read = readFacebookStoryPage,
  ) {}
  ready() {
    return true;
  }
  async prepare(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
    observeCurrent?: () => void,
    enableBuffers?: () => Promise<void>,
  ) {
    await guard();
    if (
      this.active ||
      original.link.purpose !== 'SUBMIT' ||
      operation.status !== 'DISPATCHING' ||
      operation.id !== original.link.operationId ||
      !sameExecution(operation.binding, original.intent.context) ||
      operation.binding.jobId !== original.intent.jobId ||
      operation.binding.stepId !== original.intent.stepId ||
      operation.binding.actionDigest !== hash(canonicalAction(original.link.action)) ||
      (await this.observations.get(operation.id))
    )
      throw Error('STORY_ORIGINAL_SUBMIT_REQUIRED');
    const story = await this.read(page, guard);
    await guard();
    if (
      !story.ready ||
      !story.visible ||
      (original.intent.snapshot.format === 'text'
        ? story.phase !== 'text-editor'
        : !matchesOriginalStoryMedia(story, original.intent) || story.textEditing) ||
      story.privacy?.phase !== 'CLOSED' ||
      (story.text !== original.intent.snapshot.text &&
        !matchesDerivedStoryCaption(story, original.intent)) ||
      !story.submit?.enabled
    )
      throw Error('STORY_SUBMISSION_NOT_READY');
    if (!enableBuffers) throw Error('NATIVE_BOUNDED_NETWORK_REQUIRED');
    if (original.intent.snapshot.format === 'video' && !story.videoTransfer)
      throw Error('STORY_ORIGINAL_VIDEO_TRANSFER_REQUIRED');
    await this.observations.capture({
      operationId: operation.id,
      binding: operation.binding,
      proof: original.intent.proof,
      attemptId: original.intent.attemptId,
      accountId: original.intent.context.accountId,
      fingerprint: original.intent.fingerprint,
      postIds: [],
      checkedAt: Date.now(),
      url: story.url,
      timeOrigin: story.timeOrigin,
    });
    await enableBuffers();
    await guard();
    const active: NonNullable<FacebookStorySubmissionObserver['active']> = {
      page,
      operation,
      original,
      guard: observeCurrent ?? guard,
      requests: new Map(),
      count: 0,
      bytes: 0,
      pending: new Set(),
      accepted: null,
      conflicting: false,
      timeOrigin: story.timeOrigin,
      videoId: story.videoTransfer?.videoId ?? null,
      request: () => {},
      response: () => {},
    };
    const emit = async (value: unknown) => {
      try {
        await active.guard();
        this.diagnostic(value);
      } catch {
        /* Optional diagnostics never settle a result. */
      }
    };
    active.request = async (request) => {
      if (this.active !== active || active.count >= 4) return;
      try {
        await active.guard();
        const url = new URL(request.url());
        if (
          request.method() !== 'POST' ||
          url.origin !== 'https://www.facebook.com' ||
          url.pathname !== '/api/graphql/'
        )
          return;
        const selected = matchStoryResearchRequest(
          request.postData() ?? '',
          original,
          active.videoId ?? undefined,
        );
        if (!selected) return;
        active.count++;
        active.requests.set(request, selected);
        await emit({
          event: 'STORY_NATIVE_REQUEST',
          operationId: operation.id,
          jobId: operation.jobId,
          request: selected,
        });
      } catch {
        /* A diagnostic cannot authorize input or a retry. */
      }
    };
    active.response = (response) => {
      const selected = active.requests.get(response.request());
      if (this.active !== active || !selected) return;
      active.requests.delete(response.request());
      const work = (async () => {
        await active.guard();
        const body = await response.text();
        await active.guard();
        if (
          this.active !== active ||
          Buffer.byteLength(body, 'utf8') > 512 * 1024 ||
          (active.bytes += Buffer.byteLength(body, 'utf8')) > 1024 * 1024
        )
          return;
        if (selected.nativeStory) {
          const result = parseNativeStoryCreation(
            body,
            response.status(),
            original.intent.context.accountId,
          );
          if (result) {
            if (active.accepted && JSON.stringify(active.accepted) !== JSON.stringify(result)) {
              active.conflicting = true;
              active.accepted = null;
            }
            if (!active.conflicting) active.accepted = result;
          }
        }
        const rows = body
          .replace(/^for \(;;\);\s*/, '')
          .split('\n')
          .filter((line) => line.trim())
          .slice(0, 8);
        const values = rows.map((line) => {
          try {
            return describeStoryNativeValue(JSON.parse(line) as unknown);
          } catch {
            return { parse: false };
          }
        });
        await emit({
          event: 'STORY_NATIVE_RESPONSE',
          operationId: operation.id,
          jobId: operation.jobId,
          name: selected.name,
          status: response.status(),
          values,
        });
      })()
        .catch(() => {})
        .finally(() => active.pending.delete(work));
      active.pending.add(work);
    };
    const ordered = orderedNetworkEvents(active.pending, active.request, active.response, () => {
      active.conflicting = true;
    });
    active.request = ordered.request;
    active.response = ordered.response;
    this.active = active;
    page.on('request', active.request);
    page.on('response', active.response);
  }
  async assert(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const saved = await this.observations.get(operation.id);
    if (
      !saved ||
      !sameBinding(saved.binding, operation.binding) ||
      saved.attemptId !== original.intent.attemptId ||
      saved.fingerprint !== original.intent.fingerprint ||
      !sameTabProof(saved.proof, original.intent.proof)
    )
      throw Error('STORY_SUBMISSION_BASELINE_REQUIRED');
    const current = await this.read(page, guard);
    await guard();
    if (
      current.url !== saved.url ||
      current.timeOrigin !== saved.timeOrigin ||
      !current.ready ||
      !current.visible ||
      current.privacy?.phase !== 'CLOSED' ||
      (original.intent.snapshot.format !== 'text' &&
        (!matchesOriginalStoryMedia(current, original.intent) || current.textEditing)) ||
      (current.text !== original.intent.snapshot.text &&
        !matchesDerivedStoryCaption(current, original.intent)) ||
      (this.active?.videoId !== null &&
        this.active?.videoId !== undefined &&
        current.videoTransfer?.videoId !== this.active.videoId) ||
      !current.submit?.enabled
    )
      throw Error('STORY_SUBMISSION_DOCUMENT_OR_CONTENT_CHANGED');
  }
  async verify(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict> {
    await guard();
    if (
      !this.active ||
      !sameBinding(this.active.operation.binding, operation.binding) ||
      this.active.original.intent.attemptId !== original.intent.attemptId
    )
      return { kind: 'unknown', reason: 'STORY_ORIGINAL_OBSERVER_REQUIRED' };
    await this.active.guard();
    const active = this.active;
    if (active.conflicting) return { kind: 'unknown', reason: 'STORY_NATIVE_RESULT_CONFLICT' };
    if (page !== active.page) return { kind: 'unknown', reason: 'STORY_ORIGINAL_PAGE_REQUIRED' };
    if (
      active.accepted &&
      (await readStoryPublishedNotice(page, active.timeOrigin, guard, active.accepted))
    ) {
      await guard();
      await active.guard();
      return {
        kind: 'verified',
        receipt: PostReceipt.parse({
          binding: operation.binding,
          evidence: {
            kind: 'material-post-verification',
            independent: true,
            attemptId: original.intent.attemptId,
            fingerprint: original.intent.fingerprint,
            purpose: 'SUBMIT',
            proof: original.intent.proof,
            observedAccountId: active.accepted.actorId,
            observationId: randomUUID(),
            checkedAt: new Date().toISOString(),
            outcome: 'PUBLISHED',
            basis: 'own-post-observed',
            postId: nativeStoryResultURL(active.accepted),
          },
        }),
      };
    }
    return { kind: 'wait', reason: 'STORY_NATIVE_RESULT_UNCONFIRMED' };
  }
  stop() {
    const active = this.active;
    this.active = null;
    if (active) {
      active.page.off('request', active.request);
      active.page.off('response', active.response);
      active.requests.clear();
    }
  }
}
