import type { Awaitable } from '../domain/persistence.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type { StepExecution } from '../domain/browse-execution.js';
import type { Catalog } from '../shared/material-index.js';
import type { ResourceCatalog } from '../shared/resource-materials.js';
import type { WorkspaceStorePort as WorkspaceStore } from './persistence-port.js';
import { FilesystemMaterialScanner } from './material-scanner.js';
import { ResourceMaterialPreparation } from '../application/resource-material-preparation.js';
import { FilesystemResourceMaterialVerifier } from './resource-material-verifier.js';
import { PublicDriveDownloader } from './public-drive-download.js';
import { checkKnownFacebookVideo, checkKnownFacebookVideoPath } from './video-metadata.js';

type Prepared = {
  catalog: Catalog | ResourceCatalog;
  blocked: { rowId: string; reason: string }[];
};
type Pending = {
  work: Promise<Prepared>;
  consumers: Map<symbol, () => void>;
};

// Ephemeral catalog selection over the original immutable SQL catalogs. No material claims,
// post ledger, browser input or source moves. Plans sharing one saved table revision reuse
// one catalog/cache rather than downloading the same 200 rows separately for each account.
export class FacebookPlanMaterialCatalogs {
  private readonly prepared = new Map<string, Prepared>();
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(
    private readonly store: WorkspaceStore,
    private readonly directory: string,
    private readonly downloader = (cache: string) => new PublicDriveDownloader(cache),
  ) {}
  private async key(execution: StepExecution) {
    if (execution.step.spec.type !== 'post') throw Error('FACEBOOK_POST_STEP_REQUIRED');
    if (execution.step.spec.resourceMode !== 'table') return 'directory-step:' + execution.step.id;
    const fixed = await this.store.tasks.resources.binding(execution.plan.id);
    if (!fixed) throw Error('RESOURCE_BINDING_REQUIRED');
    return `resource-table:${fixed.combinationId}:${fixed.resourceRevision}`;
  }
  private async check(execution: StepExecution, guard: () => Awaitable<void>) {
    await guard();
    const plan = await this.store.tasks.get(execution.plan.id);
    const step = (await this.store.tasks.steps(plan.id)).find((s) => s.id === execution.step.id);
    if (
      this.closed ||
      plan.state !== 'RUNNING' ||
      plan.profileId !== execution.session.profileId ||
      plan.accountId !== execution.session.accountId ||
      step?.status !== 'ACTIVE' ||
      step.position !== plan.position ||
      step.round !== plan.round ||
      step.spec.type !== 'post' ||
      JSON.stringify(step.spec) !== JSON.stringify(execution.step.spec)
    )
      throw Error('FACEBOOK_MATERIAL_PREPARATION_REVOKED');
  }
  async current(execution: StepExecution): Promise<Catalog | ResourceCatalog | null> {
    const original = (await this.store.materials.forPlan(execution.plan.id)).find(
      (r) => r.intent.stepId === execution.step.id,
    );
    if (original)
      return original.intent.directory === null
        ? await this.store.materials.resourceCatalog(original.intent.catalogId)
        : await this.store.materials.catalog(original.intent.catalogId);
    const value = this.prepared.get(await this.key(execution));
    return value ? structuredClone(value.catalog) : null;
  }
  async blocked(execution: StepExecution) {
    return structuredClone(this.prepared.get(await this.key(execution))?.blocked ?? []);
  }
  async prepare(execution: StepExecution, guard: () => Awaitable<void>) {
    await this.check(execution, guard);
    const previous = this.prepared.get(await this.key(execution));
    if (previous?.blocked.length && !previous.catalog.sources.length)
      throw Error('FACEBOOK_MATERIAL_ROWS_BLOCKED:' + previous.blocked[0]?.reason);
    if (await this.current(execution)) return;
    const key = await this.key(execution);
    const token = Symbol('resource-consumer');
    const started = performance.now();
    let guardCalls = 0,
      guardMilliseconds = 0;
    const current = async () => {
      const at = performance.now();
      try {
        await this.check(execution, guard);
      } finally {
        guardCalls++;
        guardMilliseconds += performance.now() - at;
      }
    };
    let entry = this.pending.get(key);
    if (!entry) {
      const consumers = new Map([[token, current]]);
      // Preparation only reads a fixed revision. It belongs to its current consumers,
      // not the first browser: cancelling one actor must not revoke all other actors.
      const sharedCurrent = async () => {
        if (this.closed) throw Error('FACEBOOK_MATERIAL_PREPARATION_REVOKED');
        for (const [id, check] of consumers) {
          try {
            await check();
          } catch {
            consumers.delete(id);
          }
        }
        if (!consumers.size) throw Error('FACEBOOK_MATERIAL_PREPARATION_REVOKED');
      };
      entry = { work: this.read(execution, sharedCurrent), consumers };
      this.pending.set(key, entry);
      const pending = entry;
      void entry.work
        .finally(() => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        })
        .catch(() => {});
    } else entry.consumers.set(token, current);
    try {
      const result = await entry.work;
      await this.check(execution, guard);
      this.prepared.set(key, structuredClone(result));
      if (result.blocked.length && !result.catalog.sources.length)
        throw Error('FACEBOOK_MATERIAL_ROWS_BLOCKED:' + result.blocked[0]?.reason);
    } finally {
      entry.consumers.delete(token);
      if (process.env.WORKBENCH_TRACE_TIMING === '1')
        console.warn(
          JSON.stringify({
            event: 'MATERIAL_PREPARATION_TIMING',
            jobId: execution.plan.id,
            milliseconds: Math.round(performance.now() - started),
            guardCalls,
            guardMilliseconds: Math.round(guardMilliseconds),
          }),
        );
    }
  }
  private async read(execution: StepExecution, guard: () => Awaitable<void>): Promise<Prepared> {
    await guard();
    if (execution.step.spec.type !== 'post') throw Error('FACEBOOK_POST_STEP_REQUIRED');
    if (execution.step.spec.resourceMode === 'table') {
      // Fixed downloaded references enter the original ResourceMaterialCatalog; input
      // later rechecks these exact bytes/proofs, never redownloads a changed remote object.
      const downloads = this.downloader(path.join(this.directory, 'drive-cache', randomUUID()));
      const preparation = new ResourceMaterialPreparation(
        this.store.tasks.resources,
        new FilesystemResourceMaterialVerifier(
          undefined,
          undefined,
          downloads,
          checkKnownFacebookVideoPath,
        ),
        this.store.materials,
        undefined,
        undefined,
        // A shared catalog is destination-neutral. Reservation and the executor still
        // apply destination-specific rules; the first consumer must not erase post rows.
        true,
      );
      const result = await preparation.prepare(execution.plan.id, randomUUID(), guard);
      await guard();
      return { catalog: result.catalog, blocked: result.blocked };
    }
    const scan = await new FilesystemMaterialScanner(undefined, checkKnownFacebookVideo).scan(
      execution.step.spec.resourceDirectory,
    );
    await guard();
    return { catalog: await this.store.materials.index(scan, randomUUID()), blocked: [] };
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()].map((entry) => entry.work));
    this.prepared.clear();
  }
}
