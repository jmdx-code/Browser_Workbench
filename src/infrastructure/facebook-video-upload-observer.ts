import { orderedNetworkEvents } from './ordered-network-events.js';
import type { Awaitable } from '../domain/persistence.js';
import type { Page, Request, Response } from 'playwright-core';
import { z } from 'zod';
import { uploadedFileContent, type UploadManifest } from '../shared/material-upload.js';
import type { Binding } from '../shared/task-execution.js';
import { sameBinding } from '../shared/task-execution.js';
import type { PostIntent } from '../shared/material-index.js';
import { FacebookVideoTransfer } from '../shared/facebook-video-transfer.js';
import type { PostEffects } from '../shared/facebook-post-observation.js';

type WireRequest = {
  kind: 'start' | 'receive';
  waterfall: string;
  videoId: string | null;
  start: number;
  end: number;
};
const integer = (value: string | null) =>
  value !== null && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
const payloadSchema = z.object({
  payload: z.object({
    video_id: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().nonnegative(),
  }),
  error: z.unknown().optional(),
});

// Fields and completion shape come from the actual start/receive responses captured in
// audit/video-readiness-valid-0313. A received file is not a processed preview or a published post.
export function matchVideoTransferRequest(
  urlText: string,
  method: string,
  postData: string | null,
  binding: Binding,
  bytes: number,
): WireRequest | null {
  try {
    const url = new URL(urlText);
    if (
      method !== 'POST' ||
      url.protocol !== 'https:' ||
      !['vupload2.facebook.com', 'vupload-edge.facebook.com'].includes(url.hostname) ||
      url.searchParams.getAll('av').length !== 1 ||
      url.searchParams.get('av') !== binding.accountId ||
      !postData ||
      postData.length > 65536
    )
      return null;
    const kind =
      url.pathname === '/ajax/video/upload/requests/start/'
        ? 'start'
        : url.pathname === '/ajax/video/upload/requests/receive/'
          ? 'receive'
          : null;
    if (!kind) return null;
    const values = new URLSearchParams(postData),
      waterfall = values.get('waterfall_id');
    if (
      !waterfall ||
      !z.uuid().safeParse(waterfall).success ||
      values.getAll('waterfall_id').length !== 1
    )
      return null;
    if (kind === 'start') {
      if (values.getAll('file_size').length !== 1 || integer(values.get('file_size')) !== bytes)
        return null;
      return { kind, waterfall, videoId: null, start: 0, end: 0 };
    }
    const videoId = values.get('video_id'),
      start = integer(values.get('start_offset')),
      end = integer(values.get('end_offset'));
    if (
      !videoId ||
      !/^\d{1,30}$/.test(videoId) ||
      start === null ||
      end === null ||
      start >= end ||
      end > bytes ||
      ['video_id', 'start_offset', 'end_offset'].some((key) => values.getAll(key).length !== 1)
    )
      return null;
    return { kind, waterfall, videoId, start, end };
  } catch {
    return null;
  }
}

