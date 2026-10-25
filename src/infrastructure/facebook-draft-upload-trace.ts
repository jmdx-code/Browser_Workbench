import type { Awaitable } from '../domain/persistence.js';
import { createHash } from 'node:crypto';
import type { Page, Response } from 'playwright-core';
import type { Binding } from '../shared/task-execution.js';
import type { UploadManifest } from '../shared/material-upload.js';

// Passive research of this exact owned-page upload. Reuses the original relay and bounded
// Network buffer; no browser-level CDP session, HTTP, interception or credential retention.
export class FacebookDraftUploadTrace {
  private page: Page | null = null;
  private listener: ((response: Response) => void) | null = null;
  private stopped = false;
  private count = 0;
  private pending = new Set<Promise<void>>();
  readonly records: Record<string, unknown>[] = [];
  constructor(private readonly persist: () => Promise<void>) {}
  async start(
    page: Page,
    binding: Binding,
    manifest: UploadManifest,
    guard: () => Awaitable<void>,
    enableBuffers: () => Promise<void>,
  ) {
    await guard();
    if (this.page || this.stopped) throw Error('DRAFT_UPLOAD_TRACE_ALREADY_STARTED');
    try {
      await enableBuffers();
    } catch {
      await guard();
      // Optional research must not cancel a valid upload. Business readiness is verified
      // independently; a revoked actor still throws above and cannot reach file input.
      this.records.push({ operationId: binding.operationId, result: 'OBSERVATION_UNAVAILABLE' });
      await this.persist().catch(() => {});
      await guard();
      return;
    }
    await guard();
    this.page = page;
    const names = new Set(manifest.files.map((f) => f.name));
    const listener = (response: Response) => {
      if (this.stopped) return;
      let url: URL;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (
        url.protocol !== 'https:' ||
        !(
          ['upload.facebook.com', 'rupload.facebook.com'].includes(url.hostname) ||
          (['vupload2.facebook.com', 'vupload-edge.facebook.com'].includes(url.hostname) &&
            /^\/ajax\/video\/upload\/requests\/(?:start|receive|post)\/$/.test(url.pathname)) ||
          (url.hostname === 'www.facebook.com' &&
            /^\/ajax\/react_composer\/attachments\//.test(url.pathname))
        ) ||
        !['POST', 'PUT'].includes(response.request().method())
      )
        return;
      if (++this.count > 12) return;
      const work = (async () => {
        await guard();
        const bytes = await response.body(); // Public SDK waits for this response to finish.
        await guard();
        if (this.stopped) return;
        if (bytes.length > 256 * 1024) throw Error('DRAFT_UPLOAD_TRACE_BODY_BUDGET');
        const selected: Record<string, unknown> = {};
        let visited = 0;
        const walk = (value: unknown, prefix: string, depth: number) => {
          if (++visited > 1000 || depth > 8 || !value || typeof value !== 'object') return;
          for (const [key, member] of Object.entries(value)) {
            if (/token|cookie|credential|session|secret|header/i.test(key)) continue;
            const location = prefix ? prefix + '.' + key : key;
            if (
              ['video_id', 'media_id', 'id', 'error_code', 'file_size'].includes(key) &&
              /^(?:\d{1,30})$/.test(String(member))
            )
              selected[location] = String(member);
            if (
              ['status', 'state', 'processing_status'].includes(key) &&
              typeof member === 'string' &&
              /^(?:complete|completed|ready|finished|processing|success|error|failed)$/i.test(
                member,
              )
            )
              selected[location] = member;
            if (key === 'success' && typeof member === 'boolean') selected[location] = member;
            if (
              ['name', 'file_name', 'filename'].includes(key) &&
              typeof member === 'string' &&
              names.has(member)
            )
              selected[location] = member;
            walk(member, location, depth + 1);
          }
        };
        try {
          walk(
            JSON.parse(bytes.toString('utf8').replace(/^for\s*\(;;\);\s*/, '')) as unknown,
            '',
            0,
          );
        } catch {
          /* Unknown responses are never readiness; only their digest is retained. */
        }
        this.records.push({
          operationId: binding.operationId,
          checkedAt: new Date().toISOString(),
          host: url.hostname,
          path: url.pathname.slice(0, 160),
          method: response.request().method(),
          status: response.status(),
          bytes: bytes.length,
          bodySha256: createHash('sha256').update(bytes).digest('hex'),
          selected,
        });
        await this.persist().catch(() => {});
      })().catch(() => {
        this.records.push({ operationId: binding.operationId, result: 'RESPONSE_NOT_OBSERVED' });
      });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    };
    this.listener = listener;
    page.on('response', listener);
  }
  async close() {
    this.stopped = true;
    if (this.listener) this.page?.off('response', this.listener);
    await Promise.allSettled([...this.pending]);
  }
}
