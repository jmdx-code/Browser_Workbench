import type { Awaitable } from '../domain/persistence.js';
import type { Binding } from '../shared/task-execution.js';
import type { NativeInputGuard } from '../application/native-input-gate.js';
import type { MaterialUploadPreparation } from '../application/material-upload-preparation.js';
import type { MaterialFileGrantPreparation } from '../application/material-file-grant-preparation.js';
import type { MaterialUploadOperationGuard } from '../application/material-upload-guard.js';
import type { KernelBridge } from './kernel-bridge.js';
import type { Page } from 'playwright-core';
import type { UploadManifest } from '../shared/material-upload.js';
import { AsyncWorkBudget } from '../application/async-work-budget.js';
import { MAX_CONCURRENT_UPLOAD_PREPARATIONS } from '../shared/task-capacity.js';

// Bound controller file preparation / SDK transfer, not the browser's later network upload.
const uploadPreparationBudget = new AsyncWorkBudget(MAX_CONCURRENT_UPLOAD_PREPARATIONS, 100);

type UploadSession = Pick<
  Awaited<ReturnType<KernelBridge['connect']>>,
  'execute' | 'grantOperationFiles' | 'browser' | 'enablePostNetworkObservation'
>;
// Internal scoped SDK path. A transport return is not media ready or publication evidence.
export class KernelMaterialUpload {
  constructor(
    private readonly preparation: MaterialUploadPreparation,
    private readonly files: MaterialFileGrantPreparation,
    private readonly guards: MaterialUploadOperationGuard,
    private readonly beforeUpload?: (
      page: Page,
      binding: Binding,
      manifest: UploadManifest,
      guard: () => Awaitable<void>,
      enableBuffers: () => Promise<void>,
    ) => Promise<void>,
  ) {}
  async send(
    session: UploadSession,
    binding: Binding,
    assertActorCurrent: () => Awaitable<void>,
    failureStop?: (reason: string) => Promise<void>,
    inspectBusinessTarget?: NativeInputGuard,
  ) {
    let inspect: NativeInputGuard | undefined;
    const guard: NativeInputGuard = async (command) => {
      if (!inspect) throw Error('UPLOAD_RESOURCE_GUARD_NOT_READY');
      await inspect(command);
      await assertActorCurrent();
      await inspectBusinessTarget?.(command);
      await assertActorCurrent();
    };
    return await uploadPreparationBudget.run(assertActorCurrent, () =>
      session.execute(
        binding,
        async () => {
          const manifest = await this.preparation.prepare(binding, assertActorCurrent);
          inspect = await this.guards.forOperation(binding, manifest, assertActorCurrent);
          const grant = await this.files.prepare(binding, manifest, assertActorCurrent);
          await session.grantOperationFiles(grant);
          await assertActorCurrent();
          const contexts = session.browser.contexts();
          if (contexts.length !== 1) throw Error('UPLOAD_SCOPED_CONTEXT_REQUIRED');
          const pages = contexts[0]?.pages();
          if (!pages || pages.length !== 1 || !pages[0]) throw Error('UPLOAD_SCOPED_PAGE_REQUIRED');
          const { target } = grant.action,
            page = pages[0];
          await this.beforeUpload?.(page, binding, manifest, assertActorCurrent, () =>
            session.enablePostNetworkObservation(binding, assertActorCurrent),
          );
          await assertActorCurrent();
          let locator = target.scope
            ? page.locator(target.scope).locator(target.css)
            : page.locator(target.css);
          if (target.text !== undefined)
            locator = locator.filter({
              hasText: new RegExp('^' + target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
            });
          await locator.setInputFiles(grant.files, { timeout: 15_000 });
          await assertActorCurrent();
          return { manifest };
        },
        assertActorCurrent,
        failureStop,
        guard,
      ),
    );
  }
}
