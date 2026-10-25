import type { Awaitable } from '../domain/persistence.js';
import type { TaskResourceRepository } from '../domain/task-resources.js';
import type {
  ResourceMaterialReader,
  ResourceMaterialIndex,
} from '../domain/resource-materials.js';
import type { ResourceMaterial } from '../shared/resource-materials.js';
import { BROWSER_TEXT_INPUT_LIMIT } from '../shared/browser-actions.js';
import { hasResource } from '../domain/resource-table.js';

// Internal saved-plan preparation, not HTTP input, actor authority or a reusable input permit.
export class ResourceMaterialPreparation {
  private busy = false;
  constructor(
    private readonly resources: TaskResourceRepository,
    private readonly reader: ResourceMaterialReader,
    private readonly index: ResourceMaterialIndex,
    private readonly now = () => Date.now(),
    private readonly milliseconds = 300_000,
    private readonly nativeBackground = false,
  ) {}
  async prepareForPlans(jobIds: string[], catalogId: string, assertCurrent: () => Awaitable<void>) {
    if (!jobIds.length || jobIds.length > 500 || new Set(jobIds).size !== jobIds.length)
      throw Error('RESOURCE_MATERIAL_PLAN_SCOPE');
    const jobId = jobIds[0];
    if (!jobId) throw Error('RESOURCE_MATERIAL_PLAN_SCOPE');
    const fixed = await this.resources.binding(jobId);
    if (!fixed) throw Error('RESOURCE_BINDING_REQUIRED');
    const check = async () => {
      await assertCurrent();
      for (const id of jobIds) {
        const binding = await this.resources.binding(id);
        if (
          !binding ||
          binding.combinationId !== fixed.combinationId ||
          binding.resourceRevision !== fixed.resourceRevision
        )
          throw Error('RESOURCE_MATERIAL_PLAN_SCOPE');
      }
    };
    await check();
    const result = await this.prepare(jobId, catalogId, assertCurrent);
    await check();
    return result;
  }
  async prepare(jobId: string, catalogId: string, assertCurrent: () => Awaitable<void>) {
    if (this.busy) throw Error('RESOURCE_MATERIAL_PREPARATION_BUSY');
    this.busy = true;
    try {
      const fixed = await this.resources.snapshot(jobId),
        started = this.now();
      let bytes = 0,
        latest = started;
      const check = async (read = 0) => {
        await assertCurrent();
        const current = this.now();
        bytes += read;
        if (current < latest || current - started > this.milliseconds || bytes > 10 * 1024 ** 3)
          throw Error('RESOURCE_MATERIAL_PREPARATION_LIMIT');
        latest = current;
        if (JSON.stringify(await this.resources.binding(jobId)) !== JSON.stringify(fixed.binding))
          throw Error('RESOURCE_MATERIAL_BINDING_CHANGED');
      };
      const snapshots: ResourceMaterial[] = [],
        blocked: { rowId: string; reason: string }[] = [];
      for (const row of fixed.table.rows) {
        await check();
        if (!hasResource(row)) continue;
        if (
          (!this.nativeBackground && !row.media.length && row.background === 'color') ||
          row.text.length > BROWSER_TEXT_INPUT_LIMIT
        ) {
          blocked.push({
            rowId: row.id,
            reason:
              row.text.length > BROWSER_TEXT_INPUT_LIMIT
                ? 'TEXT_INPUT_LIMIT'
                : 'BACKGROUND_UNVERIFIED',
          });
          continue;
        }
        try {
          snapshots.push(await this.reader.snapshot(row, check));
        } catch (error) {
          await check();
          if (
            !(error instanceof Error) ||
            !/^(RESOURCE_SOURCE_(DRIVE_DOWNLOAD_PENDING|FILE_UNAVAILABLE|PATH_UNSUPPORTED|FILE_CHANGED|TYPE_MISMATCH|FILE_SIZE_LIMIT)|DRIVE_(PUBLIC_DOWNLOAD_UNAVAILABLE|PERMISSION_OR_CONFIRMATION_REQUIRED|MEDIA_TYPE_UNSUPPORTED|DOWNLOAD_SIZE_LIMIT|DOWNLOAD_TRUNCATED|CONFIRMATION_SCOPE|CONFIRMATION_SIZE_LIMIT|REDIRECT_REJECTED|REDIRECT_LIMIT|FILE_ID_CHANGED|ENCODING_UNSUPPORTED))$/.test(
              error.message,
            )
          )
            throw error;
          blocked.push({ rowId: row.id, reason: error.message });
        }
        await check();
      }
      await check();
      return {
        catalog: await this.index.indexResources(jobId, catalogId, snapshots),
        blocked,
        inputPermission: false as const,
      };
    } finally {
      this.busy = false;
    }
  }
}
