import type { MaterialUsageRepository } from '../domain/material-usage.js';
import {
  MaterialUsageSnapshot,
  ClearMaterialUsage,
  ClearedMaterialUsage,
} from '../shared/material-usage.js';
export class MaterialUsageService {
  constructor(private readonly repository: MaterialUsageRepository) {}
  async snapshot() {
    return MaterialUsageSnapshot.parse(await this.repository.snapshot());
  }
  async clear(input: unknown) {
    return ClearedMaterialUsage.parse(await this.repository.clear(ClearMaterialUsage.parse(input)));
  }
}
