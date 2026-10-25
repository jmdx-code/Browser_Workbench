import type { WorkspaceStorePort } from './persistence-port.js';
import { BusinessResolution } from '../shared/settlement.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Peer, Core } from '../bridge/core.js';
import type { RuntimeProfile } from '../domain/tasks.js';
import type { Binding } from '../shared/task-execution.js';
import { sameExecution } from '../shared/task-execution.js';
import { sameTabProof } from '../domain/task-tabs.js';
import { verifyKernelUploadFixture } from '../domain/kernel-upload-fixture.js';
import { KernelMaterialUpload } from './kernel-material-upload.js';
import type { KernelBridge } from './kernel-bridge.js';
import { WorkspaceStore } from './workspace-store.js';
import { FilesystemMaterialScanner } from './material-scanner.js';
import { FilesystemMaterialSourceVerifier } from './material-source-verifier.js';
import { FilesystemMaterialUploadStage } from './material-upload-stage.js';
import { MaterialPostSourceCheck } from '../application/material-source-check.js';
import { MaterialUploadPreparation } from '../application/material-upload-preparation.js';
import { MaterialFileGrantPreparation } from '../application/material-file-grant-preparation.js';
import { MaterialUploadOperationGuard } from '../application/material-upload-guard.js';
import { PersistentMaterialUploadStage } from '../application/persistent-material-upload-stage.js';

export const confirmedUploadChrome = '2b32bd78-51d0-4576-a12b-252c4d3c2d9b';
export function uploadAuditEligible(
  peer: Pick<
    Peer,
    'profileId' | 'online' | 'synced' | 'phase' | 'extensionVersion' | 'capabilities'
  >,
) {
  return (
    peer.profileId === confirmedUploadChrome &&
    peer.online &&
    peer.synced &&
    peer.phase === 'PAUSED' &&
    ['0.3.6', '0.3.7'].includes(peer.extensionVersion ?? '') &&
    peer.capabilities?.includes('kernel-operation-files-v1') === true &&
    peer.capabilities.includes('kernel-journal-v1')
  );
}

