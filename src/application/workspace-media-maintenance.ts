import {
  MaterialUsageSnapshot,
  ClearMaterialUsage,
  ClearedMaterialUsage,
} from '../shared/material-usage.js';
import {
  MaterialCacheCleanRequest,
  MaterialCacheCleanResult,
  MaterialCacheOverview,
  type CacheOverview,
} from '../shared/material-cache-management.js';
import { ProductError, type WorkspaceRepository } from '../domain/workspace.js';
import {
  MaintenanceOverview,
  UpdateMaintenanceSettings,
  type RuntimeLogPort,
} from '../shared/runtime-log.js';
import type { Awaitable } from '../domain/persistence.js';
import type { z } from 'zod';
import type { MediaComponentStatus } from '../shared/media-component.js';
import type { PostIntent } from '../shared/material-index.js';
import type { MaterialFileSnapshot } from '../shared/materials.js';
import type { MaterialUsageRepository } from '../domain/resource-material-rules.js';

export interface MediaComponentPort {
  status(): Awaitable<z.infer<typeof MediaComponentStatus>>;
  start(): Awaitable<unknown>;
  cancel(): void;
}

export interface SourceObservation {
  fingerprint: string;
  checkedAt: string;
  files: MaterialFileSnapshot[];
}

export interface MaterialSourceVerifier {
  // assertCurrent is checked around asynchronous IO, not a reusable input permit.
  verify(intent: PostIntent, assertCurrent: () => Awaitable<void>): Promise<SourceObservation>;
}

export class MaterialUsageService {
  constructor(private readonly repository: MaterialUsageRepository) {}
  async snapshot() {
    return MaterialUsageSnapshot.parse(await this.repository.snapshot());
  }
  async clear(input: unknown) {
    return ClearedMaterialUsage.parse(await this.repository.clear(ClearMaterialUsage.parse(input)));
  }
}

export interface MaterialCacheBackend {
  snapshot(): Awaitable<CacheOverview>;
  cleanStage(stageId: string): Awaitable<{ cleaned: boolean; reason: string }>;
}

export class MaterialCacheManagement {
  private busy = false;
  constructor(private readonly backend: MaterialCacheBackend) {}

  async snapshot() {
    return MaterialCacheOverview.parse(await this.backend.snapshot());
  }

  async clean(input: unknown) {
    const request = MaterialCacheCleanRequest.parse(input);
    if (this.busy) throw new ProductError('CACHE_CLEANUP_BUSY', '缓存清理正在执行', 409);
    this.busy = true;
    try {
      const results = [];
      const started = performance.now();
      for (const stageId of request.stageIds) {
        if (performance.now() - started >= 60_000) {
          results.push({ stageId, cleaned: false, reason: 'CACHE_CLEANUP_BATCH_BUDGET' });
          continue;
        }
        try {
          const outcome = await this.backend.cleanStage(stageId);
          results.push({
            stageId,
            cleaned: outcome.cleaned,
            reason: outcome.reason.slice(0, 200),
          });
        } catch (error) {
          results.push({
            stageId,
            cleaned: false,
            reason: error instanceof Error ? error.message.slice(0, 200) : 'CACHE_CLEANUP_FAILED',
          });
        }
      }
      return MaterialCacheCleanResult.parse({ results });
    } finally {
      this.busy = false;
    }
  }
}

export class WorkspaceMaintenance {
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly log: RuntimeLogPort,
    private readonly locations: { logDirectory: string; cacheDirectory: string },
  ) {}
  async snapshot() {
    if (!this.repository.maintenanceSettings)
      throw new ProductError('MAINTENANCE_UNAVAILABLE', '维护设置尚未加载', 503);
    return MaintenanceOverview.parse({
      settings: await this.repository.maintenanceSettings(),
      locations: this.locations,
      logStatus: this.log.status(),
    });
  }
  async update(input: unknown) {
    if (!this.repository.updateMaintenanceSettings)
      throw new ProductError('MAINTENANCE_UNAVAILABLE', '维护设置尚未加载', 503);
    await this.repository.updateMaintenanceSettings(UpdateMaintenanceSettings.parse(input));
    return await this.snapshot();
  }
  export() {
    return this.log.export();
  }
}
