import { orderedNetworkEvents } from './ordered-network-events.js';
import type { Awaitable } from '../domain/persistence.js';
import type { Page, Request, Response } from 'playwright-core';
import type {
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from '../domain/facebook-post-execution.js';
import type { FacebookSubmissionResultSource } from '../domain/facebook-submission-result.js';
import type { FacebookSubmissionObservationRepository } from '../domain/facebook-submission-observations.js';
import {
  FacebookPostResultCorrelation,
  type PostResultCorrelation,
  type PostEffects,
} from '../shared/facebook-post-observation.js';
import { sameBinding } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';

export interface PostSubmissionDiagnostic {
  operationId: string;
  jobId: string;
  profileId: string;
  checkedAt: string;
  response: {
    bytes: number;
    json: boolean;
    antiXssiPrefix: boolean;
    lines: number;
    rootKeys: string[];
    dataKeys: string[];
    createKeys: string[];
    postId: string | null;
    storyId: string | null;
    flow: string | null;
    storyType: string;
    storyKeys: string[];
    embeddedStoryId: string | null;
    final: boolean | null;
    errorCount: number;
    errorCodes: number[];
  };
}
function describeResponse(body: string): PostSubmissionDiagnostic['response'] {
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const keys = (v: Record<string, unknown>) =>
    Object.keys(v)
      .filter((k) => /^[a-zA-Z_][a-zA-Z_\d]{0,63}$/.test(k))
      .slice(0, 30);
  let parsed: unknown = null,
    json = false;
  try {
    parsed = JSON.parse(body);
    json = true;
  } catch {
    /* Shape only; no body or credentials logged. */
  }
  const root = record(parsed),
    data = record(root.data),
    create = record(data.story_create),
    extensions = record(root.extensions);
  const errors = Array.isArray(root.errors) ? root.errors : [];
  return {
    bytes: Buffer.byteLength(body, 'utf8'),
    json,
    antiXssiPrefix: body.trimStart().startsWith('for (;;);'),
    lines: body.split('\n').length,
    rootKeys: keys(root),
    dataKeys: keys(data),
    createKeys: keys(create),
    postId:
      typeof create.post_id === 'string' && /^\d{1,30}$/.test(create.post_id)
        ? create.post_id
        : null,
    storyId:
      typeof create.story_id === 'string' && /^[a-zA-Z0-9+/=]{1,200}$/.test(create.story_id)
        ? create.story_id
        : null,
    flow:
      typeof create.publishing_flow === 'string' && /^[A-Z_]{1,64}$/.test(create.publishing_flow)
        ? create.publishing_flow
        : null,
    storyType: create.story === null ? 'null' : typeof create.story,
    storyKeys: keys(record(create.story)),
    embeddedStoryId:
      typeof record(create.story).id === 'string' &&
      /^[a-zA-Z0-9+/=]{1,200}$/.test(String(record(create.story).id))
        ? String(record(create.story).id)
        : null,
    final: typeof extensions.is_final === 'boolean' ? extensions.is_final : null,
    errorCount: errors.length,
    errorCodes: errors
      .slice(0, 10)
      .map((e) => record(e).code)
      .filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v)),
  };
}

export interface FacebookSubmissionWireAdapter {
  // Only an adapter validated against actual wire samples may report ready. The observer itself
  // does not guess FB's undocumented mutation name, GraphQL fields or transformed media IDs.
  ready(): boolean;
  requiredAudience?(original?: FacebookPostOriginal): Awaitable<'SELF' | undefined>;
  supportsOriginal?(original: FacebookPostOriginal): boolean;
  responseFailureReason?(): 'ACCEPTANCE_PARSE' | 'RESULT_PAGE' | 'RESULT_MEDIA' | null;
  match(postData: string, original: FacebookPostOriginal): Awaitable<string | null>;
  result(
    body: string,
    requestKey: string,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ):
    | Pick<PostResultCorrelation, 'postId' | 'photos' | 'videoId'>
    | null
    | Promise<Pick<PostResultCorrelation, 'postId' | 'photos' | 'videoId'> | null>;
  observedEffects?(
    original: FacebookPostOriginal,
    result: PostResultCorrelation,
    guard: () => Awaitable<void>,
  ): Awaitable<PostEffects | null>;
}

type Active = {
  page: Page;
  operation: FacebookPostBoundOperation;
  original: FacebookPostOriginal;
  guard: () => Awaitable<void>;
  requests: Map<Request, string>;
  pending: Set<Promise<void>>;
  responses: { body: string; key: string }[];
  responseBytes: number;
  result: PostResultCorrelation | null;
  failed: boolean;
  failureReason: string;
  count: number;
  request: (request: Request) => Awaitable<void>;
  response: (response: Response) => Awaitable<void>;
  close: () => void;
};

