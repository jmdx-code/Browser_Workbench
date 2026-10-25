import type { SynchronousRepository } from '../domain/persistence.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type { MaterialUploadStageRepository as CompatibleMaterialUploadStageRepository } from '../domain/material-upload-stages.js';
import {
  UploadStageOwner,
  UploadStageClaim,
  UploadStageRecord,
  type StageClaim,
} from '../shared/material-upload-stages.js';
import { MaterialPostIntent, type PostIntent } from '../shared/material-index.js';
import { DispatchBinding, sameBinding, type Binding } from '../shared/task-execution.js';
import {
  UploadStageManifest,
  uploadedFileContent,
  type UploadManifest,
} from '../shared/material-upload.js';
import type { SqliteTaskTabRepository } from './task-tab-store.js';
import { postLink, assertPostReady } from './material-post-guards.js';
import { transaction } from './sqlite-transaction.js';
import { assertUploadManifestSource } from '../domain/material-upload.js';
import { StepSchema } from '../shared/contracts.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class SqliteMaterialUploadStageRepository implements MaterialUploadStageRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tabs: SqliteTaskTabRepository,
  ) {}
  assertDerivationContract(intent: PostIntent) {
    const raw = this.db
      .prepare('SELECT spec FROM task_steps WHERE id=? AND job_id=?')
      .get(intent.stepId, intent.jobId);
    const spec = raw ? StepSchema.parse(JSON.parse(String(raw.spec))) : null;
    if (
      this.db
        .prepare(
          "SELECT version FROM workspace_execution_contracts WHERE name='story-video-derived-media'",
        )
        .get()?.version !== 1 ||
      spec?.type !== 'post' ||
      spec.destination !== 'story'
    )
      throw Error('UPLOAD_STAGE_DERIVATION_CONTRACT_REQUIRED');
  }
  get(stageId: string) {
    const row = this.db
      .prepare(
        'SELECT o.body,s.claim_token,s.state,s.revision,s.reason,m.body AS manifest FROM material_upload_stage_owners o JOIN material_upload_stage_state s USING(stage_id) LEFT JOIN material_upload_stage_manifests m USING(stage_id) WHERE stage_id=?',
      )
      .get(stageId);
    if (!row) throw Error('UPLOAD_STAGE_OWNER_REQUIRED');
    return UploadStageRecord.parse({
      owner: JSON.parse(String(row.body)) as unknown,
      claimToken: row.claim_token,
      state: row.state,
      revision: row.revision,
      reason: row.reason,
      manifest: row.manifest === null ? null : (JSON.parse(String(row.manifest)) as unknown),
    });
  }
  list() {
    return this.db
      .prepare('SELECT stage_id FROM material_upload_stage_owners ORDER BY created_at,stage_id')
      .all()
      .map((row) => this.get(String(row.stage_id)));
  }
  cacheBytes(stageId: string) {
    const record = this.get(stageId);
    return Math.max(
      record.owner.expectedBytes,
      record.manifest?.files.reduce((sum, file) => sum + uploadedFileContent(file).bytes, 0) ?? 0,
    );
  }
  private retainedBytes() {
    return this.db
      .prepare(
        "SELECT o.stage_id FROM material_upload_stage_owners o WHERE NOT EXISTS(SELECT 1 FROM material_cache_cleanup_completions c JOIN material_cache_cleanup_state s USING(stage_id) WHERE c.stage_id=o.stage_id AND s.state='CLEANED')",
      )
      .all()
      .reduce((sum, row) => sum + this.cacheBytes(String(row.stage_id)), 0);
  }
  reserve(input: PostIntent, bindingInput: Binding, cacheRoot: string, capacityBytes: number) {
    const intent = MaterialPostIntent.parse(input),
      binding = DispatchBinding.parse(bindingInput);
    if (
      !path.isAbsolute(cacheRoot) ||
      path.resolve(cacheRoot) !== cacheRoot ||
      !Number.isSafeInteger(capacityBytes) ||
      capacityBytes <= 0
    )
      throw Error('UPLOAD_STAGE_CONFIG_INVALID');
    return transaction(this.db, () => {
      const link = postLink(this.db, binding.operationId);
      if (!link || link.purpose !== 'UPLOAD_MEDIA' || link.attemptId !== intent.attemptId)
        throw Error('UPLOAD_STAGE_UPLOAD_REQUIRED');
      const original = assertPostReady(this.db, intent.attemptId).intent;
      if (JSON.stringify(original) !== JSON.stringify(intent))
        throw Error('UPLOAD_STAGE_INTENT_CHANGED');
      this.tabs.assertForInput(binding, intent.proof);
      if (
        this.db
          .prepare('SELECT stage_id FROM material_upload_stage_owners WHERE operation_id=?')
          .get(binding.operationId)
      )
        throw Error('UPLOAD_STAGE_ALREADY_OWNED');
      const expectedBytes = intent.snapshot.files
        .filter((file) => file.role !== 'text')
        .reduce((sum, file) => sum + file.bytes, 0);
      const retained = this.retainedBytes();
      if (
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes <= 0 ||
        !Number.isSafeInteger(retained) ||
        expectedBytes > capacityBytes - retained
      )
        throw Error('UPLOAD_STAGE_RETAINED_BUDGET');
      const owner = UploadStageOwner.parse({
        stageId: randomUUID(),
        attemptId: intent.attemptId,
        binding,
        intentDigest: digest(JSON.stringify(intent)),
        fingerprint: intent.fingerprint,
        cacheRoot,
        expectedBytes,
        createdAt: new Date().toISOString(),
      });
      const claim = UploadStageClaim.parse({ owner, claimToken: randomUUID() });
      const now = Date.now();
      this.db
        .prepare('INSERT INTO material_upload_stage_owners VALUES(?,?,?,?,?,?)')
        .run(
          owner.stageId,
          binding.operationId,
          intent.attemptId,
          expectedBytes,
          JSON.stringify(owner),
          now,
        );
      this.db
        .prepare("INSERT INTO material_upload_stage_state VALUES(?,?,'WRITING',0,'',?)")
        .run(owner.stageId, claim.claimToken, now);
      return claim;
    });
  }
  assertWriting(input: StageClaim) {
    const claim = UploadStageClaim.parse(input),
      record = this.get(claim.owner.stageId);
    if (
      JSON.stringify(record.owner) !== JSON.stringify(claim.owner) ||
      record.claimToken !== claim.claimToken ||
      record.state !== 'WRITING'
    )
      throw Error('UPLOAD_STAGE_WRITER_REVOKED');
  }
  complete(input: StageClaim, value: UploadManifest, capacityBytes = 10 * 1024 ** 3) {
    const claim = UploadStageClaim.parse(input),
      manifest = UploadStageManifest.parse(value),
      owner = claim.owner;
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0)
      throw Error('UPLOAD_STAGE_CONFIG_INVALID');
    const ready = transaction(this.db, () => {
      this.assertWriting(claim);
      if (
        manifest.stageId !== owner.stageId ||
        manifest.attemptId !== owner.attemptId ||
        !sameBinding(manifest.binding, owner.binding) ||
        manifest.intentDigest !== owner.intentDigest ||
        manifest.fingerprint !== owner.fingerprint
      )
        throw Error('UPLOAD_STAGE_READY_MISMATCH');
      const intent = assertPostReady(this.db, owner.attemptId).intent;
      this.tabs.assertForInput(owner.binding, intent.proof);
      const media = intent.snapshot.files.filter((file) => file.role !== 'text');
      assertUploadManifestSource(intent, manifest, 'UPLOAD_STAGE_READY_MISMATCH');
      if (manifest.version === 2) {
        this.assertDerivationContract(intent);
        const recipe = manifest.files[0]?.derivation;
        if (!recipe || recipe.textSha256 !== digest(recipe.text))
          throw Error('UPLOAD_STAGE_DERIVED_TEXT_MISMATCH');
      }
      if (
        JSON.stringify(manifest.files.map((file) => file.original)) !== JSON.stringify(media) ||
        media.reduce((sum, file) => sum + file.bytes, 0) !== owner.expectedBytes
      )
        throw Error('UPLOAD_STAGE_READY_MISMATCH');
      const actualBytes = manifest.files.reduce(
        (sum, file) => sum + uploadedFileContent(file).bytes,
        0,
      );
      const retained =
        this.retainedBytes() - owner.expectedBytes + Math.max(owner.expectedBytes, actualBytes);
      if (!Number.isSafeInteger(retained)) throw Error('UPLOAD_STAGE_RETAINED_BUDGET');
      const overBudget = retained > capacityBytes;
      const now = Date.now();
      this.db
        .prepare('INSERT INTO material_upload_stage_manifests VALUES(?,?,?)')
        .run(owner.stageId, JSON.stringify(manifest), now);
      this.db
        .prepare(
          'UPDATE material_upload_stage_state SET state=?,reason=?,revision=revision+1,updated_at=? WHERE stage_id=?',
        )
        .run(
          overBudget ? 'REVIEW' : 'READY',
          overBudget ? 'UPLOAD_STAGE_RETAINED_BUDGET' : '',
          now,
          owner.stageId,
        );
      return !overBudget;
    });
    // Retain the validated file sizes even when READY is refused; failed media still occupies disk.
    if (!ready) throw Error('UPLOAD_STAGE_RETAINED_BUDGET');
  }
  assertReady(input: UploadManifest) {
    const manifest = UploadStageManifest.parse(input),
      record = this.get(manifest.stageId);
    if (record.state !== 'READY' || JSON.stringify(record.manifest) !== JSON.stringify(manifest))
      throw Error('UPLOAD_STAGE_NOT_READY');
  }
  review(input: StageClaim, reason: string) {
    const claim = UploadStageClaim.parse(input);
    transaction(this.db, () => {
      const record = this.get(claim.owner.stageId);
      if (
        JSON.stringify(record.owner) !== JSON.stringify(claim.owner) ||
        record.claimToken !== claim.claimToken
      )
        throw Error('UPLOAD_STAGE_CLAIM_MISMATCH');
      if (record.state === 'REVIEW') return;
      this.db
        .prepare(
          "UPDATE material_upload_stage_state SET state='REVIEW',revision=revision+1,reason=?,updated_at=? WHERE stage_id=?",
        )
        .run(reason.slice(0, 500), Date.now(), claim.owner.stageId);
    });
  }
  recoverOnStartup() {
    return transaction(this.db, () =>
      Number(
        this.db
          .prepare(
            "UPDATE material_upload_stage_state SET state='REVIEW',revision=revision+1,reason='STARTUP_RECHECK_REQUIRED',updated_at=? WHERE state IN ('WRITING','READY')",
          )
          .run(Date.now()).changes,
      ),
    );
  }
}

type MaterialUploadStageRepository = SynchronousRepository<CompatibleMaterialUploadStageRepository>;
