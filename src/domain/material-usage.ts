import type { Awaitable } from './persistence.js';
import type {
  MaterialUsage,
  MaterialUsageClearRequest,
  MaterialUsageClearResult,
} from '../shared/material-usage.js';
export interface MaterialUsageRepository {
  snapshot(): Awaitable<MaterialUsage>;
  clear(request: MaterialUsageClearRequest): Awaitable<MaterialUsageClearResult>;
}