export class FacebookVideoUploadObserver {
  private active: {
    page: Page;
    binding: Binding;
    manifest: UploadManifest;
    intent: PostIntent;
    timeOrigin: number;
    url: string;
    guard: () => Awaitable<void>;
    requests: Map<Request, WireRequest>;
    pending: Set<Promise<void>>;
    uploadRoutes: Set<string>;
    start: { waterfall: string; videoId: string; end: number } | null;
    ranges: Map<number, { end: number; nextEnd: number; waterfall: string; videoId: string }>;
    failed: boolean;
    readFailure?: string;
    onRequest: (request: Request) => Awaitable<void>;
    onResponse: (response: Response) => Awaitable<void>;
    onClose: () => void;
  } | null = null;
  async begin(
    page: Page,
    binding: Binding,
    manifest: UploadManifest,
    intent: PostIntent,
    guard: () => Awaitable<void>,
    enable: () => Promise<void>,
  ) {
    await guard();
    this.stop();
    const file = manifest.files[0];
    if (
      intent.snapshot.format !== 'video' ||
      manifest.files.length !== 1 ||
      file?.original.role !== 'video'
    )
      return;
    if (
      !sameBinding(manifest.binding, binding) ||
      manifest.attemptId !== intent.attemptId ||
      manifest.fingerprint !== intent.fingerprint
    )
      throw Error('VIDEO_TRANSFER_MANIFEST_MISMATCH');
    const document = await page.evaluate(() => ({
      url: location.href,
      timeOrigin: performance.timeOrigin,
    }));
    await guard();
    try {
      await enable();
    } catch {
      await guard();
      return;
    } // Blob preview verification can still work independently.
    await guard();
    const active: NonNullable<FacebookVideoUploadObserver['active']> = {
      page,
      binding: structuredClone(binding),
      manifest: structuredClone(manifest),
      intent: structuredClone(intent),
      ...document,
      guard,
      requests: new Map(),
      pending: new Set(),
      uploadRoutes: new Set(),
      start: null,
      ranges: new Map(),
      failed: false,
      onRequest: () => {},
      onResponse: () => {},
      onClose: () => this.stop(),
    };
    active.onRequest = async (request) => {
      if (this.active !== active) return;
      if (active.uploadRoutes.size < 16 && request.method() === 'POST') {
        try {
          const url = new URL(request.url());
          if (
            url.protocol === 'https:' &&
            (/^(?:vupload|rupload|upload|fbupload)[a-z0-9-]*\.facebook\.com$/.test(url.hostname) ||
              (url.hostname === 'www.facebook.com' &&
                /^\/(?:ajax\/video\/upload|video-upload|rupload)/.test(url.pathname)))
          )
            active.uploadRoutes.add(
              url.origin + url.pathname.split('/').slice(0, 4).join('/').slice(0, 160),
            );
        } catch {
          /* Optional endpoint metadata never changes transfer verification. */
        }
      }
      try {
        await guard();
        const matched = matchVideoTransferRequest(
          request.url(),
          request.method(),
          request.postData(),
          binding,
          uploadedFileContent(file).bytes,
        );
        if (!matched) return;
        if (active.requests.size + active.pending.size >= 64) {
          active.failed = true;
          return;
        }
        active.requests.set(request, matched);
      } catch {
        active.failed = true;
      }
    };
    active.onResponse = (response) => {
      const request = response.request(),
        matched = active.requests.get(request);
      if (this.active !== active || !matched) return;
      active.requests.delete(request);
      const work = (async () => {
        await guard();
        if (response.status() !== 200) throw Error('VIDEO_TRANSFER_HTTP_FAILED');
        const body = await response.body();
        await guard();
        if (this.active !== active) return;
        if (body.length > 256 * 1024) throw Error('VIDEO_TRANSFER_RESPONSE_BUDGET');
        const parsed = payloadSchema.parse(
          JSON.parse(body.toString('utf8').replace(/^for\s*\(;;\);\s*/, '')),
        );
        if (parsed.error != null && parsed.error !== 0) throw Error('VIDEO_TRANSFER_NATIVE_ERROR');
        const value = parsed.payload;
        if (matched.kind === 'start') {
          if (
            !value.video_id ||
            value.start_offset !== 0 ||
            value.end_offset <= 0 ||
            value.end_offset > uploadedFileContent(file).bytes
          )
            throw Error('VIDEO_TRANSFER_START_INVALID');
          const start = {
            waterfall: matched.waterfall,
            videoId: value.video_id,
            end: value.end_offset,
          };
          if (active.start && JSON.stringify(active.start) !== JSON.stringify(start))
            throw Error('VIDEO_TRANSFER_START_AMBIGUOUS');
          active.start = start;
        } else {
          if (
            !matched.videoId ||
            value.start_offset !== matched.end ||
            value.end_offset < matched.end ||
            value.end_offset > uploadedFileContent(file).bytes
          )
            throw Error('VIDEO_TRANSFER_RECEIVE_MISMATCH');
          const range = {
            end: matched.end,
            nextEnd: value.end_offset,
            waterfall: matched.waterfall,
            videoId: matched.videoId,
          };
          const old = active.ranges.get(matched.start);
          if (old !== undefined && JSON.stringify(old) !== JSON.stringify(range))
            throw Error('VIDEO_TRANSFER_RANGE_CONFLICT');
          if (active.ranges.size >= 1024) throw Error('VIDEO_TRANSFER_RANGE_BUDGET');
          active.ranges.set(matched.start, range);
        }
      })().catch(() => {
        if (this.active === active) active.failed = true;
      });
      active.pending.add(work);
      void work.finally(() => active.pending.delete(work));
      return work;
    };
    const ordered = orderedNetworkEvents(
      active.pending,
      active.onRequest,
      active.onResponse,
      () => {
        active.failed = true;
      },
    );
    active.onRequest = ordered.request;
    active.onResponse = ordered.response;
    this.active = active;
    page.on('request', active.onRequest);
    page.on('response', active.onResponse);
    page.on('close', active.onClose);
  }
  async read(
    page: Page,
    binding: Binding,
    intent: PostIntent,
    manifest: UploadManifest,
    effects: Pick<PostEffects, 'url' | 'timeOrigin'>,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const active = this.active,
      file = manifest.files[0];
    if (
      !active ||
      active.page !== page ||
      active.failed ||
      active.pending.size ||
      active.requests.size ||
      !active.start ||
      !file ||
      !sameBinding(active.binding, binding) ||
      JSON.stringify(active.manifest) !== JSON.stringify(manifest) ||
      JSON.stringify(active.intent) !== JSON.stringify(intent) ||
      effects.timeOrigin !== active.timeOrigin ||
      effects.url !== active.url
    )
      return null;
    await active.guard();
    let received = 0,
      nextEnd = active.start.end;
    for (const [start, range] of [...active.ranges].sort((a, b) => a[0] - b[0])) {
      if (
        start !== received ||
        // The native Story client can coalesce the initial suggested window into
        // one larger receive. Its response must acknowledge that exact range.
        range.end < nextEnd ||
        range.waterfall !== active.start.waterfall ||
        range.videoId !== active.start.videoId
      )
        return null;
      received = range.end;
      nextEnd = range.nextEnd;
    }
    if (received !== uploadedFileContent(file).bytes || nextEnd !== received) return null;
    await guard();
    return FacebookVideoTransfer.parse({
      source: 'owned-video-upload-transfer',
      binding,
      proof: intent.proof,
      attemptId: intent.attemptId,
      stageId: manifest.stageId,
      fingerprint: intent.fingerprint,
      digest: uploadedFileContent(file).digest,
      bytes: uploadedFileContent(file).bytes,
      videoId: active.start.videoId,
      timeOrigin: active.timeOrigin,
      url: active.url,
      receivedBytes: received,
      ...(file.derivation ? { derivation: file.derivation } : {}),
    });
  }
  async readCurrent(
    page: Page,
    document: Pick<PostEffects, 'url' | 'timeOrigin'>,
    guard: () => Awaitable<void>,
  ) {
    await guard();
    const active = this.active;
    if (!active || active.page !== page) return null;
    try {
      return await this.read(page, active.binding, active.intent, active.manifest, document, guard);
    } catch (error) {
      if (this.active === active)
        active.readFailure =
          error instanceof Error && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message)
            ? error.message
            : 'VIDEO_TRANSFER_READ_REJECTED';
      await guard();
      return null;
    }
  }
  diagnostic(document?: Pick<PostEffects, 'url' | 'timeOrigin'>) {
    const active = this.active;
    const ranges = [...(active?.ranges ?? [])].sort((a, b) => a[0] - b[0]);
    return {
      active: active !== null,
      matchedStart: active?.start !== null && active?.start !== undefined,
      receivedRanges: active?.ranges.size ?? 0,
      pendingRequests: active?.requests.size ?? 0,
      pendingReads: active?.pending.size ?? 0,
      failed: active?.failed ?? false,
      uploadRoutes: [...(active?.uploadRoutes ?? [])],
      expectedBytes: active?.manifest.files[0]
        ? uploadedFileContent(active.manifest.files[0]).bytes
        : null,
      startEnd: active?.start?.end ?? null,
      receivedEnd: ranges.at(-1)?.[1].end ?? null,
      nextEnd: ranges.at(-1)?.[1].nextEnd ?? null,
      ...(document
        ? {
            documentMatches:
              active?.url === document.url && active?.timeOrigin === document.timeOrigin,
          }
        : {}),
      readFailure: active?.readFailure ?? null,
    };
  }
  stop() {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.page.off('request', active.onRequest);
    active.page.off('response', active.onResponse);
    active.page.off('close', active.onClose);
    active.requests.clear();
  }
}