// One new explicitly enabled diagnostic, one confirmed Chrome, generated resources only.
// Report reservation is durable before native operations; process restart never retries this run.
export class KernelUploadAudit {
  private attempted = false;
  private disabled = false;
  constructor(
    private readonly bridge: KernelBridge,
    private readonly core: Core,
    private readonly root: string,
    private readonly formal: WorkspaceStorePort,
  ) {}
  disable() {
    this.disabled = true;
  }
  tick() {
    if (this.disabled || this.attempted) return;
    const peer = this.core.peers.get(confirmedUploadChrome);
    if (!peer || !uploadAuditEligible(peer)) return;
    this.attempted = true;
    void this.run(peer).catch(() => {});
  }
  private assertCurrent(peer: Peer) {
    if (this.disabled || this.core.peers.get(peer.profileId) !== peer || !uploadAuditEligible(peer))
      throw Error('UPLOAD_AUDIT_OWNER_CHANGED');
  }
  private async run(peer: Peer) {
    const output = path.join(this.root, 'audit'),
      report = path.join(output, `kernel-upload-live-${peer.profileId}.json`);
    await mkdir(output, { recursive: true });
    try {
      await writeFile(
        report,
        JSON.stringify({
          state: 'RESERVED',
          recordedAt: new Date().toISOString(),
          profileId: peer.profileId,
        }),
        { flag: 'wx' },
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
    const cases: Record<string, unknown>[] = [],
      failures: string[] = [];
    const directory = path.join(output, 'kernel-upload-isolated-' + randomUUID());
    try {
      this.assertCurrent(peer);
      if ((await this.formal.tasks.list()).some((plan) => plan.profileId === peer.profileId))
        throw Error('FORMAL_PROFILE_HAS_PLANS');
      await this.bridge.withSummary(peer, async (summary) => {
        const state = await summary.inventory();
        if (state.operations.some((row) => row.state !== 'RECONCILED'))
          throw Error('UPLOAD_AUDIT_REMOTE_REVIEW_REQUIRED');
      });
      await mkdir(directory);
      const resources = path.join(directory, 'generated-resources');
      await mkdir(resources);
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
        'base64',
      );
      await writeFile(path.join(resources, 'image.png'), png, { flag: 'wx' });
      await mkdir(path.join(resources, 'album'));
      await writeFile(path.join(resources, 'album', 'a.png'), png, { flag: 'wx' });
      await writeFile(path.join(resources, 'album', 'b.png'), png, { flag: 'wx' });
      await writeFile(
        path.join(resources, 'video.mp4'),
        await readFile(path.join(this.root, 'public/sample.mp4')),
        { flag: 'wx' },
      );
      for (const [ordinal, source] of ['image.png', 'album', 'video.mp4'].entries()) {
        this.assertCurrent(peer);
        const evidence = await this.transfer(
          peer,
          resources,
          path.join(directory, `case-${ordinal}`),
          source,
        );
        cases.push(evidence);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'UPLOAD_AUDIT_FAILED');
    }
    await writeFile(
      report,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          softwareVersion: '0.1.26',
          state: failures.length === 0 && cases.length === 3 ? 'PASSED' : 'FAILED',
          profileId: peer.profileId,
          extensionVersion: peer.extensionVersion,
          browserVendor: 'User-confirmed Chrome only',
          directory,
          scope:
            'Original bound UPLOAD_MEDIA and stable public SDK; generated local page file bytes only.',
          syntheticBusinessIdentity: true,
          actualFacebookUploaded: false,
          actualFacebookPublished: false,
          sourceMoves: false,
          formalTasksCreated: 0,
          automaticReplay: false,
          cases,
          failures,
          trace: this.bridge.diagnostics(peer.profileId),
          detectionProbability: 'not-measured',
        },
        null,
        2,
      ),
    );
  }
  private async transfer(peer: Peer, resources: string, directory: string, source: string) {
    await mkdir(directory);
    const database = path.join(directory, 'workspace.sqlite'),
      store = await WorkspaceStore.open(database);
    let connection: Awaited<ReturnType<KernelBridge['connect']>> | undefined,
      binding: Binding | undefined;
    const evidence: Record<string, unknown> = {
      source,
      database,
      actualSdkFileTransfer: false,
      nativeTargetClosed: false,
      stopped: false,
    };
    try {
      connection = await this.bridge.connect(peer, []);
      const conn = connection,
        proof = conn.proof;
      if (!proof) throw Error('UPLOAD_AUDIT_TAB_PROOF_MISSING');
      evidence.proof = proof;
      const page = conn.browser.contexts()[0]?.pages()[0];
      if (!page) throw Error('UPLOAD_AUDIT_PAGE_MISSING');
      const accountId = 'local-upload-fixture:' + peer.profileId;
      const context = await conn.context(accountId);
      if (!context) throw Error('UPLOAD_AUDIT_CONTEXT_MISSING');
      const runtime: RuntimeProfile = {
        id: peer.profileId,
        online: true,
        synced: true,
        unresolved: 0,
        dispatchAllowed: true,
        account: { state: 'logged-in', id: accountId, name: null, avatar: null },
      };
      const catalog = store.materials.index(
        await new FilesystemMaterialScanner().scan(resources),
        randomUUID(),
      );
      const saved = store.createCombination({
        name: '本机原操作上传验收',
        note: '模拟业务身份，仅实际本机文件读取',
        steps: [
          {
            id: randomUUID(),
            type: 'post',
            resourceDirectory: resources,
            count: 1,
            allowRepeat: false,
            forbidSameAccountRepeat: true,
            archivePublished: true,
          },
        ],
        randomOrder: false,
        loop: { mode: 'finite', rounds: 1 },
      });
      store.tasks.assign(
        {
          requestId: randomUUID(),
          combinationId: saved.id,
          version: saved.version,
          profileIds: [peer.profileId],
        },
        [runtime],
      );
      const plan = store.tasks.claimNext([runtime], new Set(['post']));
      if (!plan) throw Error('UPLOAD_AUDIT_PLAN_MISSING');
      const step = store.tasks.steps(plan.id)[0],
        member = catalog.sources.find((row) => row.snapshot.source === source);
      if (!step || !member || member.snapshot.format === 'text')
        throw Error('UPLOAD_AUDIT_MEDIA_MISSING');
      store.taskTabs.register(plan.id, proof, context);
      const intent = store.materials.reserve({
        attemptId: randomUUID(),
        jobId: plan.id,
        stepId: step.id,
        expectedProgressRevision: step.progress.revision,
        catalogId: catalog.id,
        sourceId: member.id,
        context,
        proof,
      }).intent;
      const hashes = async () =>
        await Promise.all(
          intent.snapshot.files.map(async (file) => ({
            file: file.relativePath,
            hash: createHash('sha256')
              .update(await readFile(path.join(resources, file.relativePath)))
              .digest('hex'),
          })),
        );
      const before = await hashes();
      store.materialPosts.prepare({
        attemptId: intent.attemptId,
        operationId: randomUUID(),
        purpose: 'UPLOAD_MEDIA',
        action: {
          kind: 'uploadMedia',
          tabId: proof.tabId,
          documentEpoch: 0,
          routeEpoch: 0,
          target: { css: '#files' },
          attemptId: intent.attemptId,
          fingerprint: intent.fingerprint,
        },
      });
      const operation = store.tasks.takeBoundOperation(context);
      if (!operation?.binding) throw Error('UPLOAD_AUDIT_BINDING_MISSING');
      binding = operation.binding;
      const original = binding;
      evidence.binding = original;
      const ownerCurrent = async () => {
        this.assertCurrent(peer);
        const current = await conn.context(accountId);
        if (!current || !sameExecution(current, original))
          throw Error('UPLOAD_AUDIT_CONTEXT_CHANGED');
        const row = store.taskTabs.get(proof.ownershipId);
        if (
          row.state !== 'READY' ||
          !row.context ||
          !sameExecution(row.context, current) ||
          !sameTabProof(row.proof, proof) ||
          store.tasks.get(plan.id).state !== 'RUNNING'
        )
          throw Error('UPLOAD_AUDIT_OBSERVATION_OWNER_CHANGED');
      };
      const actor = async () => {
        await ownerCurrent();
        store.taskTabs.assertForInput(original, proof);
      };
      const cache = new PersistentMaterialUploadStage(
        store.uploadStages,
        new FilesystemMaterialUploadStage(path.join(directory, 'cache')),
      );
      const check = new MaterialPostSourceCheck(
        store.materials,
        store.materialPosts,
        store.taskTabs,
        new FilesystemMaterialSourceVerifier(),
      );
      const uploader = new KernelMaterialUpload(
        new MaterialUploadPreparation(check, cache),
        new MaterialFileGrantPreparation(check, cache),
        new MaterialUploadOperationGuard(check, cache),
      );
      const result = await uploader.send(conn, original, actor);
      evidence.binding = original;
      evidence.proof = proof;
      evidence.manifest = result.value.manifest;
      store.tasks.acknowledgeBound({
        binding: result.binding,
        evidence: { kind: 'local-upload-transport-ack' },
      });
      if (
        store.tasks.operations(plan.id)[0]?.status !== 'ACKNOWLEDGED' ||
        store.materialPosts.result(intent.attemptId)
      )
        throw Error('UPLOAD_ACK_PREMATURE_BUSINESS_RESULT');
      await ownerCurrent();
      await page
        .locator('#file-report[data-state="ready"]')
        .waitFor({ state: 'attached', timeout: 15_000 });
      await ownerCurrent();
      const raw = await page.locator('#file-report').textContent();
      await ownerCurrent();
      const observed = verifyKernelUploadFixture(result.value.manifest, JSON.parse(raw ?? 'null'));
      evidence.actualSdkFileTransfer = true;
      evidence.localPageByteObservation = observed;
      if (JSON.stringify(await hashes()) !== JSON.stringify(before))
        throw Error('UPLOAD_AUDIT_SOURCE_CHANGED');
      evidence.originalSourceHashes = before;
      evidence.sourceUnchanged = true;
      store.materialPosts.verify({
        binding: original,
        evidence: {
          kind: 'material-post-verification',
          independent: true,
          attemptId: intent.attemptId,
          fingerprint: intent.fingerprint,
          purpose: 'UPLOAD_MEDIA',
          proof,
          observedAccountId: accountId,
          observationId: randomUUID(),
          checkedAt: new Date().toISOString(),
          outcome: 'APPLIED',
          basis: 'media-upload-observed',
          postId: null,
          media: { ready: true, format: member.snapshot.format, count: observed.files.length },
        },
      });
      const notice = store.tasks.settlements.claim(peer.profileId);
      if (!notice?.claimToken) throw Error('UPLOAD_AUDIT_NOTICE_MISSING');
      store.tasks.settlements.delivered(
        original.operationId,
        notice.claimToken,
        await conn.reconcile(notice.binding, BusinessResolution.parse(notice.resolution)),
      );
      if (
        store.tasks.steps(plan.id)[0]?.progress.published !== 0 ||
        store.materialPosts.result(intent.attemptId) ||
        store.materialPosts.archives().length
      )
        throw Error('UPLOAD_AUDIT_AUXILIARY_PUBLISHED');
      evidence.auxiliaryVerified = true;
      evidence.published = 0;
      evidence.archives = 0;
      await page.close();
      const inventory = await conn.inventory();
      const closed = inventory.tabs.find((row) => row.ownershipId === proof.ownershipId);
      if (closed?.state !== 'CLOSED' || !closed.proof || !sameTabProof(closed.proof, proof))
        throw Error('UPLOAD_AUDIT_CLOSE_UNCONFIRMED');
      const row = store.taskTabs.get(proof.ownershipId);
      store.taskTabs.confirmClosed(proof.ownershipId, row.revision, inventory);
      evidence.nativeTargetClosed = true;
      const stop = await conn.close();
      if (stop.state !== 'stopped') throw Error('UPLOAD_AUDIT_STOP_UNCONFIRMED');
      evidence.stopped = true;
      evidence.stop = stop;
      evidence.trace = this.bridge.diagnostics(peer.profileId);
      return evidence;
    } catch (error) {
      if (binding) {
        const original = binding;
        const operation = store.tasks
          .operations(original.jobId)
          .find((row) => row.id === original.operationId);
        if (operation && ['DISPATCHING', 'ACKNOWLEDGED'].includes(operation.status))
          store.tasks.markBoundUnknown(binding, 'LOCAL_UPLOAD_AUDIT_FAILED');
      }
      evidence.failure = error instanceof Error ? error.message : 'UNKNOWN';
      if (connection) {
        try {
          evidence.stop = await connection.close();
          evidence.stopped = true;
        } catch (stopError) {
          evidence.stopFailure = stopError instanceof Error ? stopError.message : 'UNKNOWN';
        }
        evidence.trace = this.bridge.diagnostics(peer.profileId);
      }
      await writeFile(path.join(directory, 'failure.json'), JSON.stringify(evidence, null, 2), {
        flag: 'wx',
      });
      throw error;
    } finally {
      store.close();
    }
  }
}
