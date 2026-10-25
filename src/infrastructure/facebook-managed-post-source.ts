import type { Awaitable } from '../domain/persistence.js';
import type { Page } from 'playwright-core';
import type { StepExecution } from '../domain/browse-execution.js';
import type {
  FacebookPostPageSource,
  FacebookPostBoundOperation,
  FacebookPostOriginal,
} from '../domain/facebook-post-execution.js';
import type { PostExecutionVerdict } from '../shared/post-execution.js';
import { sameExecution } from '../shared/task-execution.js';
import { MaterialCatalog } from '../shared/material-index.js';
import { ResourceMaterialCatalog } from '../shared/resource-materials.js';
import type { Catalog } from '../shared/material-index.js';
import type { ResourceCatalog } from '../shared/resource-materials.js';
import type { TaskResourceRepository } from '../domain/task-resources.js';
import type { KernelManagedFacebookSession } from './kernel-managed-facebook-session.js';

export interface FacebookPostBusinessObserver {
  ready(): Awaitable<boolean>;
  readyForPurpose?(purpose: FacebookPostOriginal['link']['purpose']): boolean;
  // Inspect only. The SDK/native gate refuses input outside the original active operation.
  verify(
    page: Page,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    assertCurrent: () => Awaitable<void>,
  ): Promise<PostExecutionVerdict>;
}

// Same original session and immutable material catalog; no new controller, scheduler or ledger.
export class ManagedFacebookPostSource implements FacebookPostPageSource {
  constructor(
    private readonly session: (
      execution: StepExecution,
    ) => Awaitable<KernelManagedFacebookSession | null>,
    private readonly catalog: (
      execution: StepExecution,
    ) => Awaitable<Catalog | ResourceCatalog | null>,
    private readonly resources: TaskResourceRepository,
    private readonly business: FacebookPostBusinessObserver,
    private readonly prepareCatalog?: (
      execution: StepExecution,
      guard: () => Awaitable<void>,
    ) => Promise<void>,
    private readonly requiredAudience?: 'SELF',
  ) {}
  async ready() {
    return await this.business.ready();
  }
  async catalogId(execution: StepExecution) {
    const current = await this.catalog(execution);
    if (!current || execution.step.spec.type !== 'post')
      throw Error('FACEBOOK_POST_MATERIAL_CATALOG_REQUIRED');
    if (execution.step.spec.resourceMode === 'table') {
      const parsed = ResourceMaterialCatalog.parse(current),
        fixed = await this.resources.binding(execution.plan.id);
      if (
        !fixed ||
        fixed.combinationId !== parsed.combinationId ||
        fixed.resourceRevision !== parsed.resourceRevision
      )
        throw Error('FACEBOOK_POST_RESOURCE_CATALOG_SCOPE');
      return parsed.id;
    }
    const parsed = MaterialCatalog.parse(current);
    if (parsed.directory !== execution.step.spec.resourceDirectory)
      throw Error('FACEBOOK_POST_DIRECTORY_CATALOG_SCOPE');
    return parsed.id;
  }
  private async owner(execution: StepExecution, guard: () => Awaitable<void>) {
    const session = await this.session(execution);
    if (!session) throw Error('FACEBOOK_POST_MANAGED_OWNER_REQUIRED');
    const assertCurrent = async () => {
      await guard();
      const current = await session.current();
      if (
        (await this.session(execution)) !== session ||
        !current ||
        !sameExecution(current, execution.session)
      )
        throw Error('FACEBOOK_POST_MANAGED_OWNER_CHANGED');
    };
    await assertCurrent();
    return { session, assertCurrent };
  }
  async read(execution: StepExecution, guard: () => Awaitable<void>) {
    const owner = await this.owner(execution, guard);
    if (this.prepareCatalog) {
      await this.prepareCatalog(execution, owner.assertCurrent);
      await owner.assertCurrent();
    }
    const catalog =
      execution.step.spec.type === 'post' && execution.step.spec.resourceMode === 'table'
        ? await this.catalog(execution)
        : null;
    const readAILabel =
      catalog &&
      ResourceMaterialCatalog.parse(catalog).sources.some(
        (source) => source.origin.row.aiLabel === 'on' || source.origin.row.aiLabel === 'off',
      );
    const result = await owner.session.readPostPage(
      execution,
      owner.assertCurrent,
      this.requiredAudience,
      Boolean(readAILabel),
    );
    await owner.assertCurrent();
    return result;
  }
  async verifyBusiness(
    execution: StepExecution,
    operation: FacebookPostBoundOperation,
    original: FacebookPostOriginal,
    guard: () => Awaitable<void>,
  ) {
    if (!(await this.ready())) throw Error('FACEBOOK_POST_BUSINESS_OBSERVER_REQUIRED');
    const owner = await this.owner(execution, guard);
    const result = await owner.session.verifyPostBusiness(
      execution,
      operation,
      original,
      this.business,
      owner.assertCurrent,
    );
    await owner.assertCurrent();
    return result;
  }
}
