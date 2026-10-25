import type { Awaitable } from './persistence.js';
import type { ResourceMediaValue } from '../shared/resource-table.js';

export interface ResourceDriveDownloader {
  // Explicit public download to a managed local source. Never authorizes browser input.
  download(
    source: string,
    index: number,
    assertCurrent: (bytesRead?: number) => Awaitable<void>,
  ): Promise<ResourceMediaValue>;
}
