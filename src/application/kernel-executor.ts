import { KernelLease } from '../domain/kernel-lease.js';
import {
  assertKernelSessionCommand,
  kernelAccessURL,
  kernelRequiresOperation,
  type KernelAccess,
} from '../shared/kernel-policy.js';
import {
  PageReadRequest,
  validateProjection,
  type PageProjectionRequest,
} from '../shared/page-read.js';
import type {
  KernelBackend,
  KernelJsonObject,
  KernelStamp,
  KernelTarget,
  KernelTargetInfo,
} from '../shared/kernel-protocol.js';
import {
  KernelOperationFileGrant,
  assertFileGrantActionDigest,
  type OperationFileGrant,
} from '../shared/kernel-file-grant.js';
import { sameBinding } from '../shared/task-execution.js';
import { FacebookNativeIdentityRead } from '../shared/facebook-native-identity.js';

export type KernelStopEvidence = {
  requestId: string;
  state: 'stopped' | 'unconfirmed';
  unresolvedMethods: string[];
};
export class KernelExecutor {
  private readonly owned = new Set<number>();
  private readonly attached = new Set<number>();
  private readonly children = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unresolved = new Set<string>();
  private readonly inFlightMethods = new Map<symbol, string>();
  private readonly cleanupFailures = new Set<number>();
  private readonly targetIds = new Map<number, string>();
  private operationFiles:
    { grant: OperationFileGrant; assertCurrent: () => void; active: boolean } | undefined;
  private fileGrantPending = false;
  private fileGrantRevision = 0;
  private nativeInputsPending = 0;
  private phase: 'paused' | 'running' | 'stopping' | 'stopped' | 'unconfirmed' = 'paused';
  private stopOperation:
    { id: string; retained: boolean; promise: Promise<KernelStopEvidence> } | undefined;
  private retainedStop: KernelStopEvidence | undefined;
  constructor(
    readonly lease: KernelLease,
    private readonly backend: KernelBackend,
    initialOwnedTabs: readonly number[],
    private readonly approvedFiles: ReadonlySet<string> = new Set(),
    private readonly access: KernelAccess = 'fixture',
  ) {
    for (const tabId of initialOwnedTabs) {
      if (!Number.isSafeInteger(tabId) || tabId <= 0) throw Error('KERNEL_TAB_INVALID');
      this.owned.add(tabId);
    }
  }
  grant(stamp: unknown): KernelStamp {
    if (this.phase === 'stopping' || this.phase === 'unconfirmed')
      throw Error('KERNEL_STOP_NOT_CONFIRMED');
    if (this.unresolved.size) throw Error('KERNEL_RESULT_REVIEW_REQUIRED');
    const accepted = this.lease.grant(stamp);
    this.retainedStop = undefined;
    this.phase = 'running';
    return accepted;
  }
  private check(expected?: KernelStamp): KernelStamp {
    if (this.phase !== 'running') throw Error('KERNEL_FENCED');
    return this.lease.check(expected);
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  async attach(tabId: number): Promise<KernelTargetInfo> {
    if (!this.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    const stamp = this.check();
    return this.track(async () => {
      await this.backend.scope(tabId);
      this.check(stamp);
      // Track the attempt before awaiting: stop must also clean up a late attach or partial failure.
      this.attached.add(tabId);
      try {
        const info = await this.backend.attach(tabId);
        this.check(stamp);
        if (info.type !== 'page' || !kernelAccessURL(info.url, this.access))
          throw Error('KERNEL_URL_REJECTED');
        this.targetIds.set(tabId, info.targetId);
        return info;
      } catch (error) {
        await this.detach(tabId);
        throw error;
      }
    });
  }
  async create(
    url: string,
    ownershipId?: string,
    foreground?: boolean,
  ): Promise<{ tabId: number }> {
    if (!kernelAccessURL(url, this.access)) throw Error('KERNEL_URL_REJECTED');
    const stamp = this.check();
    return this.track(async () => {
      const tab = await this.backend.create(url, ownershipId, foreground);
      this.owned.add(tab.tabId);
      try {
        this.check(stamp);
        return tab;
      } catch (error) {
        // A tab created after stop belongs to us; clean it up without touching user tabs.
        try {
          await this.backend.remove(tab.tabId);
          this.owned.delete(tab.tabId);
        } catch {
          this.cleanupFailures.add(tab.tabId);
        }
        throw error;
      }
    });
  }
  async adopt(tabId: number): Promise<void> {
    const stamp = this.check();
    await this.backend.scope(tabId);
    this.check(stamp);
    this.owned.add(tabId);
  }
  async remove(tabId: number): Promise<void> {
    if (!this.owned.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    if (this.operationFiles?.grant.proof.tabId === tabId) this.revokeFiles();
    const stamp = this.check();
    return this.track(async () => {
      if (this.backend.scopeForClose) await this.backend.scopeForClose(tabId);
      else await this.backend.scope(tabId);
      this.check(stamp);
      await this.backend.remove(tabId);
      this.owned.delete(tabId);
      this.attached.delete(tabId);
      this.targetIds.delete(tabId);
      this.check(stamp);
    });
  }
  async send(
    target: KernelTarget,
    method: string,
    params: KernelJsonObject,
  ): Promise<KernelJsonObject> {
    if (!this.owned.has(target.tabId) || !this.attached.has(target.tabId))
      throw Error('KERNEL_TAB_NOT_OWNED');
    if (target.sessionId && !this.children.has(`${target.tabId}:${target.sessionId}`))
      throw Error('KERNEL_CHILD_NOT_OWNED');
    if (kernelRequiresOperation(method, this.access) && this.fileGrantPending)
      throw Error('KERNEL_FILE_GRANT_IN_FLIGHT');
    const fileRecord = this.operationFiles,
      fileRevision = this.fileGrantRevision;
    const approved = assertKernelSessionCommand(
      method,
      params,
      fileRecord ? new Set(fileRecord.grant.files) : this.approvedFiles,
      this.access,
    );
    if (method === 'DOM.setFileInputFiles')
      this.assertFileCommand(target, approved, fileRecord, fileRevision);
    const stamp = this.check();
    const input = kernelRequiresOperation(method, this.access);
    if (input) this.nativeInputsPending++;
    try {
      return await this.track(async () => {
        if (!this.backend.scopeEnforcedBySend) await this.backend.scope(target.tabId);
        this.check(stamp);
        if (method === 'DOM.setFileInputFiles')
          this.assertFileCommand(target, approved, fileRecord, fileRevision);
        let dispatched = false;
        const id = Symbol();
        try {
          dispatched = true;
          this.inFlightMethods.set(id, method);
          const result = await this.backend.send(target, method, approved);
          this.check(stamp);
          return result;
        } catch (error) {
          // Protocol ACKs are not business verification. Preserve uncertain in-flight inputs.
          let fenced = false;
          try {
            this.check(stamp);
          } catch {
            fenced = true;
          }
          if (
            dispatched &&
            (kernelRequiresOperation(method, this.access) ||
              (/^Runtime\.(evaluate|callFunctionOn)$/.test(method) &&
                (fenced || (error instanceof Error && error.message.includes('_UNKNOWN')))))
          )
            this.unresolved.add(method);
          throw error;
        } finally {
          this.inFlightMethods.delete(id);
        }
      });
    } finally {
      if (input) this.nativeInputsPending--;
    }
  }
  async grantFiles(value: OperationFileGrant, assertCurrent: () => void): Promise<void> {
    const grant = KernelOperationFileGrant.parse(value),
      stamp = this.check(),
      revision = this.fileGrantRevision;
    if (this.access === 'facebook-readonly') throw Error('KERNEL_READONLY_FILES_REJECTED');
    if (this.fileGrantPending || this.nativeInputsPending)
      throw Error('KERNEL_FILE_GRANT_IN_FLIGHT');
    const previous = this.operationFiles;
    if (previous) {
      if (sameBinding(previous.grant.binding, grant.binding)) {
        if (!previous.active) throw Error('KERNEL_FILE_GRANT_REVOKED');
        if (JSON.stringify(previous.grant) !== JSON.stringify(grant))
          throw Error('KERNEL_FILE_GRANT_CONFLICT');
        previous.assertCurrent();
        assertCurrent();
        return;
      }
      if (previous.active) throw Error('KERNEL_FILE_GRANT_CONFLICT');
    }
    assertCurrent();
    if (
      grant.binding.profileId !== stamp.profileId ||
      grant.binding.connectionEpoch !== stamp.connectionEpoch ||
      grant.binding.leaseId !== stamp.leaseId ||
      grant.binding.generation !== stamp.generation ||
      !this.owned.has(grant.proof.tabId) ||
      !this.attached.has(grant.proof.tabId) ||
      this.targetIds.get(grant.proof.tabId) !== grant.proof.targetId
    )
      throw Error('KERNEL_FILE_GRANT_CONTEXT_MISMATCH');
    this.fileGrantPending = true;
    try {
      await this.track(async () => {
        await assertFileGrantActionDigest(grant);
        this.check(stamp);
        assertCurrent();
        await this.backend.scope(grant.proof.tabId);
        this.check(stamp);
        assertCurrent();
        if (
          this.fileGrantRevision !== revision ||
          this.operationFiles !== previous ||
          !this.attached.has(grant.proof.tabId) ||
          this.targetIds.get(grant.proof.tabId) !== grant.proof.targetId
        )
          throw Error('KERNEL_FILE_GRANT_REVOKED');
        this.operationFiles = { grant, assertCurrent, active: true };
      });
    } finally {
      this.fileGrantPending = false;
    }
  }
  revokeFiles(): void {
    this.fileGrantRevision++;
    if (this.operationFiles) this.operationFiles.active = false;
  }
  private assertFileCommand(
    target: KernelTarget,
    params: KernelJsonObject,
    expected: typeof this.operationFiles,
    revision: number,
  ) {
    if (
      this.fileGrantPending ||
      revision !== this.fileGrantRevision ||
      this.operationFiles !== expected
    )
      throw Error('KERNEL_FILE_GRANT_REVOKED');
    if (!expected) return; // Initial fixed fixture files remain a separate historical diagnostic path.
    if (!expected.active) throw Error('KERNEL_FILE_GRANT_REVOKED');
    expected.assertCurrent();
    if (
      target.tabId !== expected.grant.proof.tabId ||
      JSON.stringify(params.files) !== JSON.stringify(expected.grant.files)
    )
      throw Error('KERNEL_FILE_GRANT_FILES_MISMATCH');
  }
  async project(tabId: number, input: PageProjectionRequest) {
    if (this.access !== 'facebook-readonly' || !this.backend.project)
      throw Error('KERNEL_PROJECTION_UNAVAILABLE');
    if (!this.owned.has(tabId) || !this.attached.has(tabId)) throw Error('KERNEL_TAB_NOT_OWNED');
    const request = PageReadRequest.parse(input);
    const project = this.backend.project.bind(this.backend);
    const stamp = this.check();
    return this.track(async () => {
      await this.backend.scope(tabId);
      this.check(stamp);
      const result = validateProjection(request, await project(tabId, request));
      this.check(stamp);
      if (!kernelAccessURL(result.url, this.access)) throw Error('KERNEL_SCOPE_CHANGED');
      return result;
    });
  }
  async observeFacebookIdentity(tabId: number) {
    if (
      this.access !== 'facebook-readonly' ||
      !this.owned.has(tabId) ||
      !this.attached.has(tabId) ||
      !this.backend.observeIdentity
    )
      throw Error('KERNEL_IDENTITY_READ_UNAVAILABLE');
    const stamp = this.check();
    return this.track(async () => {
      await this.backend.scope(tabId);
      this.check(stamp);
      const result = await this.backend.observeIdentity?.(tabId, () => {
        this.check(stamp);
      });
      this.check(stamp);
      return result ? FacebookNativeIdentityRead.parse(result) : null;
    });
  }
  registerChild(source: KernelTarget, child: string): boolean {
    try {
      this.check();
      if (
        !this.attached.has(source.tabId) ||
        (source.sessionId && !this.children.has(`${source.tabId}:${source.sessionId}`))
      )
        return false;
      this.children.add(`${source.tabId}:${child}`);
      return true;
    } catch {
      return false;
    }
  }
  forgetChild(tabId: number, child: string): void {
    this.children.delete(`${tabId}:${child}`);
  }
  acceptsEvent(source: KernelTarget): boolean {
    try {
      this.check();
      return (
        this.attached.has(source.tabId) &&
        (!source.sessionId || this.children.has(`${source.tabId}:${source.sessionId}`))
      );
    } catch {
      return false;
    }
  }
  private async detach(tabId: number): Promise<void> {
    if (this.operationFiles?.grant.proof.tabId === tabId) this.revokeFiles();
    try {
      await this.backend.detach(tabId);
      this.attached.delete(tabId);
      this.targetIds.delete(tabId);
      this.cleanupFailures.delete(tabId);
    } catch {
      this.cleanupFailures.add(tabId);
    }
  }
  stop(
    requestId: string,
    timeoutMs = 12_000,
    retainAttachments = false,
  ): Promise<KernelStopEvidence> {
    if (retainAttachments && this.retainedStop?.requestId === requestId)
      return Promise.resolve(this.retainedStop);
    if (this.stopOperation) {
      if (this.stopOperation.id !== requestId) throw Error('KERNEL_CONTROL_PENDING');
      if (this.stopOperation.retained !== retainAttachments)
        throw Error('KERNEL_CONTROL_SCOPE_CONFLICT');
      return this.stopOperation.promise;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw Error('KERNEL_STOP_TIMEOUT_INVALID');
    this.phase = 'stopping';
    this.revokeFiles();
    this.lease.revoke(); // Synchronous fence before any detach or wait.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = (async (): Promise<KernelStopEvidence> => {
      const detached = retainAttachments
        ? Promise.resolve()
        : Promise.all([...this.attached].map((tabId) => this.detach(tabId)));
      const drain = Promise.allSettled([...this.pending]);
      const finished = await Promise.race([
        Promise.all([detached, drain]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      const confirmed = finished && !this.pending.size && !this.cleanupFailures.size;
      this.phase = confirmed ? 'stopped' : 'unconfirmed';
      if (confirmed && !retainAttachments) this.children.clear();
      const evidence: KernelStopEvidence = {
        requestId,
        state: confirmed ? 'stopped' : 'unconfirmed',
        unresolvedMethods: [
          ...new Set([
            ...this.unresolved,
            ...[...this.inFlightMethods.values()].filter(
              (method) =>
                kernelRequiresOperation(method, this.access) ||
                /^Runtime\.(evaluate|callFunctionOn)$/.test(method),
            ),
          ]),
        ],
      };
      if (confirmed && retainAttachments) this.retainedStop = evidence;
      return evidence;
    })();
    this.stopOperation = { id: requestId, retained: retainAttachments, promise };
    void promise
      .finally(() => {
        this.stopOperation = undefined;
      })
      .catch(() => {});
    return promise;
  }
  get state(): string {
    return this.phase;
  }
  get hasPendingCommands(): boolean {
    return this.pending.size > 0 || this.nativeInputsPending > 0;
  }
  get reviewRequired(): boolean {
    return this.unresolved.size > 0;
  }
}