// Passive observation of native requests already made by the original UI click. Never sends,
// intercepts, replays, changes headers, copies cookies, or persists request bodies/credentials.
export class FacebookSubmissionNetworkObserver implements FacebookSubmissionResultSource<Page> {
  private active: Active | null = null;
  private preparing = false;
  private generation = 0;
  constructor(
    private readonly observations: FacebookSubmissionObservationRepository,
    private readonly adapter: FacebookSubmissionWireAdapter,
    private readonly diagnostic?: (value: PostSubmissionDiagnostic) => void,
  ) {}
  ready() {
    return this.adapter.ready();
  }
  async requiredAudience(original?: FacebookPostOriginal) {
    return await this.adapter.requiredAudience?.(original);
  }
  async observedEffects(
    original: FacebookPostOriginal,
    result: PostResultCorrelation,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const saved = await this.observations.result(original.link.operationId);
    if (
      !saved ||
      !sameBinding(saved.binding, result.binding) ||
      !sameTabProof(saved.proof, result.proof) ||
      saved.attemptId !== result.attemptId ||
      saved.fingerprint !== result.fingerprint ||
      saved.postId !== result.postId ||
      saved.videoId !== result.videoId ||
      JSON.stringify(saved.photos) !== JSON.stringify(result.photos)
    )
      return null;
    return (await this.adapter.observedEffects?.(original, result, guard)) ?? null;
  }
  async start(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
    enableBuffers: () => Promise<void>,
  ) {
    const openingGeneration = this.generation;
    await guard();
    const baseline = await this.observations.get(operation.id);
    if (
      openingGeneration !== this.generation ||
      !this.ready() ||
      this.adapter.supportsOriginal?.(original) === false ||
      this.active ||
      this.preparing ||
      !baseline ||
      operation.status !== 'DISPATCHING' ||
      original.link.purpose !== 'SUBMIT' ||
      !sameBinding(baseline.binding, operation.binding) ||
      !sameTabProof(baseline.proof, original.intent.proof)
    )
      throw Error('ORIGINAL_NETWORK_SUBMISSION_REQUIRED');
    const generation = this.generation;
    this.preparing = true;
    try {
      await enableBuffers();
      await guard();
      if (this.active || generation !== this.generation)
        throw Error('ORIGINAL_NETWORK_OBSERVATION_REVOKED');
    } finally {
      this.preparing = false;
    }
    const active: Active = {
      page,
      operation: structuredClone(operation),
      original: structuredClone(original),
      guard,
      requests: new Map(),
      pending: new Set(),
      responses: [],
      responseBytes: 0,
      result: null,
      failed: false,
      failureReason: '',
      count: 0,
      request: async (request) => await this.request(active, request),
      response: (response) => this.response(active, response),
      close: () => this.stop(),
    };
    const ordered = orderedNetworkEvents(active.pending, active.request, active.response, () => {
      active.failed = true;
      active.failureReason ||= 'EVENT_OBSERVATION';
    });
    active.request = ordered.request;
    active.response = ordered.response;
    this.active = active;
    page.on('request', active.request);
    page.on('response', active.response);
    page.once('close', active.close);
  }
  private async request(active: Active, request: Request) {
    if (this.active !== active || active.failed) return;
    try {
      await active.guard();
      const url = new URL(request.url());
      if (
        url.origin !== 'https://www.facebook.com' ||
        url.pathname !== '/api/graphql/' ||
        url.search ||
        request.method() !== 'POST' ||
        request.frame() !== active.page.mainFrame()
      )
        return;
      const body = request.postData();
      // Facebook also sends unrelated queries while a submission is in flight. They
      // cannot consume the matching mutation budget or invalidate an observed result.
      if (!body || body.length > 512 * 1024) return;
      const key = await this.adapter.match(body, active.original);
      if (!key) return;
      if (key.length > 2048 || ++active.count > 32) {
        active.failed = true;
        active.failureReason = 'MATCHED_REQUEST_BUDGET';
        return;
      }
      active.requests.set(request, key);
      await active.guard();
    } catch {
      active.failed = true;
      active.failureReason = 'REQUEST_OBSERVATION';
    }
  }
  private response(active: Active, response: Response) {
    if (this.active !== active || active.failed) return;
    const key = active.requests.get(response.request());
    if (!key) return;
    active.requests.delete(response.request());
    const work = this.body(active, response, key).catch(() => {
      active.failed = true;
      active.failureReason ||= 'RESPONSE_INSPECTION';
    });
    active.pending.add(work);
    void work.finally(() => active.pending.delete(work));
    return work;
  }
  private async body(active: Active, response: Response, key: string) {
    await active.guard();
    if (response.status() !== 200) {
      active.failed = true;
      active.failureReason = 'MATCHED_HTTP_STATUS';
      return;
    }
    // Chrome response buffers were bounded before the click. A native h3 JSON response may
    // omit Content-Length and use text/html; neither alone is a business success signal.
    active.failureReason = 'RESPONSE_HEADERS';
    const headers = await response.allHeaders();
    if (this.active !== active) return;
    await active.guard();
    const length = headers['content-length'];
    const bytes = length === undefined ? null : Number(length);
    if (
      (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 512 * 1024)) ||
      !/^(?:application\/json|text\/(?:javascript|html))(?:;|$)/i.test(
        headers['content-type'] ?? '',
      )
    ) {
      active.failed = true;
      active.failureReason = 'RESPONSE_HEADER_BUDGET_OR_TYPE';
      return;
    }
    active.failureReason = 'RESPONSE_BODY_READ';
    const body = await response.body();
    if (this.active !== active) return;
    await active.guard();
    if (body.length > 512 * 1024) {
      active.failed = true;
      active.failureReason = 'RESPONSE_BODY_BUDGET';
      return;
    }
    if (active.responseBytes + body.length > 2 * 1024 * 1024) {
      active.failed = true;
      active.failureReason = 'RESPONSE_BUFFER_BUDGET';
      return;
    }
    // The response may arrive while the original click is still DISPATCHING. Capture
    // its bounded body now, but resolve the result page only after the software ACK.
    active.responses.push({ body: body.toString('utf8'), key });
    active.responseBytes += body.length;
    try {
      this.diagnostic?.({
        operationId: active.operation.id,
        jobId: active.operation.jobId,
        profileId: active.operation.binding.profileId,
        checkedAt: new Date().toISOString(),
        response: describeResponse(body.toString('utf8')),
      });
    } catch {
      /* Optional capture cannot change the original publication verdict. */
    }
    active.failureReason = '';
  }
  private async resolveResponses(active: Active) {
    while (this.active === active && !active.failed && active.responses.length) {
      const response = active.responses.shift();
      if (!response) return;
      active.responseBytes -= Buffer.byteLength(response.body, 'utf8');
      await this.resolveResponse(active, response.body, response.key);
    }
  }
  private async resolveResponse(active: Active, body: string, key: string) {
    await active.guard();
    active.failureReason = 'NATIVE_RESULT_RESOLUTION';
    const parsed = await this.adapter.result(body, key, active.original, active.guard);
    if (this.active !== active) return;
    await active.guard();
    if (!parsed) {
      active.failed = true;
      active.failureReason = this.adapter.responseFailureReason?.() ?? 'NATIVE_RESULT_UNRECOGNIZED';
      return;
    }
    const result = FacebookPostResultCorrelation.parse({
      ...parsed,
      binding: active.operation.binding,
      proof: active.original.intent.proof,
      attemptId: active.original.intent.attemptId,
      fingerprint: active.original.intent.fingerprint,
    });
    if (active.result && JSON.stringify(active.result) !== JSON.stringify(result)) {
      active.failed = true;
      active.failureReason = 'CONFLICTING_NATIVE_RESULT';
    } else {
      active.failureReason = 'RESULT_PERSISTENCE';
      active.result = await this.observations.captureResult(result);
      active.failureReason = '';
    }
    await active.guard();
  }
  async read(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const current = this.active;
    if (
      current &&
      current.page === page &&
      sameBinding(current.operation.binding, operation.binding)
    ) {
      if (current.failed)
        throw Error(`ORIGINAL_SUBMISSION_RESPONSE_UNCONFIRMED:${current.failureReason}`);
      if (current.pending.size || current.requests.size) return null;
      if (current.responses.length) {
        if (operation.status !== 'ACKNOWLEDGED') return null;
        const work = this.resolveResponses(current).catch(() => {
          current.failed = true;
          current.failureReason ||= 'NATIVE_RESULT_RESOLUTION';
        });
        current.pending.add(work);
        void work.finally(() => current.pending.delete(work));
        return null;
      }
    }
    const saved = await this.observations.result(operation.id);
    if (
      saved &&
      sameBinding(saved.binding, operation.binding) &&
      saved.attemptId === original.intent.attemptId &&
      sameTabProof(saved.proof, original.intent.proof)
    ) {
      if (current && sameBinding(current.operation.binding, operation.binding)) this.stop();
      return saved;
    }
    const active = this.active;
    if (
      !active ||
      active.page !== page ||
      !sameBinding(active.operation.binding, operation.binding) ||
      original.intent.attemptId !== active.original.intent.attemptId ||
      !sameTabProof(original.intent.proof, active.original.intent.proof)
    )
      return null;
    // Polling never blocks the actor on a response or generates a second request.
    if (active.pending.size || active.failed) return null;
    await guard();
    return active.result ? structuredClone(active.result) : null;
  }
  stop() {
    this.generation++;
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.page.removeListener('request', active.request);
    active.page.removeListener('response', active.response);
    active.page.removeListener('close', active.close);
    active.requests.clear();
    active.responses.length = 0;
    active.responseBytes = 0;
  }
}
