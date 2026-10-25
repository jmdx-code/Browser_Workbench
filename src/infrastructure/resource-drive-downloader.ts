import type { Awaitable } from '../domain/persistence.js';
import type { ResourceDriveDownloader } from '../domain/resource-download.js';
import { mediaReference } from '../domain/resource-table.js';
import { PublicDriveDownloader } from './public-drive-download.js';

// Reuse the original public downloader's complete SHA, ready manifest, file proof and
// cancellation. Saved local references then enter the same source verifier/claim/archive chain.
export class PublicResourceDriveDownloader implements ResourceDriveDownloader {
  constructor(
    private readonly directory: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async download(
    source: string,
    index: number,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ) {
    const result = await new PublicDriveDownloader(
      this.directory,
      undefined,
      this.request,
    ).download(source, index, assertCurrent);
    await assertCurrent();
    return mediaReference(result.path);
  }
}
