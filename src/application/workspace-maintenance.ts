import { ProductError, type WorkspaceRepository } from '../domain/workspace.js';
import {
  MaintenanceOverview,
  UpdateMaintenanceSettings,
  type RuntimeLogPort,
} from '../shared/runtime-log.js';

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
