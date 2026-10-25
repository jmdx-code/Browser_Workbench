import type { Awaitable } from '../domain/persistence.js';
import { kernelFacebookReadURL } from '../shared/kernel-policy.js';
import { validateProjection, type PageProjectionRequest } from '../shared/page-read.js';

export interface PageReadSamplingPort {
  assertCurrent(): Awaitable<void>;
  read(): Promise<unknown>;
  wait(): Promise<void>;
}
// Reads may be sampled during an initial navigation; no action is retried or dispatched here.
export async function sampleFacebookPage(
  request: PageProjectionRequest,
  port: PageReadSamplingPort,
) {
  for (let attempt = 0; attempt < 16; attempt++) {
    await port.assertCurrent();
    try {
      const page = validateProjection(request, await port.read());
      await port.assertCurrent();
      if (!kernelFacebookReadURL(page.url)) throw Error('PAGE_READ_FOREIGN_DOCUMENT');
      if (page.ready === 'complete' && page.rows.some((row) => row.nodes.length)) return page;
      if (attempt === 15) return page;
    } catch (error) {
      await port.assertCurrent();
      // getTargets may expose the requested URL before the initial document has committed.
      // Extension checks each native scope and refuses out-of-scope document results.
      if (!(error instanceof Error) || error.message !== 'KERNEL_SCOPE_CHANGED' || attempt === 15)
        throw error;
    }
    await port.wait();
    await port.assertCurrent();
  }
  throw Error('PAGE_READ_EXHAUSTED');
}
