import type { Awaitable } from '../domain/persistence.js';
import type { z } from 'zod';
import type { MediaComponentStatus } from '../shared/media-component.js';

export interface MediaComponentPort {
  status(): Awaitable<z.infer<typeof MediaComponentStatus>>;
  start(): Awaitable<unknown>;
  cancel(): void;
}
